import { LogLevel } from './logger';
import type { SoftwareEngineer } from './engineer/engineer';
import type { ApplicationControlPlane } from './engineer/controlPlane';
import type { ReactApplicationContext } from './react/types';

export type SeimMode = 'restrict' | 'bypass';

export interface GenericRequest {
  method: string;
  url: string;
  headers: Record<string, any>;
  query?: any;
  params?: any;
  body?: any;
  ip?: string;
  [key: string]: any;
}

export interface GenericResponse {
  json: (body: any) => any;
  send: (body: any) => any;
  status: (code: number) => any;
  end: () => void;
  setHeader?: (name: string, value: any) => any;
  [key: string]: any;
}

export type BusinessRule<T = unknown> = (response: T, request?: GenericRequest) => boolean | Promise<boolean>;

export type SecurityRule = (oldCode: string, newCode: string) => { pass: boolean; reason?: string };

export interface OptimizationCandidate {
  id: string;
  routeKey: string;
  pattern: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  originalCode: string;
  optimizedCode?: string;
  confidence: number;
  status: 'pending' | 'validating' | 'shadow' | 'promoted' | 'rejected' | 'rolledback';
  createdAt: number;
  updatedAt: number;
}

export interface SeimConfig {
  mode: SeimMode;
  environment?: 'development' | 'production';
  framework?: 'express' | 'fastify' | 'http' | 'generic';
  studioPath: string;
  storagePath?: string;
  businessRules: BusinessRule[];
  securityRules: SecurityRule[];
  production?: {
    ciCd?: {
      enabled?: boolean;
      outputDir?: string;
    };
    requireIsolatedVm?: boolean;
  };
  ai: {
    generatorModel: string;
    reviewerModel: string;
    verifierModel: string;
    provider?: 'openai' | 'anthropic' | 'google' | 'grok' | 'custom';
    apiKey?: string;
    baseUrl?: string;
    enabled: boolean;
    headers?: Record<string, string>;
    responsePath?: string;
    flashModel?: string;
    proModel?: string;
    criticModel?: string;
  };
  experiment: {
    confidenceThreshold: number;
    canaryPercent: number;
    rollbackLatencyMultiplier: number;
    rollbackErrorRate: number;
    minSampleSize: number;
    shadowCooldownMs: number;
    shadowAllowedMethods: string[];
    shadowSampleSize: number;
    sandboxTimeoutMs?: number;
  };
  storage: {
    type: 'memory' | 'file' | 'redis';
    connection?: string;
  };
  security: {
    blockAuthenticationChanges: boolean;
    blockAuthorizationChanges: boolean;
    blockPaymentChanges: boolean;
    blockSecretUsage: boolean;
    allowedPatternModels: string[];
  };
  learning: {
    enabled: boolean;
    persistencePath?: string;
    sampleSize: number;
  };
  logging?: {
    level?: LogLevel;
    json?: boolean;
  };
  worker?: {
    enabled?: boolean;
    intervalMs?: number;
    batchSize?: number;
  };
  autoMiddleware?: {
    etag?: boolean;
    compression?: boolean;
    caching?: boolean;
    rateLimit?: boolean;
  };
  evolution?: Partial<EvolutionConfig>;
  scaffolding?: {
    enabled: boolean;
    maxDynamicRoutes?: number;
  };
  /** Whether SEIM can autonomously promote candidates to production. Default: false (requires manual approval). */
  autonomousPromotion?: boolean;

  /** Behavior-driven feature discovery configuration */
  behavior?: {
    /** Enable visitor behavior tracking. Default: false */
    enabled?: boolean;
    /** Minimum times a pattern must appear before triggering feature discovery */
    minPatternFrequency?: number;
    /** Maximum behavior events to keep in memory */
    maxEvents?: number;
    /** Whether to autonomously scaffold discovered features. Default: false */
    autoScaffold?: boolean;
    /** Paths to exclude from behavior tracking (e.g., health checks) */
    excludePaths?: string[];
    /** How often to run the IssueStream scanner (ms). Default: 60000 (1 min) */
    issueCheckIntervalMs?: number;
    /** Minimum sessions required to flag an issue. Default: 3 */
    minIssueSessionThreshold?: number;
  };

  /** Frontend React component generation configuration */
  frontend?: {
    /** Enable React component generation. Default: false */
    enabled?: boolean;
    /** Path where generated components should be written on disk */
    outputDir?: string;
    /** Write generated component code to disk. Default: false */
    writeToDisk?: boolean;
    /** Framework target */
    framework?: 'react' | 'next' | 'vite';
    /** Whether to use TypeScript in generated components. Default: true */
    typescript?: boolean;
    /** Path to write HMR trigger / reload signal */
    hmrSignalPath?: string;
    /** Path to write route manifest (e.g., seim-routes.tsx) */
    routesFile?: string;
    /** Optional application facts used when generating runtime React components */
    applicationContext?: ReactApplicationContext;
  };

  /** Product evolution changelog ledger */
  changelog?: {
    /** Enable changelog recording. Default: true */
    enabled?: boolean;
    /** Maximum entries to retain. Default: 500 */
    maxEntries?: number;
    /** Custom persistence file path */
    persistPath?: string;
  };

  /** Custom optimization pattern templates registered by the developer */
  patterns?: {
    /** Whether to run custom patterns in addition to built-in ones. Default: true */
    enabled?: boolean;
  };

  /** Built-in software engineer configuration */
  engineer?: {
    enabled?: boolean;
    rootDir?: string;
    baseBranch?: string;
    maxVerificationMs?: number;
    repository?: "memory" | "github";
    persistence?: "memory" | "file" | "postgres";
    postgres?: { client: any; tableName?: string };
    github?: {
      owner: string;
      repository: string;
      token?: string;
      apiBaseUrl?: string;
      app?: { appId?: string | number; installationId?: string | number; privateKey?: string };
    };
    feedback?: {
      enabled?: boolean;
      webhookSecret?: string;
      allowedBranches?: string[];
      allowedWorkflowPrefixes?: string[];
      maxPayloadBytes?: number;
      maxTransientRetries?: number;
      maxRepairsPerFingerprint?: number;
    };
  };

  /** Control center & Studio authentication configuration */
  auth?: {
    /** Whether authentication is required. Defaults to true in production. */
    enabled?: boolean;
    /** Secret API key or Bearer token */
    secret?: string;
    /** Custom API key */
    apiKey?: string;
    /** Basic Auth username. Default: 'admin' */
    username?: string;
    /** Basic Auth password */
    password?: string;
  };
}

export interface RouteMetrics {
  requestCount: number;
  errorCount: number;
  timeoutCount: number;
  totalDuration: number;
  durations: number[];
  responseSizes: number[];
  payloadSizes: number[];
  statusCodes: Record<number, number>;
  lastSeen: number;
}

export interface HotRoute {
  routeKey: string;
  requestCount: number;
  averageLatency: number;
  p95: number;
  p99: number;
  errorRate: number;
  throughput: number;
}

export interface MetricsSnapshot {
  routes: Record<string, RouteMetrics>;
  hotRoutes: HotRoute[];
  aggregate: {
    totalRequests: number;
    totalErrors: number;
    averageLatency: number;
    p95: number;
    p99: number;
    throughput: number;
    peakTrafficTime?: number;
  };
  system: {
    memoryUsage: NodeJS.MemoryUsage;
    cpuUsage: NodeJS.CpuUsage;
    uptime: number;
  };
  generatedAt: number;
}

export interface ValidationCheckResult {
  pass: boolean;
  skipped?: boolean;
  reason?: string;
}

export interface ValidationReport {
  candidateId: string;
  layer1Schema: ValidationCheckResult;
  layer2ResponseEquivalence: ValidationCheckResult;
  layer2bSchemaCompatibility: ValidationCheckResult;
  layer3BusinessRules: ValidationCheckResult & { violations: string[] };
  layer4UnitTests: ValidationCheckResult;
  layer5IntegrationTests: ValidationCheckResult;
  layer6Security: ValidationCheckResult;
  layer7AICritic: ValidationCheckResult;
  layer8PerformanceGate: ValidationCheckResult;
  overall: boolean;
  /** True only if all checks actually ran (none were skipped) */
  fullyValidated: boolean;
  /** Summary of skipped checks */
  skippedChecks: string[];
}

export interface ExperimentReport {
  candidateId: string;
  routeKey: string;
  v1Latency: number;
  v2Latency: number;
  v1Errors: number;
  v2Errors: number;
  v1Memory: number;
  v2Memory: number;
  sampleSize: number;
  promoted: boolean;
  rolledBack: boolean;
  reason?: string;
}

export interface SeimStatus {
  mode: SeimMode;
  framework: string;
  uptime: number;
  totalOptimizationsGenerated: number;
  totalOptimizationsPromoted: number;
  totalRollbacks: number;
  activeShadowTests: number;
  activeVersions: { routeKey: string; active: 'original' | 'optimized' }[];
  workerQueueSize: number;
  lastOptimizationAt?: number;
  healthy: boolean;
  /** Component-level health for diagnostics */
  components?: {
    worker: boolean;
    storage: boolean;
    ai: boolean;
    evolution: boolean;
  };
}

export interface MetricsStore {
  record(routeKey: string, duration: number, statusCode: number, responseSize: number, payloadSize: number, error: boolean, timeout: boolean): void;
  snapshot(): MetricsSnapshot;
  hotRoutes(limit: number): HotRoute[];
  forRoute(routeKey: string): RouteMetrics | undefined;
}

export interface SeimInstance {
  listener: () => any; // Keep returning framework-specific middleware handler (e.g. Express RequestHandler)
  plugin?: () => any;   // Keep returning Fastify plugin function
  dashboard: any;       // Studio router/handler
  status(): SeimStatus;
  shutdown(): Promise<void>;
  on(event: string, listener: (...args: any[]) => void): void;
  registerVariant?: (routePattern: string, variant: any) => void;
  activateVariant?: (routePattern: string, variantName: string) => boolean;

  /** Behavior tracking analytics snapshot */
  behaviors?: any;

  /**
   * Generate a React component from a description.
   * Only available when config.frontend.enabled = true.
   */
  generateComponent?: (request: {
    name: string;
    routePath?: string;
    intent: string;
    dataEndpoints?: string[];
    isPage?: boolean;
  }) => Promise<{ code: string; componentId: string }>;

  /**
   * Custom optimization pattern templates.
   * Register your own patterns like: seim.patterns.registerRegex(...)
   */
  patterns?: any;

  config: Readonly<SeimConfig>;
  metrics: MetricsStore;
  endpointTracker?: any;
  productionManager?: any;
  dynamicRouter?: any;
  versionManager?: any;
  dispatcher?: any;
  versionRegistry?: any;
  variantRegistry?: any;
  candidateStore?: any;
  artifactStore?: any;
  pipeline?: any;
  behaviorTracker?: any;
  featureDiscovery?: any;
  reactRegistry?: any;
  reactGenerator?: any;
  issueStream?: any;
  orchestrator?: any;
  frontendEvolver?: any;
  changelog?: any;
  prGenerator?: any;
  scaffolder?: any;
  runtimeOptimizer?: any;
  astOptimizer?: any;
  moduleGraph?: any;
  fuzzer?: any;
  schemaEvolution?: any;
  multiModel?: any;
  intentAnalyzer?: any;
  intelligentOptimizer?: any;
  engineer?: SoftwareEngineer;
  applicationControlPlane?: ApplicationControlPlane;
  githubFeedback?: import('./feedback/githubFeedbackLoop').GitHubFeedbackLoop;
  githubWebhook?: any;
}

export type RequestListener = (req: GenericRequest, res: GenericResponse, next: () => void) => void;

export interface OptimizationMemory {
  problem: string;
  solution: string;
  framework: string;
  successCount: number;
  failureCount: number;
  averageImprovement: number;
  lastUsed: number;
  bestImprovement?: number;
  bestSolutionCode?: string;
  bestOriginalCode?: string;
  routeKeys?: string[];
}

export interface EvolutionConfig {
  enabled: boolean;
  populationSize: number;
  maxGenerations: number;
  fitnessWeights: {
    latency: number;
    errorRate: number;
    memory: number;
    stability: number;
  };
  tournamentRounds: number;
  elitePreservation: boolean;
  driftDetection: boolean;
  driftThresholdPercent: number;
  driftCheckIntervalMs: number;
  patternExtraction: boolean;
  crossRouteIntelligence: boolean;
}

export interface FitnessScore {
  overall: number;
  latencyScore: number;
  errorRateScore: number;
  memoryScore: number;
  stabilityScore: number;
  generation: number;
  lineageId: string;
}

export interface EvolutionCandidate {
  id: string;
  routeKey: string;
  generation: number;
  parentId?: string;
  strategy: 'template' | 'ai-standard' | 'ai-creative' | 'learned-pattern' | 'crossover';
  code: string;
  originalCode: string;
  pattern: string;
  fitness?: FitnessScore;
  status: 'pending' | 'testing' | 'eliminated' | 'winner' | 'promoted';
  createdAt: number;
}

export interface OptimizationExplanation {
  routeKey: string;
  candidateId: string;
  pattern: string;
  strategy: string;
  whatChanged: string;
  whyChosen: string;
  measuredImpact: {
    latencyReduction: number;
    latencyReductionPercent: number;
    errorRateChange: number;
    memoryChange: number;
  };
  fitnessScore: number;
  generation: number;
  lineage: string[];
  relatedOptimizations: string[];
  timestamp: number;
}
