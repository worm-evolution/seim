import type { FailedWorkflowStep } from './types';
import { staticGitHubToken, type GitHubTokenProvider } from '../github';

export interface GitHubActionsClientOptions {
  owner: string;
  repository: string;
  token?: string;
  tokenProvider?: GitHubTokenProvider;
  apiBaseUrl?: string;
  apiVersion?: string;
}

export interface GitHubActionsClientLike {
  failedSteps(runId: number): Promise<FailedWorkflowStep[]>;
  branchHead(branch: string): Promise<string | undefined>;
  rerunFailedJobs(runId: number): Promise<void>;
}

/** Minimal Actions API client. Tokens are confined to the Authorization header. */
export class GitHubActionsClient implements GitHubActionsClientLike {
  private readonly baseUrl: string;
  private readonly tokenProvider: GitHubTokenProvider;
  constructor(private options: GitHubActionsClientOptions) {
    if (!options.owner || !options.repository || (!options.token && !options.tokenProvider)) throw new Error('GitHub Actions client requires owner, repository, and authentication');
    this.baseUrl = (options.apiBaseUrl || 'https://api.github.com').replace(/\/$/, '');
    this.tokenProvider = options.tokenProvider || staticGitHubToken(options.token || '');
  }

  public async failedSteps(runId: number): Promise<FailedWorkflowStep[]> {
    const data = await this.request<any>(`${this.repo()}/actions/runs/${runId}/jobs?filter=latest&per_page=100`);
    const failures: FailedWorkflowStep[] = [];
    for (const job of Array.isArray(data?.jobs) ? data.jobs : []) {
      const failed = (Array.isArray(job.steps) ? job.steps : []).filter((step: any) => isFailure(step.conclusion));
      if (failed.length === 0 && isFailure(job.conclusion)) failures.push({ job: safeText(job.name, 'unknown job'), conclusion: safeText(job.conclusion, 'failure') });
      for (const step of failed) failures.push({ job: safeText(job.name, 'unknown job'), step: safeText(step.name, 'unknown step'), conclusion: safeText(step.conclusion, 'failure') });
    }
    return failures.slice(0, 50);
  }

  public async branchHead(branch: string): Promise<string | undefined> {
    const data = await this.request<any>(`${this.repo()}/git/ref/heads/${encodeURIComponent(branch)}`);
    return typeof data?.object?.sha === 'string' ? data.object.sha : undefined;
  }

  public async rerunFailedJobs(runId: number): Promise<void> {
    await this.request(`${this.repo()}/actions/runs/${runId}/rerun-failed-jobs`, { method: 'POST', body: '{}' });
  }

  private repo(): string { return `/repos/${encodeURIComponent(this.options.owner)}/${encodeURIComponent(this.options.repository)}`; }
  private async request<T = unknown>(endpoint: string, init: RequestInit = {}): Promise<T> {
    const token = await this.tokenProvider();
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': this.options.apiVersion || '2022-11-28',
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    });
    if (!response.ok) throw new Error(`GitHub Actions API ${response.status}: ${(await response.text()).slice(0, 500)}`);
    return response.status === 204 || response.status === 201 ? (undefined as T) : await response.json() as T;
  }
}

function isFailure(value: unknown): boolean { return ['failure', 'timed_out', 'startup_failure', 'stale'].includes(String(value || '')); }
function safeText(value: unknown, fallback: string): string { return (typeof value === 'string' && value.trim() ? value.trim() : fallback).slice(0, 200); }
