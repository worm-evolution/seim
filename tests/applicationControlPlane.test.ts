import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { mergeConfig } from '../src/config';
import { FeatureScaffolder } from '../src/scaffolder';
import { ReactComponentGenerator, ReactComponentRegistry } from '../src/react';
import { LLMClient } from '../src/ai';
import { SeimEventBus } from '../src/events';
import { Logger } from '../src/logger';
import {
  ApplicationControlPlane,
  FileControlPlaneStore,
  IssuePlanner,
  MemoryEngineerStore,
  MemoryRepositoryProvider,
  ProjectAdapter,
  RiskPolicy,
  SoftwareEngineer,
  WorkspaceExecutor,
} from '../src/engineer';

describe('ApplicationControlPlane', () => {
  const config = mergeConfig({ mode: 'bypass', storage: { type: 'memory' } });
  let root: string;
  let storage: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'seim-control-app-'));
    storage = fs.mkdtempSync(path.join(os.tmpdir(), 'seim-control-storage-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'handoff-app',
      scripts: { test: 'node -e "process.exit(0)"' },
      dependencies: { express: '^4.0.0', react: '^18.0.0', 'react-router-dom': '^6.0.0' },
    }));
    fs.writeFileSync(path.join(root, 'server.js'), 'const express = require("express");\nconst app = express();\napp.get("/health", (req, res) => res.json({ ok: true }));\n');
    fs.writeFileSync(path.join(root, 'src', 'App.tsx'), 'import { Routes, Route } from "react-router-dom"; export default function App() { return <Routes><Route path="/" element={<div />} /></Routes>; }');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(storage, { recursive: true, force: true });
  });

  function engineer(repository = new MemoryRepositoryProvider()): SoftwareEngineer {
    const events = new SeimEventBus();
    const logger = new Logger({ level: 'error' });
    const scaffolder = new FeatureScaffolder(config, new LLMClient(config));
    const generator = new ReactComponentGenerator(new ReactComponentRegistry(), new LLMClient(config), config, events, logger);
    return new SoftwareEngineer(new ProjectAdapter(), new IssuePlanner(scaffolder, generator), new RiskPolicy(), new WorkspaceExecutor(), new MemoryEngineerStore(), repository, logger, events);
  }

  it('hands off an existing React/backend application and decomposes a mixed goal', async () => {
    const events = new SeimEventBus();
    const control = new ApplicationControlPlane(new ProjectAdapter(), new FileControlPlaneStore(storage), engineer(), events);
    const app = await control.handoff(root);
    expect(app.status).toBe('active');
    expect(app.manifest.frontendContext.router).toBe('react-router');
    expect(app.manifest.backendEntrypoint).toBe('server.js');

    const plan = await control.submitGoal({
      applicationId: app.id,
      title: 'Add a cart dashboard',
      description: 'Build a React page at /cart and a GET /api/cart endpoint.',
      acceptanceCriteria: ['Users can view their cart', 'The endpoint returns cart items'],
    });
    expect(plan.status).toBe('planned');
    expect(plan.tasks.filter(task => task.executable).map(task => task.kind)).toEqual(['frontend', 'backend']);
    expect(plan.tasks.some(task => task.kind === 'test' && !task.executable)).toBe(true);
    expect(plan.tasks.find(task => task.kind === 'frontend')?.issue?.path).toBe('/cart');
    expect(plan.tasks.find(task => task.kind === 'backend')?.issue?.path).toBe('/api/cart');
    expect((await control.listPlans()).map(item => item.id)).toContain(plan.id);
  });

  it('executes a supported backend goal through verification and approval', async () => {
    const repository = new MemoryRepositoryProvider();
    const engineerInstance = engineer(repository);
    const control = new ApplicationControlPlane(new ProjectAdapter(), new FileControlPlaneStore(storage), engineerInstance);
    engineerInstance.attachControlPlane(control);
    const app = await control.handoff(root);
    const plan = await control.submitGoal({ applicationId: app.id, title: 'Add cart API', description: 'Implement GET /api/cart endpoint.' });

    const running = await control.runPlan(plan.id);
    const backend = running.tasks.find(task => task.kind === 'backend')!;
    expect(backend.jobId).toBeDefined();
    expect(backend.status).toBe('awaiting_approval');
    expect(running.status).toBe('awaiting_approval');

    const approved = await control.approveTask(plan.id, backend.id);
    expect(approved.tasks.find(task => task.id === backend.id)?.status).toBe('awaiting_approval');
    expect(repository.published).toHaveLength(1);
  });

  it('reloads handoffs and plans from file storage', async () => {
    const store = new FileControlPlaneStore(storage);
    const first = new ApplicationControlPlane(new ProjectAdapter(), store, engineer());
    const app = await first.handoff(root);
    const plan = await first.submitGoal({ applicationId: app.id, title: 'Improve health API', description: 'Add GET /api/health endpoint.' });

    const second = new ApplicationControlPlane(new ProjectAdapter(), new FileControlPlaneStore(storage), engineer());
    expect((await second.listApplications()).find(item => item.id === app.id)?.rootDir).toBe(root);
    expect((await second.getPlan(plan.id))?.goal.title).toBe('Improve health API');
  });
});
