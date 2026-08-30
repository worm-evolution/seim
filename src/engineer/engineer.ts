import { SeimEventBus } from '../events';
import { Logger } from '../logger';
import { ProductIssue } from '../issueStream';
import { ChangePlan, EngineerJob, EngineerJobStatus, EngineerOptions, ProjectManifest, PullRequestRecord } from './types';
import { ProjectAdapter } from './projectAdapter';
import { RiskPolicy } from './riskPolicy';
import { EngineerStore } from './store';
import { RepositoryProvider, PublishRequest } from './repository';
import { WorkspaceExecutor } from './executor';
import { IssuePlanner } from './planner';
import type { ApplicationControlPlane } from './controlPlane';
import type { ApplicationRegistration, EngineeringGoalInput, EngineeringPlan } from './types';

export interface ReleaseProvider {
  deploy(job: EngineerJob): Promise<void>;
  rollback(job: EngineerJob): Promise<void>;
}

export class SoftwareEngineer {
  constructor(
    private projectAdapter: ProjectAdapter,
    private planner: IssuePlanner,
    private policy: RiskPolicy,
    private executor: WorkspaceExecutor,
    private store: EngineerStore,
    private repository: RepositoryProvider,
    private logger: Logger,
    private events?: SeimEventBus,
    private release?: ReleaseProvider,
  ) {}

  private controlPlane?: ApplicationControlPlane;

  public attachControlPlane(controlPlane: ApplicationControlPlane): void { this.controlPlane = controlPlane; }
  public get applicationControlPlane(): ApplicationControlPlane | undefined { return this.controlPlane; }
  public async handoffApplication(rootDir: string, baseBranch?: string): Promise<ApplicationRegistration> { return this.requireControlPlane().handoff(rootDir, baseBranch); }
  public async listApplications(): Promise<ApplicationRegistration[]> { return this.requireControlPlane().listApplications(); }
  public async submitGoal(input: EngineeringGoalInput): Promise<EngineeringPlan> { return this.requireControlPlane().submitGoal(input); }
  public async listPlans(): Promise<EngineeringPlan[]> { return this.requireControlPlane().listPlans(); }
  public async getPlan(planId: string): Promise<EngineeringPlan | undefined> { return this.requireControlPlane().getPlan(planId); }
  public async runPlan(planId: string, options?: { maxVerificationMs?: number }): Promise<EngineeringPlan> { return this.requireControlPlane().runPlan(planId, options); }
  public async approveTask(planId: string, taskId: string): Promise<EngineeringPlan> { return this.requireControlPlane().approveTask(planId, taskId); }
  public async mergeTask(planId: string, taskId: string): Promise<EngineeringPlan> { return this.requireControlPlane().mergeTask(planId, taskId); }
  public async completeTask(planId: string, taskId: string): Promise<EngineeringPlan> { return this.requireControlPlane().completeTask(planId, taskId); }
  private requireControlPlane(): ApplicationControlPlane {
    if (!this.controlPlane) throw new Error('Application control plane is not configured');
    return this.controlPlane;
  }

  public async submit(issue: ProductIssue, options: EngineerOptions = {}): Promise<EngineerJob> {
    const manifest = this.projectAdapter.inspect(options.rootDir || process.cwd(), options.baseBranch ? { baseBranch: options.baseBranch } : {});
    const plan = await this.planner.create(issue, manifest);
    const now = Date.now();
    const job: EngineerJob = {
      id: `eng_${now}_${Math.random().toString(36).slice(2, 10)}`,
      issue,
      manifest,
      plan,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
    };
    await this.save(job);
    this.emit('engineer:job-created', job);
    if (options.autoRun) return this.run(job.id, options);
    return job;
  }

  public async run(jobId: string, options: EngineerOptions = {}): Promise<EngineerJob> {
    const job = await this.requireJob(jobId);
    if (!job.plan) return this.fail(job, 'Job has no change plan');
    if (job.status === 'deployed' || job.status === 'pr_open' || job.status === 'awaiting_approval') return job;

    job.status = 'verifying';
    await this.save(job);
    const decision = this.policy.evaluate(job.plan, job.manifest);
    job.risk = decision.risk;
    if (!decision.allowed) return this.fail(job, decision.reasons.join('; '));

    job.verification = await this.executor.verify(job.manifest, job.plan.files, options.maxVerificationMs);
    if (!job.verification.passed) return this.fail(job, 'Verification failed');
    if (decision.requiresApproval) {
      job.status = 'awaiting_approval';
      await this.save(job);
      this.emit('engineer:approval-required', { job, reasons: decision.reasons });
      return job;
    }
    return this.publish(job);
  }

  public async approve(jobId: string): Promise<EngineerJob> {
    const job = await this.requireJob(jobId);
    if (job.status !== 'awaiting_approval') throw new Error(`Job ${jobId} is not awaiting approval`);
    if (!job.verification?.passed) throw new Error(`Job ${jobId} has no passing verification report`);
    return this.publish(job);
  }

  public async merge(jobId: string): Promise<EngineerJob> {
    const job = await this.requireJob(jobId);
    const autonomy = job.manifest.handoff?.policies.autonomy;
    if (autonomy && autonomy !== 'merge' && autonomy !== 'deploy') throw new Error(`Handoff autonomy ${autonomy} does not allow merging`);
    if (job.status !== 'pr_open' || !job.pullRequest) throw new Error(`Job ${jobId} has no open pull request`);
    if (!this.repository.merge) throw new Error(`Repository provider ${this.repository.name} does not support merging`);
    await this.repository.merge(job.pullRequest);
    job.status = 'approved';
    await this.save(job);
    if (this.release && (!autonomy || autonomy === 'deploy')) {
      await this.release.deploy(job);
      job.status = 'deployed';
      await this.save(job);
    }
    this.emit('engineer:deployed', job);
    return job;
  }

  public async rollback(jobId: string): Promise<EngineerJob> {
    const job = await this.requireJob(jobId);
    if (!this.release) throw new Error('No release provider is configured for rollback');
    await this.release.rollback(job);
    job.status = 'rolled_back';
    await this.save(job);
    this.emit('engineer:rolled-back', job);
    return job;
  }

  public async get(jobId: string): Promise<EngineerJob | undefined> { return this.store.get(jobId); }
  public async list(): Promise<EngineerJob[]> { return this.store.list(); }

  private async publish(job: EngineerJob): Promise<EngineerJob> {
    const plan = job.plan!;
    const branch = `seim/engineer/${job.id}`;
    const request: PublishRequest = {
      manifest: job.manifest,
      branch,
      title: plan.title,
      body: this.pullRequestBody(job, plan),
      files: plan.files,
    };
    try {
      job.pullRequest = await this.repository.publish(request);
      job.status = 'pr_open';
      await this.save(job);
      this.emit('engineer:pull-request-created', job);
      return job;
    } catch (error) {
      return this.fail(job, error instanceof Error ? error.message : String(error));
    }
  }

  private pullRequestBody(job: EngineerJob, plan: ChangePlan): string {
    const checks = job.verification?.checks.map(check => `- ${check.name}: ${check.passed ? 'passed' : 'failed'}`).join('\n') || '- verification unavailable';
    return `## SEIM Software Engineer\n\n${plan.summary}\n\nRisk: **${job.risk || plan.risk}**\n\n### Verification\n${checks}\n\nThis pull request was generated from observed application behavior. Production credentials were not exposed to the build worker.`;
  }

  private async requireJob(id: string): Promise<EngineerJob> {
    const job = await this.store.get(id);
    if (!job) throw new Error(`Engineer job ${id} was not found`);
    return job;
  }

  private async fail(job: EngineerJob, reason: string): Promise<EngineerJob> {
    job.status = 'rejected';
    job.failureReason = reason;
    await this.save(job);
    this.logger.warn('Software engineer rejected job', { jobId: job.id, reason });
    this.emit('engineer:job-rejected', job);
    return job;
  }

  private async save(job: EngineerJob): Promise<void> {
    job.updatedAt = Date.now();
    await this.store.save(job);
  }

  private emit(event: string, payload: unknown): void {
    this.events?.emitEvent(event as any, payload as any);
  }
}
