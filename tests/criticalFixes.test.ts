import { seim } from '../src/index';
import { Sandbox } from '../src/sandbox';
import { DynamicRouter } from '../src/dynamicRouter';
import { ProductionManager } from '../src/productionManager';
import { IssueStream } from '../src/issueStream';
import { BehaviorTracker } from '../src/behaviorTracker';
import { InMemoryMetricsStore } from '../src/metrics';

describe('Critical Fixes Regression Test Suite', () => {
  describe('Fix 1: Dynamic Route Interception in Middleware', () => {
    it('should intercept and execute dynamically registered routes via listener middleware', (done) => {
      const s = seim({ mode: 'bypass', scaffolding: { enabled: true } });
      const listener = s.listener();

      // Register a dynamic route at runtime
      s.dynamicRouter.registerRoute('/api/v1/auto-generated', 'GET', (req: any, res: any) => {
        res.status(200).json({ success: true, evolved: true });
      });

      const mockReq = {
        method: 'GET',
        path: '/api/v1/auto-generated',
        url: '/api/v1/auto-generated',
        headers: {},
      };

      const mockRes: any = {
        statusCode: 200,
        status(code: number) { this.statusCode = code; return this; },
        json(data: any) {
          expect(data.success).toBe(true);
          expect(data.evolved).toBe(true);
          s.shutdown().then(done);
        },
        send(data: any) { this.json(data); },
        on: jest.fn(),
      };

      const next = jest.fn();

      listener(mockReq, mockRes, next);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('Fix 2: Sybil Resistance in IssueStream', () => {
    it('should strictly reject single-session crawler/bot spam hammering missing routes', () => {
      const tracker = new BehaviorTracker();
      const metrics = new InMemoryMetricsStore();
      const events: any = { emitEvent: jest.fn(), emit: jest.fn() };
      const logger: any = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

      const issueStream = new IssueStream(
        tracker,
        metrics,
        { behavior: { minIssueSessionThreshold: 3, minPatternFrequency: 3 } } as any,
        events,
        logger
      );

      // Single bot session hammering 10 times
      for (let i = 0; i < 10; i++) {
        tracker.record({
          sessionId: 'single_bot_session',
          type: 'error_404',
          path: '/api/v1/random-probe',
          method: 'GET',
          statusCode: 404,
          timestamp: Date.now(),
        });
      }

      const issues = issueStream.scanAndEmit();
      const botIssue = issues.find(i => i.path === '/api/v1/random-probe');
      expect(botIssue).toBeUndefined(); // Sybil filter blocked single session bot

      // Multi-session legitimate traffic (3 distinct sessions)
      for (let i = 1; i <= 3; i++) {
        tracker.record({
          sessionId: `legit_user_${i}`,
          type: 'error_404',
          path: '/api/v1/real-feature',
          method: 'GET',
          statusCode: 404,
          timestamp: Date.now(),
        });
      }

      const updatedIssues = issueStream.scanAndEmit();
      const legitIssue = updatedIssues.find(i => i.path === '/api/v1/real-feature');
      expect(legitIssue).toBeDefined();
      expect(legitIssue?.affectedSessions).toBe(3);

      tracker.destroy();
      issueStream.destroy();
    });
  });

  describe('Fix 3: Sandbox runVm Execution Safety', () => {
    it('should execute full async function handler declarations with comments and trailing semicolons', async () => {
      const sandbox = new Sandbox();

      const codeWithComments = `
        // AI Generated route handler with inner helper
        async function handler(req, res) {
          function calculate() { return 42; }
          res.status(200).json({ answer: calculate() });
        };
      `;

      let responseData: any = null;
      const mockReq: any = { method: 'GET', url: '/test', body: {}, params: {}, query: {}, headers: {} };
      const mockRes: any = {
        statusCode: 200,
        status(code: number) { this.statusCode = code; return this; },
        json(data: any) { responseData = data; return this; },
        send(data: any) { responseData = data; return this; },
        end() {},
      };

      await sandbox.run(codeWithComments, '', mockReq, mockRes, () => {}, 1000);
      expect(responseData).toEqual({ answer: 42 });
    });
  });

  describe('Fix 5: DynamicRouter Parameterized Path Normalization', () => {
    it('should match dynamic paths against normalized route definitions', () => {
      const productionManager = new ProductionManager({} as any);
      const router = new DynamicRouter(productionManager);

      const handler: any = (req: any, res: any) => res.json({ id: req.params.id });

      // Register route as :id
      router.registerRoute('/api/users/:id', 'GET', handler);

      expect(router.hasHandler('GET /api/users/:id')).toBe(true);
      expect(router.hasHandler('GET /api/users/12345')).toBe(true);
      expect(router.hasHandler('GET /api/users/507f1f77bcf86cd799439011')).toBe(true);

      const matchedHandler = router.getHandler('GET /api/users/12345');
      expect(matchedHandler).toBe(handler);
    });
  });
});
