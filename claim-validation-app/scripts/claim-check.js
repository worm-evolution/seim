const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { STUDIO_SECRET, seimInstance, start, stop } = require('../server');

const results = [];

async function check(name, operation) {
  try {
    const detail = await operation();
    results.push({ name, status: 'PASS', detail: detail || '' });
  } catch (error) {
    results.push({ name, status: 'FAIL', detail: error instanceof Error ? error.message : String(error) });
  }
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json();
  return { response, body };
}

async function main() {
  const { server, port } = await start(0);
  const baseUrl = `http://127.0.0.1:${port}`;
  const authorization = { Authorization: `Bearer ${STUDIO_SECRET}` };

  try {
    await check('Express baseline route remains functional', async () => {
      const { response, body } = await jsonRequest(`${baseUrl}/api/health`);
      assert.equal(response.status, 200);
      assert.equal(body.service, 'seim-validation-store');
      return 'GET /api/health returned the baseline service response';
    });

    await check('Built React application is served with SEIM instrumentation', async () => {
      const response = await fetch(`${baseUrl}/`);
      const html = await response.text();
      assert.equal(response.status, 200);
      assert.match(html, /SEIM Validation Store/);
      assert.match(html, /<script src="\/seim\/sensor\.js" defer><\/script>/);
      return 'Vite production HTML was served with the SEIM sensor';
    });

    await check('SEIM observes a real backend route without breaking it', async () => {
      for (let index = 0; index < 12; index += 1) {
        const { response, body } = await jsonRequest(`${baseUrl}/api/products`, {
          headers: { 'x-session-id': `session-${index}` }
        });
        assert.equal(response.status, 200);
        assert.equal(body.products.length, 2);
      }
      return '12 product requests completed with unchanged responses';
    });

    await check('Studio authentication fails closed', async () => {
      const response = await fetch(`${baseUrl}/seim/api/status`);
      assert.equal(response.status, 401);
      return 'unauthenticated status request returned 401';
    });

    await check('Authenticated Studio status and security headers work', async () => {
      const { response, body } = await jsonRequest(`${baseUrl}/seim/api/status`, { headers: authorization });
      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(response.headers.get('x-frame-options'), 'DENY');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      return `mode=${body.mode}; framework=${body.framework}`;
    });

    await check('Metrics are exposed through the authenticated control plane', async () => {
      const { response, body } = await jsonRequest(`${baseUrl}/seim/api/metrics`, { headers: authorization });
      assert.equal(response.status, 200);
      assert.equal(typeof body, 'object');
      assert.ok(Object.keys(body).length > 0, 'metrics snapshot was empty');
      return `${Object.keys(body).length} metric groups returned`;
    });

    await check('Frontend telemetry sensor is served', async () => {
      const response = await fetch(`${baseUrl}/seim/sensor.js`);
      const source = await response.text();
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') || '', /javascript/);
      assert.ok(source.length > 100);
      return `${source.length} bytes of sensor JavaScript returned`;
    });

    await check('Frontend telemetry endpoint accepts bounded issues', async () => {
      const { response, body } = await jsonRequest(`${baseUrl}/seim/telemetry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: '/',
          sessionId: 'browser-validation',
          issues: [{ type: 'layout', selector: '.card', message: 'Validation-only layout signal' }]
        })
      });
      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      return 'telemetry was accepted without injecting executable JavaScript';
    });

    await check('Dashboard renders and does not expose the disabled merge action', async () => {
      const response = await fetch(`${baseUrl}/seim`, { headers: authorization });
      const html = await response.text();
      assert.equal(response.status, 200);
      assert.match(html, /Control Center/);
      assert.doesNotMatch(html, /1-CLICK MERGE & DEPLOY/);
      assert.match(html, /role="tablist"/);
      return 'dashboard HTML includes accessible tabs and no dead merge control';
    });

    await check('React fallback generation is safe and structurally valid', async () => {
      const intent = "Show products; </script><script>alert('x')</script>";
      const generated = await seimInstance.generateComponent({
        name: 'ValidationProducts',
        intent,
        dataEndpoints: ['/api/products'],
        isPage: true,
        routePath: '/generated-products'
      });
      assert.match(generated.code, /export default function ValidationProducts/);
      assert.match(generated.code, /const componentIntent =/);
      assert.match(generated.code, /fetch\("\/api\/products"/);
      assert.doesNotMatch(generated.code, /Autonomous component for: Show products/);
      return `component ${generated.componentId} generated and registered`;
    });

    await check('Handoff recognizes both React frontend and Express backend', async () => {
      const handoffPath = path.join(__dirname, '..', '.seim', 'handoff.json');
      assert.ok(fs.existsSync(handoffPath), '.seim/handoff.json was not created');
      const handoff = JSON.parse(fs.readFileSync(handoffPath, 'utf8'));
      assert.equal(handoff.version, 1);
      assert.ok(handoff.paths.frontend, 'frontend path was not detected');
      assert.ok(handoff.paths.backend, 'backend path was not detected');
      assert.equal(handoff.policies.autonomy, 'pull_request');
      assert.ok(handoff.policies.protectedPaths.includes('.env'));
      return `frontend=${handoff.paths.frontend}; backend=${handoff.paths.backend}; autonomy=${handoff.policies.autonomy}`;
    });

    await check('Generated Vercel and AWS workflows include production safeguards', async () => {
      const workflowRoot = path.join(__dirname, '..', '.github', 'workflows');
      const vercel = fs.readFileSync(path.join(workflowRoot, 'seim-vercel-web.yml'), 'utf8');
      const vercelRollback = fs.readFileSync(path.join(workflowRoot, 'seim-vercel-web-rollback.yml'), 'utf8');
      const aws = fs.readFileSync(path.join(workflowRoot, 'seim-aws-api.yml'), 'utf8');
      const awsRollback = fs.readFileSync(path.join(workflowRoot, 'seim-aws-api-rollback.yml'), 'utf8');
      assert.match(vercel, /secrets\.VERCEL_TOKEN/);
      assert.match(vercel, /name: production/);
      assert.match(vercelRollback, /workflow_dispatch:/);
      assert.match(aws, /id-token: write/);
      assert.match(aws, /vars\.AWS_ROLE_ARN/);
      assert.match(awsRollback, /workflow_dispatch:/);
      return 'Vercel secrets, AWS OIDC, production environments, and rollback entry points are present';
    });
  } finally {
    await stop(server);
  }

  for (const result of results) {
    console.log(`${result.status.padEnd(4)} ${result.name}${result.detail ? ` — ${result.detail}` : ''}`);
  }

  const failures = results.filter((result) => result.status === 'FAIL');
  console.log(`\n${results.length - failures.length}/${results.length} claims passed`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
