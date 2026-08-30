import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitHubRepositoryProvider, ProjectAdapter } from '../src/engineer';

describe('GitHubRepositoryProvider atomic publication', () => {
  const originalFetch = global.fetch;
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'seim-github-provider-'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'app' }));
  });
  afterEach(() => {
    global.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('publishes all files as one commit after checking source hashes', async () => {
    const original = 'export const value = 1;\n';
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'app.ts'), original);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let blob = 0;
    global.fetch = jest.fn(async (input: any, init?: RequestInit) => {
      const url = String(input); calls.push({ url, init });
      if (url.includes('/git/ref/heads/')) return response({ object: { sha: 'base-commit' } });
      if (url.endsWith('/git/commits/base-commit')) return response({ tree: { sha: 'base-tree' } });
      if (url.includes('/git/trees/base-tree?recursive=1')) return response({ tree: [{ path: 'src/app.ts', type: 'blob', mode: '100644' }] });
      if (url.includes('/contents/src/app.ts')) return response({ encoding: 'base64', content: Buffer.from(original).toString('base64') });
      if (url.endsWith('/git/blobs')) return response({ sha: `blob-${++blob}` });
      if (url.endsWith('/git/trees')) return response({ sha: 'change-tree' });
      if (url.endsWith('/git/commits')) return response({ sha: 'change-commit' });
      if (url.endsWith('/git/refs')) return response({ ref: 'refs/heads/seim/test' });
      if (url.endsWith('/pulls')) return response({ id: 10, number: 7, html_url: 'https://github.example/pr/7' });
      return response({ message: 'not found' }, 404);
    }) as any;

    const provider = new GitHubRepositoryProvider({ owner: 'acme', repository: 'app', token: 'test-token', apiBaseUrl: 'https://github.example' });
    const result = await provider.publish({
      manifest: new ProjectAdapter().inspect(root), branch: 'seim/test', title: 'atomic change', body: 'verified',
      files: [
        { path: 'src/app.ts', operation: 'update', content: 'export const value = 2;\n', expectedSha256: createHash('sha256').update(original).digest('hex') },
        { path: 'src/new.ts', operation: 'create', content: 'export const added = true;\n' },
      ],
    });

    expect(result.number).toBe(7);
    expect(calls.filter(call => call.url.endsWith('/git/commits') && call.init?.method === 'POST')).toHaveLength(1);
    const treeCall = calls.find(call => call.url.endsWith('/git/trees') && call.init?.method === 'POST')!;
    const treeBody = JSON.parse(String(treeCall.init?.body));
    expect(treeBody.base_tree).toBe('base-tree');
    expect(treeBody.tree.map((entry: any) => entry.path)).toEqual(['src/app.ts', 'src/new.ts']);
    const refCall = calls.find(call => call.url.endsWith('/git/refs'))!;
    expect(JSON.parse(String(refCall.init?.body)).sha).toBe('change-commit');
    expect(calls.filter(call => call.url.endsWith('/contents/src/app.ts') && call.init?.method === 'PUT')).toHaveLength(0);
  });

  it('refuses publication when a planned source hash is stale', async () => {
    global.fetch = jest.fn(async (input: any) => {
      const url = String(input);
      if (url.includes('/git/ref/heads/')) return response({ object: { sha: 'base-commit' } });
      if (url.endsWith('/git/commits/base-commit')) return response({ tree: { sha: 'base-tree' } });
      if (url.includes('/git/trees/base-tree')) return response({ tree: [] });
      if (url.includes('/contents/src/app.ts')) return response({ encoding: 'base64', content: Buffer.from('changed').toString('base64') });
      return response({});
    }) as any;
    const provider = new GitHubRepositoryProvider({ owner: 'acme', repository: 'app', token: 'test-token', apiBaseUrl: 'https://github.example' });
    await expect(provider.publish({
      manifest: new ProjectAdapter().inspect(root), branch: 'seim/test', title: 'stale', body: '',
      files: [{ path: 'src/app.ts', operation: 'update', content: 'new', expectedSha256: createHash('sha256').update('old').digest('hex') }],
    })).rejects.toThrow(/Source changed while planning/);
  });

  it('requests protected auto-merge only for merge autonomy', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    global.fetch = jest.fn(async (input: any, init?: RequestInit) => {
      const url = String(input); calls.push({ url, init });
      if (url.includes('/git/ref/heads/')) return response({ object: { sha: 'base-commit' } });
      if (url.endsWith('/git/commits/base-commit')) return response({ tree: { sha: 'base-tree' } });
      if (url.includes('/git/trees/base-tree?recursive=1')) return response({ tree: [] });
      if (url.endsWith('/git/blobs')) return response({ sha: 'blob-1' });
      if (url.endsWith('/git/trees')) return response({ sha: 'change-tree' });
      if (url.endsWith('/git/commits')) return response({ sha: 'change-commit' });
      if (url.endsWith('/git/refs')) return response({});
      if (url.endsWith('/pulls')) return response({ id: 10, node_id: 'PR_node', number: 7, html_url: 'https://github.example/pr/7' });
      if (url.endsWith('/graphql')) return response({ data: { enablePullRequestAutoMerge: { pullRequest: { id: 'PR_node', autoMergeRequest: { enabledAt: new Date().toISOString() } } } } });
      return response({}, 404);
    }) as any;
    const manifest = new ProjectAdapter().inspect(root);
    manifest.handoff = { version: 1, application: { name: 'app' }, repository: { baseBranch: 'main' }, paths: {}, commands: {}, policies: { autonomy: 'merge', protectedPaths: [], approvalRequiredPaths: [], requireTests: false, requireBrowserForFrontend: false } };
    const provider = new GitHubRepositoryProvider({ owner: 'acme', repository: 'app', token: 'test-token', apiBaseUrl: 'https://github.example' });
    const result = await provider.publish({ manifest, branch: 'seim/repair', title: 'repair', body: '', files: [{ path: 'src/fix.ts', operation: 'create', content: 'export const fixed = true;\n' }] });
    expect(result.autoMergeEnabled).toBe(true);
    const graphql = calls.find(call => call.url.endsWith('/graphql'))!;
    expect(JSON.parse(String(graphql.init?.body))).toMatchObject({ variables: { pullRequestId: 'PR_node' } });
  });
});

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
