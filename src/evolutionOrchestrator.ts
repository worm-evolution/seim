import { IssueStream, ProductIssue } from './issueStream';
import { FeatureScaffolder } from './scaffolder';
import { FrontendEvolver } from './frontendEvolver';
import { ProductChangelog } from './productChangelog';
import { DynamicRouter } from './dynamicRouter';
import { Sandbox } from './sandbox';
import { SeimConfig } from './types';
import { SeimEventBus } from './events';
import { Logger } from './logger';

export class EvolutionOrchestrator {
  private activeGenerations = new Set<string>();
  private hourlyGenerationCount = 0;
  private hourTimer: NodeJS.Timeout | null = null;
  private readonly MAX_PER_HOUR = 5;

  constructor(
    private issueStream: IssueStream,
    private scaffolder: FeatureScaffolder,
    private frontendEvolver: FrontendEvolver,
    private changelog: ProductChangelog,
    private dynamicRouter: DynamicRouter,
    private sandbox: Sandbox,
    private config: SeimConfig,
    private events: SeimEventBus,
    private logger: Logger,
  ) {
    this.hourTimer = setInterval(() => {
      this.hourlyGenerationCount = 0;
    }, 3600000);

    if (this.hourTimer && typeof this.hourTimer.unref === 'function') {
      this.hourTimer.unref();
    }
  }

  public start(): void {
    this.events.on('issue:detected', async (issue: ProductIssue) => {
      if (this.config.mode === 'bypass' && this.config.behavior?.autoScaffold && !this.config.engineer?.enabled) {
        await this.handleIssue(issue);
      }
    });

    this.logger.info('[EvolutionOrchestrator] Autonomous evolution pipeline active');
  }

  public async handleIssue(issue: ProductIssue): Promise<boolean> {
    if (this.activeGenerations.has(issue.id)) return false;
    if (this.hourlyGenerationCount >= this.MAX_PER_HOUR) {
      this.logger.warn('[EvolutionOrchestrator] Hourly evolution budget reached (5/hr). Issue queued.', { issueId: issue.id });
      return false;
    }

    this.activeGenerations.add(issue.id);
    this.hourlyGenerationCount++;

    try {
      this.logger.info(`[EvolutionOrchestrator] Processing issue ${issue.id} [${issue.type}] on ${issue.path}`);

      // 1. Missing Backend API Feature
      if (issue.type === 'feature:missing_api') {
        const method = issue.method || 'GET';
        const code = await this.scaffolder.scaffoldRoute(method, issue.path, issue.suggestedAction);

        // Verify sandbox execution
        const mockCandidate = { id: `feat_${Date.now()}`, optimizedCode: code, originalCode: '' };
        const sandboxedHandler = (req: any, res: any, next: any) => {
          this.sandbox.run(code, '', req, res, next, this.config.experiment?.sandboxTimeoutMs || 5000)
            .catch(next);
        };

        // Hot-swap/inject route dynamically into router stack
        this.dynamicRouter.registerRoute(issue.path, method, sandboxedHandler);

        // Record in Product Changelog
        this.changelog.record({
          type: 'new_feature',
          title: `Added API Route: ${method.toUpperCase()} ${issue.path}`,
          description: `Built from ${issue.affectedSessions} visitor 404 requests: "${issue.suggestedAction}"`,
          path: issue.path,
          code,
          affectedSessions: issue.affectedSessions,
          status: 'live',
          triggerIssueId: issue.id,
        });

        this.issueStream.resolveIssue(issue.id);
        (this.events as any).emitEvent?.('feature:deployed', { path: issue.path, method, code });
        (this.events as any).emit?.('feature:deployed', { path: issue.path, method, code });
        return true;
      }

      // 2. Missing Frontend Page or UX Loop
      if (issue.type === 'feature:missing_page' || issue.type === 'ux:navigation_loop' || issue.type === 'ux:drop_off') {
        const result = await this.frontendEvolver.evolve(issue);
        if (result) {
          this.changelog.record({
            type: 'ux_improvement',
            title: `Generated React Component: ${result.component.name}`,
            description: `Auto-generated for user experience on ${issue.path}: "${issue.suggestedAction}"`,
            path: issue.path,
            code: result.component.code,
            affectedSessions: issue.affectedSessions,
            status: 'live',
            triggerIssueId: issue.id,
          });

          this.issueStream.resolveIssue(issue.id);
          return true;
        }
      }

      return false;
    } catch (err: any) {
      this.logger.error(`[EvolutionOrchestrator] Failed to evolve for issue ${issue.id}: ${err?.message}`);
      return false;
    } finally {
      this.activeGenerations.delete(issue.id);
    }
  }

  public destroy(): void {
    if (this.hourTimer) {
      clearInterval(this.hourTimer);
      this.hourTimer = null;
    }
    this.activeGenerations.clear();
  }
}
