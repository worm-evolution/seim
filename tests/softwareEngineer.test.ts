import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { mergeConfig } from '../src/config';
import { FeatureScaffolder } from '../src/scaffolder';
import { ReactComponentGenerator, ReactComponentRegistry } from '../src/react';
import { LLMClient } from '../src/ai';
import { SeimEventBus } from '../src/events';
import { Logger } from '../src/logger';
import { ProductIssue } from '../src/issueStream';
import {
  IssuePlanner,
  MemoryEngineerStore,
  MemoryRepositoryProvider,
  ProjectAdapter,
  RiskPolicy,
  SoftwareEngineer,
  WorkspaceExecutor,
} from '../src/engineer';

describe('SoftwareEngineer closed-loop repository evolution', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seim-engineer-test-'));
    fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({
      name: 'fixture-app',
      scripts: { test: 'node -e "process.exit(0)"' },
      dependencies: { express: '^4.0.0' },
    }), 'utf8');
    fs.writeFileSync(path.join(projectDir, 'server.js'), 'const express = require("express");\nconst app = express();\napp.get("/health", (req, res) => res.json({ ok: true }));\n', 'utf8');
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  function createEngineer(repository = new MemoryRepositoryProvider()) {
    const config = mergeConfig({ mode: 'bypass', storage: { type: 'memory' } });
    const events = new SeimEventBus();
    const logger = new Logger({ level: 'error' });
    const scaffolder = new FeatureScaffolder(config, new LLMClient(config));
    const reactGenerator = new ReactComponentGenerator(new ReactComponentRegistry(), new LLMClient(config), config, events, logger);
    const store = new MemoryEngineerStore();
    return {
      engineer: new SoftwareEngineer(
        new ProjectAdapter(),
        new IssuePlanner(scaffolder, reactGenerator),
        new RiskPolicy(),
        new WorkspaceExecutor(),
        store,
        repository,
        logger,
        events,
      ),
      repository,
      store,
    };
  }

  it('plans, verifies, and publishes a real backend file change', async () => {
    const { engineer, repository } = createEngineer();
    const issue: ProductIssue = {
      id: 'missing-cart',
      type: 'feature:missing_api',
      path: '/api/cart',
      method: 'GET',
      severity: 'medium',
      frequency: 4,
      affectedSessions: 4,
      evidence: [],
      suggestedAction: 'Provide cart items',
      detectedAt: Date.now(),
      updatedAt: Date.now(),
      status: 'open',
    };

    const queued = await engineer.submit(issue, { rootDir: projectDir });
    expect(queued.status).toBe('queued');

    const awaitingApproval = await engineer.run(queued.id);
    expect(awaitingApproval.status).toBe('awaiting_approval');
    expect(awaitingApproval.verification?.passed).toBe(true);

    const published = await engineer.approve(queued.id);
    expect(published.status).toBe('pr_open');
    expect(repository.published).toHaveLength(1);
    expect(repository.published[0].files.map(file => file.path)).toEqual(expect.arrayContaining([
      'src/seim-generated/get-api-cart.js',
      'server.js',
    ]));
    expect(repository.published[0].files.find(file => file.path === 'server.js')?.content).toContain('/api/cart');
  });

  it('rejects unsafe generated content before running project commands', async () => {
    const { engineer, store } = createEngineer();
    const job = await engineer.submit({
      id: 'missing-cart',
      type: 'feature:missing_api',
      path: '/api/cart',
      method: 'GET',
      severity: 'medium',
      frequency: 4,
      affectedSessions: 4,
      evidence: [],
      suggestedAction: 'Provide cart items',
      detectedAt: Date.now(),
      updatedAt: Date.now(),
      status: 'open',
    }, { rootDir: projectDir });
    job.plan!.files[0].content = 'module.exports = () => eval("process.exit(1)");';
    const storeJob = await engineer.get(job.id);
    storeJob!.plan!.files[0].content = 'module.exports = () => eval("process.exit(1)");';
    await store.save(storeJob!);
    const result = await engineer.run(job.id);
    expect(result.status).toBe('rejected');
    expect(result.failureReason).toBe('Verification failed');
  });

  it('confines changes to the inspected project root', () => {
    expect(() => new ProjectAdapter().assertSafePath(projectDir, '../outside.js')).toThrow(/outside project root/);
  });
});
