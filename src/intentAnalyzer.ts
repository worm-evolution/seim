import { LLMClient } from './ai';
import { SeimConfig } from './types';
import { Logger } from './logger';

export interface IntentSignal {
  type: 'ui_action' | 'search_query' | 'form_submission' | 'unhandled_route' | 'api_call';
  path: string;
  method?: string;
  payload?: any;
  query?: any;
  referrer?: string;
  context?: Record<string, any>;
  frequency?: number;
  affectedSessions?: number;
}

export interface AnalyzedFeatureSpec {
  isGenuineFeature: boolean;
  classification: 'genuine_feature_request' | 'malicious_probe' | 'user_typo' | 'static_asset' | 'noise';
  confidence: number;
  featureName: string;
  intentDescription: string;
  targetMethod: string;
  targetPath: string;
  suggestedBackendLogic: string;
  suggestedFrontendComponent?: string;
  dataSchema?: {
    inputs?: Record<string, string>;
    outputs?: Record<string, string>;
  };
  rejectionReason?: string;
}

/**
 * Intelligent Semantic Intent Analyzer.
 * 
 * Replaces naive raw 404 URL matching with LLM-powered semantic intent reasoning.
 * Analyzes visitor interaction signals, search queries, unhandled UI actions, and payloads
 * to classify whether a pattern represents a genuine business feature vs a crawler probe or typo.
 */
export class IntentAnalyzer {
  private blocklistRegexes = [
    /\.(php|asp|aspx|jsp|cgi|env|git|yml|yaml|xml|bak|swp|ini|conf|config|sh|sql)$/i,
    /^(?:\/api)?\/(?:wp-admin|wp-login|administrator|phpmyadmin|cpanel|actuator|\.env|\.git)/i,
    /(?:select\s+.*from|union\s+select|<script|eval\(|\.\.\/)/i,
  ];

  constructor(
    private config: SeimConfig,
    private llm: LLMClient,
    private logger: Logger
  ) {}

  /**
   * Evaluates an interaction signal using LLM semantic reasoning to produce a verified feature spec.
   */
  public async analyzeSignal(signal: IntentSignal): Promise<AnalyzedFeatureSpec> {
    const rawPath = signal.path || '/';

    // 1. Fast deterministic heuristic rejection for obvious scanner probes
    for (const re of this.blocklistRegexes) {
      if (re.test(rawPath)) {
        return {
          isGenuineFeature: false,
          classification: 'malicious_probe',
          confidence: 1.0,
          featureName: 'Blocked Probe',
          intentDescription: 'Security scanner / exploit probe',
          targetMethod: signal.method || 'GET',
          targetPath: rawPath,
          suggestedBackendLogic: '',
          rejectionReason: `Matched deterministic probe filter: ${re.source}`,
        };
      }
    }

    // 2. If AI is available, run LLM semantic intent classification
    if (this.config.ai?.apiKey && this.config.ai.enabled !== false) {
      try {
        const systemPrompt = `You are a Principal Product Architect and Security Auditor.
Your job is to analyze web application telemetry signals (unhandled routes, user search queries, failed actions, button clicks) and determine whether this represents a GENUINE missing feature needed by real users, or if it is a malicious security probe, user typo, static file request, or noise.

Respond ONLY with a valid JSON object matching this exact schema:
{
  "isGenuineFeature": true/false,
  "classification": "genuine_feature_request" | "malicious_probe" | "user_typo" | "static_asset" | "noise",
  "confidence": 0.0 to 1.0,
  "featureName": "Clean Name in PascalCase",
  "intentDescription": "Clear description of the feature and why users need it",
  "targetMethod": "GET" | "POST" | "PUT" | "DELETE",
  "targetPath": "/api/clean/path",
  "suggestedBackendLogic": "High level description of how the backend should implement this",
  "suggestedFrontendComponent": "High level description of what the UI component should display",
  "dataSchema": {
    "inputs": { "field1": "type" },
    "outputs": { "field1": "type" }
  },
  "rejectionReason": "Reason if rejected, or empty string"
}`;

        const userPrompt = `Analyze this telemetry signal from live visitor activity:
Type: ${signal.type}
Path: ${signal.path}
Method: ${signal.method || 'GET'}
Referrer: ${signal.referrer || 'direct'}
User Query / Action Payload: ${JSON.stringify(signal.payload || signal.query || {}, null, 2)}
Affected Visitor Sessions: ${signal.affectedSessions || 1}
Hit Frequency: ${signal.frequency || 1}
Context: ${JSON.stringify(signal.context || {}, null, 2)}`;

        const responseText = await this.llm.chat(systemPrompt, userPrompt);
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]) as AnalyzedFeatureSpec;
          this.logger.info('[IntentAnalyzer] Classified signal via LLM', {
            path: signal.path,
            classification: parsed.classification,
            isGenuine: parsed.isGenuineFeature,
            confidence: parsed.confidence,
          });
          return parsed;
        }
      } catch (err: any) {
        this.logger.warn('[IntentAnalyzer] LLM intent classification failed, falling back to heuristics', {
          error: err?.message,
        });
      }
    }

    // 3. Fallback Heuristic Classification when AI is offline
    const isApiPath = rawPath.startsWith('/api/') || rawPath.startsWith('/v1/') || rawPath.startsWith('/v2/');
    const isProbe = rawPath.includes('admin') || rawPath.includes('login') || rawPath.includes('.php');
    const isTypo = rawPath.length > 50 && !rawPath.includes('/');

    if (isProbe || isTypo) {
      return {
        isGenuineFeature: false,
        classification: isProbe ? 'malicious_probe' : 'user_typo',
        confidence: 0.8,
        featureName: 'Rejected Request',
        intentDescription: 'Classified as probe or typo by heuristics',
        targetMethod: signal.method || 'GET',
        targetPath: rawPath,
        suggestedBackendLogic: '',
        rejectionReason: 'Heuristic probe or typo detection',
      };
    }

    return {
      isGenuineFeature: isApiPath && (signal.affectedSessions ?? 1) >= 3,
      classification: isApiPath ? 'genuine_feature_request' : 'noise',
      confidence: 0.75,
      featureName: this.pathToFeatureName(rawPath),
      intentDescription: `Implement ${signal.method || 'GET'} endpoint on ${rawPath}`,
      targetMethod: signal.method || (rawPath.includes('create') || rawPath.includes('add') ? 'POST' : 'GET'),
      targetPath: rawPath,
      suggestedBackendLogic: `Handle ${signal.method || 'GET'} request on ${rawPath} with document collection storage`,
    };
  }

  private pathToFeatureName(p: string): string {
    const segments = p.split('/').filter(Boolean);
    const last = segments[segments.length - 1] || 'Feature';
    return last
      .replace(/[^a-zA-Z0-9]/g, ' ')
      .split(' ')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join('') + 'Handler';
  }
}
