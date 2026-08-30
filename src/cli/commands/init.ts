import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_CONFIG = {
  mode: 'restrict',
  studioPath: '/seim',
  framework: 'express',
  logging: { level: 'info', json: false },
  experiment: {
    canaryPercent: 5,
    shadowCooldownMs: 60000,
    shadowSampleSize: 25,
    sandboxTimeoutMs: 500,
    shadowAllowedMethods: ['GET', 'HEAD', 'OPTIONS'],
  },
  worker: { enabled: true, intervalMs: 10000 },
  ai: { enabled: false },
  behavior: { enabled: true, autoScaffold: false },
  frontend: { enabled: false, framework: 'react' },
  patterns: { enabled: true },
  security: {
    blockAuthenticationChanges: true,
    blockPaymentChanges: true,
    blockSecretUsage: true,
  },
};

const STARTER_SERVER = `const express = require('express');
const { seim } = require('seim-core');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ── SEIM: self-evolving middleware ──────────────────────────────────
// Reads config from .seimrc.json. Place BEFORE your routes.
const s = seim();
app.use(s.listener());

// SEIM dashboard — visit http://localhost:<PORT>/seim
app.use(s.config.studioPath, s.dashboard);
// ────────────────────────────────────────────────────────────────────

// Your routes go here — SEIM monitors and optimises them automatically
app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.get('/api/hello', (req, res) => {
  res.json({ message: 'Hello from SEIM-powered app!' });
});

app.listen(PORT, () => {
  console.log(\`Server: http://localhost:\${PORT}\`);
  console.log(\`SEIM dashboard: http://localhost:\${PORT}\${s.config.studioPath}\`);
});
`;

function makePackageJson(name: string): string {
  return JSON.stringify({
    name,
    version: '1.0.0',
    main: 'server.js',
    scripts: { start: 'node server.js', dev: 'node --watch server.js' },
    dependencies: { express: '^4.18.2', 'seim-core': 'latest' },
  }, null, 2) + '\n';
}

export async function initCommand(_args: string[]): Promise<void> {
  const cwd = process.cwd();
  const seimrcPath = path.join(cwd, '.seimrc.json');
  const pkgPath    = path.join(cwd, 'package.json');
  const serverPath = path.join(cwd, 'server.js');

  const hasPackageJson = fs.existsSync(pkgPath);
  const hasSeimrc      = fs.existsSync(seimrcPath);

  // Always write .seimrc.json if missing
  if (hasSeimrc) {
    console.log('⚠️  .seimrc.json already exists — skipping.');
  } else {
    fs.writeFileSync(seimrcPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
    console.log('✅ Created .seimrc.json');
  }

  if (!hasPackageJson) {
    // ── Fresh / new project: scaffold a working starter ──────────────────────
    const dirName = path.basename(cwd).replace(/[^a-z0-9-]/gi, '-').toLowerCase() || 'seim-app';
    fs.writeFileSync(pkgPath, makePackageJson(dirName));
    console.log('✅ Created package.json');

    if (!fs.existsSync(serverPath)) {
      fs.writeFileSync(serverPath, STARTER_SERVER);
      console.log('✅ Created server.js  ← SEIM already wired in');
    }

    console.log('');
    console.log('🚀 Next steps:');
    console.log('   npm install      # install express + seim');
    console.log('   npm start        # start the server');
    console.log('');
    console.log('   Dashboard → http://localhost:3000/seim');
    console.log('   Add your routes to server.js — SEIM evolves them automatically.');
  } else {
    // ── Existing project: show the 3-line integration snippet ────────────────
    console.log('');
    console.log('📦 Existing project — add these 3 lines to your server file:');
    console.log('');
    console.log("   const { seim } = require('seim-core');");
    console.log('   const s = seim();                               // reads .seimrc.json');
    console.log('   app.use(s.listener());                          // BEFORE your routes');
    console.log("   app.use(s.config.studioPath, s.dashboard);      // optional dashboard at /seim");
    console.log('');
    console.log('   Modes (edit .seimrc.json → "mode"):');
    console.log('     "restrict"  — monitor only (safe default)');
    console.log('     "bypass"    — fully autonomous optimization + feature discovery');
    console.log('');
    console.log('   Dashboard → http://localhost:<PORT>/seim');
  }
}
