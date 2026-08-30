import type { SeimConfig } from '../types';
import { SeimEventBus } from '../events';
import { Logger } from '../logger';
import { FeatureScaffolder } from '../scaffolder';
import { ReactComponentGenerator } from '../react/componentGenerator';
import { EngineerStore, FileEngineerStore, MemoryEngineerStore } from './store';
import { PostgresEngineerStore } from './postgresStore';
import { ApplicationControlPlane } from './controlPlane';
import { ControlPlaneStore, FileControlPlaneStore, MemoryControlPlaneStore, PostgresControlPlaneStore } from './controlPlaneStore';
import { GitHubRepositoryProvider, MemoryRepositoryProvider, RepositoryProvider } from './repository';
import { IssuePlanner } from './planner';
import { ProjectAdapter } from './projectAdapter';
import { RiskPolicy } from './riskPolicy';
import { SoftwareEngineer } from './engineer';
import { WorkspaceExecutor } from './executor';
import { LLMClient } from '../ai';
import { createCiRepairPlanner } from './ciRepairPlanner';
import { githubTokenProvider } from '../github';

export interface SoftwareEngineerDependencies {
  config: SeimConfig;
  storagePath: string;
  scaffolder: FeatureScaffolder;
  reactGenerator: ReactComponentGenerator;
  logger: Logger;
  events: SeimEventBus;
}

/** Compose the repository engineer in one place so runtime assembly stays declarative. */
export function createSoftwareEngineer(deps: SoftwareEngineerDependencies): SoftwareEngineer {
  const adapter = new ProjectAdapter();
  const engineer = new SoftwareEngineer(
    adapter,
    new IssuePlanner(deps.scaffolder, deps.reactGenerator, createCiRepairPlanner(new LLMClient(deps.config), deps.config.ai.enabled && !!deps.config.ai.apiKey)),
    new RiskPolicy(),
    new WorkspaceExecutor(),
    createEngineerStore(deps),
    createRepositoryProvider(deps.config),
    deps.logger,
    deps.events,
  );
  engineer.attachControlPlane(new ApplicationControlPlane(adapter, createControlPlaneStore(deps), engineer, deps.events, deps.logger));
  return engineer;
}

function createControlPlaneStore(deps: SoftwareEngineerDependencies): ControlPlaneStore {
  const settings = deps.config.engineer;
  const persistence = settings?.persistence || (deps.config.storage.type === 'memory' ? 'memory' : 'file');
  if (persistence === 'postgres') return new PostgresControlPlaneStore(settings?.postgres?.client, 'seim_engineer_control_plane');
  if (persistence === 'file') return new FileControlPlaneStore(deps.storagePath);
  return new MemoryControlPlaneStore();
}

function createEngineerStore(deps: SoftwareEngineerDependencies): EngineerStore {
  const settings = deps.config.engineer;
  const persistence = settings?.persistence || (deps.config.storage.type === 'memory' ? 'memory' : 'file');
  if (persistence === 'postgres') {
    return new PostgresEngineerStore(settings?.postgres?.client, settings?.postgres?.tableName);
  }
  if (persistence === 'file') return new FileEngineerStore(deps.storagePath);
  return new MemoryEngineerStore();
}

function createRepositoryProvider(config: SeimConfig): RepositoryProvider {
  const settings = config.engineer;
  if (settings?.repository !== 'github') return new MemoryRepositoryProvider();

  const github = settings.github;
  return new GitHubRepositoryProvider({
    owner: github?.owner || 'unknown',
    repository: github?.repository || 'unknown',
    tokenProvider: githubTokenProvider(config),
    apiBaseUrl: github?.apiBaseUrl,
  });
}
