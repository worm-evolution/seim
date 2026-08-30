import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProjectAdapter, RiskPolicy, createHandoffContract, validateHandoffContract, writeHandoffContract } from '../src/engineer';
import { handoffCommand } from '../src/cli/commands/handoff';
import type { ChangePlan } from '../src/engineer';

describe('application handoff contract and context index', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'seim-handoff-'));
    fs.mkdirSync(path.join(root, 'src', 'components', 'ui'), { recursive: true });
    fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(root, 'prisma'), { recursive: true });
    fs.mkdirSync(path.join(root, 'contracts'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'baseline-app',
      scripts: { test: 'jest', build: 'tsc', e2e: 'playwright test' },
      dependencies: { react: '^18.0.0', express: '^4.0.0', 'react-router-dom': '^6.0.0' },
    }));
    fs.writeFileSync(path.join(root, 'server.js'), 'const app = require("express")();');
    fs.writeFileSync(path.join(root, 'src', 'App.tsx'), 'export default function App() { return <main />; }');
    fs.writeFileSync(path.join(root, 'src', 'components', 'ui', 'Button.tsx'), 'export const Button = () => <button />;');
    fs.writeFileSync(path.join(root, 'tests', 'app.test.ts'), 'test("app", () => {});');
    fs.writeFileSync(path.join(root, 'docs', 'ARCHITECTURE.md'), '# Architecture');
    fs.writeFileSync(path.join(root, 'prisma', 'schema.prisma'), 'model User { id String @id }');
    fs.writeFileSync(path.join(root, 'contracts', 'openapi.yaml'), 'openapi: 3.0.0');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('indexes application context and reloads a developer-approved handoff', async () => {
    const adapter = new ProjectAdapter();
    const detected = adapter.inspect(root);
    expect(detected.contextIndex.sourceFiles).toContain('src/App.tsx');
    expect(detected.contextIndex.testFiles).toContain('tests/app.test.ts');
    expect(detected.contextIndex.documentationFiles).toContain('docs/ARCHITECTURE.md');
    expect(detected.contextIndex.databaseFiles).toContain('prisma/schema.prisma');
    expect(detected.contextIndex.apiContractFiles).toContain('contracts/openapi.yaml');
    expect(detected.contextIndex.designSystemFiles).toContain('src/components/ui/Button.tsx');

    const contract = createHandoffContract(detected);
    contract.policies.autonomy = 'merge';
    contract.policies.protectedPaths.push('src/identity');
    contract.commands.test = 'npm test -- --runInBand';
    await writeHandoffContract(root, contract);

    const handedOff = adapter.inspect(root);
    expect(handedOff.handoff?.policies.autonomy).toBe('merge');
    expect(handedOff.handoff?.policies.protectedPaths).toContain('src/identity');
    expect(handedOff.commands.test).toBe('npm test -- --runInBand');
  });

  it('creates the takeover contract through the CLI workflow', async () => {
    await handoffCommand([root]);
    const contractPath = path.join(root, '.seim', 'handoff.json');
    expect(fs.existsSync(contractPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(contractPath, 'utf8')).policies.autonomy).toBe('pull_request');
  });

  it('rejects handoff policy paths that escape the repository', () => {
    expect(() => validateHandoffContract({
      version: 1,
      application: { name: 'unsafe' },
      policies: { autonomy: 'pull_request', protectedPaths: ['../outside'], approvalRequiredPaths: [] },
    })).toThrow(/stay inside the repository/);
  });

  it('blocks protected files and approval-gates governed files', async () => {
    const adapter = new ProjectAdapter();
    const contract = createHandoffContract(adapter.inspect(root));
    contract.policies.protectedPaths = ['src/identity'];
    contract.policies.approvalRequiredPaths = ['prisma'];
    await writeHandoffContract(root, contract);
    const manifest = adapter.inspect(root);
    const base: ChangePlan = { id: 'p1', title: 'change', summary: 'change', files: [], risk: 'low', reasons: [], generatedBy: 'developer', createdAt: Date.now() };
    const policy = new RiskPolicy();

    const blocked = policy.evaluate({ ...base, files: [{ path: 'src/identity/session.ts', operation: 'update', content: 'safe' }] }, manifest);
    expect(blocked.allowed).toBe(false);
    expect(blocked.risk).toBe('critical');

    const governed = policy.evaluate({ ...base, files: [{ path: 'prisma/migrations/001.sql', operation: 'create', content: 'CREATE TABLE note(id int);' }] }, manifest);
    expect(governed.allowed).toBe(true);
    expect(governed.requiresApproval).toBe(true);
    expect(governed.risk).toBe('high');
  });
});
