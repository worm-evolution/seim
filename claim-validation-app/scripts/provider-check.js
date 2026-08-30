const assert = require('assert/strict');
const { randomUUID } = require('crypto');
const os = require('os');
const path = require('path');
const { Pool } = require('pg');
const { createClient } = require('redis');
const {
  GitHubAppTokenProvider,
  PostgresEngineerStore,
  seim,
} = require('seim-core');
const { LLMClient } = require('seim-core/dist/ai');

const results = [];

async function check(name, requiredEnvironment, operation) {
  const missing = requiredEnvironment.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    results.push({ name, status: 'SKIP', detail: `missing ${missing.join(', ')}` });
    return;
  }

  try {
    const detail = await operation();
    results.push({ name, status: 'PASS', detail });
  } catch (error) {
    results.push({ name, status: 'FAIL', detail: safeError(error) });
  }
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const status = message.match(/(?:API|HTTP|status)\s*(\d{3})/i)?.[1];
  return status ? `provider returned HTTP ${status}` : (error?.code ? `error code ${error.code}` : 'provider check failed');
}

function baseConfig(storage) {
  return {
    mode: 'restrict',
    environment: 'production',
    framework: 'express',
    storage,
    storagePath: path.join(os.tmpdir(), 'seim-provider-acceptance'),
    auth: { enabled: true, secret: 'local-provider-acceptance-only' },
    ai: { enabled: false },
    worker: { enabled: false },
    evolution: { enabled: false, driftDetection: false },
    behavior: { enabled: false },
    learning: { enabled: false },
    logging: { level: 'silent', json: false },
  };
}

async function checkRedis() {
  const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:56379';
  const routeKey = `GET /seim-provider-check/${randomUUID()}`;
  let first;
  let second;
  const cleanup = createClient({ url: redisUrl });
  cleanup.on('error', () => undefined);

  try {
    first = seim(baseConfig({ type: 'redis', connection: redisUrl }));
    const created = await first.versionManager.createVersion(
      routeKey,
      'async function providerCheck(request, response) { response.json({ ok: true }); }',
      { createdBy: 'manual', reason: 'Redis acceptance check' },
    );
    await first.versionManager.activateVersion(routeKey, created.id, {
      reason: 'Redis acceptance check',
      triggeredBy: 'manual',
      rolloutStrategy: 'immediate',
      rolloutPercentage: 100,
    });
    await first.shutdown();
    first = undefined;

    second = seim(baseConfig({ type: 'redis', connection: redisUrl }));
    await second.versionManager.loadState(routeKey);
    const restored = await second.versionManager.getActiveVersion(routeKey);
    assert.equal(restored?.id, created.id);
    return 'version and active state survived a SEIM restart';
  } finally {
    if (first) await first.shutdown().catch(() => undefined);
    if (second) await second.shutdown().catch(() => undefined);
    await cleanup.connect().catch(() => undefined);
    if (cleanup.isOpen) {
      const token = Buffer.from(routeKey, 'utf8').toString('base64url');
      await cleanup.del(
        `seim:${token}:versions`,
        `seim:${token}:version-order`,
        `seim:${token}:transitions`,
        `seim:${token}:transition-order`,
        `seim:${token}:active`,
      );
      await cleanup.sRem('seim:routes', routeKey);
      await cleanup.quit();
    }
  }
}

async function checkPostgres() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const tableName = `seim_claim_jobs_${Date.now()}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const store = new PostgresEngineerStore(pool, tableName);
  const now = Date.now();
  const job = {
    id: `claim-${randomUUID()}`,
    status: 'queued',
    manifest: {
      version: 1,
      rootDir: '/provider-check',
      packageManager: 'npm',
      baseBranch: 'main',
      frontendContext: {
        framework: 'react',
        router: 'react-router',
        dependencies: ['react'],
        stylingLibraries: [],
        stateLibraries: [],
        dataLibraries: [],
        existingRoutes: [],
      },
      contextIndex: {
        totalFiles: 0,
        indexedFiles: 0,
        truncated: false,
        languages: {},
        sourceFiles: [],
        testFiles: [],
        documentationFiles: [],
        configurationFiles: [],
        apiContractFiles: [],
        databaseFiles: [],
        deploymentFiles: [],
        designSystemFiles: [],
        workspacePackages: [],
        generatedAt: now,
      },
      commands: {},
      frontend: true,
      backend: true,
    },
    createdAt: now,
    updatedAt: now,
  };

  try {
    await store.save(job);
    assert.equal((await store.get(job.id))?.id, job.id);
    assert.ok((await store.list()).some((item) => item.id === job.id));
    return 'engineer job round-tripped through PostgreSQL';
  } finally {
    await pool.query(`DROP TABLE IF EXISTS ${tableName}`).catch(() => undefined);
    await pool.end();
  }
}

async function checkGemini() {
  const client = new LLMClient({
    ai: {
      enabled: true,
      provider: 'google',
      apiKey: process.env.SEIM_AI_API_KEY,
      generatorModel: process.env.SEIM_AI_MODEL || 'gemini-2.5-flash',
      reviewerModel: process.env.SEIM_AI_MODEL || 'gemini-2.5-flash',
      verifierModel: process.env.SEIM_AI_MODEL || 'gemini-2.5-flash',
    },
  });
  const response = await client.chat('Reply with exactly READY.', 'Provider acceptance check.');
  assert.ok(response.trim().length > 0);
  return 'SEIM received a Gemini response';
}

async function checkGitHubApp() {
  const provider = new GitHubAppTokenProvider({
    appId: process.env.SEIM_GITHUB_APP_ID,
    installationId: process.env.SEIM_GITHUB_INSTALLATION_ID,
    privateKey: process.env.SEIM_GITHUB_PRIVATE_KEY,
  });
  const token = await provider.getToken();
  const owner = encodeURIComponent(process.env.SEIM_GITHUB_OWNER);
  const repository = encodeURIComponent(process.env.SEIM_GITHUB_REPOSITORY);
  const response = await fetch(`https://api.github.com/repos/${owner}/${repository}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  assert.equal(response.ok, true, `GitHub API ${response.status}`);
  return 'installation token can read the configured repository';
}

async function checkVercel() {
  const headers = { Authorization: `Bearer ${process.env.VERCEL_TOKEN}` };
  const identity = await fetch('https://api.vercel.com/v2/user', { headers });
  assert.equal(identity.ok, true, `Vercel API ${identity.status}`);

  if (process.env.VERCEL_ORG_ID && process.env.VERCEL_PROJECT_ID) {
    const projectId = encodeURIComponent(process.env.VERCEL_PROJECT_ID);
    const teamId = encodeURIComponent(process.env.VERCEL_ORG_ID);
    const project = await fetch(`https://api.vercel.com/v9/projects/${projectId}?teamId=${teamId}`, { headers });
    assert.equal(project.ok, true, `Vercel project API ${project.status}`);
    return 'token can read the configured Vercel project';
  }
  return 'token authenticated; project IDs were not configured';
}

async function main() {
  await check('Redis-backed SEIM version persistence', [], checkRedis);
  await check('PostgreSQL engineer-job persistence', ['DATABASE_URL'], checkPostgres);
  await check('Gemini through SEIM LLMClient', ['SEIM_AI_API_KEY'], checkGemini);
  await check(
    'GitHub App installation authentication',
    [
      'SEIM_GITHUB_APP_ID',
      'SEIM_GITHUB_INSTALLATION_ID',
      'SEIM_GITHUB_PRIVATE_KEY',
      'SEIM_GITHUB_OWNER',
      'SEIM_GITHUB_REPOSITORY',
    ],
    checkGitHubApp,
  );
  await check('Vercel token authentication', ['VERCEL_TOKEN'], checkVercel);

  for (const result of results) {
    console.log(`${result.status.padEnd(4)} ${result.name} — ${result.detail}`);
  }
  const failures = results.filter((result) => result.status === 'FAIL');
  const passes = results.filter((result) => result.status === 'PASS');
  const skips = results.filter((result) => result.status === 'SKIP');
  console.log(`\n${passes.length} passed, ${skips.length} skipped, ${failures.length} failed`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch(() => {
  console.error('Provider acceptance harness failed unexpectedly');
  process.exitCode = 1;
});
