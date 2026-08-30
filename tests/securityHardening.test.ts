import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createAuthGuard } from '../src/auth';
import { loadConfigFromFile } from '../src/configLoader';
import { WorkspaceExecutor } from '../src/engineer/executor';
import { SchemaEvolutionEngine } from '../src/schemaEvolution';
import { ReactComponentGenerator, ReactComponentRegistry } from '../src/react';
import { LLMClient } from '../src/ai';
import { Logger } from '../src/logger';
import { mergeConfig } from '../src/config';
import { SeimEventBus } from '../src/events';
import { createStudioHandler } from '../src/studio';

describe('additional security hardening', () => {
  it('cannot disable production authentication explicitly', () => {
    const guard = createAuthGuard({ environment: 'production', auth: { enabled: false } } as any);
    const req: any = { headers: {}, query: {}, path: '/api/status', accepts: () => false };
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();

    guard(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('does not execute JavaScript config unless explicitly opted in', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seim-config-'));
    const marker = path.join(root, 'executed');
    try {
      fs.writeFileSync(path.join(root, 'seim.config.js'), `require('fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); module.exports = { mode: 'bypass' };`);
      expect(loadConfigFromFile(root)).toBeUndefined();
      expect(fs.existsSync(marker)).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects symbolic links before verification writes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seim-symlink-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'seim-outside-'));
    try {
      fs.writeFileSync(path.join(root, 'package.json'), '{}');
      fs.writeFileSync(path.join(outside, 'target.js'), 'safe');
      fs.symlinkSync(path.join(outside, 'target.js'), path.join(root, 'link.js'));
      await expect(new WorkspaceExecutor().verify({ rootDir: root, commands: {}, contextIndex: {}, frontend: false, backend: false } as any, [])).rejects.toThrow(/symbolic link/);
      expect(fs.readFileSync(path.join(outside, 'target.js'), 'utf8')).toBe('safe');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects cross-origin Studio mutations', async () => {
    const handler = createStudioHandler({
      config: { environment: 'production', auth: { secret: 'secret' } },
    } as any);
    const req: any = {
      path: '/seim/api/rollback', method: 'POST',
      headers: { authorization: 'Bearer secret', origin: 'https://attacker.example', host: 'app.example' },
      body: { routeKey: '/api/users' },
    };
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn(), setHeader: jest.fn() };

    await handler(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('Cross-origin') }));
  });

  it('validates schema identifiers before generating model files', () => {
    const engine = new SchemaEvolutionEngine(undefined, new Logger({ level: 'silent' }));
    expect(() => engine.registerTable('../escape', {})).toThrow(/Invalid table name/);
    expect(() => engine.registerTable('users', { 'bad-name': { name: 'bad-name', type: 'string' } as any })).toThrow(/Invalid field name/);
  });

  it('does not interpolate unsafe frontend endpoints into generated source', async () => {
    const config = mergeConfig({ mode: 'restrict', storage: { type: 'memory' } });
    const generator = new ReactComponentGenerator(new ReactComponentRegistry(), new LLMClient(config), config, new SeimEventBus(), new Logger({ level: 'silent' }));
    const result = await generator.generate({ name: 'SafePage', intent: 'show data', dataEndpoints: ["'); alert('xss');//"] });
    expect(result.code).not.toContain("alert('xss')");
  });

  it('keeps unsafe intent text as data in generated React source', async () => {
    const config = mergeConfig({ mode: 'restrict', storage: { type: 'memory' } });
    const generator = new ReactComponentGenerator(new ReactComponentRegistry(), new LLMClient(config), config, new SeimEventBus(), new Logger({ level: 'silent' }));
    const result = await generator.generate({ name: 'SafeIntentPage', intent: "show `data`; ${globalThis.process}; </script>" });
    expect(result.code).toContain('const componentIntent =');
    expect(result.code).toContain('{componentIntent}');
    expect(result.code).not.toContain('Autonomous component for: show `data`');
  });

  it('rejects invalid React component identifiers before generating source', async () => {
    const config = mergeConfig({ mode: 'restrict', storage: { type: 'memory' } });
    const generator = new ReactComponentGenerator(new ReactComponentRegistry(), new LLMClient(config), config, new SeimEventBus(), new Logger({ level: 'silent' }));
    await expect(generator.generate({ name: 'Bad-Component', intent: 'test' })).rejects.toThrow(/Invalid React component name/);
  });

  it('does not expose internal engineer errors through the API', async () => {
    const { handleEngineerApi } = await import('../src/studio/engineerApi');
    const req: any = { path: '/seim/api/engineer/run', method: 'POST', body: { jobId: 'job-1' } };
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const instance: any = { engineer: { run: jest.fn().mockRejectedValue(new Error('/private/path/secret-command')) } };

    await handleEngineerApi(req, res, instance);

    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Engineer operation failed', requestId: expect.any(String) });
  });
});
