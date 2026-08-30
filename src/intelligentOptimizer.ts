import { LLMClient } from './ai';
import { SeimConfig, OptimizationCandidate, RouteMetrics } from './types';
import { SecurityGate } from './security';
import { Logger } from './logger';

export interface HolisticOptimizationResult {
  canOptimize: boolean;
  strategy: 'algorithmic_rewrite' | 'query_batching' | 'intelligent_caching' | 'stream_processing' | 'parallel_execution';
  optimizedCode?: string;
  explanation: string;
  expectedImprovementPercent: number;
  confidence: number;
}

/**
 * Intelligent LLM-Powered Full-Scale Code Optimizer.
 * 
 * Far exceeds simple N+1 regex replacements. Uses the LLM client to perform
 * deep holistic refactoring, algorithmic redesign, query projection, and intelligent
 * caching while strictly verifying code safety and syntax invariants.
 */
export class IntelligentOptimizer {
  private securityGate: SecurityGate;

  constructor(
    private config: SeimConfig,
    private llm: LLMClient,
    private logger: Logger
  ) {
    this.securityGate = new SecurityGate(config);
  }

  /**
   * Performs full-scale holistic code refactoring using LLM architectural intelligence.
   */
  public async refactorRoute(
    routeKey: string,
    sourceCode: string,
    metrics?: RouteMetrics
  ): Promise<HolisticOptimizationResult> {
    if (!this.config.ai?.apiKey || this.config.ai.enabled === false) {
      return {
        canOptimize: false,
        strategy: 'parallel_execution',
        explanation: 'AI optimization disabled (no API key configured).',
        expectedImprovementPercent: 0,
        confidence: 0,
      };
    }

    const metricsSummary = metrics ? `
Current Production Telemetry:
- Request Count: ${metrics.requestCount}
- Average Latency: ${metrics.requestCount ? Math.round(metrics.totalDuration / metrics.requestCount) : 0}ms
- Durations Samples: ${metrics.durations ? metrics.durations.slice(-10).join(', ') : 'none'}
- Status Codes: ${JSON.stringify(metrics.statusCodes || {})}
` : 'Telemetry: Standard traffic';

    const systemPrompt = `You are a Principal Software Performance Engineer and Compiler Architect.
Analyze the provided Node.js/Express route handler and refactor it for maximum throughput, sub-millisecond response times, and minimal CPU/memory footprint.

You are NOT restricted to toy patterns. You should apply:
1. Deep algorithmic refactoring (replace O(N^2) searches with HashMaps, Sets, indexed lookups).
2. Intelligent in-memory caching and memoization for deterministic operations.
3. Batching and parallel execution of independent I/O and database operations (Promise.all).
4. Memory optimization and payload streaming.
5. Early returns and branch prediction optimizations.

CRITICAL INVARIANTS:
- Preserve 100% of business logic, authentication checks, status codes, and response schemas.
- Do NOT introduce external npm packages.
- Ensure the code is an async function or clean Express handler function.

Respond ONLY with a valid JSON object matching:
{
  "canOptimize": true/false,
  "strategy": "algorithmic_rewrite" | "query_batching" | "intelligent_caching" | "stream_processing" | "parallel_execution",
  "optimizedCode": "Full javascript code for the optimized handler function",
  "explanation": "Detailed explanation of what was changed and the algorithmic reasons why it is faster",
  "expectedImprovementPercent": 40,
  "confidence": 0.95
}`;

    const userPrompt = `Route: ${routeKey}
${metricsSummary}

Original Handler Source Code:
\`\`\`javascript
${sourceCode}
\`\`\``;

    try {
      const responseText = await this.llm.chat(systemPrompt, userPrompt);
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('LLM response did not contain a valid JSON object');
      }

      const result = JSON.parse(jsonMatch[0]) as HolisticOptimizationResult;

      if (result.canOptimize && result.optimizedCode) {
        // Validate through SecurityGate before returning
        const mockCandidate: OptimizationCandidate = {
          id: `holistic_${Date.now()}`,
          routeKey,
          pattern: result.strategy,
          severity: 'high',
          originalCode: sourceCode,
          optimizedCode: result.optimizedCode,
          confidence: result.confidence,
          status: 'pending',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };

        const safety = this.securityGate.validate(sourceCode, mockCandidate);
        if (!safety.pass) {
          this.logger.warn('[IntelligentOptimizer] Refactored code blocked by SecurityGate', {
            routeKey,
            reason: safety.reason,
          });
          return {
            canOptimize: false,
            strategy: result.strategy,
            explanation: `Refactoring blocked by safety gate: ${safety.reason}`,
            expectedImprovementPercent: 0,
            confidence: 0,
          };
        }

        this.logger.info('[IntelligentOptimizer] Successfully generated holistic refactoring', {
          routeKey,
          strategy: result.strategy,
          expectedImprovement: `${result.expectedImprovementPercent}%`,
        });
      }

      return result;
    } catch (err: any) {
      this.logger.warn('[IntelligentOptimizer] Holistic optimization failed', {
        routeKey,
        error: err?.message,
      });
      return {
        canOptimize: false,
        strategy: 'parallel_execution',
        explanation: `Optimization failed: ${err?.message}`,
        expectedImprovementPercent: 0,
        confidence: 0,
      };
    }
  }
}
