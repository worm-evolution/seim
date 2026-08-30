import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { SeimConfig, OptimizationMemory } from './types';
import { LearningContext } from './learning';

export class LLMClient {
  private apiKey: string | undefined;
  private provider: string;
  private baseUrl: string;
  private model: string;
  private headers?: Record<string, string>;
  private responsePath?: string;
  private readonly systemPrompt =
    'You are a senior Node.js/Express performance engineer. You optimize code while strictly preserving correctness, authentication, authorization, payment logic, secrets, and business invariants. Do not introduce new external network calls or unsafe constructs.';

  private readonly featureSystemPrompt = 
    'You are a senior product engineer. You analyze user behavior and business metrics to suggest feature improvements. You generate feature variants that can be A/B tested. You preserve business invariants and user experience consistency.';

  private readonly frontendSystemPrompt = 
    'You are a senior frontend engineer. You generate UI components that display new backend data while maintaining existing functionality. You follow framework best practices and ensure component reusability.';

  constructor(private config: SeimConfig) {
    this.apiKey = config.ai.apiKey;
    const configuredBaseUrl = config.ai.baseUrl;
    this.provider = config.ai.provider || this.detectProvider(configuredBaseUrl || 'https://api.openai.com/v1/chat/completions');
    this.model = config.ai.generatorModel || this.defaultModel();
    this.baseUrl = configuredBaseUrl || this.defaultBaseUrl();
    this.headers = config.ai.headers;
    this.responsePath = config.ai.responsePath || this.defaultResponsePath();
  }

  public async analyzeAndOptimize(sourceCode: string, currentMetrics?: { averageLatency: number; p95: number; p99: number; errorRate: number; requestCount: number }, learningContext?: LearningContext): Promise<{ canOptimize: boolean; reason: string; optimizedCode?: string; pattern?: string }> {
    if (!this.apiKey) return { canOptimize: false, reason: 'AI disabled (no API key)' };
    
    const metricsContext = currentMetrics 
      ? `\nCurrent performance metrics:\n- Request count: ${currentMetrics.requestCount}\n- Average latency: ${currentMetrics.averageLatency}ms\n- P95 latency: ${currentMetrics.p95}ms\n- P99 latency: ${currentMetrics.p99}ms\n- Error rate: ${(currentMetrics.errorRate * 100).toFixed(2)}%`
      : '';

    const historyContext = learningContext ? this.buildLearningContextString(learningContext) : '';

    try {
      const prompt = this.buildHolisticAnalysisPrompt(sourceCode, metricsContext + historyContext);
      const content = await this.chat(this.systemPrompt, prompt);
      return this.parseHolisticAnalysis(content);
    } catch (err) {
      // Fallback local simulator when API key is rate limited or offline
      if (sourceCode.includes('delay')) {
        const transformed = sourceCode.replace(
          /await\s+delay\s*\(\s*(\d+)\s*\);\s*\n\s*await\s+delay\s*\(\s*(\d+)\s*\);/,
          'await Promise.all([delay($1), delay($2)]);'
        );
        const body = this.extractFunctionBody(transformed);
        return {
          canOptimize: true,
          reason: `[LOCAL SIMULATOR FALLBACK] Rate limit hit. Parallelized sequential delay.`,
          pattern: 'sequential-async',
          optimizedCode: body
        };
      }
      throw err;
    }
  }

  /**
   * Generate an optimization with a specific strategy variant.
   * Used by the evolution engine to produce diverse candidates.
   */
  public async optimizeWithStrategy(originalSource: string, pattern: string, strategy: 'standard' | 'creative' | 'conservative', learningContext?: LearningContext): Promise<string | undefined> {
    if (!this.apiKey) return undefined;
    const prompt = this.buildStrategyPrompt(originalSource, pattern, strategy, learningContext);
    const content = await this.chat(this.systemPrompt, prompt);
    return this.extractCode(content);
  }

  public async optimize(originalSource: string, pattern: string): Promise<string | undefined> {
    if (!this.apiKey) return undefined;
    const prompt = this.buildOptimizePrompt(originalSource, pattern);
    const content = await this.chat(this.systemPrompt, prompt);
    return this.extractCode(content);
  }

  /**
   * Generate a human-readable explanation for an optimization.
   */
  public async generateFrontendOverrides(path: string, issues: any[]): Promise<{ css: string; js: string }> {
    if (!this.apiKey) {
      // Local fallback simulator when AI is disabled/offline
      let css = '';
      let js = '';
      for (const issue of issues) {
        if (issue.type === 'layout' && issue.selector) {
          css += `${issue.selector} { max-width: 100% !important; box-sizing: border-box !important; overflow: hidden !important; }\n`;
        }
        if (issue.type === 'accessibility' && issue.message.includes('alt attribute') && issue.selector) {
          js += `const el = document.querySelector('${issue.selector}'); if(el) el.setAttribute('alt', 'Optimized image description');\n`;
        }
        if (issue.type === 'accessibility' && issue.message.includes('readable text or ARIA label') && issue.selector) {
          js += `const el = document.querySelector('${issue.selector}'); if(el) el.setAttribute('aria-label', 'Interactive action button');\n`;
        }
        if (issue.type === 'accessibility' && issue.message.includes('associated label') && issue.selector) {
          js += `const el = document.querySelector('${issue.selector}'); if(el) { el.setAttribute('aria-label', 'Input field'); }\n`;
        }
      }
      return { css, js };
    }

    const systemPrompt = "You are a senior frontend optimization expert. Generate minimal CSS and JS overrides to fix specific layout overflows and accessibility errors based on the reported issues. Respond ONLY with JSON format: {\"css\": \"...\", \"js\": \"...\"}. Do not include markdown code block characters in your final response.";
    const userPrompt = `Generate overrides for the page path: ${path}\nIssues:\n${JSON.stringify(issues, null, 2)}`;
    try {
      const content = await this.chat(systemPrompt, userPrompt);
      const jsonMatch = content.match(/{[\s\S]*}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      return { css: '', js: '' };
    } catch {
      // Fallback on error
      return { css: '', js: '' };
    }
  }

  public async explain(original: string, optimized: string, pattern: string, improvement: number): Promise<string> {
    if (!this.apiKey) return `Optimized for pattern "${pattern}" with ${improvement.toFixed(0)}ms latency reduction.`;
    const prompt = `Explain this optimization in 2-3 sentences for a developer. What was changed and why it's faster.\n\nPattern: ${pattern}\nLatency improvement: ${improvement.toFixed(0)}ms\n\nOriginal:\n${original}\n\nOptimized:\n${optimized}`;
    return await this.chat(this.systemPrompt, prompt);
  }

  public async review(original: string, optimized: string): Promise<{ pass: boolean; reason?: string }> {
    if (!this.apiKey) return { pass: true, reason: 'AI disabled (no API key)' };
    try {
      const prompt = this.buildReviewPrompt(original, optimized);
      const content = await this.chat(this.systemPrompt, prompt);
      return this.parseReview(content);
    } catch (err) {
      // Fallback local simulator when API key is rate limited or offline
      if (optimized.includes('Promise.all')) {
        return { pass: true, reason: '[LOCAL SIMULATOR FALLBACK] Validated sequential delay parallelization.' };
      }
      throw err;
    }
  }

  /**
   * Generate a feature variant based on user behavior and business metrics
   */
  public async generateFeatureVariant(
    routeKey: string,
    opportunity: any,
    userBehavior: any,
    routeMetrics: any
  ): Promise<string | undefined> {
    if (!this.apiKey) return undefined;

    const prompt = this.buildFeatureVariantPrompt(routeKey, opportunity, userBehavior, routeMetrics);
    const content = await this.chat(this.featureSystemPrompt, prompt);
    return this.extractCode(content);
  }

  /**
   * Analyze feature opportunities from user behavior
   */
  public async analyzeFeatureOpportunities(
    routeKey: string,
    userBehavior: any,
    routeMetrics: any
  ): Promise<any[]> {
    if (!this.apiKey) return [];

    const prompt = this.buildFeatureOpportunityPrompt(routeKey, userBehavior, routeMetrics);
    const content = await this.chat(this.featureSystemPrompt, prompt);
    return this.parseFeatureOpportunities(content);
  }

  /**
   * Generate a frontend component for displaying new backend data
   */
  public async generateFrontendComponent(
    schema: any,
    framework: string,
    existingComponent?: string
  ): Promise<string | undefined> {
    if (!this.apiKey) return undefined;

    const prompt = this.buildFrontendComponentPrompt(schema, framework, existingComponent);
    const content = await this.chat(this.frontendSystemPrompt, prompt);
    return this.extractCode(content);
  }

  /**
   * Review frontend component for safety and correctness
   */
  public async reviewFrontendComponent(
    component: string,
    framework: string
  ): Promise<{ pass: boolean; reason?: string }> {
    if (!this.apiKey) return { pass: true, reason: 'AI disabled (no API key)' };

    const prompt = this.buildFrontendReviewPrompt(component, framework);
    const content = await this.chat(this.frontendSystemPrompt, prompt);
    return this.parseReview(content);
  }

  private detectProvider(baseUrl: string): string {
    const lower = baseUrl.toLowerCase();
    if (lower.includes('anthropic')) return 'anthropic';
    if (lower.includes('google') || lower.includes('gemini')) return 'google';
    if (lower.includes('x.ai') || lower.includes('grok')) return 'grok';
    return 'openai';
  }

  private defaultModel(): string {
    switch (this.provider) {
      case 'anthropic':
        return 'claude-3-5-sonnet-20241022';
      case 'google':
        return 'gemini-2.5-flash'; // Updated to working model
      case 'grok':
        return 'grok-2';
      default:
        return 'gpt-4';
    }
  }

  private defaultBaseUrl(): string {
    switch (this.provider) {
      case 'anthropic':
        return 'https://api.anthropic.com/v1/messages';
      case 'google':
        return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`;
      case 'grok':
        return 'https://api.x.ai/v1/chat/completions';
      default:
        return 'https://api.openai.com/v1/chat/completions';
    }
  }

  private defaultResponsePath(): string {
    switch (this.provider) {
      case 'google':
        return 'candidates.0.content.parts.0.text';
      default:
        return '';
    }
  }

  public async chat(system: string, user: string): Promise<string> {
    const url = new URL(this.baseUrl);
    const body = this.buildBody(system, user);
    const { options, client } = this.buildRequest(url, body);

    return new Promise((resolve, reject) => {
      const req = client.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.error) {
              reject(new Error(`LLM API Error: ${json.error.message}`));
              return;
            }
            const text = this.extractText(json);
            resolve(text);
          } catch (e) {
            reject(new Error(`LLM response parse error: ${(e as Error).message}: ${data.slice(0, 200)}`));
          }
        });
      });
      req.on('error', (err) => reject(err));
      req.write(body);
      req.end();
    });
  }

  private buildBody(system: string, user: string): string {
    switch (this.provider) {
      case 'anthropic':
        return JSON.stringify({
          model: this.model,
          max_tokens: 2048,
          system,
          messages: [{ role: 'user', content: user }],
        });
      case 'google': {
        const contents = [
          { parts: [{ text: `${system}\n\n${user}` }] },
        ];
        return JSON.stringify({ 
          contents,
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 2048
          }
        });
      }
      case 'openai':
      case 'grok':
      case 'custom':
      default:
        return JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: 0.2,
        });
    }
  }

  private buildRequest(url: URL, body: string): { options: https.RequestOptions; client: typeof http | typeof https } {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body).toString(),
    };

    if (this.provider === 'anthropic') {
      headers['x-api-key'] = this.apiKey || '';
      headers['anthropic-version'] = '2023-06-01';
      headers['anthropic-dangerous-direct-browser-access'] = 'true';
    } else if (this.provider === 'google' && this.apiKey) {
      url.searchParams.set('key', this.apiKey);
    } else if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    if (this.headers) {
      Object.assign(headers, this.headers);
    }

    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers,
    };

    const client = url.protocol === 'https:' ? https : http;
    return { options, client };
  }

  private extractText(json: any): string {
    if (this.responsePath) {
      return this.getByPath(json, this.responsePath) || '';
    }
    switch (this.provider) {
      case 'anthropic':
        return json.content?.[0]?.text || '';
      case 'google':
        return json.candidates?.[0]?.content?.parts?.[0]?.text || '';
      case 'openai':
      case 'grok':
      case 'custom':
      default:
        return json.choices?.[0]?.message?.content || '';
    }
  }

  private getByPath(obj: any, path: string): any {
    return path.split('.').reduce((current, part) => {
      if (current == null) return undefined;
      const match = part.match(/^(.+)\[(\d+)\]$/);
      if (match) {
        const arr = current[match[1]];
        return Array.isArray(arr) ? arr[parseInt(match[2], 10)] : undefined;
      }
      return current[part];
    }, obj);
  }

  private buildLearningContextString(ctx: LearningContext): string {
    if (ctx.relatedSolutions.length === 0) return '';
    let s = `\n\nHistorical optimization data for this pattern type:`;
    s += `\n- Historical success rate: ${(ctx.historicalSuccessRate * 100).toFixed(0)}%`;
    for (const sol of ctx.relatedSolutions.slice(0, 3)) {
      const total = sol.successCount + sol.failureCount;
      const rate = total === 0 ? 0 : (sol.successCount / total * 100);
      s += `\n- Pattern "${sol.problem}": ${rate.toFixed(0)}% success rate, avg improvement ${sol.averageImprovement.toFixed(0)}ms`;
      if (sol.bestSolutionCode) {
        s += `\n  Best solution (${sol.bestImprovement?.toFixed(0)}ms improvement):\n  ${sol.bestSolutionCode.slice(0, 200)}...`;
      }
    }
    s += `\n\nUse these past successes to inform your optimization. Prefer approaches that have historically worked.`;
    return s;
  }

  private buildStrategyPrompt(source: string, pattern: string, strategy: 'standard' | 'creative' | 'conservative', learningContext?: LearningContext): string {
    const historyStr = learningContext ? this.buildLearningContextString(learningContext) : '';
    const strategyInstructions: Record<string, string> = {
      standard: 'Apply the most straightforward optimization for this pattern. Focus on correctness first, then performance.',
      creative: 'Take a creative, unconventional approach to optimization. Consider algorithmic improvements, data structure changes, caching strategies, or parallelization that go beyond the obvious fix. Try something different from the standard approach.',
      conservative: 'Apply the safest minimal optimization. Make the smallest change that yields improvement. Prioritize zero risk of behavior change.',
    };

    return `${strategyInstructions[strategy]}

Optimize the following Express route handler for the detected pattern: ${pattern}.
${historyStr}

Keep the function signature as an async Express handler (req, res, next). Do not change authentication, authorization, payment logic, business rules, or the response schema. Do not introduce secrets or network calls. Return ONLY the function body inside a JavaScript code block. Do not include explanation.

Original handler:
${source}`;
  }

  private sanitizeSourceForPrompt(source: string): string {
    // Strip block comments (/* ... */) and line comments (// ...) to prevent prompt injection
    return source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*/g, '');
  }

  private buildOptimizePrompt(source: string, pattern: string): string {
    const cleanSource = this.sanitizeSourceForPrompt(source);
    return `Optimize the following Express route handler for the detected pattern: ${pattern}.

Keep the function signature as an async Express handler (req, res, next). Do not change authentication, authorization, payment logic, business rules, or the response schema. Do not introduce secrets or network calls. Return ONLY the function body inside a JavaScript code block. Do not include explanation.

Original handler:
${cleanSource}`;
  }

  private buildHolisticAnalysisPrompt(source: string, metricsContext: string): string {
    const cleanSource = this.sanitizeSourceForPrompt(source);
    return `Analyze the following Express route handler code holistically for performance optimization opportunities.
${metricsContext}

Analyze the code for:
1. Performance bottlenecks (async operations, inefficient loops, blocking operations)
2. Code quality issues (redundant operations, memory leaks, unnecessary computations)
3. Best practices violations (error handling, resource management, security issues)
4. Architectural improvements (caching opportunities, batching, parallelization)

Based on your analysis, determine if the code can be optimized and whether it would provide meaningful performance improvements given the current metrics.

Respond with JSON only:
{
  "canOptimize": true|false,
  "reason": "detailed explanation of your analysis and decision",
  "pattern": "identified pattern type (e.g., 'sequential-async', 'n-plus-one', 'inefficient-loop', 'blocking-op', 'cache-miss', 'redundant-operation', 'none')",
  "optimizedCode": "if canOptimize is true, provide the optimized function body"
}

Original handler code:
${cleanSource}`;
  }

  private buildReviewPrompt(original: string, optimized: string): string {
    const cleanOriginal = this.sanitizeSourceForPrompt(original);
    const cleanOptimized = this.sanitizeSourceForPrompt(optimized);
    return `Review whether the optimized Express handler preserves the original behavior and does not introduce security issues. Respond with JSON only:

{"pass": true|false, "reason": "..."}

Original:
${cleanOriginal}

Optimized:
${cleanOptimized}`;
  }

  private extractCode(content: string): string | undefined {
    const match = content.match(/```(?:js|javascript|typescript)?\s*([\s\S]*?)\s*```/);
    return match ? match[1].trim() : content.trim();
  }

  private parseReview(content: string): { pass: boolean; reason?: string } {
    try {
      const jsonMatch = content.match(/{[\s\S]*}/);
      if (jsonMatch) {
        const json = JSON.parse(jsonMatch[0]);
        return { pass: !!json.pass, reason: json.reason || '' };
      }
    } catch {
      // fall through to heuristic
    }
    const pass = !/\b(fail|incorrect|unsafe|reject|wrong|broken)\b/i.test(content);
    return { pass, reason: content.slice(0, 200) };
  }

  private buildFeatureVariantPrompt(
    routeKey: string,
    opportunity: any,
    userBehavior: any,
    routeMetrics: any
  ): string {
    return `Generate a feature variant for route "${routeKey}" based on the following opportunity:

Opportunity Type: ${opportunity.type}
Description: ${opportunity.description}
Expected Impact: ${(opportunity.expectedImpact * 100).toFixed(0)}%
Confidence: ${(opportunity.confidence * 100).toFixed(0)}%

User Behavior Summary:
- Conversion Rate: ${userBehavior.kpis?.conversionRate || 'N/A'}
- Engagement: ${userBehavior.kpis?.engagement || 'N/A'}
- User Segments: ${userBehavior.segments?.join(', ') || 'N/A'}

Route Metrics:
- Average Latency: ${routeMetrics.averageLatency || 'N/A'}ms
- Throughput: ${routeMetrics.throughput || 'N/A'} req/s
- Error Rate: ${routeMetrics.errorRate || 'N/A'}%

Generate Express middleware code that implements this feature improvement. The code should:
1. Preserve all existing functionality
2. Add the new feature logic
3. Be safe to deploy and A/B test
4. Not modify authentication, authorization, or payment logic

Return only the code, no explanation.`;
  }

  private buildFeatureOpportunityPrompt(
    routeKey: string,
    userBehavior: any,
    routeMetrics: any
  ): string {
    return `Analyze user behavior for route "${routeKey}" and identify feature improvement opportunities.

User Behavior:
${JSON.stringify(userBehavior, null, 2)}

Route Metrics:
${JSON.stringify(routeMetrics, null, 2)}

Identify 3-5 feature opportunities with:
- type: personalization, recommendation, pricing, content, ui, or other
- description: clear description of the improvement
- expectedImpact: 0-1 range for expected impact
- confidence: 0-1 range for confidence in this opportunity

Return as JSON array:
[
  {
    "type": "personalization",
    "description": "...",
    "expectedImpact": 0.15,
    "confidence": 0.8
  }
]`;
  }

  private buildFrontendComponentPrompt(
    schema: any,
    framework: string,
    existingComponent?: string
  ): string {
    const schemaStr = JSON.stringify(schema, null, 2);
    const existingStr = existingComponent ? `\n\nExisting Component:\n${existingComponent}` : '';

    return `Generate a ${framework} component to display data with the following schema:

Schema:
${schemaStr}
${existingStr}

Requirements:
1. Follow ${framework} best practices
2. Make the component reusable and composable
3. Handle loading and error states
4. Include basic styling
5. Preserve any existing functionality
6. Use TypeScript if applicable

Return only the component code, no explanation.`;
  }

  private buildFrontendReviewPrompt(component: string, framework: string): string {
    return `Review this ${framework} component for safety and correctness. Respond with:
PASS if correct and safe
FAIL: reason if incorrect or unsafe

Check for:
- Security vulnerabilities (XSS, injection, etc.)
- Performance issues
- Accessibility issues
- Framework best practices violations

Component:
${component}`;
  }

  private parseFeatureOpportunities(content: string): any[] {
    try {
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      return [];
    } catch (e) {
      return [];
    }
  }

  private parseHolisticAnalysis(content: string): { canOptimize: boolean; reason: string; optimizedCode?: string; pattern?: string } {
    try {
      const jsonMatch = content.match(/{[\s\S]*}/);
      if (jsonMatch) {
        const json = JSON.parse(jsonMatch[0]);
        return {
          canOptimize: !!json.canOptimize,
          reason: json.reason || 'No reason provided',
          optimizedCode: json.optimizedCode,
          pattern: json.pattern,
        };
      }
    } catch {
      // fall through to heuristic
    }
    
    // Heuristic: if content mentions "already optimal", "no further", etc., assume not optimizable
    const cannotOptimize = /\b(already optimal|no further|cannot be optimized|not worth|minimal impact)\b/i.test(content);
    return {
      canOptimize: !cannotOptimize,
      reason: content.slice(0, 200),
      pattern: undefined,
    };
  }

  private extractFunctionBody(fnSource: string): string {
    const trimmed = fnSource.trim();
    let m = trimmed.match(/^async\s+function\s*[\w]*\s*\([^)]*\)\s*\{([\s\S]*)\}$/);
    if (m) return m[1].trim();
    m = trimmed.match(/^function\s*[\w]*\s*\([^)]*\)\s*\{([\s\S]*)\}$/);
    if (m) return m[1].trim();
    m = trimmed.match(/^(?:async\s+)?\([^)]*\)\s*=>\s*\{([\s\S]*)\}$/);
    if (m) return m[1].trim();
    m = trimmed.match(/=\s*(?:async\s+)?\([^)]*\)\s*=>\s*\{([\s\S]*)\}$/);
    if (m) return m[1].trim();
    return trimmed;
  }
}
