const path = require('path');
const express = require('express');
const { seim } = require('seim-core');

const STUDIO_SECRET = process.env.SEIM_AUTH_SECRET || 'local-validation-secret';

const seimInstance = seim({
  mode: 'restrict',
  environment: 'development',
  framework: 'express',
  storage: { type: 'memory' },
  auth: { enabled: true, secret: STUDIO_SECRET },
  logging: { level: 'warn', json: false },
  worker: { enabled: true, intervalMs: 250 },
  behavior: {
    enabled: true,
    autoScaffold: false,
    minPatternFrequency: 3,
    minIssueSessionThreshold: 3,
    issueCheckIntervalMs: 250,
    excludePaths: ['/api/health']
  },
  frontend: {
    enabled: true,
    framework: 'vite',
    typescript: true,
    writeToDisk: false
  }
});

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.use(seimInstance.listener());
app.use(seimInstance.config.studioPath, seimInstance.dashboard);

app.get('/api/health', (_request, response) => {
  response.json({ ok: true, service: 'seim-validation-store' });
});

app.get('/api/products', (_request, response) => {
  response.json({
    products: [
      { id: 'p1', name: 'Governed Runtime', description: 'A bounded application runtime.', price: 49 },
      { id: 'p2', name: 'Repository Engineer', description: 'Verified pull-request automation.', price: 99 }
    ]
  });
});

app.use(express.static(path.join(__dirname, 'dist')));
app.get('*', (_request, response) => response.sendFile(path.join(__dirname, 'dist', 'index.html')));

function start(port = Number(process.env.PORT) || 4310) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, port: address.port });
    });
    server.once('error', reject);
  });
}

async function stop(server) {
  await seimInstance.shutdown();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

if (require.main === module) {
  start().then(({ server, port }) => {
    console.log(`Validation app: http://127.0.0.1:${port}`);
    const shutdown = () => stop(server).finally(() => process.exit(0));
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { STUDIO_SECRET, seimInstance, start, stop };
