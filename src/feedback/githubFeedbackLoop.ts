import { createHash, createHmac, timingSafeEqual } from 'crypto';
import type { ProductIssue } from '../issueStream';
import type { EngineerJob } from '../engineer/types';
import type { SeimEventBus } from '../events';
import type { Logger } from '../logger';
import type { FeedbackStore } from './store';
import type { GitHubActionsClientLike } from './githubClient';
import type { DeliveryFeedbackRecord, FailedWorkflowStep, GitHubFeedbackResult, GitHubWorkflowRunPayload } from './types';

export interface FeedbackEngineer {
  submit(issue: ProductIssue, options: { rootDir: string; baseBranch: string; autoRun: boolean; maxVerificationMs?: number }): Promise<EngineerJob>;
}

export interface GitHubFeedbackLoopOptions {
  webhookSecret: string;
  repository: string;
  rootDir: string;
  baseBranch: string;
  allowedBranches?: string[];
  allowedWorkflowPrefixes?: string[];
  maxPayloadBytes?: number;
  maxTransientRetries?: number;
  maxRepairsPerFingerprint?: number;
  maxVerificationMs?: number;
}

/** Converts authenticated GitHub delivery failures into bounded retries or verified repair PRs. */
export class GitHubFeedbackLoop {
  constructor(
    private options: GitHubFeedbackLoopOptions,
    private store: FeedbackStore,
    private github: GitHubActionsClientLike,
    private engineer: FeedbackEngineer,
    private events?: SeimEventBus,
    private logger?: Logger,
  ) {
    if (!options.webhookSecret) throw new Error('GitHub feedback requires a webhook secret');
    if (!options.repository || !options.rootDir || !options.baseBranch) throw new Error('GitHub feedback requires repository, rootDir, and baseBranch');
  }

  public verify(body: Buffer, signature: string | undefined): boolean {
    if (!signature?.startsWith('sha256=')) return false;
    const expected = Buffer.from(`sha256=${createHmac('sha256', this.options.webhookSecret).update(body).digest('hex')}`);
    const actual = Buffer.from(signature);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  public async handle(event: string, deliveryId: string, signature: string | undefined, body: Buffer): Promise<GitHubFeedbackResult> {
    if (body.length > (this.options.maxPayloadBytes || 1024 * 1024)) throw new FeedbackHttpError(413, 'GitHub webhook payload is too large');
    if (!this.verify(body, signature)) throw new FeedbackHttpError(401, 'Invalid GitHub webhook signature');
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(deliveryId)) throw new FeedbackHttpError(400, 'Invalid GitHub delivery identifier');
    let payload: any;
    try { payload = JSON.parse(body.toString('utf8')); } catch { throw new FeedbackHttpError(400, 'GitHub webhook body must be valid JSON'); }

    const now = Date.now();
    const record: DeliveryFeedbackRecord = { deliveryId, event, status: 'received', createdAt: now, updatedAt: now };
    if (!await this.store.claim(record)) return { accepted: true, duplicate: true, record: (await this.store.get(deliveryId)) || record };

    try {
      if (event === 'ping') return this.finish(record, 'ignored', 'GitHub webhook ping accepted');
      if (event === 'workflow_run') return await this.workflowRun(record, payload as GitHubWorkflowRunPayload);
      if (event === 'deployment_status') return await this.deploymentStatus(record, payload);
      return this.finish(record, 'ignored', `Unsupported GitHub event: ${event}`);
    } catch (error) {
      record.status = 'failed';
      record.reason = error instanceof Error ? error.message : String(error);
      record.updatedAt = Date.now();
      await this.store.save(record);
      this.logger?.warn('[GitHubFeedback] Delivery failed', { deliveryId, reason: record.reason });
      return { accepted: true, record };
    }
  }

  public async list(): Promise<DeliveryFeedbackRecord[]> { return this.store.list(); }

  private async workflowRun(record: DeliveryFeedbackRecord, payload: GitHubWorkflowRunPayload): Promise<GitHubFeedbackResult> {
    const run = payload.workflow_run;
    const repository = payload.repository?.full_name;
    record.repository = repository;
    record.workflowRunId = run?.id;
    record.workflowName = run?.name || payload.workflow?.name;
    record.headBranch = run?.head_branch || undefined;
    record.headSha = run?.head_sha;
    record.conclusion = run?.conclusion || undefined;
    if (payload.action !== 'completed' || !run?.id) return this.finish(record, 'ignored', 'Workflow run is not completed');
    if (repository?.toLowerCase() !== this.options.repository.toLowerCase()) return this.finish(record, 'ignored', 'Repository does not match the configured application');
    if (!this.workflowAllowed(record.workflowName, payload.workflow?.path)) return this.finish(record, 'ignored', 'Workflow is outside the SEIM delivery allowlist');
    if (!this.branchAllowed(record.headBranch)) return this.finish(record, 'ignored', 'Branch is outside the repair allowlist');
    if (record.conclusion === 'success') return this.finish(record, 'resolved', 'Workflow completed successfully');
    if (!isActionableConclusion(record.conclusion)) return this.finish(record, 'ignored', `Workflow conclusion is not actionable: ${record.conclusion || 'unknown'}`);

    record.failedSteps = await this.github.failedSteps(run.id);
    record.fingerprint = fingerprint(record.workflowName, record.headBranch, record.failedSteps);
    if (isTransient(record.conclusion) && (run.run_attempt || 1) <= (this.options.maxTransientRetries ?? 1)) {
      const currentHead = record.headBranch ? await this.github.branchHead(record.headBranch) : undefined;
      if (currentHead && currentHead === record.headSha) {
        await this.github.rerunFailedJobs(run.id);
        record.retryRequested = true;
        return this.finish(record, 'retrying', 'One bounded retry requested for a transient failure');
      }
    }
    return this.repair(record, run.html_url);
  }

  private async deploymentStatus(record: DeliveryFeedbackRecord, payload: any): Promise<GitHubFeedbackResult> {
    record.repository = payload.repository?.full_name;
    record.headBranch = typeof payload.deployment?.ref === 'string' ? payload.deployment.ref : undefined;
    record.headSha = typeof payload.deployment?.sha === 'string' ? payload.deployment.sha : undefined;
    record.workflowName = `deployment:${safeText(payload.deployment_status?.environment || payload.deployment?.environment || 'production')}`;
    record.conclusion = safeText(payload.deployment_status?.state || 'unknown');
    if (record.repository?.toLowerCase() !== this.options.repository.toLowerCase()) return this.finish(record, 'ignored', 'Repository does not match the configured application');
    if (!this.branchAllowed(record.headBranch)) return this.finish(record, 'ignored', 'Branch is outside the repair allowlist');
    if (['success', 'active'].includes(record.conclusion)) return this.finish(record, 'resolved', 'Deployment is healthy');
    if (!['failure', 'error'].includes(record.conclusion)) return this.finish(record, 'ignored', `Deployment state is not actionable: ${record.conclusion}`);
    record.failedSteps = [{ job: record.workflowName, step: safeText(payload.deployment_status?.description || 'deployment failed'), conclusion: record.conclusion }];
    record.fingerprint = fingerprint(record.workflowName, record.headBranch, record.failedSteps);
    return this.repair(record, payload.deployment_status?.target_url);
  }

  private async repair(record: DeliveryFeedbackRecord, detailsUrl?: string): Promise<GitHubFeedbackResult> {
    const previous = (await this.store.list()).filter(item => item.deliveryId !== record.deliveryId && item.fingerprint === record.fingerprint && ['repairing', 'repair_pr_open', 'failed'].includes(item.status));
    if (previous.length >= (this.options.maxRepairsPerFingerprint ?? 2)) return this.finish(record, 'ignored', 'Repair circuit breaker opened for this recurring failure');
    record.status = 'repairing';
    record.updatedAt = Date.now();
    await this.store.save(record);
    const issue = this.toIssue(record, detailsUrl);
    const job = await this.engineer.submit(issue, {
      rootDir: this.options.rootDir,
      baseBranch: this.options.baseBranch,
      autoRun: true,
      maxVerificationMs: this.options.maxVerificationMs,
    });
    record.engineerJob = { id: job.id, status: job.status, pullRequest: job.pullRequest, failureReason: job.failureReason };
    if (job.status === 'pr_open') return this.finish(record, 'repair_pr_open', `Verified repair pull request opened: ${job.pullRequest?.url || job.pullRequest?.id || job.id}`);
    return this.finish(record, 'failed', job.failureReason || `Repair job stopped in status ${job.status}`);
  }

  private toIssue(record: DeliveryFeedbackRecord, detailsUrl?: string): ProductIssue {
    const steps = record.failedSteps?.map(item => `${item.job}${item.step ? ` / ${item.step}` : ''}: ${item.conclusion}`).join('; ') || 'failure details unavailable';
    const now = Date.now();
    return {
      id: `github_failure_${record.deliveryId}`,
      type: 'bug:error_pattern',
      path: `/ci/${slug(record.workflowName || 'deployment')}`,
      severity: record.workflowName?.startsWith('deployment:') ? 'critical' : 'high',
      frequency: 1,
      affectedSessions: 1,
      evidence: [{ source: 'github', deliveryId: record.deliveryId, runId: record.workflowRunId, workflow: record.workflowName, headSha: record.headSha, headBranch: record.headBranch, failedSteps: record.failedSteps, detailsUrl }],
      suggestedAction: `Diagnose and repair the failed ${record.workflowName || 'GitHub workflow'} at ${record.headSha || 'the current revision'}. Failed checks: ${steps}. Preserve application behavior and deployment security.`,
      detectedAt: now,
      updatedAt: now,
      status: 'open',
      intentMetadata: { source: 'github-feedback', fingerprint: record.fingerprint },
    };
  }

  private workflowAllowed(name?: string, workflowPath?: string): boolean {
    const prefixes = this.options.allowedWorkflowPrefixes || ['SEIM'];
    return prefixes.some(prefix => name?.startsWith(prefix)) || /(^|\/)seim-[^/]+\.ya?ml$/i.test(workflowPath || '');
  }
  private branchAllowed(branch?: string): boolean { return !!branch && (this.options.allowedBranches || [this.options.baseBranch]).includes(branch); }
  private async finish(record: DeliveryFeedbackRecord, status: DeliveryFeedbackRecord['status'], reason: string): Promise<GitHubFeedbackResult> {
    record.status = status; record.reason = reason; record.updatedAt = Date.now();
    await this.store.save(record);
    this.events?.emitEvent('engineer:delivery-feedback', record);
    return { accepted: true, record };
  }
}

export class FeedbackHttpError extends Error { constructor(public statusCode: number, message: string) { super(message); } }

function isActionableConclusion(value?: string): boolean { return ['failure', 'timed_out', 'startup_failure', 'stale'].includes(value || ''); }
function isTransient(value?: string): boolean { return ['timed_out', 'startup_failure', 'stale'].includes(value || ''); }
function fingerprint(workflow?: string, branch?: string, steps: FailedWorkflowStep[] = []): string {
  const normalized = steps.map(item => `${item.job}/${item.step || ''}/${item.conclusion}`).sort();
  return createHash('sha256').update(JSON.stringify([workflow || '', branch || '', normalized])).digest('hex');
}
function slug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'failure'; }
function safeText(value: unknown): string { return typeof value === 'string' ? value.trim().slice(0, 500) : ''; }
