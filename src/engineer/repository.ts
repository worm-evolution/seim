import { createHash } from 'crypto';
import { ChangeFile, ProjectManifest, PullRequestRecord } from './types';
import { staticGitHubToken, type GitHubTokenProvider } from '../github';

export interface PublishRequest {
  manifest: ProjectManifest;
  branch: string;
  title: string;
  body: string;
  files: ChangeFile[];
}

export interface RepositoryProvider {
  readonly name: string;
  publish(request: PublishRequest): Promise<PullRequestRecord>;
  merge?(pullRequest: PullRequestRecord): Promise<void>;
}

export class MemoryRepositoryProvider implements RepositoryProvider {
  public readonly name = 'memory';
  public readonly published: PublishRequest[] = [];
  private nextNumber = 1;
  public async publish(request: PublishRequest): Promise<PullRequestRecord> {
    this.published.push(request);
    return { provider: this.name, id: `memory-pr-${this.nextNumber}`, number: this.nextNumber++, branch: request.branch, baseBranch: request.manifest.baseBranch, title: request.title, createdAt: Date.now() };
  }
}

export interface GitHubRepositoryOptions {
  owner: string;
  repository: string;
  token?: string;
  tokenProvider?: GitHubTokenProvider;
  apiBaseUrl?: string;
}

/** GitHub REST implementation that publishes every plan as one atomic Git commit. */
export class GitHubRepositoryProvider implements RepositoryProvider {
  public readonly name = 'github';
  private readonly baseUrl: string;
  private readonly tokenProvider: GitHubTokenProvider;

  constructor(private options: GitHubRepositoryOptions) {
    this.baseUrl = (options.apiBaseUrl || 'https://api.github.com').replace(/\/$/, '');
    if (!options.owner || !options.repository || (!options.token && !options.tokenProvider)) throw new Error('GitHub repository provider requires owner, repository, and authentication');
    this.tokenProvider = options.tokenProvider || staticGitHubToken(options.token || '');
  }

  public async publish(request: PublishRequest): Promise<PullRequestRecord> {
    if (request.files.length === 0) throw new Error('GitHub publish requires at least one file');
    const repo = `/repos/${encodeURIComponent(this.options.owner)}/${encodeURIComponent(this.options.repository)}`;
    const baseRef = await this.request<any>(`${repo}/git/ref/heads/${encodeURIComponent(request.manifest.baseBranch)}`);
    const baseCommitSha = baseRef.object?.sha;
    if (!baseCommitSha) throw new Error('GitHub did not return the base branch SHA');
    const baseCommit = await this.request<any>(`${repo}/git/commits/${encodeURIComponent(baseCommitSha)}`);
    const baseTreeSha = baseCommit.tree?.sha;
    if (!baseTreeSha) throw new Error('GitHub did not return the base tree SHA');
    const baseTree = await this.request<any>(`${repo}/git/trees/${encodeURIComponent(baseTreeSha)}?recursive=1`);
    const existingModes = new Map<string, string>((baseTree.tree || []).filter((item: any) => item.type === 'blob').map((item: any) => [item.path, item.mode]));

    await this.verifySourceHashes(repo, request);
    const tree: Array<{ path: string; mode?: string; type?: 'blob'; sha: string | null }> = [];
    for (const file of request.files) {
      const filePath = normalizeRepositoryPath(file.path);
      if (file.operation === 'delete') {
        tree.push({ path: filePath, sha: null });
        continue;
      }
      if (file.content === undefined) throw new Error(`Change ${file.path} has no content`);
      const blob = await this.request<any>(`${repo}/git/blobs`, {
        method: 'POST',
        body: JSON.stringify({ content: file.content, encoding: 'utf-8' }),
      });
      if (!blob.sha) throw new Error(`GitHub did not create a blob for ${filePath}`);
      tree.push({ path: filePath, mode: existingModes.get(filePath) || (file.content.startsWith('#!') ? '100755' : '100644'), type: 'blob', sha: blob.sha });
    }

    const createdTree = await this.request<any>(`${repo}/git/trees`, { method: 'POST', body: JSON.stringify({ base_tree: baseTreeSha, tree }) });
    if (!createdTree.sha) throw new Error('GitHub did not create the change tree');
    const commit = await this.request<any>(`${repo}/git/commits`, {
      method: 'POST',
      body: JSON.stringify({ message: `feat(seim): ${request.title}`, tree: createdTree.sha, parents: [baseCommitSha] }),
    });
    if (!commit.sha) throw new Error('GitHub did not create the change commit');
    await this.request(`${repo}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${request.branch}`, sha: commit.sha }) });

    const pr = await this.request<any>(`${repo}/pulls`, {
      method: 'POST',
      body: JSON.stringify({ title: request.title, body: request.body, head: request.branch, base: request.manifest.baseBranch }),
    });
    let autoMergeEnabled: boolean | undefined;
    let autoMergeReason: string | undefined;
    if (['merge', 'deploy'].includes(request.manifest.handoff?.policies.autonomy || '') && pr.node_id) {
      try {
        await this.enableAutoMerge(pr.node_id);
        autoMergeEnabled = true;
      } catch (error) {
        autoMergeEnabled = false;
        autoMergeReason = error instanceof Error ? error.message.slice(0, 500) : 'GitHub auto-merge was unavailable';
      }
    }
    return { provider: this.name, id: String(pr.id || pr.number), number: pr.number, url: pr.html_url, branch: request.branch, baseBranch: request.manifest.baseBranch, title: request.title, autoMergeEnabled, autoMergeReason, createdAt: Date.now() };
  }

  public async merge(pullRequest: PullRequestRecord): Promise<void> {
    if (!pullRequest.number) throw new Error('GitHub pull request number is required for merge');
    const result = await this.request<any>(`/repos/${encodeURIComponent(this.options.owner)}/${encodeURIComponent(this.options.repository)}/pulls/${pullRequest.number}/merge`, {
      method: 'PUT', body: JSON.stringify({ merge_method: 'squash' }),
    });
    if (result?.merged === false) throw new Error(`GitHub refused to merge pull request ${pullRequest.number}: ${result.message || 'unknown reason'}`);
  }

  private async enableAutoMerge(pullRequestId: string): Promise<void> {
    const result = await this.request<any>('/graphql', {
      method: 'POST',
      body: JSON.stringify({
        query: 'mutation EnableSeimAutoMerge($pullRequestId: ID!) { enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: SQUASH }) { pullRequest { id autoMergeRequest { enabledAt } } } }',
        variables: { pullRequestId },
      }),
    });
    if (Array.isArray(result?.errors) && result.errors.length) throw new Error(`GitHub could not enable protected auto-merge: ${String(result.errors[0]?.message || 'unknown error')}`);
    if (!result?.data?.enablePullRequestAutoMerge?.pullRequest?.autoMergeRequest) throw new Error('GitHub did not enable protected auto-merge');
  }

  private async verifySourceHashes(repo: string, request: PublishRequest): Promise<void> {
    for (const file of request.files.filter(candidate => candidate.expectedSha256)) {
      const filePath = normalizeRepositoryPath(file.path);
      let existing: any;
      try { existing = await this.request<any>(`${repo}/contents/${encodeRepositoryPath(filePath)}?ref=${encodeURIComponent(request.manifest.baseBranch)}`); }
      catch { throw new Error(`Source changed while planning: ${filePath} no longer exists`); }
      const content = typeof existing.content === 'string' ? Buffer.from(existing.content.replace(/\s/g, ''), existing.encoding === 'base64' ? 'base64' : 'utf8') : Buffer.alloc(0);
      const current = createHash('sha256').update(content).digest('hex');
      if (current !== file.expectedSha256) throw new Error(`Source changed while planning: ${filePath}`);
    }
  }

  private async request<T = unknown>(endpoint: string, init: RequestInit = {}): Promise<T> {
    const token = await this.tokenProvider();
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      ...init,
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json', ...(init.headers || {}) },
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`GitHub API ${response.status}: ${detail}`);
    }
    return response.status === 204 ? (undefined as T) : await response.json() as T;
  }
}

function normalizeRepositoryPath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.split('/').includes('..')) throw new Error(`Invalid repository path: ${value}`);
  return normalized;
}
function encodeRepositoryPath(value: string): string { return value.split('/').map(encodeURIComponent).join('/'); }
