import { ModuleGraph } from '../src/moduleGraph';
import { SyntheticFuzzer } from '../src/fuzzer';
import { SchemaEvolutionEngine } from '../src/schemaEvolution';
import { MultiModelOrchestrator } from '../src/multiModelOrchestrator';
import { Sandbox } from '../src/sandbox';
import { Logger } from '../src/logger';
import * as path from 'path';

describe('Maximal Power Production Engines', () => {
  const logger = new Logger({ level: 'silent', json: false });
  const sandbox = new Sandbox();

  describe('1. ModuleGraph (Cross-Module Dependency Analysis)', () => {
    it('should build a dependency graph and analyze impacted callers', async () => {
      const graph = new ModuleGraph(path.resolve(__dirname, '../src'));
      const nodes = await graph.buildGraph();

      expect(nodes.size).toBeGreaterThan(5);

      // Check impact of modifying types.ts
      const typesPath = path.resolve(__dirname, '../src/types.ts');
      const callers = graph.checkImpact(typesPath);
      expect(Array.isArray(callers)).toBe(true);

      // Get context for index.ts
      const indexPath = path.resolve(__dirname, '../src/index.ts');
      const context = graph.getContextForRoute(indexPath);
      expect(context.source).toBeDefined();
      expect(context.dependencies.length).toBeGreaterThan(0);
    });
  });

  describe('2. SyntheticFuzzer (Differential Invariant Fuzzing)', () => {
    it('should generate a robust suite of 8+ edge-case payloads', () => {
      const fuzzer = new SyntheticFuzzer(sandbox, logger);
      const payloads = fuzzer.generatePayloads('/api/test', 'POST');

      expect(payloads.length).toBeGreaterThanOrEqual(8);
      const names = payloads.map(p => p.name);
      expect(names).toContain('valid_baseline');
      expect(names).toContain('boundary_numbers');
      expect(names).toContain('unicode_and_special_chars');
    });

    it('should pass differential fuzzing for equivalent handlers', async () => {
      const fuzzer = new SyntheticFuzzer(sandbox, logger);
      const payloads = fuzzer.generatePayloads('/api/echo', 'POST');

      const v1Code = `
        async function handler(req, res) {
          const body = req.body || {};
          res.status(200).json({ ok: true, data: body });
        }
      `;

      const v2Code = `
        async function handler(req, res) {
          const b = req.body || {};
          res.status(200).json({ ok: true, data: b });
        }
      `;

      const result = await fuzzer.runDifferentialFuzz(v1Code, v2Code, payloads.slice(0, 5));
      expect(result.passed).toBe(true);
      expect(result.divergentInputs.length).toBe(0);
    });

    it('should detect divergence when v2 returns wrong status or body', async () => {
      const fuzzer = new SyntheticFuzzer(sandbox, logger);
      const payloads = fuzzer.generatePayloads('/api/math', 'POST');

      const v1Code = `
        async function handler(req, res) {
          res.status(200).json({ result: 100 });
        }
      `;

      const v2Code = `
        async function handler(req, res) {
          res.status(500).json({ error: 'Broken math' });
        }
      `;

      const result = await fuzzer.runDifferentialFuzz(v1Code, v2Code, [payloads[0]]);
      expect(result.passed).toBe(false);
      expect(result.divergentInputs.length).toBe(1);
    });
  });

  describe('3. SchemaEvolutionEngine (Safe Additive Database Evolution)', () => {
    it('should strictly block destructive DDL operations', () => {
      const engine = new SchemaEvolutionEngine(undefined, logger);

      expect(engine.validateDdl('DROP TABLE users;').safe).toBe(false);
      expect(engine.validateDdl('DROP COLUMN email FROM users;').safe).toBe(false);
      expect(engine.validateDdl('TRUNCATE orders;').safe).toBe(false);
      expect(engine.validateDdl('ALTER COLUMN age TYPE VARCHAR;').safe).toBe(false);
    });

    it('should allow safe additive DDL operations', () => {
      const engine = new SchemaEvolutionEngine(undefined, logger);

      expect(engine.validateDdl('CREATE TABLE customers (id VARCHAR PRIMARY KEY);').safe).toBe(true);
      expect(engine.validateDdl('ALTER TABLE users ADD COLUMN phone VARCHAR DEFAULT "";').safe).toBe(true);
      expect(engine.validateDdl('CREATE INDEX idx_user_email ON users(email);').safe).toBe(true);
    });

    it('should generate TypeScript interfaces, Prisma models, and Mongoose schemas', () => {
      const engine = new SchemaEvolutionEngine(undefined, logger);
      engine.registerTable('customer', {
        email: { name: 'email', type: 'string', isUnique: true },
        balance: { name: 'balance', type: 'number', defaultValue: 0 },
        isActive: { name: 'isActive', type: 'boolean', defaultValue: true },
      });

      const tsInterface = engine.generateTypeScriptInterface('customer');
      expect(tsInterface).toContain('export interface Customer');
      expect(tsInterface).toContain('email: string;');

      const prismaModel = engine.generatePrismaModel('customer');
      expect(prismaModel).toContain('model Customer');
      expect(prismaModel).toContain('id        String   @id @default(uuid())');

      const mongooseSchema = engine.generateMongooseSchema('customer');
      expect(mongooseSchema).toContain('const CustomerSchema = new Schema');
      expect(mongooseSchema).toContain('export const CustomerModel');
    });
  });

  describe('4. MultiModelOrchestrator (Hierarchical AI Pipeline)', () => {
    it('should review candidate code with adversarial critic', async () => {
      const config: any = {
        ai: {
          enabled: true,
          apiKey: 'test-key',
          flashModel: 'gemini-2.0-flash',
          proModel: 'gemini-2.0-pro',
        },
      };

      const orchestrator = new MultiModelOrchestrator(config, logger);
      const original = 'async function(req, res) { res.json({ id: 1 }); }';
      const candidate = 'async function(req, res) { res.json({ id: 1 }); }';

      // Critic review fallback on mock
      const review = await orchestrator.reviewWithCritic(original, candidate, 'GET /api/test');
      expect(review.approved).toBe(true);
      expect(review.score).toBeGreaterThan(0.5);
    });
  });
});
