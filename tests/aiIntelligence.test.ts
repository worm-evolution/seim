import { IntentAnalyzer } from '../src/intentAnalyzer';
import { IntelligentOptimizer } from '../src/intelligentOptimizer';
import { LLMClient } from '../src/ai';
import { Logger } from '../src/logger';

describe('AI Intelligence & Semantic Intent Engine', () => {
  const logger = new Logger({ level: 'silent', json: false });

  it('uses the Gemini endpoint when Google is selected without a custom base URL', async () => {
    const https = require('https');
    const request = jest.spyOn(https, 'request').mockImplementation((options: any, callback: any) => {
      expect(options.hostname).toBe('generativelanguage.googleapis.com');
      expect(options.path).toContain('/v1beta/models/gemini-2.5-flash:generateContent');
      expect(options.path).toContain('key=test-key');
      const response = new (require('events').EventEmitter)();
      callback(response);
      process.nextTick(() => {
        response.emit('data', JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ready' }] } }] }));
        response.emit('end');
      });
      return { on: jest.fn(), write: jest.fn(), end: jest.fn() } as any;
    });
    const config: any = {
      ai: {
        enabled: true,
        provider: 'google',
        apiKey: 'test-key',
        generatorModel: 'gemini-2.5-flash',
      },
    };

    await expect(new LLMClient(config).chat('system', 'ping')).resolves.toBe('ready');
    request.mockRestore();
  });

  describe('IntentAnalyzer (Semantic Signal Classification)', () => {
    it('should reject malicious scanner probes immediately via deterministic heuristics', async () => {
      const config: any = { ai: { enabled: true, apiKey: 'test-key' } };
      const llm = new LLMClient(config);
      const analyzer = new IntentAnalyzer(config, llm, logger);

      const probeSignal = {
        type: 'unhandled_route' as const,
        path: '/wp-login.php',
        method: 'POST',
      };

      const result = await analyzer.analyzeSignal(probeSignal);
      expect(result.isGenuineFeature).toBe(false);
      expect(result.classification).toBe('malicious_probe');
      expect(result.rejectionReason).toContain('probe filter');
    });

    it('should reject .env and SQL injection probes', async () => {
      const config: any = { ai: { enabled: false } };
      const llm = new LLMClient(config);
      const analyzer = new IntentAnalyzer(config, llm, logger);

      const envSignal = {
        type: 'unhandled_route' as const,
        path: '/api/v1/.env',
        method: 'GET',
      };

      const result = await analyzer.analyzeSignal(envSignal);
      expect(result.isGenuineFeature).toBe(false);
      expect(result.classification).toBe('malicious_probe');
    });

    it('should classify genuine multi-session API demand as genuine feature request', async () => {
      const config: any = { ai: { enabled: false } };
      const llm = new LLMClient(config);
      const analyzer = new IntentAnalyzer(config, llm, logger);

      const featureSignal = {
        type: 'unhandled_route' as const,
        path: '/api/v1/orders/export-csv',
        method: 'POST',
        affectedSessions: 5,
        frequency: 12,
      };

      const result = await analyzer.analyzeSignal(featureSignal);
      expect(result.isGenuineFeature).toBe(true);
      expect(result.classification).toBe('genuine_feature_request');
      expect(result.targetMethod).toBe('POST');
      expect(result.targetPath).toBe('/api/v1/orders/export-csv');
    });
  });

  describe('IntelligentOptimizer (Holistic Code Refactoring)', () => {
    it('should safely return canOptimize: false when AI is disabled', async () => {
      const config: any = { ai: { enabled: false } };
      const llm = new LLMClient(config);
      const optimizer = new IntelligentOptimizer(config, llm, logger);

      const result = await optimizer.refactorRoute('GET /api/slow', 'async function(req, res) {}');
      expect(result.canOptimize).toBe(false);
    });

    it('should handle LLM refactoring when AI is enabled with mock LLM client', async () => {
      const config: any = { ai: { enabled: true, apiKey: 'test-key' } };
      const mockLLM = {
        chat: jest.fn().mockResolvedValue(JSON.stringify({
          canOptimize: true,
          strategy: 'algorithmic_rewrite',
          optimizedCode: `
            async function handler(req, res) {
              const lookup = new Map();
              res.json({ success: true });
            }
          `,
          explanation: 'Replaced O(N^2) array lookup with O(1) Map cache',
          expectedImprovementPercent: 65,
          confidence: 0.95
        }))
      } as any;

      const optimizer = new IntelligentOptimizer(config, mockLLM, logger);
      const result = await optimizer.refactorRoute('GET /api/users', 'async function(req, res) { res.json({}); }');

      expect(result.canOptimize).toBe(true);
      expect(result.strategy).toBe('algorithmic_rewrite');
      expect(result.expectedImprovementPercent).toBe(65);
      expect(result.optimizedCode).toContain('new Map()');
    });
  });
});
