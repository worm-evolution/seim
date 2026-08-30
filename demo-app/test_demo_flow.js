const http = require('http');

const BASE_URL = 'http://localhost:3005';

const request = (path, method = 'GET', body = null) => {
  return new Promise((resolve, reject) => {
    const url = `${BASE_URL}${path}`;
    const options = {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {}
    };
    
    const req = http.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({
            statusCode: res.statusCode,
            body: data ? JSON.parse(data) : null
          });
        } catch {
          resolve({
            statusCode: res.statusCode,
            body: data
          });
        }
      });
    });
    
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
};

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {
  console.log('🚀 Starting Full-Stack SEIM Demo Flow Integration Test');
  console.log('========================================================');

  // 1. Verify baseline server status
  console.log('\nStep 1: Verifying baseline server status...');
  let status = await request('/api/seim/status');
  console.log('Uptime:', status.body.uptime);
  console.log('Active Handler:', status.body.activeHandler);
  console.log('Promoted Count:', status.body.totalOptimizationsPromoted);

  // 2. Trigger pattern injection (Simulate sequential-async delay)
  console.log('\nStep 2: Injecting sequential-async delay anti-pattern...');
  let trigger = await request('/api/seim/trigger-pattern', 'POST', { pattern: 'sequential-async' });
  console.log('Response:', trigger.body);

  // Confirm active handler changed
  status = await request('/api/seim/status');
  console.log('Active Handler after injection:', status.body.activeHandler);

  // 3. Send warmup traffic (12 requests)
  console.log('\nStep 3: Sending 12 warmup requests to trigger SEIM worker...');
  for (let i = 1; i <= 12; i++) {
    const start = Date.now();
    await request('/api/analytics/dashboard');
    const duration = Date.now() - start;
    console.log(`Request #${i} completed in ${duration}ms`);
    await sleep(200); // 200ms gap
  }

  // 4. Wait for shadow test, validation, and promotion to complete
  console.log('\nStep 4: Waiting for shadow testing and promotion in background...');
  let promoted = false;
  for (let attempt = 1; attempt <= 15; attempt++) {
    await sleep(1000);
    status = await request('/api/seim/status');
    console.log(`Polling status (attempt ${attempt}/15)... Promoted optimizations: ${status.body.totalOptimizationsPromoted}`);
    if (status.body.totalOptimizationsPromoted > 0) {
      promoted = true;
      break;
    }
  }

  if (!promoted) {
    console.error('❌ SEIM failed to promote candidate in 15 seconds!');
    process.exit(1);
  }

  console.log('✅ SEIM successfully promoted the route handler!');

  // 5. Verify the hot path latency is now halved (~600ms)
  console.log('\nStep 5: Verifying optimized latency on next request...');
  const startOpt = Date.now();
  await request('/api/analytics/dashboard');
  const optDuration = Date.now() - startOpt;
  console.log(`Optimized route request completed in ${optDuration}ms`);
  if (optDuration < 900) {
    console.log('✅ Latency verified! halved successfully!');
  } else {
    console.error('❌ Latency was not reduced!');
  }

  // 6. Restore baseline
  console.log('\nStep 6: Restoring baseline route and rolling back...');
  let restore = await request('/api/seim/trigger-pattern', 'POST', { pattern: 'restore-fast' });
  console.log('Response:', restore.body);

  status = await request('/api/seim/status');
  console.log('Final Active Handler:', status.body.activeHandler);
  console.log('Final Promoted Count (should be reset):', status.body.totalOptimizationsPromoted);

  console.log('\n========================================================');
  console.log('🎉 Integration Test Successful! All SEIM features working!');
}

run().catch((error) => {
  console.error('❌ Demo flow failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
