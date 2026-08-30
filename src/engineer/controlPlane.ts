import { createHash } from 'crypto';
import * as fs from 'fs';
import { SeimEventBus } from '../events';
import { ProductIssue } from '../issueStream';
import { Logger } from '../logger';
import { ProjectAdapter } from './projectAdapter';
import type { SoftwareEngineer } from './engineer';
import { ControlPlaneStore } from './controlPlaneStore';
import {
  ApplicationRegistration,
  EngineeringGoal,
  EngineeringGoalInput,
  EngineeringPlan,
  EngineeringTask,
  EngineerJob,
} from './types';

export interface PlanRunOptions {
  maxVerificationMs?: number;
}

/**
 * The application control plane is the handoff boundary between a founder and SEIM.
 * It turns an existing repository plus a product goal into explicit, durable work.
 * Only tasks with a known safe repository planner are executable; the rest stay visible
 * as review work instead of being silently guessed or mutated.
 */
export class ApplicationControlPlane {
  constructor(
    private adapter: ProjectAdapter,
    private store: ControlPlaneStore,
    private engineer: SoftwareEngineer,
    private events?: SeimEventBus,
    private logger?: Logger,
  ) {}

  public async handoff(rootDir: string, baseBranch?: string): Promise<ApplicationRegistration> {
    const resolvedRoot = this.adapter.inspect(rootDir, baseBranch ? { baseBranch } : {}).rootDir;
    const stat = await fs.promises.stat(resolvedRoot).catch(() => undefined);
    if (!stat?.isDirectory()) throw new Error(`Application root is not a directory: ${rootDir}`);
    const manifest = this.adapter.inspect(resolvedRoot, baseBranch ? { baseBranch } : {});
    const fingerprint = createHash('sha256').update(JSON.stringify({
      rootDir: manifest.rootDir,
      packageName: manifest.packageName,
      packageManager: manifest.packageManager,
      frontend: manifest.frontend,
      backend: manifest.backend,
      frontendContext: manifest.frontendContext,
      contextIndex: manifest.contextIndex,
      handoff: manifest.handoff,
      commands: manifest.commands,
    })).digest('hex');
    const existing = (await this.store.listApplications()).find(app => app.rootDir === manifest.rootDir);
    const now = Date.now();
    const application: ApplicationRegistration = {
      id: existing?.id || `app_${fingerprint.slice(0, 16)}`,
      rootDir: manifest.rootDir,
      name: manifest.packageName,
      manifest,
      status: existing?.status || 'active',
      fingerprint,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    await this.store.saveApplication(application);
    this.events?.emitEvent('engineer:application-handed-off', application);
    return application;
  }

  public async getApplication(id: string): Promise<ApplicationRegistration | undefined> { return this.store.getApplication(id); }
  public async listApplications(): Promise<ApplicationRegistration[]> { return this.store.listApplications(); }
  public async getPlan(id: string): Promise<EngineeringPlan | undefined> { return this.store.getPlan(id); }
  public async listPlans(): Promise<EngineeringPlan[]> { return this.store.listPlans(); }

  public async submitGoal(input: EngineeringGoalInput): Promise<EngineeringPlan> {
    if (!input.title?.trim() || !input.description?.trim()) throw new Error('Goal title and description are required');
    const application = await this.resolveApplication(input);
    if (application.status !== 'active') throw new Error(`Application ${application.id} is paused`);
    const now = Date.now();
    const goal: EngineeringGoal = {
      id: `goal_${now}_${randomId()}`,
      applicationId: application.id,
      title: input.title.trim(),
      description: input.description.trim(),
      acceptanceCriteria: (input.acceptanceCriteria || []).map(item => item.trim()).filter(Boolean).slice(0, 20),
      priority: input.priority || 'medium',
      status: 'planned',
      createdAt: now,
      updatedAt: now,
    };
    const tasks = this.decompose(goal, application);
    const plan: EngineeringPlan = {
      id: `plan_${now}_${randomId()}`,
      applicationId: application.id,
      goal,
      tasks,
      status: 'planned',
      risks: this.planRisks(goal, application, tasks),
      createdAt: now,
      updatedAt: now,
    };
    await this.store.savePlan(plan);
    this.events?.emitEvent('engineer:goal-created', plan);
    return plan;
  }

  public async runPlan(planId: string, options: PlanRunOptions = {}): Promise<EngineeringPlan> {
    const plan = await this.requirePlan(planId);
    plan.status = 'in_progress';
    plan.goal.status = 'in_progress';
    await this.save(plan);

    for (const task of plan.tasks) {
      if (!task.executable || task.status === 'completed' || task.status === 'awaiting_approval') continue;
      if (task.dependsOn.some(id => plan.tasks.find(candidate => candidate.id === id)?.status !== 'completed')) {
        task.status = 'blocked';
        task.failureReason = 'A prerequisite task has not completed';
        continue;
      }
      if (!task.issue) {
        task.status = 'blocked';
        task.failureReason = 'No safe repository issue was produced for this task';
        continue;
      }
      task.status = 'in_progress';
      await this.save(plan);
      try {
        const job = await this.engineer.submit(task.issue, {
          rootDir: (await this.store.getApplication(plan.applicationId))!.rootDir,
          baseBranch: (await this.store.getApplication(plan.applicationId))!.manifest.baseBranch,
          maxVerificationMs: options.maxVerificationMs,
          autoRun: true,
        });
        task.jobId = job.id;
        this.updateTaskFromJob(task, job);
      } catch (error) {
        task.status = 'failed';
        task.failureReason = error instanceof Error ? error.message : String(error);
        this.logger?.warn('Control-plane task failed to start', { taskId: task.id, error: task.failureReason });
      }
      await this.save(plan);
      if ((task.status as string) === 'awaiting_approval' || task.status === 'failed') break;
    }
    this.updatePlanStatus(plan);
    await this.save(plan);
    return plan;
  }

  public async approveTask(planId: string, taskId: string): Promise<EngineeringPlan> {
    const plan = await this.requirePlan(planId);
    const task = this.requireTask(plan, taskId);
    if (!task.jobId) throw new Error(`Task ${taskId} has no engineer job`);
    const job = await this.engineer.approve(task.jobId);
    this.updateTaskFromJob(task, job);
    this.updatePlanStatus(plan);
    await this.save(plan);
    return plan;
  }

  public async completeTask(planId: string, taskId: string): Promise<EngineeringPlan> {
    const plan = await this.requirePlan(planId);
    const task = this.requireTask(plan, taskId);
    if (task.executable) throw new Error(`Executable task ${taskId} must be completed by its engineer job`);
    if (task.dependsOn.some(id => plan.tasks.find(candidate => candidate.id === id)?.status !== 'completed')) throw new Error(`Task ${taskId} has incomplete prerequisites`);
    task.status = 'completed';
    task.updatedAt = Date.now();
    this.updatePlanStatus(plan);
    await this.save(plan);
    this.events?.emitEvent('engineer:task-updated', task);
    return plan;
  }

  public async mergeTask(planId: string, taskId: string): Promise<EngineeringPlan> {
    const plan = await this.requirePlan(planId);
    const task = this.requireTask(plan, taskId);
    if (!task.jobId) throw new Error(`Task ${taskId} has no engineer job`);
    const job = await this.engineer.merge(task.jobId);
    this.updateTaskFromJob(task, job);
    this.updatePlanStatus(plan);
    await this.save(plan);
    return plan;
  }

  private async resolveApplication(input: EngineeringGoalInput): Promise<ApplicationRegistration> {
    if (input.applicationId) {
      const existing = await this.store.getApplication(input.applicationId);
      if (!existing) throw new Error(`Application ${input.applicationId} was not found`);
      return existing;
    }
    if (!input.rootDir) throw new Error('applicationId or rootDir is required');
    return this.handoff(input.rootDir);
  }

  private decompose(goal: EngineeringGoal, application: ApplicationRegistration): EngineeringTask[] {
    const text = `${goal.title} ${goal.description}`;
    const frontendRoute = extractRoute(text, 'frontend');
    const backendRoute = extractRoute(text, 'backend');
    const context = application.manifest.contextIndex;
    const wantsFrontend = /\b(frontend|front-end|react|next\.js|page|screen|dashboard|ui|component|experience)\b/i.test(text);
    const wantsBackend = /\b(backend|back-end|api|endpoint|server|service|database|data|integration)\b/i.test(text);
    const tasks: EngineeringTask[] = [];
    const createdAt = Date.now();

    if (wantsFrontend && application.manifest.frontend) {
      tasks.push(this.task(goal, 'frontend', `Implement the ${frontendRoute || 'new'} user experience`, `Build the requested UI in the detected ${application.manifest.frontendContext.framework} application using its existing router and libraries. Reuse ${context.designSystemFiles.length} indexed design-system files when relevant.`, frontendRoute || inferredRoute(goal.title), createdAt, true));
    }
    if (wantsBackend && application.manifest.backend) {
      tasks.push(this.task(goal, 'backend', `Implement the ${backendRoute || 'new'} backend capability`, `Implement the requested server capability while preserving the existing backend entrypoint and security policy. Consult ${context.apiContractFiles.length} API contracts and ${context.databaseFiles.length} database files.`, backendRoute || `/api/${slug(goal.title)}`, createdAt, true));
    }
    if (/\b(database|data|migration|schema|payment|auth|authorization|secret|billing)\b/i.test(text)) {
      tasks.push(this.manualTask(goal, 'review', 'Review data and security impact', 'A human or separately configured specialist must review data, authentication, authorization, payment, or secret-handling changes before implementation.', createdAt, tasks.map(task => task.id)));
    }
    const reviewTask = tasks.find(task => task.kind === 'review');
    const backendTask = tasks.find(task => task.kind === 'backend');
    const frontendTask = tasks.find(task => task.kind === 'frontend');
    if (reviewTask) for (const task of tasks.filter(candidate => candidate.executable)) task.dependsOn.push(reviewTask.id);
    if (backendTask && frontendTask) frontendTask.dependsOn.push(backendTask.id);
    tasks.push(this.manualTask(goal, 'test', 'Confirm acceptance criteria with regression coverage', 'Add or update unit, integration, and browser coverage for the acceptance criteria. This remains visible until a project-specific test agent is configured.', createdAt, tasks.map(task => task.id)));
    if (!tasks.some(task => task.executable)) {
      tasks.unshift(this.manualTask(goal, 'review', 'Clarify an executable repository change', 'The goal does not map to a currently supported safe frontend or backend planner. Review the plan and provide a concrete route or repository task.', createdAt, []));
    }
    return tasks;
  }

  private task(goal: EngineeringGoal, kind: 'frontend' | 'backend', title: string, description: string, route: string, createdAt: number, executable: boolean): EngineeringTask {
    const type = kind === 'frontend' ? 'feature:missing_page' : 'feature:missing_api';
    const issue: ProductIssue = {
      id: `goal_${goal.id}_${kind}`,
      type,
      path: route,
      method: kind === 'backend' ? 'GET' : undefined,
      severity: goal.priority === 'urgent' ? 'high' : goal.priority === 'high' ? 'medium' : 'low',
      frequency: 1,
      affectedSessions: 1,
      evidence: [{ source: 'founder-goal', goalId: goal.id }],
      suggestedAction: `${description} Acceptance criteria: ${goal.acceptanceCriteria.join('; ') || 'defined by the goal description'}`,
      detectedAt: createdAt,
      updatedAt: createdAt,
      status: 'open',
    };
    return { id: `task_${goal.id}_${kind}`, goalId: goal.id, kind, title, description, dependsOn: [], executable, issue, status: 'queued', createdAt, updatedAt: createdAt };
  }

  private manualTask(goal: EngineeringGoal, kind: 'test' | 'review', title: string, description: string, createdAt: number, dependsOn: string[]): EngineeringTask {
    return { id: `task_${goal.id}_${kind}_${randomId()}`, goalId: goal.id, kind, title, description, dependsOn, executable: false, status: 'queued', createdAt, updatedAt: createdAt };
  }

  private planRisks(goal: EngineeringGoal, application: ApplicationRegistration, tasks: EngineeringTask[]): string[] {
    const risks: string[] = [];
    if (application.manifest.frontendContext.router === 'unknown' && tasks.some(task => task.kind === 'frontend')) risks.push('Frontend router was not confidently detected; UI work stays behind engineer verification.');
    if (tasks.some(task => task.kind === 'review')) risks.push('Sensitive or non-standard work requires explicit review before implementation.');
    if (!application.manifest.commands.test && tasks.some(task => task.executable)) risks.push('The application does not declare a test command; generated changes cannot receive project test coverage.');
    if (/\b(production|deploy|release|migration)\b/i.test(`${goal.title} ${goal.description}`)) risks.push('Deployment-affecting work requires a pull request and release approval.');
    return risks;
  }

  private updateTaskFromJob(task: EngineeringTask, job: EngineerJob): void {
    task.updatedAt = Date.now();
    if (job.status === 'deployed' || job.status === 'approved') task.status = 'completed';
    else if (job.status === 'awaiting_approval' || job.status === 'pr_open') task.status = 'awaiting_approval';
    else if (job.status === 'rejected' || job.status === 'failed') { task.status = 'failed'; task.failureReason = job.failureReason || 'Engineer job failed'; }
    else task.status = 'in_progress';
    this.events?.emitEvent('engineer:task-updated', task);
  }

  private updatePlanStatus(plan: EngineeringPlan): void {
    const executable = plan.tasks.filter(task => task.executable);
    if (plan.tasks.some(task => task.status === 'failed')) plan.status = plan.goal.status = 'failed';
    else if (plan.tasks.some(task => task.status === 'awaiting_approval')) plan.status = plan.goal.status = 'awaiting_approval';
    else if (plan.tasks.length > 0 && plan.tasks.every(task => task.status === 'completed')) plan.status = plan.goal.status = 'completed';
    else if (plan.tasks.some(task => task.status === 'blocked' || (task.status === 'queued' && !task.executable))) plan.status = plan.goal.status = 'blocked';
    else plan.status = plan.goal.status = 'in_progress';
    plan.updatedAt = plan.goal.updatedAt = Date.now();
  }

  private requireTask(plan: EngineeringPlan, taskId: string): EngineeringTask { const task = plan.tasks.find(item => item.id === taskId); if (!task) throw new Error(`Task ${taskId} was not found in plan ${plan.id}`); return task; }
  private async requirePlan(id: string): Promise<EngineeringPlan> { const plan = await this.store.getPlan(id); if (!plan) throw new Error(`Engineering plan ${id} was not found`); return plan; }
  private async save(plan: EngineeringPlan): Promise<void> { plan.updatedAt = Date.now(); await this.store.savePlan(plan); }
}

function extractRoute(text: string, target: 'frontend' | 'backend'): string | undefined {
  const routes = Array.from(text.matchAll(/(?:^|\s)(\/(?:api\/)?[a-zA-Z0-9][a-zA-Z0-9/_-]*)\b/g)).map(match => match[1]).filter(route => !route.includes('..'));
  const selected = target === 'backend' ? routes.find(route => route.startsWith('/api/')) : routes.find(route => !route.startsWith('/api/'));
  return selected ? selected.replace(/\/$/, '') || '/' : undefined;
}
function inferredRoute(title: string): string { return `/${slug(title)}`; }
function slug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'new-feature'; }
function randomId(): string { return Math.random().toString(36).slice(2, 9); }
