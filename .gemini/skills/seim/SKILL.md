---
name: seim
description: "Comprehensive skill for Antigravity (AGY) agents to integrate, configure, benchmark, and operate the SEIM (Self-Evolving Infrastructure Middleware v1.0.4) full-stack runtime."
---

# SEIM — Antigravity Agent Skill Guide (v1.0.4)

This skill enables Antigravity (AGY) agents to install, configure, debug, and autonomously operate the **SEIM (Self-Evolving Infrastructure Middleware)** full-stack runtime.

## When to Use This Skill
- Adding autonomous product evolution (auto-scaffolding missing APIs, generating React pages from visitor 404s/journeys) to a Node.js/React project.
- Setting up Telemetry-Driven Pull Request & Staging Branch generation (`s.prGenerator`).
- Configuring automated performance optimizations (N+1 queries, sequential async parallelization, caching) with staged canary traffic and <500ms rollback sentry.
- Operating the Neo-Brutalist Studio Control Center (`/seim`) with Dark/Light mode and Maroon theme.
- Registering custom domain-specific optimization pattern templates (`s.patterns.registerRegex`).

---

## 1. Quick Integration Recipes

### Express Backend Integration
```javascript
const express = require('express');
const { seim } = require('seim-core');

const app = express();
app.use(express.json());

const s = seim({
  mode: 'bypass', // 'bypass' for autonomous evolution, 'restrict' for observe-only
  behavior: {
    enabled: true,
    autoScaffold: true,     // Autonomously build missing routes
    minPatternFrequency: 3, // Multi-session threshold for Sybil defense
    minIssueSessionThreshold: 3,
  },
  frontend: {
    enabled: true,
    outputDir: './src/seim-generated',
  },
  businessRules: [
    (response) => response && response.total >= 0,
  ],
});

// CRITICAL: Mount listener BEFORE application routes
app.use(s.listener());

// Mount the Neo-Brutalist Studio Control Center Dashboard
app.use(s.config.studioPath, s.dashboard);

// Application routes...
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
```

### Fastify Backend Integration
```javascript
const fastify = require('fastify')({ logger: true });
const { seim } = require('seim-core');

const s = seim({ framework: 'fastify', mode: 'bypass' });
fastify.register(s.plugin());
```

### React Frontend Auto-Routing Integration
SEIM writes generated page components to `src/seim-generated/` and maintains `seim-routes.tsx`:
```tsx
import React, { Suspense } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { seimGeneratedRoutes } from './seim-generated/seim-routes';

export default function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<div>Loading...</div>}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          {seimGeneratedRoutes.map(r => (
            <Route key={r.path} path={r.path} element={<r.Component />} />
          ))}
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
```

---

## 2. Telemetry-Driven PR & Staging Branch Generation

```javascript
// Generate a clean staging branch and .patch file from a detected issue
const pr = await s.prGenerator.createPrFromIssue(issue, handlerCode);
console.log(`Created PR #${pr.number} on branch ${pr.branchName}`);

// 1-Click merge to live production
s.prGenerator.mergePr(pr.id);
```

---

## 3. Registering Custom Optimization Patterns

```javascript
// Register regex-based custom rule
s.patterns.registerRegex(
  'company/no-sync-file-io',
  'Disallow readFileSync in request handlers',
  'Use fs.promises.readFile with async/await',
  'critical',
  /fs\.readFileSync\((.*?)\)/,
  (source, match) => source.replace(/fs\.readFileSync\(/g, 'await fs.promises.readFile('),
  { tags: ['filesystem', 'async'] }
);
```

---

## 4. CLI & Operational Commands

```bash
# Initialize SEIM in a project
npx seim init

# View live system status & active routes
npx seim status http://localhost:3000

# Benchmark overhead & latency
npx seim benchmark http://localhost:3000/api/health

# Trigger 1-click rollback
npx seim rollback /api/problematic-route
```

---

## 5. Verification & Testing Checklist

When implementing or modifying SEIM features, run:
```bash
npm run build && npx jest --no-coverage --runInBand
```
Ensure all 28 test suites (153 tests) pass cleanly.
