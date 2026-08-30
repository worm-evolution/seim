import { createHmac } from 'crypto';
import { GitHubFeedbackLoop, MemoryFeedbackStore, type FeedbackEngineer, type GitHubActionsClientLike } from '../src/feedback';
import type { ProductIssue } from '../src/issueStream';
import type { EngineerJob } from '../src/engineer';

describe('GitHubFeedbackLoop', () => {
  const secret = 'test-webhook-secret';
  let github: FakeGitHub;
  let engineer: FakeEngineer;
  let store: MemoryFeedbackStore;
  let loop: GitHubFeedbackLoop;

  beforeEach(() => {
    github = new FakeGitHub();
    engineer = new FakeEngineer();
    store = new MemoryFeedbackStore();
    loop = new GitHubFeedbackLoop({ webhookSecret: secret, repository: 'acme/app', rootDir: '/app', baseBranch: 'main' }, store, github, engineer);
  });

  it('rejects spoofed deliveries before storing or executing them', async () => {
    const body = payload({ conclusion: 'failure' });
    await expect(loop.handle('workflow_run', 'delivery-1', 'sha256=bad', body)).rejects.toMatchObject({ statusCode: 401 });
    expect(await store.list()).toHaveLength(0);
    expect(engineer.issues).toHaveLength(0);
  });

  it('deduplicates webhook delivery identifiers', async () => {
    const body = payload({ conclusion: 'failure' });
    const first = await loop.handle('workflow_run', 'delivery-2', signature(body), body);
    const second = await loop.handle('workflow_run', 'delivery-2', signature(body), body);
    expect(first.record.status).toBe('repair_pr_open');
    expect(second.duplicate).toBe(true);
    expect(engineer.issues).toHaveLength(1);
  });

  it('retries one transient failure only when the branch still points at the failed SHA', async () => {
    github.head = 'commit-1';
    const body = payload({ conclusion: 'timed_out', run_attempt: 1 });
    const result = await loop.handle('workflow_run', 'delivery-3', signature(body), body);
    expect(result.record.status).toBe('retrying');
    expect(github.reruns).toEqual([101]);
    expect(engineer.issues).toHaveLength(0);
  });

  it('does not retry stale code and creates a bounded repair PR instead', async () => {
    github.head = 'newer-commit';
    const body = payload({ conclusion: 'timed_out', run_attempt: 1 });
    const result = await loop.handle('workflow_run', 'delivery-4', signature(body), body);
    expect(result.record.status).toBe('repair_pr_open');
    expect(github.reruns).toHaveLength(0);
    expect(engineer.issues[0].intentMetadata?.source).toBe('github-feedback');
  });

  it('ignores non-SEIM workflows and unapproved branches', async () => {
    const foreign = payload({ name: 'Third-party workflow', conclusion: 'failure' });
    const branch = payload({ branch: 'feature/untrusted', conclusion: 'failure' });
    expect((await loop.handle('workflow_run', 'delivery-5', signature(foreign), foreign)).record.status).toBe('ignored');
    expect((await loop.handle('workflow_run', 'delivery-6', signature(branch), branch)).record.status).toBe('ignored');
    expect(engineer.issues).toHaveLength(0);
  });

  it('opens the circuit breaker after two equivalent repair attempts', async () => {
    for (let index = 0; index < 3; index++) {
      const body = payload({ conclusion: 'failure' });
      await loop.handle('workflow_run', `repair-${index}`, signature(body), body);
    }
    const records = await store.list();
    expect(records.find(item => item.deliveryId === 'repair-2')?.status).toBe('ignored');
    expect(engineer.issues).toHaveLength(2);
  });

  function signature(body: Buffer): string { return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`; }
});

class FakeGitHub implements GitHubActionsClientLike {
  public head = 'commit-1';
  public reruns: number[] = [];
  public async failedSteps(): Promise<any[]> { return [{ job: 'verify', step: 'Run tests', conclusion: 'failure' }]; }
  public async branchHead(): Promise<string> { return this.head; }
  public async rerunFailedJobs(runId: number): Promise<void> { this.reruns.push(runId); }
}

class FakeEngineer implements FeedbackEngineer {
  public issues: ProductIssue[] = [];
  public async submit(issue: ProductIssue): Promise<EngineerJob> {
    this.issues.push(issue);
    const now = Date.now();
    return { id: `job-${this.issues.length}`, issue, manifest: {} as any, status: 'pr_open', pullRequest: { provider: 'github', id: '1', branch: 'seim/repair', baseBranch: 'main', title: 'repair', url: 'https://github.example/pr/1', createdAt: now }, createdAt: now, updatedAt: now };
  }
}

function payload(options: { name?: string; conclusion: string; run_attempt?: number; branch?: string }): Buffer {
  return Buffer.from(JSON.stringify({
    action: 'completed',
    repository: { full_name: 'acme/app' },
    workflow: { name: options.name || 'SEIM Verify', path: options.name === 'Third-party workflow' ? '.github/workflows/third-party.yml' : '.github/workflows/seim-verify.yml' },
    workflow_run: { id: 101, name: options.name || 'SEIM Verify', conclusion: options.conclusion, run_attempt: options.run_attempt || 1, head_branch: options.branch || 'main', head_sha: 'commit-1', html_url: 'https://github.example/actions/runs/101' },
  }));
}
