import { SeimInstance, SeimConfig, SeimStatus } from './types';
import { mergeConfig } from './config';
import { InMemoryMetricsStore } from './metrics';
import { OptimizationEngine } from './optimization';
import { ValidationEngine } from './validation';
import { ShadowTestEngine } from './shadow';
import { RollbackEngine } from './rollback';
import { LearningMemoryStore } from './learning';
import { LLMClient } from './ai';
import { Sandbox } from './sandbox';
import { ShadowLimiter } from './shadowLimiter';
import { MetricsAnalyzer } from './metricsAnalyzer';
import { EndpointTracker } from './endpointTracker';
import { ProductionManager } from './productionManager';
import { DynamicRouter } from './dynamicRouter';
import { PersistentVersionManager } from './persistentVersionManager';
import { createStorageAdapter } from './storageFactory';
import { createExpressListener, createListener } from './middleware';
import { createStudioHandler, pushStudioEvent } from './studio';
import { createAdapter } from './adapters';
import { SeimEventBus } from './events';
import { Logger } from './logger';
import { OptimizationWorker } from './worker';
import { FeatureScaffolder } from './scaffolder';
import { ExplanationGenerator } from './explain';
import {
  EvolutionManager,
  PopulationGenerator,
  TournamentSelector,
  CallGraph,
  OptimizationPropagator,
  PatternExtractor,
  LearnedPatternRegistry,
  DriftDetector,
  EvolutionPipeline,
} from './evolution';
import { VersionRegistry, RuntimeVersion } from './versionRegistry';
import { VersionDispatcher } from './versionDispatcher';
import { StableCanaryAssigner, CanaryAssigner } from './canaryAssignment';
import { VariantRegistry, HandlerVariant } from './variantRegistry';
import { CandidateStore, MemoryCandidateStore, FileCandidateStore, PersistedCandidate, CandidateTransition } from './candidateStore';
import { ArtifactStore, MemoryArtifactStore, FileArtifactStore, EvolutionArtifact } from './artifactStore';

// Autonomous Product Evolution imports
import { BehaviorTracker } from './behaviorTracker';
import { FeatureDiscovery } from './featureDiscovery';
import { ReactComponentRegistry, ReactComponentGenerator } from './react';
import { CustomPatternRegistry } from './customPatternRegistry';
import { IssueStream, ProductIssue, IssueType } from './issueStream';
import { FrontendEvolver, FrontendChange } from './frontendEvolver';
import { ProductChangelog, ChangelogEntry } from './productChangelog';
import { EvolutionOrchestrator } from './evolutionOrchestrator';
import { RuntimeOptimizer } from './runtimeOptimizer';
import { AstOptimizer } from './astOptimizer';
import { IntentAnalyzer } from './intentAnalyzer';
import { IntelligentOptimizer } from './intelligentOptimizer';
import { ModuleGraph } from './moduleGraph';
import { SyntheticFuzzer } from './fuzzer';
import { SchemaEvolutionEngine } from './schemaEvolution';
import { MultiModelOrchestrator } from './multiModelOrchestrator';
import { PrGenerator } from './prGenerator';
import { createSoftwareEngineer, connectEngineerToIssueStream } from './engineer';
import { createGitHubFeedbackService } from './feedback';

export * from './types';
export { mergeConfig } from './config';
export { SeimEventBus } from './events';
export { Logger, LogLevel, LogTransport, LoggerConfig } from './logger';
export { FrameworkAdapter } from './adapters/types';
export { EvolutionManager, CallGraph, LearnedPatternRegistry, EvolutionPipeline } from './evolution';
export * from './engineer';
export * from './delivery';
export * from './feedback';
export * from './github';
export { CandidateLifecycleManager, CandidateStatus, LiveCandidate } from './candidateLifecycle';
export { VersionRegistry, RuntimeVersion } from './versionRegistry';
export { VersionDispatcher } from './versionDispatcher';
export { StableCanaryAssigner, CanaryAssigner } from './canaryAssignment';
export { VariantRegistry, HandlerVariant } from './variantRegistry';
export { CandidateStore, MemoryCandidateStore, FileCandidateStore, PersistedCandidate, CandidateTransition } from './candidateStore';
export { ArtifactStore, MemoryArtifactStore, FileArtifactStore, EvolutionArtifact } from './artifactStore';
export { BehaviorTracker } from './behaviorTracker';
export { FeatureDiscovery } from './featureDiscovery';
export { ReactComponentRegistry, ReactComponentGenerator } from './react';
export { CustomPatternRegistry } from './customPatternRegistry';
export { IssueStream, ProductIssue, IssueType } from './issueStream';
export { FrontendEvolver, FrontendChange } from './frontendEvolver';
export { ProductChangelog, ChangelogEntry } from './productChangelog';
export { EvolutionOrchestrator } from './evolutionOrchestrator';
export type { CustomPattern, PatternDetector, PatternFixer } from './customPatternRegistry';
export type { ReactComponent, FrontendRouteConfig, ComponentRequest, ReactApplicationContext, ReactAppFramework, ReactRouterKind } from './react';

function seim(userConfig: Partial<SeimConfig> = {}): SeimInstance {
  const config = mergeConfig(userConfig);

  // Core infrastructure
  const events = new SeimEventBus();
  const logger = new Logger({
    level: config.logging?.level ?? 'info',
    json: config.logging?.json ?? false,
  });
  const adapter = createAdapter(config.framework);
  const worker = new OptimizationWorker(
    config.worker?.intervalMs ?? 10000,
    events,
    logger,
  );

  const metrics = new InMemoryMetricsStore();
  const llm = new LLMClient(config);
  const sandbox = new Sandbox(config.environment === 'production' || config.production?.requireIsolatedVm === true);
  const optimization = new OptimizationEngine(config, llm);
  
  // Persistent storage directory and file paths
  const storagePath = config.storagePath ?? './.seim-storage';
  const schemasPath = `${storagePath}/schemas.json`;
  const businessMetricsPath = `${storagePath}/business-metrics.json`;

  // Validation Engine
  const validation = new ValidationEngine(config, llm);
  
  const rollback = new RollbackEngine(config);
  const shadow = new ShadowTestEngine();
  const shadowLimiter = new ShadowLimiter(config);
  const metricsAnalyzer = new MetricsAnalyzer();
  const endpointTracker = new EndpointTracker();
  const productionManager = new ProductionManager(config);
  const dynamicRouter = new DynamicRouter(productionManager);

  // Persistent learning with file-backed storage
  const usesMemoryStorage = config.storage?.type === 'memory';
  const learningPath = usesMemoryStorage ? undefined : `${storagePath}/learning.json`;
  const patternsPath = usesMemoryStorage ? undefined : `${storagePath}/learned-patterns.json`;
  const learning = new LearningMemoryStore(learningPath);

  // Evolution engine components
  const learnedPatterns = new LearnedPatternRegistry(patternsPath);
  const callGraph = new CallGraph();
  const populationGenerator = new PopulationGenerator(
    config, llm, optimization, learning, learnedPatterns, logger,
  );
  const tournament = new TournamentSelector(config, logger, events);
  const evolutionManager = new EvolutionManager(
    config, populationGenerator, tournament, logger, events,
  );
  const propagator = new OptimizationPropagator(callGraph, worker, logger, events);
  const patternExtractor = new PatternExtractor(learnedPatterns, logger, events);
  const driftDetector = new DriftDetector(config, metrics, worker, logger, events);
  const explainer = new ExplanationGenerator(llm, logger);

  // Persistent version management
  const storageAdapter = createStorageAdapter(config);
  const versionManager = new PersistentVersionManager(config, storageAdapter);

  // Deployment engine: version registry & dispatcher
  const versionRegistry = new VersionRegistry();
  const canaryAssigner = new StableCanaryAssigner();
  const dispatcher = new VersionDispatcher(versionRegistry, canaryAssigner, events, logger);
  const variantRegistry = new VariantRegistry();

  // Candidate and Artifact persistence stores
  const candidateStore = config.storage?.type === 'memory'
    ? new MemoryCandidateStore()
    : new FileCandidateStore(storagePath);

  const artifactStore = config.storage?.type === 'memory'
    ? new MemoryArtifactStore()
    : new FileArtifactStore(storagePath);

  const pipeline = new EvolutionPipeline(artifactStore, dispatcher, events, logger);

  const scaffolder = new FeatureScaffolder(config, llm);

  // Feature 1: Behavior-Driven Feature Discovery
  const behaviorTracker = new BehaviorTracker();
  const featureDiscovery = new FeatureDiscovery(behaviorTracker, scaffolder, config, events, logger);

  // Feature 2: React Frontend Component Generation
  const reactRegistry = new ReactComponentRegistry();
  const reactGenerator = new ReactComponentGenerator(reactRegistry, llm, config, events, logger);

  const softwareEngineer = createSoftwareEngineer({
    config,
    storagePath,
    scaffolder,
    reactGenerator,
    logger,
    events,
  });
  const githubFeedbackService = createGitHubFeedbackService(config, storagePath, softwareEngineer, events, logger);

  // Feature 3: Custom Pattern Registry — wire into optimization engine
  const customPatternRegistry = new CustomPatternRegistry();
  optimization.setCustomPatternRegistry(customPatternRegistry);

  // Autonomous Product Evolution System
  const changelogPath = config.changelog?.persistPath ?? (usesMemoryStorage ? null : storagePath);
  const changelog = new ProductChangelog(changelogPath);
  const frontendEvolver = new FrontendEvolver(reactGenerator, reactRegistry, config, events, logger);
  const issueStream = new IssueStream(behaviorTracker, metrics, config, events, logger);
  const orchestrator = new EvolutionOrchestrator(
    issueStream, scaffolder, frontendEvolver, changelog, dynamicRouter, sandbox, config, events, logger
  );

  // Frontier Maximal Power Engines
  const moduleGraph = new ModuleGraph();
  const fuzzer = new SyntheticFuzzer(sandbox, logger);
  const schemaEvolution = new SchemaEvolutionEngine(undefined, logger);
  const multiModel = new MultiModelOrchestrator(config, logger);
  const intentAnalyzer = new IntentAnalyzer(config, llm, logger);
  const intelligentOptimizer = new IntelligentOptimizer(config, llm, logger);
  const prGenerator = new PrGenerator(config, storagePath);

  // Load persisted state on startup
  versionManager.loadAllStates().catch((err: Error) => {
    logger.warn('Failed to load persisted version state', { error: err.message });
  });

  const deps = {
    metrics, optimization, validation, shadow, rollback, learning, sandbox,
    shadowLimiter, metricsAnalyzer, endpointTracker, adapter, events, logger, worker, scaffolder,
    dynamicRouter,
  };

  // Start the background worker if enabled
  if (config.worker?.enabled !== false) {
    worker.start();
  }

  // Start drift detection if evolution + drift detection enabled
  if (config.evolution?.enabled !== false && config.evolution?.driftDetection) {
    driftDetector.start();
  }

  // Start autonomous product evolution issue stream & orchestrator
  if (config.behavior?.enabled !== false) {
    issueStream.start();
    orchestrator.start();
  }

  connectEngineerToIssueStream({ config, events, engineer: softwareEngineer, logger });

  // Wire learning into the optimization lifecycle via events
  events.on('optimization:promoted', async (payload: any) => {
    const { routeKey, candidateId, latencyImprovement } = payload;
    const candidates = evolutionManager.getCandidates(routeKey);
    const winner = candidates.find(c => c.id === candidateId) || candidates.find(c => c.status === 'winner');
    const pattern = winner?.pattern || 'unknown';
    const strategy = winner?.strategy || 'unknown';

    // Record success in learning store
    learning.remember(pattern, strategy, adapter.name, latencyImprovement, true, {
      routeKey,
      candidateCode: winner?.code,
      originalCode: winner?.originalCode,
    });

    // Record in product changelog
    changelog.record({
      type: 'optimization',
      title: `Optimized Route: ${routeKey}`,
      description: `Autonomous latency improvement of ${Math.round(latencyImprovement)}ms (${pattern} - ${strategy})`,
      path: routeKey,
      code: winner?.code,
      latencyImprovement: `${Math.round(latencyImprovement)}ms`,
      status: 'live',
    });

    // Extract pattern from AI-generated fixes for future reuse
    if (config.evolution?.patternExtraction && winner && (winner.strategy === 'ai-standard' || winner.strategy === 'ai-creative')) {
      patternExtractor.extract(routeKey, winner.originalCode, winner.code, pattern, latencyImprovement);
    }

    // Cross-route propagation
    if (config.evolution?.crossRouteIntelligence) {
      propagator.propagate(routeKey, pattern);
    }

    // Record drift baseline
    const routeMetrics = metrics.forRoute(routeKey);
    if (routeMetrics) {
      driftDetector.recordBaseline(routeKey, routeMetrics);
    }

    // Generate explanation
    if (winner?.fitness) {
      const lineage = evolutionManager.getLineage(routeKey, winner.id);
      const relatedRoutes = callGraph.findRelatedRoutes(routeKey);
      const v1Latency = routeMetrics ? routeMetrics.totalDuration / Math.max(1, routeMetrics.requestCount) : 0;
      const v2Latency = v1Latency - latencyImprovement;
      try {
        const explanation = await explainer.generate(winner, winner.fitness, v1Latency, v2Latency, lineage, relatedRoutes);
        events.emitEvent('optimization:explained', { routeKey, explanation });
      } catch {
        // Explanation generation is best-effort
      }
    }
  });

  events.on('optimization:rejected', (payload: any) => {
    const { routeKey, candidateId, reason } = payload;
    const candidates = evolutionManager.getCandidates(routeKey);
    const candidate = candidates.find(c => c.id === candidateId);
    const pattern = candidate?.pattern || 'unknown';
    const strategy = candidate?.strategy || 'unknown';

    learning.remember(pattern, strategy, adapter.name, 0, false, {
      routeKey,
      candidateCode: candidate?.code,
      originalCode: candidate?.originalCode,
    });
  });

  events.on('optimization:rolledback', (payload: any) => {
    const { routeKey } = payload;
    driftDetector.removeBaseline(routeKey);
    changelog.rollback(routeKey, 'Performance regression detected in production');
  });

  logger.info('SEIM initialized', {
    mode: config.mode,
    framework: adapter.name,
    environment: config.environment ?? 'development',
    workerEnabled: config.worker?.enabled !== false,
    evolutionEnabled: config.evolution?.enabled !== false,
    behaviorEnabled: config.behavior?.enabled === true,
    frontendEnabled: config.frontend?.enabled === true,
    learnedPatterns: learnedPatterns.size(),
    learningEntries: learning.size(),
  });

  events.emitEvent('lifecycle:started', {
    mode: config.mode,
    framework: adapter.name,
  });

  // Feature 1: run behavior-driven discovery every 5 minutes when enabled
  let behaviorDiscoveryTimer: NodeJS.Timeout | null = null;
  if (config.behavior?.enabled) {
    behaviorDiscoveryTimer = setInterval(async () => {
      try {
        const discovered = await featureDiscovery.discover();
        if (discovered.length > 0) {
          logger.info(`[BehaviorDiscovery] Found ${discovered.length} new feature opportunities`, {
            features: discovered.map(f => `${f.method} ${f.path}`),
          });
          if (config.behavior?.autoScaffold) {
            for (const feature of discovered) {
              await featureDiscovery.scaffoldFeature(feature.id);
            }
          }
        }
      } catch (err: any) {
        logger.warn('[BehaviorDiscovery] Discovery cycle failed', { error: err?.message });
      }
    }, 5 * 60 * 1000);
    if (behaviorDiscoveryTimer && typeof behaviorDiscoveryTimer.unref === 'function') {
      behaviorDiscoveryTimer.unref();
    }
  }

  const behaviorMiddleware = config.behavior?.enabled !== false ? behaviorTracker.middleware() : undefined;

  // Build instance object — note: dashboard is set AFTER so the handler closes over the real instance
  const instance: SeimInstance = {
    listener: createExpressListener(config, deps, behaviorMiddleware),
    plugin: adapter.name === 'fastify' ? () => createListener(config, deps, behaviorMiddleware)() : undefined,
    dashboard: null as any, // set below after instance is built
    status: (): SeimStatus => {
      const workerHealthy = worker.isRunning();

      return {
        mode: config.mode,
        framework: adapter.name,
        uptime: process.uptime(),
        totalOptimizationsGenerated: evolutionManager.stats().totalCandidates,
        totalOptimizationsPromoted: rollback.promotedCount(),
        totalRollbacks: rollback.totalRollbacks(),
        activeShadowTests: evolutionManager.stats().activeEvolutions,
        activeVersions: rollback.list().map((v) => ({ routeKey: v.routeKey, active: v.active })),
        workerQueueSize: worker.queueSize(),
        healthy: workerHealthy,
        components: {
          worker: workerHealthy,
          storage: true,
          ai: config.ai.enabled,
          evolution: config.evolution?.enabled !== false,
        },
      };
    },
    shutdown: async (): Promise<void> => {
      logger.info('SEIM shutting down');
      worker.stop();
      driftDetector.stop();
      productionManager.destroy();
      learning.destroy();
      metrics.destroy();
      behaviorTracker.destroy();
      issueStream.destroy();
      orchestrator.destroy();
      await versionManager.close();
      if (behaviorDiscoveryTimer) {
        clearInterval(behaviorDiscoveryTimer);
        behaviorDiscoveryTimer = null;
      }
      events.emitEvent('lifecycle:shutdown', { reason: 'shutdown() called' });
      events.removeAllListeners();
    },
    on: (event: string, listener: (...args: any[]) => void): void => {
      events.on(event, listener);
    },
    registerVariant: (routePattern: string, variant: any): void => {
      variantRegistry.register(routePattern, variant);
      logger.info('Registered prebuilt handler variant', { routePattern, variantName: variant.name });
    },
    activateVariant: (routePattern: string, variantName: string): boolean => {
      const ok = variantRegistry.activateVariant(routePattern, variantName);
      if (ok) {
        logger.info('Activated prebuilt handler variant', { routePattern, variantName });
      }
      return ok;
    },
    // Feature 1: Behavior analytics snapshot
    get behaviors() {
      return behaviorTracker.snapshot();
    },
    // Feature 2: React component generation
    generateComponent: async (request) => {
      if (!config.frontend?.enabled) {
        throw new Error('React frontend generation is not enabled. Set config.frontend.enabled = true');
      }
      const component = await reactGenerator.generate({
        name: request.name,
        routePath: request.routePath,
        intent: request.intent,
        dataEndpoints: request.dataEndpoints,
        isPage: request.isPage,
      });
      return { code: component.code, componentId: component.id };
    },
    // Feature 3: Custom optimization pattern registry
    patterns: customPatternRegistry,
    config,
    metrics,
    endpointTracker,
    productionManager,
    dynamicRouter,
    versionManager,
    dispatcher,
    versionRegistry,
    variantRegistry,
    candidateStore,
    artifactStore,
    pipeline,
    behaviorTracker,
    featureDiscovery,
    reactRegistry,
    reactGenerator,
    issueStream,
    orchestrator,
    changelog,
    prGenerator,
    scaffolder,
    runtimeOptimizer: RuntimeOptimizer,
    astOptimizer: AstOptimizer,
    moduleGraph,
    fuzzer,
    schemaEvolution,
    multiModel,
    intentAnalyzer,
    intelligentOptimizer,
    engineer: softwareEngineer,
    applicationControlPlane: softwareEngineer.applicationControlPlane,
    githubFeedback: githubFeedbackService?.loop,
    githubWebhook: githubFeedbackService?.handler,
  };

  // Wire up studio dashboard ONCE with the fully-built instance (single source of truth)
  instance.dashboard = createStudioHandler(instance);

  // Wire key lifecycle events into studio event log so /api/events shows real activity
  const studioEvents = [
    'optimization:detected', 'optimization:promoted', 'optimization:rejected',
    'optimization:rolledback', 'feature:discovered', 'feature:deployed',
    'frontend:component_generated', 'frontend:evolved', 'issue:detected',
    'issue:resolved', 'metrics:threshold', 'error:sandbox', 'error:validation',
    'lifecycle:started', 'engineer:application-handed-off', 'engineer:goal-created', 'engineer:task-updated', 'engineer:job-created', 'engineer:approval-required', 'engineer:pull-request-created', 'engineer:job-rejected', 'engineer:deployed', 'engineer:rolled-back', 'engineer:delivery-feedback',
  ];
  for (const ev of studioEvents) {
    events.on(ev, (payload: any) => pushStudioEvent(ev, payload));
  }

  // Prepend behavior tracking middleware if enabled
  if (config.behavior?.enabled !== false && behaviorMiddleware) {
    (instance as any)._behaviorMiddleware = behaviorMiddleware;
    logger.info('[BehaviorTracker] Behavior tracking middleware active');
  }

  return instance;
}

export default seim;
export {
  seim,
  RuntimeOptimizer,
  AstOptimizer,
  ModuleGraph,
  SyntheticFuzzer,
  SchemaEvolutionEngine,
  MultiModelOrchestrator,
  IntentAnalyzer,
  IntelligentOptimizer,
  PrGenerator,
};
export { createAuthGuard } from './auth';
