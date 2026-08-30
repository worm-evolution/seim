import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CiRepairPlanner, ProjectAdapter } from '../src/engineer';
import type { ProductIssue } from '../src/issueStream';

describe('CiRepairPlanner', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'seim-repair-planner-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'repair-app', scripts: { test: 'node -e "process.exit(1)"' } }));
    fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'export const healthy = false;\n');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('turns bounded diagnostics and model output into hash-guarded changes', async () => {
    const model = { chat: jest.fn(async () => JSON.stringify({ title: 'fix(app): restore health', summary: 'Correct the health flag.', changes: [{ path: 'src/app.ts', operation: 'update', content: 'export const healthy = true;\n' }] })) };
    const plan = await new CiRepairPlanner(model, true, 5000).create(issue(), new ProjectAdapter().inspect(root));
    expect(plan.generatedBy).toBe('model');
    expect(plan.risk).toBe('low');
    expect(plan.files).toEqual([{ path: 'src/app.ts', operation: 'update', content: 'export const healthy = true;\n', expectedSha256: createHash('sha256').update('export const healthy = false;\n').digest('hex') }]);
    expect(model.chat).toHaveBeenCalledWith(expect.stringContaining('Never weaken tests'), expect.stringContaining('process.exit(1)'));
  });

  it('rejects sensitive paths and refuses to run without an AI provider', async () => {
    const unsafe = { chat: jest.fn(async () => JSON.stringify({ title: 'fix', summary: 'bad', changes: [{ path: '.env', operation: 'create', content: 'TOKEN=x' }] })) };
    await expect(new CiRepairPlanner(unsafe, true, 5000).create(issue(), new ProjectAdapter().inspect(root))).rejects.toThrow(/unsafe or duplicate path/);
    await expect(new CiRepairPlanner(unsafe, false).create(issue(), new ProjectAdapter().inspect(root))).rejects.toThrow(/requires an enabled AI provider/);
  });
});

function issue(): ProductIssue {
  const now = Date.now();
  return { id: 'github_failure_test', type: 'bug:error_pattern', path: '/ci/seim-verify', severity: 'high', frequency: 1, affectedSessions: 1, evidence: [{ failedSteps: [{ job: 'verify', step: 'test', conclusion: 'failure' }] }], suggestedAction: 'Repair the failing tests', detectedAt: now, updatedAt: now, status: 'open', intentMetadata: { source: 'github-feedback' } };
}
