import { SeimConfig } from '../types';
import { SeimEventBus } from '../events';
import { Logger } from '../logger';
import { SoftwareEngineer } from './engineer';

export interface EngineerIntegrationDependencies {
  config: SeimConfig;
  events: SeimEventBus;
  engineer: SoftwareEngineer;
  logger: Logger;
}

/** Connect observed product issues to repository jobs without coupling IssueStream to delivery. */
export function connectEngineerToIssueStream(deps: EngineerIntegrationDependencies): void {
  if (!deps.config.engineer?.enabled) return;

  deps.events.onEvent('issue:detected', async issue => {
    try {
      const job = await deps.engineer.submit(issue, {
        rootDir: deps.config.engineer?.rootDir || process.cwd(),
        baseBranch: deps.config.engineer?.baseBranch,
        autoRun: true,
        maxVerificationMs: deps.config.engineer?.maxVerificationMs,
      });
      deps.logger.info('[SoftwareEngineer] Evolution job submitted', { jobId: job.id, status: job.status });
    } catch (error) {
      deps.logger.warn('[SoftwareEngineer] Could not create evolution job', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
