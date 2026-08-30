import { PrGenerator } from '../src/prGenerator';
import { ProductIssue } from '../src/issueStream';
import * as fs from 'fs';
import * as path from 'path';

describe('Telemetry-Driven PR & Staging Branch Generator', () => {
  const testStorageDir = path.join(__dirname, '.test-pr-storage');

  beforeEach(() => {
    if (fs.existsSync(testStorageDir)) {
      fs.rmSync(testStorageDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(testStorageDir)) {
      fs.rmSync(testStorageDir, { recursive: true, force: true });
    }
  });

  it('should generate a clean PR, staging branch, and patch from a detected issue', async () => {
    const generator = new PrGenerator({} as any, testStorageDir);

    const mockIssue: ProductIssue = {
      id: 'issue_cart_123',
      type: 'feature:missing_api',
      path: '/api/v1/cart',
      method: 'POST',
      frequency: 5,
      affectedSessions: 4,
      severity: 'high',
      detectedAt: Date.now() - 10000,
      updatedAt: Date.now(),
      evidence: [],
      suggestedAction: 'Scaffold POST /api/v1/cart',
      status: 'open',
    };

    const handlerCode = `async function cartHandler(req, res) {
  const { productId, quantity } = req.body || {};
  res.status(201).json({ success: true, item: { productId, quantity } });
}`;

    const pr = await generator.createPrFromIssue(mockIssue, handlerCode);

    expect(pr.number).toBe(1);
    expect(pr.id).toBe('PR-1');
    expect(pr.branchName).toBe('seim/feat-api-v1-cart');
    expect(pr.title).toContain('autonomously implement POST /api/v1/cart');
    expect(pr.description).toContain('4'); // affected visitor sessions
    expect(pr.patch).toContain('diff --git a//api/v1/cart b//api/v1/cart');
    expect(pr.status).toBe('open');

    // Check patch file persistence
    expect(fs.existsSync(pr.patchPath!)).toBe(true);
    expect(fs.existsSync(pr.docPath!)).toBe(true);

    // Merge PR
    const merged = generator.mergePr(pr.id);
    expect(merged).toBe(true);
    expect(generator.getById(pr.id)?.status).toBe('merged');
  });

  it('should generate an optimization PR from route performance data', async () => {
    const generator = new PrGenerator({} as any, testStorageDir);

    const pr = await generator.createPrFromOptimization(
      '/api/users/checkout',
      'const user = await getUser(); const cart = await getCart();',
      'const [user, cart] = await Promise.all([getUser(), getCart()]);',
      '120ms'
    );

    expect(pr.id).toBe('PR-1');
    expect(pr.branchName).toBe('seim/perf-api-users-checkout');
    expect(pr.title).toContain('optimize latency on /api/users/checkout (-120ms)');
    expect(pr.patch).toContain('Promise.all');
  });
});
