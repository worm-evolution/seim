import type { SeimConfig } from '../types';
import type { SoftwareEngineer } from '../engineer';
import type { SeimEventBus } from '../events';
import type { Logger } from '../logger';
import { GitHubActionsClient } from './githubClient';
import { GitHubFeedbackLoop } from './githubFeedbackLoop';
import { createGitHubFeedbackHandler } from './httpHandler';
import { FileFeedbackStore, MemoryFeedbackStore, type FeedbackStore } from './store';
import { PostgresFeedbackStore } from './postgresStore';
import { githubTokenProvider } from '../github';

export function createGitHubFeedbackService(config: SeimConfig, storagePath: string, engineer: SoftwareEngineer, events: SeimEventBus, logger: Logger): { loop: GitHubFeedbackLoop; handler: ReturnType<typeof createGitHubFeedbackHandler> } | undefined {
  const settings = config.engineer;
  if (!settings?.feedback?.enabled) return undefined;
  if (settings.repository !== 'github') throw new Error('GitHub feedback requires engineer.repository = "github"');
  const github = settings.github;
  const webhookSecret = settings.feedback.webhookSecret || process.env.SEIM_GITHUB_WEBHOOK_SECRET || '';
  if (!github?.owner || !github.repository || !webhookSecret) throw new Error('GitHub feedback requires owner, repository, authentication, and webhook secret');
  const tokenProvider = githubTokenProvider(config);
  const store = createStore(config, storagePath);
  const client = new GitHubActionsClient({ owner: github.owner, repository: github.repository, tokenProvider, apiBaseUrl: github.apiBaseUrl });
  const loop = new GitHubFeedbackLoop({
    webhookSecret,
    repository: `${github.owner}/${github.repository}`,
    rootDir: settings.rootDir || process.cwd(),
    baseBranch: settings.baseBranch || 'main',
    allowedBranches: settings.feedback.allowedBranches,
    allowedWorkflowPrefixes: settings.feedback.allowedWorkflowPrefixes,
    maxPayloadBytes: settings.feedback.maxPayloadBytes,
    maxTransientRetries: settings.feedback.maxTransientRetries,
    maxRepairsPerFingerprint: settings.feedback.maxRepairsPerFingerprint,
    maxVerificationMs: settings.maxVerificationMs,
  }, store, client, engineer, events, logger);
  return { loop, handler: createGitHubFeedbackHandler(loop) };
}

function createStore(config: SeimConfig, storagePath: string): FeedbackStore {
  if (config.engineer?.persistence === 'postgres') return new PostgresFeedbackStore(config.engineer.postgres?.client);
  if (config.engineer?.persistence === 'file') return new FileFeedbackStore(storagePath);
  return new MemoryFeedbackStore();
}
