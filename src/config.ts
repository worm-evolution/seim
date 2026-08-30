import { SeimConfig, SeimMode, EvolutionConfig } from './types';
import { loadConfigFromFile } from './configLoader';

export const DEFAULT_EVOLUTION_CONFIG: EvolutionConfig = {
  enabled: true,
  populationSize: 3,
  maxGenerations: 3,
  fitnessWeights: {
    latency: 0.4,
    errorRate: 0.3,
    memory: 0.1,
    stability: 0.2,
  },
  tournamentRounds: 3,
  elitePreservation: true,
  driftDetection: true,
  driftThresholdPercent: 20,
  driftCheckIntervalMs: 300_000,
  patternExtraction: true,
  crossRouteIntelligence: true,
};

export const DEFAULT_STUDIO_PATH = '/seim';
export const DEFAULT_STORAGE_PATH = './.seim-storage';

export const DEFAULT_SECURITY_CONFIG: NonNullable<SeimConfig['security']> = {
  blockAuthenticationChanges: true,
  blockAuthorizationChanges: true,
  blockPaymentChanges: true,
  blockSecretUsage: true,
  allowedPatternModels: ['sequential-async', 'n-plus-one', 'missing-cache', 'inefficient-loop', 'redundant-serialization', 'blocking-op', 'nested-ternary', 'unindexed-find', 'response-streaming', 'ai-detected'],
};

export const DEFAULT_EXPERIMENT_CONFIG: NonNullable<SeimConfig['experiment']> = {
  confidenceThreshold: 0.92,
  canaryPercent: 5,
  rollbackLatencyMultiplier: 1.2,
  rollbackErrorRate: 1.5,
  minSampleSize: 100,
  shadowCooldownMs: 60000,
  shadowAllowedMethods: ['GET'],
  shadowSampleSize: 25,
  sandboxTimeoutMs: 500,
};

export function getDefaultConfig(): SeimConfig {
  return {
    mode: 'restrict' as SeimMode,
    environment: 'development',
    framework: 'express',
    studioPath: DEFAULT_STUDIO_PATH,
    storagePath: DEFAULT_STORAGE_PATH,
    businessRules: [],
    securityRules: [],
    production: {},
    ai: {
      generatorModel: 'gpt-4',
      reviewerModel: 'gpt-4',
      verifierModel: 'gpt-4',
      baseUrl: 'https://api.openai.com/v1/chat/completions',
      enabled: false,
    },
    experiment: { ...DEFAULT_EXPERIMENT_CONFIG },
    storage: {
      type: 'memory',
    },
    security: { ...DEFAULT_SECURITY_CONFIG },
    learning: {
      enabled: true,
      sampleSize: 50,
    },
    logging: {
      level: 'info',
      json: false,
    },
    worker: {
      enabled: true,
      intervalMs: 10000,
      batchSize: 5,
    },
    autoMiddleware: {
      etag: true,
      compression: true,
      caching: true,
      rateLimit: false,
    },
    evolution: { ...DEFAULT_EVOLUTION_CONFIG },
    autonomousPromotion: false,
    engineer: { enabled: false, repository: "memory", persistence: "memory", maxVerificationMs: 600000 },
  };
}

export function mergeConfig(user: Partial<SeimConfig> = {}): SeimConfig {
  // Auto-discover config from project files if no config passed
  const fileConfig = loadConfigFromFile(process.cwd(), { allowJavaScript: process.env.SEIM_ALLOW_JS_CONFIG === 'true' }) || {};
  const effective = { ...fileConfig, ...user };

  const defaults = getDefaultConfig();
  const merged: SeimConfig = {
    ...defaults,
    ...effective,
    storagePath: effective.storagePath ?? DEFAULT_STORAGE_PATH,
    businessRules: [...(effective.businessRules ?? defaults.businessRules)],
    securityRules: [...(effective.securityRules ?? defaults.securityRules)],
    ai: { ...defaults.ai, ...effective.ai },
    experiment: { ...defaults.experiment, ...(effective.experiment ?? {}) },
    storage: { ...defaults.storage, ...(effective.storage ?? {}) },
    security: { ...defaults.security, ...(effective.security ?? {}) },
    learning: { ...defaults.learning, ...(effective.learning ?? {}) },
    logging: { ...defaults.logging, ...(effective.logging ?? {}) },
    worker: { ...defaults.worker, ...(effective.worker ?? {}) },
    autoMiddleware: { ...defaults.autoMiddleware, ...(effective.autoMiddleware ?? {}) },
    evolution: {
      ...DEFAULT_EVOLUTION_CONFIG,
      ...(effective.evolution ?? {}),
      fitnessWeights: {
        ...DEFAULT_EVOLUTION_CONFIG.fitnessWeights,
        ...((effective.evolution as any)?.fitnessWeights ?? {}),
      },
    },
    environment: effective.environment ?? defaults.environment,
    framework: effective.framework ?? defaults.framework,
    production: { ...defaults.production, ...(effective.production ?? {}) },
    autonomousPromotion: effective.autonomousPromotion ?? defaults.autonomousPromotion,
    behavior: {
      enabled: false,
      minPatternFrequency: 3,
      maxEvents: 10000,
      autoScaffold: false,
      excludePaths: ['/health', '/metrics', '/favicon.ico', '/seim'],
      ...(effective.behavior ?? {}),
    },
    frontend: {
      enabled: false,
      outputDir: './src/components/seim-generated',
      writeToDisk: false,
      framework: 'react',
      typescript: true,
      ...(effective.frontend ?? {}),
    },
    patterns: {
      enabled: true,
      ...(effective.patterns ?? {}),
    },
    engineer: {
      enabled: false,
      repository: "memory",
      persistence: "memory",
      maxVerificationMs: 600000,
      ...(effective.engineer ?? {}),
      feedback: {
        enabled: false,
        maxPayloadBytes: 1048576,
        maxTransientRetries: 1,
        maxRepairsPerFingerprint: 2,
        ...(effective.engineer?.feedback ?? {}),
      },
    },

  };

  const supportedStorageTypes = new Set(['memory', 'file', 'redis']);
  if (!supportedStorageTypes.has(String(merged.storage?.type))) {
    throw new Error(`Unsupported storage.type: ${String(merged.storage?.type)}. Use "memory", "file", or "redis".`);
  }

  if (merged.environment === 'production') {
    if (merged.storage?.type === 'memory') {
      throw new Error('Production environment requires persistent storage. Set storage.type to "file" or "redis".');
    }
    if (merged.storage?.type === 'redis' && !merged.storage?.connection) {
      throw new Error('Production environment with Redis requires storage.connection (Redis URL).');
    }
  }

  return merged;
}
