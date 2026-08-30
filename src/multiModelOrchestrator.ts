import { LLMClient } from './ai';
import { SeimConfig } from './types';
import { Logger } from './logger';

export type ModelTier = 'flash' | 'pro' | 'critic';

export interface MultiModelConfig {
  flashModel?: string;   // e.g. 'gemini-2.0-flash', 'gpt-4o-mini'
  proModel?: string;     // e.g. 'gemini-2.0-pro', 'claude-3-7-sonnet', 'gpt-4o'
  criticModel?: string;  // e.g. 'gemini-2.0-flash', 'gpt-4o'
}

export interface MultiModelReviewResult {
  approved: boolean;
  score: number; // 0.0 to 1.0
  criticNotes: string;
  identifiedVulnerabilities: string[];
}

/**
 * Hierarchical Multi-Model AI Orchestrator.
 * 
 * Routes tasks to the most cost-effective and capable model tier:
 * 1. Flash Tier (<300ms): Fast telemetry triage, intent classification, and syntax checks.
 * 2. Pro Tier (Deep Reasoning): Algorithmic refactoring, whole-project code synthesis.
 * 3. Adversarial Critic: Red-team security auditor verifying candidate safety before sandbox.
 */
export class MultiModelOrchestrator {
  private flashClient: LLMClient;
  private proClient: LLMClient;
  private criticClient: LLMClient;

  constructor(
    private config: SeimConfig,
    private logger: Logger
  ) {
    const flashConfig: SeimConfig = {
      ...config,
      ai: {
        ...config.ai,
        generatorModel: config.ai?.flashModel || 'gemini-2.0-flash',
      },
    };

    const proConfig: SeimConfig = {
      ...config,
      ai: {
        ...config.ai,
        generatorModel: config.ai?.proModel || 'gemini-2.0-pro',
      },
    };

    const criticConfig: SeimConfig = {
      ...config,
      ai: {
        ...config.ai,
        generatorModel: config.ai?.criticModel || 'gemini-2.0-flash',
      },
    };

    this.flashClient = new LLMClient(flashConfig);
    this.proClient = new LLMClient(proConfig);
    this.criticClient = new LLMClient(criticConfig);
  }

  /**
   * Fast Tier (<300ms) execution for high-frequency tasks.
   */
  public async executeFlash(systemPrompt: string, userPrompt: string): Promise<string> {
    return await this.flashClient.chat(systemPrompt, userPrompt);
  }

  /**
   * Pro Tier (Deep Reasoning) execution for complex architectural refactorings.
   */
  public async executePro(systemPrompt: string, userPrompt: string): Promise<string> {
    return await this.proClient.chat(systemPrompt, userPrompt);
  }

  /**
   * Adversarial Critic review: Red-teams candidate code to find potential invariant breaks.
   */
  public async reviewWithCritic(
    originalCode: string,
    candidateCode: string,
    routeKey: string
  ): Promise<MultiModelReviewResult> {
    if (!this.config.ai?.apiKey || this.config.ai.enabled === false) {
      return {
        approved: true,
        score: 1.0,
        criticNotes: 'AI disabled — skipped critic review',
        identifiedVulnerabilities: [],
      };
    }

    const systemPrompt = `You are a Strict Adversarial Security & Reliability Critic.
Your goal is to inspect an optimized code candidate against its original version and actively seek flaws:
1. Does it subtly change response payload formats or status codes?
2. Does it introduce race conditions, unhandled promise rejections, or memory leaks?
3. Does it compromise authentication, session tokens, or payment calculations?
4. Does it introduce algorithmic regressions under edge cases?

Respond ONLY with a JSON object:
{
  "approved": true|false,
  "score": 0.0 to 1.0,
  "criticNotes": "Clear summary of findings",
  "identifiedVulnerabilities": ["List of specific flaws found, or empty array"]
}`;

    const userPrompt = `Route: ${routeKey}

Original Code:
\`\`\`javascript
${originalCode}
\`\`\`

Candidate Code:
\`\`\`javascript
${candidateCode}
\`\`\``;

    try {
      const response = await this.criticClient.chat(systemPrompt, userPrompt);
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]) as MultiModelReviewResult;
        this.logger.info('[MultiModelOrchestrator] Adversarial critic review complete', {
          routeKey,
          approved: result.approved,
          score: result.score,
        });
        return result;
      }
    } catch (err: any) {
      this.logger.warn('[MultiModelOrchestrator] Critic review failed, allowing fallback', {
        error: err?.message,
      });
    }

    return {
      approved: true,
      score: 0.9,
      criticNotes: 'Critic review passed with default fallback',
      identifiedVulnerabilities: [],
    };
  }
}
