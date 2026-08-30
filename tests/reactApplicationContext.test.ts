import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { mergeConfig } from '../src/config';
import { FeatureScaffolder } from '../src/scaffolder';
import { ReactComponentGenerator, ReactComponentRegistry } from '../src/react';
import { LLMClient } from '../src/ai';
import { SeimEventBus } from '../src/events';
import { Logger } from '../src/logger';
import { IssuePlanner, ProjectAdapter } from '../src/engineer';
import { ProductIssue } from '../src/issueStream';

describe('React application context integration', () => {
  const config = mergeConfig({ storage: { type: 'memory' } });

  function issue(pathname: string): ProductIssue {
    return {
      id: `issue-${pathname}`,
      type: 'feature:missing_page',
      path: pathname,
      severity: 'medium',
      frequency: 4,
      affectedSessions: 4,
      evidence: [],
      suggestedAction: `Build the page for ${pathname} using the existing application conventions`,
      detectedAt: Date.now(),
      updatedAt: Date.now(),
      status: 'open',
    };
  }

  function planner(): IssuePlanner {
    const events = new SeimEventBus();
    const logger = new Logger({ level: 'error' });
    return new IssuePlanner(
      new FeatureScaffolder(config, new LLMClient(config)),
      new ReactComponentGenerator(new ReactComponentRegistry(), new LLMClient(config), config, events, logger),
    );
  }

  it('discovers React Router conventions and integrates a page into the existing Routes tree', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seim-react-router-'));
    try {
      fs.mkdirSync(path.join(root, 'src'), { recursive: true });
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
        dependencies: { react: '^18.0.0', 'react-router-dom': '^6.0.0', '@mui/material': '^5.0.0', zustand: '^4.0.0' },
      }));
      fs.writeFileSync(path.join(root, 'src', 'App.tsx'), 'import { Routes, Route } from "react-router-dom";\nexport default function App() { return <Routes><Route path="/" element={<div />} /></Routes>; }');

      const manifest = new ProjectAdapter().inspect(root);
      expect(manifest.frontendContext.router).toBe('react-router');
      expect(manifest.frontendContext.stylingLibraries).toContain('@mui/material');
      expect(manifest.frontendContext.stateLibraries).toContain('zustand');
      expect(manifest.frontendContext.existingRoutes).toContain('/');

      const plan = await planner().create(issue('/cart'), manifest);
      expect(plan.files.map(file => file.path)).toEqual(expect.arrayContaining(['src/App.tsx', 'src/seim-generated/CartPage.tsx']));
      expect(plan.files.find(file => file.path === 'src/App.tsx')?.content).toContain('<Route path="/cart" element={<CartPage />} />');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('discovers the Next app router and creates a page in the route segment', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seim-next-app-'));
    try {
      fs.mkdirSync(path.join(root, 'app'), { recursive: true });
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { next: '^14.0.0', react: '^18.0.0' } }));
      fs.writeFileSync(path.join(root, 'app', 'page.tsx'), 'export default function Home() { return <main>Home</main>; }');

      const manifest = new ProjectAdapter().inspect(root);
      expect(manifest.frontendContext.framework).toBe('next');
      expect(manifest.frontendContext.router).toBe('next-app');

      const plan = await planner().create(issue('/settings'), manifest);
      expect(plan.files).toHaveLength(1);
      expect(plan.files[0].path).toBe('app/settings/page.tsx');
      expect(plan.files[0].content).toContain("'use client';");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("discovers the Next Pages Router and creates a page in pages", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "seim-next-pages-"));
    try {
      fs.mkdirSync(path.join(root, "src", "pages"), { recursive: true });
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { next: "^14.0.0", react: "^18.0.0" } }));
      fs.writeFileSync(path.join(root, "src", "pages", "_app.tsx"), "export default function App({ Component, pageProps }) { return <Component {...pageProps} />; }");

      const manifest = new ProjectAdapter().inspect(root);
      expect(manifest.frontendContext.router).toBe("next-pages");
      expect(manifest.frontendContext.pagesDirectory).toBe("src/pages");

      const plan = await planner().create(issue("/settings"), manifest);
      expect(plan.files).toHaveLength(1);
      expect(plan.files[0].path).toBe("src/pages/settings.tsx");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});