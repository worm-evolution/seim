import { OptimizationCandidate, SeimConfig, RouteMetrics } from './types';
import { LLMClient } from './ai';
import { EndpointTracker } from './endpointTracker';
import { LearningMemoryStore, LearningContext } from './learning';
import { CustomPatternRegistry } from './customPatternRegistry';
import { AstOptimizer } from './astOptimizer';

export class OptimizationEngine {
  private customPatterns?: CustomPatternRegistry;

  constructor(private config: SeimConfig, public llm: LLMClient) {}

  /** Attach the custom pattern registry so it runs alongside built-in patterns */
  public setCustomPatternRegistry(registry: CustomPatternRegistry): void {
    this.customPatterns = registry;
  }

  public async analyze(routeKey: string, sourceCode: string): Promise<OptimizationCandidate[]> {
    // Legacy method for backward compatibility - uses pattern-based approach
    return this.analyzeWithPatterns(routeKey, sourceCode);
  }

  public async analyzeWithMetricsCheck(
    routeKey: string, 
    sourceCode: string, 
    routeMetrics: RouteMetrics | undefined,
    endpointTracker: EndpointTracker,
    learningStore?: LearningMemoryStore,
  ): Promise<OptimizationCandidate[]> {
    const candidates: OptimizationCandidate[] = [];
    
    // Calculate current metrics for AI context
    const currentMetrics = routeMetrics ? {
      averageLatency: routeMetrics.requestCount === 0 ? 0 : routeMetrics.totalDuration / routeMetrics.requestCount,
      p95: this.calculateP95(routeMetrics.durations),
      p99: this.calculateP99(routeMetrics.durations),
      errorRate: routeMetrics.requestCount === 0 ? 0 : routeMetrics.errorCount / routeMetrics.requestCount,
      requestCount: routeMetrics.requestCount,
    } : undefined;

    // Build learning context if store is available
    const learningContext = learningStore
      ? learningStore.buildContext('ai-detected', routeKey, this.config.framework ?? 'express', sourceCode)
      : undefined;

    // Use AI-driven holistic analysis instead of pattern matching
    if (this.config.ai.enabled) {
      const analysis = await this.llm.analyzeAndOptimize(sourceCode, currentMetrics, learningContext);
      
      if (!analysis.canOptimize) {
        // AI determined no optimization needed
        endpointTracker.markAsNonOptimizable(routeKey, analysis.reason);
        return []; // No candidates
      }

      // AI found optimization opportunity
      if (analysis.optimizedCode) {
        // Calibrate confidence based on learning history
        let confidence = 0.92;
        if (learningContext) {
          confidence = learningContext.suggestedConfidence;
        }

        const candidate: OptimizationCandidate = {
          id: `${routeKey}::ai-generated::${Date.now()}`,
          routeKey,
          pattern: analysis.pattern || 'ai-detected',
          severity: 'high',
          originalCode: sourceCode,
          optimizedCode: analysis.optimizedCode,
          confidence,
          status: 'pending',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        candidates.push(candidate);
      }
    } else {
      // AI disabled, fall back to pattern-based approach
      return this.analyzeWithPatterns(routeKey, sourceCode);
    }

    return candidates;
  }

  private async analyzeWithPatterns(routeKey: string, sourceCode: string): Promise<OptimizationCandidate[]> {
    // Legacy pattern-based approach (only used when AI is disabled)
    const patterns = [
      { id: 'sequential-async', regex: /const\s+\w+\s*=\s*await\s+[^;]+;\s*\n\s*const\s+\w+\s*=\s*await\s+[^;]+;/, severity: 'high' as const },
      { id: 'n-plus-one', regex: /for\s*\([^)]*\)\s*\{[^}]*await\s+[^}]*\}/, severity: 'critical' as const },
      { id: 'missing-cache', regex: /await\s+get[^\(]*\([^\)]*\)(?!.*cache)/, severity: 'medium' as const },
      { id: 'inefficient-loop', regex: /for\s*\(let\s+\w+\s*=\s*0;\s*\w+\s*<\s*\w+\.length;\s*\w+\+\+\s*\)/, severity: 'low' as const },
      { id: 'redundant-serialization', regex: /JSON\.parse\(JSON\.stringify\(/, severity: 'medium' as const },
      { id: 'blocking-op', regex: /readFileSync\(|writeFileSync\(|execSync\(/, severity: 'high' as const },
      { id: 'nested-ternary', regex: /\?\s*[^:]+\s*:\s*[^?]+\?\s*[^:]+\s*:/, severity: 'low' as const },
      { id: 'unindexed-find', regex: /\.find\s*\(\s*\w+\s*=>/, severity: 'low' as const },
      { id: 'response-streaming', regex: /res\.json\s*\(\s*(?:await\s+)?.*\.map\s*\(/, severity: 'medium' as const },
    ];

    const candidates: OptimizationCandidate[] = [];
    const seen = new Set<string>();
    
    for (const pattern of patterns) {
      if (!pattern.regex.test(sourceCode)) continue;
      if (seen.has(pattern.id)) continue;
      seen.add(pattern.id);

      const optimized = await this.generateFix(sourceCode, pattern.id);
      if (!optimized && this.config.mode === 'bypass') continue;

      const candidate: OptimizationCandidate = {
        id: `${routeKey}::${pattern.id}::${Date.now()}`,
        routeKey,
        pattern: pattern.id,
        severity: pattern.severity,
        originalCode: sourceCode,
        optimizedCode: optimized,
        confidence: this.config.ai.enabled ? 0.92 : 0.85,
        status: 'pending',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      if (this.config.security.allowedPatternModels.includes(candidate.pattern)) {
        candidates.push(candidate);
      }
    }

    // Run developer-registered custom patterns (Feature 3)
    if (this.customPatterns && this.config.patterns?.enabled !== false) {
      const customMatches = this.customPatterns.scan(sourceCode);
      for (const { pattern: cp } of customMatches) {
        if (seen.has(cp.id)) continue;
        seen.add(cp.id);

        // Apply fixer if available
        let optimizedCode: string | undefined;
        if (cp.fixer) {
          optimizedCode = cp.fixer.fix(sourceCode) ?? undefined;
        } else if (cp.useAI && this.config.ai.enabled) {
          optimizedCode = (await this.llm.optimize(sourceCode, cp.description)) ?? undefined;
        }

        if (!optimizedCode && this.config.mode === 'bypass') continue;

        candidates.push({
          id: `${routeKey}::custom::${cp.id}::${Date.now()}`,
          routeKey,
          pattern: cp.id,
          severity: cp.severity,
          originalCode: sourceCode,
          optimizedCode,
          confidence: 0.85,
          status: 'pending',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
    }

    return candidates;
  }

  private calculateP95(durations: number[]): number {
    if (durations.length === 0) return 0;
    const sorted = [...durations].sort((a, b) => a - b);
    const index = Math.ceil((95 / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  private calculateP99(durations: number[]): number {
    if (durations.length === 0) return 0;
    const sorted = [...durations].sort((a, b) => a - b);
    const index = Math.ceil((99 / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  private async generateFix(sourceCode: string, patternId: string): Promise<string | undefined> {
    if (this.config.mode === 'restrict') return undefined;

    if (this.config.ai.enabled) {
      const body = await this.llm.optimize(sourceCode, patternId);
      if (body) return body;
    }

    // Fallback template generator
    return this.templateFix(sourceCode, patternId);
  }

  private templateFix(sourceCode: string, patternId: string): string | undefined {
    let modified = sourceCode;
    switch (patternId) {
      case 'sequential-async': {
        const astResult = AstOptimizer.optimizeSequentialAsync(sourceCode);
        if (astResult.applied) return astResult.code;
        const transformed = sourceCode.replace(
          /const\s+(\w+)\s*=\s*await\s+([^;]+);\s*\n\s*const\s+(\w+)\s*=\s*await\s+([^;]+);/,
          'const [$1, $3] = await Promise.all([$2, $4]);'
        );
        modified = transformed === sourceCode ? sourceCode : transformed;
        break;
      }
      case 'n-plus-one': {
        const astResult = AstOptimizer.optimizeNPlusOne(sourceCode);
        if (astResult.applied) return astResult.code;
        // Transform: for(...) { await fn(...) } → collect IDs then batch with Promise.all
        modified = sourceCode.replace(
          /for\s*\(([^)]*)\)\s*\{([^}]*)(await\s+(\w+)\(([^)]*)\))([^}]*)\}/,
          (_match, iterExpr, before, _awaitCall, fnName, fnArgs, after) => {
            const trimBefore = (before as string).trim();
            const trimAfter = (after as string).trim();
            const idVar = (fnArgs as string).trim().split(/\s*,\s*/)[0] || 'id';
            return [
              `// [SEIM] Batched: collect IDs first, then resolve in parallel`,
              `const __seimIds = [];`,
              `for (${iterExpr}) { ${trimBefore} __seimIds.push(${idVar}); ${trimAfter} }`,
              `const __seimResults = await Promise.all(__seimIds.map(${idVar} => ${fnName}(${fnArgs})));`,
            ].join('\n');
          }
        );
        break;
      }
      case 'missing-cache': {
        // Wrap the get* call with a simple Map cache lookup
        modified = sourceCode.replace(
          /(await\s+(get[^\(]*)\(([^\)]*)\))/,
          (_match, _fullAwait, fnName, args) => {
            return [
              `(() => {`,
              `  const __seimCacheKey = JSON.stringify([${args}]);`,
              `  if (!globalThis.__seimCache) globalThis.__seimCache = new Map();`,
              `  if (globalThis.__seimCache.has(__seimCacheKey)) return globalThis.__seimCache.get(__seimCacheKey);`,
              `  const __seimVal = await ${fnName}(${args});`,
              `  globalThis.__seimCache.set(__seimCacheKey, __seimVal);`,
              `  return __seimVal;`,
              `})()`,
            ].join('\n');
          }
        );
        break;
      }
      case 'inefficient-loop': {
        // Replace: for(let i = 0; i < arr.length; i++) → for (const item of arr)
        modified = sourceCode.replace(
          /for\s*\(\s*let\s+(\w+)\s*=\s*0;\s*\1\s*<\s*(\w+)\.length;\s*\1\+\+\s*\)/,
          'for (const item of $2)'
        );
        // Also replace arr[i] references inside the loop body with `item`
        modified = modified.replace(
          /(\w+)\[item\]/g,
          'item'
        );
        break;
      }
      case 'redundant-serialization': {
        // Replace JSON.parse(JSON.stringify(x)) with structuredClone(x)
        modified = sourceCode.replace(
          /JSON\.parse\(JSON\.stringify\(([^)]+)\)\)/g,
          'structuredClone($1)'
        );
        break;
      }
      case 'blocking-op': {
        // Replace blocking fs/child_process calls with async equivalents
        modified = sourceCode.replace(
          /readFileSync\(/g,
          `await require('fs').promises.readFile(`
        );
        modified = modified.replace(
          /writeFileSync\(/g,
          `await require('fs').promises.writeFile(`
        );
        modified = modified.replace(
          /execSync\(/g,
          `await require('child_process').exec(`
        );
        break;
      }
      case 'nested-ternary':
        // Too complex for reliable template rewrite — leave a comment
        modified = `// [SEIM] Replace nested ternary with early returns or object lookup for better readability\n` + sourceCode;
        break;
      case 'unindexed-find': {
        // Suggest using a Map for O(1) lookup instead of .find()
        modified = sourceCode.replace(
          /(\w+)\.find\s*\(\s*(\w+)\s*=>\s*\2\.(\w+)\s*===?\s*([^)]+)\)/,
          `/* [SEIM] Use a Map for O(1) lookup: const __map = new Map($1.map(o => [o.$3, o])); __map.get($4) */\n$1.find($2 => $2.$3 === $4)`
        );
        break;
      }
      case 'response-streaming': {
        // Suggest streaming large arrays instead of buffering in res.json()
        modified = `// [SEIM] Consider streaming large arrays instead of buffering:\n` +
          `// res.setHeader('Content-Type', 'application/json'); res.write('[');\n` +
          `// for (const item of data) { res.write(JSON.stringify(item) + ','); } res.end(']');\n` +
          sourceCode;
        break;
      }
      default:
        return undefined;
    }
    return this.extractFunctionBody(modified);
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
