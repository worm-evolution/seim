import type { ProductIssue } from '../issueStream';
import type { ReactApplicationContext } from '../react/types';

export type EngineerRisk = 'low' | 'medium' | 'high' | 'critical';
export type EngineerJobStatus =
  | 'queued'
  | 'planning'
  | 'awaiting_approval'
  | 'verifying'
  | 'rejected'
  | 'pr_open'
  | 'approved'
  | 'deployed'
  | 'rolled_back'
  | 'failed';

export type ApplicationStatus = 'active' | 'paused';
export type EngineeringGoalStatus = 'planned' | 'in_progress' | 'awaiting_approval' | 'completed' | 'blocked' | 'failed';
export type EngineeringTaskKind = 'frontend' | 'backend' | 'data' | 'test' | 'operations' | 'review';
export type EngineeringTaskStatus = 'queued' | 'in_progress' | 'awaiting_approval' | 'completed' | 'blocked' | 'failed';

export interface ProjectCommands {
  typecheck?: string;
  test?: string;
  integration?: string;
  build?: string;
  browser?: string;
}

export type EngineerAutonomy = 'observe' | 'plan' | 'pull_request' | 'merge' | 'deploy';

export interface VercelDeliveryTarget {
  id: string;
  provider: 'vercel';
  workingDirectory?: string;
  productionBranch?: string;
  healthCheckUrl?: string;
}

export interface AwsEcsDeliveryTarget {
  id: string;
  provider: 'aws-ecs';
  workingDirectory?: string;
  productionBranch?: string;
  healthCheckUrl?: string;
  taskDefinition: string;
  containerName: string;
}

export type DeliveryTarget = VercelDeliveryTarget | AwsEcsDeliveryTarget;

export interface ApplicationHandoffContract {
  version: 1;
  application: { name: string; owner?: string };
  repository: { baseBranch: string };
  paths: { frontend?: string; backend?: string; tests?: string; designSystem?: string; database?: string };
  commands: ProjectCommands;
  delivery?: { targets: DeliveryTarget[] };
  policies: {
    autonomy: EngineerAutonomy;
    protectedPaths: string[];
    approvalRequiredPaths: string[];
    requireTests: boolean;
    requireBrowserForFrontend: boolean;
  };
}

export interface ProjectContextIndex {
  totalFiles: number;
  indexedFiles: number;
  truncated: boolean;
  languages: Record<string, number>;
  sourceFiles: string[];
  testFiles: string[];
  documentationFiles: string[];
  configurationFiles: string[];
  apiContractFiles: string[];
  databaseFiles: string[];
  deploymentFiles: string[];
  designSystemFiles: string[];
  workspacePackages: string[];
  generatedAt: number;
}

export interface ProjectManifest {
  version: 1;
  rootDir: string;
  packageManager: 'npm' | 'yarn' | 'pnpm' | 'unknown';
  packageName?: string;
  baseBranch: string;
  backendEntrypoint?: string;
  frontendEntrypoint?: string;
  frontendRoutesFile?: string;
  frontendContext: ReactApplicationContext;
  contextIndex: ProjectContextIndex;
  handoff?: ApplicationHandoffContract;
  commands: ProjectCommands;
  frontend: boolean;
  backend: boolean;
}

export interface ChangeFile {
  path: string;
  operation: 'create' | 'update' | 'delete';
  content?: string;
  expectedSha256?: string;
}

export interface ChangePlan {
  id: string;
  title: string;
  summary: string;
  issueId?: string;
  files: ChangeFile[];
  risk: EngineerRisk;
  reasons: string[];
  generatedBy: 'template' | 'model' | 'developer';
  createdAt: number;
}

export interface VerificationCheck {
  name: string;
  command?: string;
  passed: boolean;
  skipped?: boolean;
  durationMs: number;
  output?: string;
  reason?: string;
}

export interface VerificationReport {
  passed: boolean;
  checks: VerificationCheck[];
  workspacePath?: string;
  generatedAt: number;
}

export interface PullRequestRecord {
  provider: string;
  id: string;
  number?: number;
  url?: string;
  branch: string;
  baseBranch: string;
  title: string;
  autoMergeEnabled?: boolean;
  autoMergeReason?: string;
  createdAt: number;
}

export interface EngineerJob {
  id: string;
  issue?: ProductIssue;
  manifest: ProjectManifest;
  plan?: ChangePlan;
  status: EngineerJobStatus;
  risk?: EngineerRisk;
  verification?: VerificationReport;
  pullRequest?: PullRequestRecord;
  failureReason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface EngineerOptions {
  rootDir?: string;
  baseBranch?: string;
  maxVerificationMs?: number;
  autoRun?: boolean;
}

/** Durable handoff record for an existing application that SEIM is responsible for evolving. */
export interface ApplicationRegistration {
  id: string;
  rootDir: string;
  name?: string;
  manifest: ProjectManifest;
  status: ApplicationStatus;
  fingerprint: string;
  createdAt: number;
  updatedAt: number;
}

export interface EngineeringGoalInput {
  applicationId?: string;
  rootDir?: string;
  title: string;
  description: string;
  acceptanceCriteria?: string[];
  priority?: 'low' | 'medium' | 'high' | 'urgent';
}

export interface EngineeringGoal {
  id: string;
  applicationId: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  priority: NonNullable<EngineeringGoalInput['priority']>;
  status: EngineeringGoalStatus;
  createdAt: number;
  updatedAt: number;
}

export interface EngineeringTask {
  id: string;
  goalId: string;
  kind: EngineeringTaskKind;
  title: string;
  description: string;
  dependsOn: string[];
  executable: boolean;
  issue?: ProductIssue;
  status: EngineeringTaskStatus;
  jobId?: string;
  failureReason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface EngineeringPlan {
  id: string;
  applicationId: string;
  goal: EngineeringGoal;
  tasks: EngineeringTask[];
  status: EngineeringGoalStatus;
  risks: string[];
  createdAt: number;
  updatedAt: number;
}
