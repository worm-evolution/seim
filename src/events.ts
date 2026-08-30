import { EventEmitter } from 'events';
import type { ProductIssue } from './issueStream';
import type { EngineerJob, ApplicationRegistration, EngineeringPlan, EngineeringTask } from './engineer/types';
import { OptimizationCandidate, ExperimentReport, OptimizationExplanation } from './types';
import type { DeliveryFeedbackRecord } from './feedback/types';

export interface SeimEvents {
  'issue:detected': ProductIssue;
  'issue:resolved': ProductIssue;
  'issue:dismissed': ProductIssue;
  'engineer:job-created': EngineerJob;
  'engineer:application-handed-off': ApplicationRegistration;
  'engineer:goal-created': EngineeringPlan;
  'engineer:task-updated': EngineeringTask;
  'engineer:approval-required': { job: EngineerJob; reasons: string[] };
  'engineer:pull-request-created': EngineerJob;
  'engineer:job-rejected': EngineerJob;
  'engineer:deployed': EngineerJob;
  'engineer:rolled-back': EngineerJob;
  'engineer:delivery-feedback': DeliveryFeedbackRecord;
  'optimization:detected': { routeKey: string; pattern: string; severity: string; candidateId: string };
  'optimization:validated': { routeKey: string; candidateId: string; report: any };
  'optimization:promoted': { routeKey: string; candidateId: string; latencyImprovement: number };
  'optimization:rejected': { routeKey: string; candidateId: string; reason: string };
  'optimization:rolledback': { routeKey: string; reason: string };
  'optimization:explained': { routeKey: string; explanation: OptimizationExplanation };
  'shadow:started': { routeKey: string; candidateId: string };
  'shadow:completed': { routeKey: string; v1Latency: number; v2Latency: number; improvement: number };
  'health:degraded': { routeKey: string; healthScore: number; reason: string };
  'health:recovered': { routeKey: string; healthScore: number };
  'error:sandbox': { routeKey: string; error: string };
  'error:validation': { routeKey: string; layer: string; reason: string };
  'error:internal': { component: string; error: string; stack?: string };
  'metrics:threshold': { routeKey: string; metric: string; value: number; threshold: number };
  'worker:cycle': { routesAnalyzed: number; candidatesFound: number; duration: number };
  'lifecycle:started': { mode: string; framework: string };
  'lifecycle:shutdown': { reason: string };
  'evolution:generation-started': { routeKey: string; generation: number; maxGenerations: number };
  'evolution:candidate-eliminated': { routeKey: string; candidateId: string; strategy: string; fitness: number; generation: number };
  'evolution:winner-selected': { routeKey: string; candidateId: string; strategy: string; fitness: number; generation: number };
  'evolution:pattern-learned': { name: string; description: string; extractedFrom: string; improvement: number };
  'evolution:propagated': { sourceRoute: string; targetRoutes: string[]; pattern: string; sharedFunctionCount: number };
  'evolution:drift-detected': { routeKey: string; currentP95: number; promotedP95: number; degradationPercent: number };
  'schema:change': { change: any };
  'feature:opportunities_analyzed': { routeKey: string; opportunities: any[]; insights: any };
  'feature:variant_generated': { routeKey: string; variant: any; opportunity: any };
  'feature:abtest_started': { testId: string; routeKey: string };
  'feature:abtest_completed': { testId: string; winner: string; confidence: number };
  'feature:winner_promoted': { testId: string; winner: string };
  'frontend:evolution_queued': { change: any };
  'frontend:component_generated': { component: any; change: any };
  'frontend:component_approved': { component: any };
  'frontend:component_rejected': { component: any; reason: string };
  'frontend:component_deployed': { component: any };
  'featureflag:created': { flag: any };
  'featureflag:updated': { flagId: string; updates: any };
  'featureflag:deleted': { flagId: string };
  'featureflag:rollout_completed': { flagId: string; targetPercentage: number };
  'frontend:telemetry_received': { path: string; issues: any[] };
}

export type SeimEventName = keyof SeimEvents;

export class SeimEventBus extends EventEmitter {
  public emitEvent<K extends SeimEventName>(event: K, payload: SeimEvents[K]): boolean {
    return this.emit(event, payload);
  }

  public onEvent<K extends SeimEventName>(event: K, listener: (payload: SeimEvents[K]) => void): this {
    return this.on(event, listener);
  }

  public onceEvent<K extends SeimEventName>(event: K, listener: (payload: SeimEvents[K]) => void): this {
    return this.once(event, listener);
  }
}
