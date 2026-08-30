import type { EngineerJob } from '../engineer/types';

export type FeedbackStatus = 'received' | 'ignored' | 'retrying' | 'repairing' | 'repair_pr_open' | 'failed' | 'resolved';

export interface FailedWorkflowStep {
  job: string;
  step?: string;
  conclusion: string;
}

export interface DeliveryFeedbackRecord {
  deliveryId: string;
  event: string;
  repository?: string;
  workflowRunId?: number;
  workflowName?: string;
  headBranch?: string;
  headSha?: string;
  conclusion?: string;
  fingerprint?: string;
  failedSteps?: FailedWorkflowStep[];
  status: FeedbackStatus;
  reason?: string;
  retryRequested?: boolean;
  engineerJob?: Pick<EngineerJob, 'id' | 'status' | 'pullRequest' | 'failureReason'>;
  createdAt: number;
  updatedAt: number;
}

export interface GitHubWorkflowRunPayload {
  action: string;
  repository?: { full_name?: string };
  workflow?: { path?: string; name?: string } | null;
  workflow_run?: {
    id?: number;
    name?: string;
    conclusion?: string | null;
    run_attempt?: number;
    head_branch?: string | null;
    head_sha?: string;
    html_url?: string;
    event?: string;
  };
}

export interface GitHubFeedbackResult {
  accepted: boolean;
  duplicate?: boolean;
  record: DeliveryFeedbackRecord;
}
