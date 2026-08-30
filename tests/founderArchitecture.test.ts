import { RuntimeOptimizer } from '../src/runtimeOptimizer';
import { AstOptimizer } from '../src/astOptimizer';
import { createAuthGuard } from '../src/auth';
import { ShadowTestEngine } from '../src/shadow';
import { FileStorageAdapter } from '../src/persistentVersionManager';
import * as path from 'path';
import * as fs from 'fs';

describe('Founder Enterprise Architecture Tests', () => {
  describe('1. Scope & Closure Preservation (RuntimeOptimizer)', () => {
    it('should preserve external database and lexical closure variables without ReferenceError', async () => {
      // Simulate real-world external database pool / closure
      const mockDatabasePool = {
        queryCount: 0,
        async fetchUser(id: string) {
          this.queryCount++;
          return { id, name: 'Alice', plan: 'Enterprise' };
        }
      };

      // Real-world route handler capturing external lexical scope
      const routeHandler = async (req: any, res: any) => {
        const user = await mockDatabasePool.fetchUser(req.query.id);
        res.status(200).json({ user });
      };

      // Decorate with SEIM RuntimeOptimizer
      const optimizedHandler = RuntimeOptimizer.wrapWithCache(routeHandler, { ttlMs: 5000 });

      let resOutput: any = null;
      let statusCode = 200;
      let headers: Record<string, string> = {};

      const createMockRes = () => ({
        status(code: number) { statusCode = code; return this; },
        setHeader(k: string, v: string) { headers[k] = v; },
        getHeaders() { return headers; },
        send(data: any) { resOutput = data; },
        json(data: any) { resOutput = data; },
      });

      const mockReq: any = { method: 'GET', path: '/api/user', query: { id: 'u123' }, url: '/api/user?id=u123' };

      // First call (Cache MISS)
      await optimizedHandler(mockReq, createMockRes() as any, () => {});
      expect(resOutput).toEqual({ user: { id: 'u123', name: 'Alice', plan: 'Enterprise' } });
      expect(mockDatabasePool.queryCount).toBe(1);
      expect(headers['X-SEIM-Cache']).toBe('MISS');

      // Second call (Cache HIT - zero DB queries, 100% closure intact)
      await optimizedHandler(mockReq, createMockRes() as any, () => {});
      expect(resOutput).toEqual({ user: { id: 'u123', name: 'Alice', plan: 'Enterprise' } });
      expect(mockDatabasePool.queryCount).toBe(1); // No new DB query
      expect(headers['X-SEIM-Cache']).toBe('HIT');
    });
  });

  describe('2. AST Code Transformation (Destructuring & Loops)', () => {
    it('should transform sequential await with object destructuring into Promise.all', () => {
      const code = `
        const { data: user } = await fetchUser(req.params.id);
        const [ orders, settings ] = await fetchOrdersAndSettings(user.id);
        res.json({ user, orders, settings });
      `;

      const result = AstOptimizer.optimizeSequentialAsync(code);
      expect(result.applied).toBe(true);
      expect(result.code).toContain('Promise.all');
      expect(result.code).toContain('const [{ data: user }, [ orders, settings ]] = await Promise.all');
      expect(AstOptimizer.validateSyntax(result.code)).toBe(true);
    });

    it('should transform N+1 for-of loop into Promise.all(map)', () => {
      const code = `
        for (const item of items) {
          const detail = await fetchDetail(item.id);
        }
      `;

      const result = AstOptimizer.optimizeNPlusOne(code);
      expect(result.applied).toBe(true);
      expect(result.code).toContain('await Promise.all(items.map(async (item)');
      expect(AstOptimizer.validateSyntax(result.code)).toBe(true);
    });
  });

  describe('3. Control Plane Authentication Guard', () => {
    it('should block unauthenticated requests when auth is enabled', (done) => {
      const authGuard = createAuthGuard({
        environment: 'production',
        auth: { enabled: true, secret: 'enterprise-secret-123' },
      } as any);

      const mockReq: any = {
        headers: {},
        query: {},
        ip: '192.168.1.100',
        path: '/api/metrics',
        accepts: () => false,
      };

      const mockRes: any = {
        statusCode: 200,
        status(code: number) { this.statusCode = code; return this; },
        json(data: any) {
          expect(this.statusCode).toBe(401);
          expect(data.error).toBe('Unauthorized');
          done();
        },
      };

      authGuard(mockReq, mockRes, () => {
        done(new Error('Should not have allowed unauthenticated request'));
      });
    });

    it('should allow requests with valid Bearer token', (done) => {
      const authGuard = createAuthGuard({
        environment: 'production',
        auth: { enabled: true, secret: 'enterprise-secret-123' },
      } as any);

      const mockReq: any = {
        headers: { authorization: 'Bearer enterprise-secret-123' },
        query: {},
        ip: '192.168.1.100',
        path: '/api/metrics',
      };

      const mockRes: any = {};

      authGuard(mockReq, mockRes, () => {
        // Successfully authenticated!
        done();
      });
    });

    it('should fail closed without credentials even when the proxy reports localhost', () => {
      const authGuard = createAuthGuard({ environment: 'production', auth: {} } as any);
      const mockReq: any = { headers: {}, query: {}, ip: '127.0.0.1', hostname: 'localhost', path: '/api/status', accepts: () => false };
      const mockRes: any = {
        statusCode: 200,
        status(code: number) { this.statusCode = code; return this; },
        json(data: any) { expect(this.statusCode).toBe(401); expect(data.error).toBe('Unauthorized'); },
      };
      authGuard(mockReq, mockRes, () => { throw new Error('localhost must not bypass production auth'); });
    });

    it('should reject query-string credentials', () => {
      const authGuard = createAuthGuard({ environment: 'production', auth: { secret: 'enterprise-secret-123' } } as any);
      const mockReq: any = { headers: {}, query: { key: 'enterprise-secret-123' }, path: '/api/status', accepts: () => false };
      const mockRes: any = {
        statusCode: 200,
        status(code: number) { this.statusCode = code; return this; },
        json(data: any) { expect(this.statusCode).toBe(401); expect(data.error).toBe('Unauthorized'); },
      };
      authGuard(mockReq, mockRes, () => { throw new Error('query credentials must not authenticate'); });
    });
  });

  describe('4. Shadow Execution Side-Effect Isolation Flag', () => {
    it('should tag cloned requests with x-seim-shadow: true and isShadow: true', async () => {
      const shadowEngine = new ShadowTestEngine();

      let shadowFlagDetected = false;
      const originalHandler = (req: any, res: any) => res.json({ original: true });
      const optimizedHandler = (req: any, res: any) => {
        if (req.isShadow || req.headers['x-seim-shadow'] === 'true') {
          shadowFlagDetected = true;
        }
        res.json({ optimized: true });
      };

      const mockReq: any = { method: 'GET', url: '/api/test', headers: { 'user-agent': 'jest' } };
      await shadowEngine.run('/api/test', originalHandler as any, optimizedHandler as any, mockReq);

      expect(shadowFlagDetected).toBe(true);
    });
  });

  describe('5. Storage Persistence Across Process Restarts', () => {
    it('should persist versions to disk and reload them successfully', async () => {
      const storageDir = path.join(__dirname, '.temp-seim-test-storage');
      const storage = new FileStorageAdapter(storageDir);

      const version = {
        id: 'v_prod_1',
        routeKey: 'GET /api/checkout',
        version: 'optimized',
        code: '// Optimized checkout',
        createdAt: Date.now(),
      };

      await storage.saveVersion('GET /api/checkout', version as any);
      await storage.setActiveVersion('GET /api/checkout', 'v_prod_1');

      // Create new storage instance simulating process restart
      const restartedStorage = new FileStorageAdapter(storageDir);
      const reloadedVersions = await restartedStorage.getVersions('GET /api/checkout');
      const activeVersion = await restartedStorage.getActiveVersion('GET /api/checkout');

      expect(reloadedVersions.length).toBe(1);
      expect(reloadedVersions[0].id).toBe('v_prod_1');
      expect(activeVersion).toBe('v_prod_1');

      // Cleanup
      fs.rmSync(storageDir, { recursive: true, force: true });
    });
  });
});
