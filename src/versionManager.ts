import { SeimConfig } from './types';

export interface EndpointVersion {
  id: string;
  routeKey: string;
  version: string; // Semantic versioning (v1.0.0, v1.1.0, etc.)
  type: 'original' | 'optimized' | 'rollback';
  code: string;
  metadata: {
    createdAt: number;
    createdBy: 'ai' | 'manual';
    reason: string;
    commitHash?: string; // Git commit for code-based deployments
    pattern?: string; // AI-detected pattern
    confidence?: number; // AI confidence score
  };
  performance: {
    averageLatency: number;
    p95Latency: number;
    errorRate: number;
    sampleSize: number;
  };
  status: 'active' | 'inactive' | 'deprecated';
  rollbackSafe: boolean; // Can this version be safely rolled back to
}

export interface VersionTransition {
  id: string;
  routeKey: string;
  fromVersion: string;
  toVersion: string;
  transitionAt: number;
  reason: string;
  triggeredBy: 'auto' | 'manual';
  rolloutStrategy: 'immediate' | 'canary' | 'blue-green';
  rolloutPercentage: number;
}

export class VersionManager {
  protected versions: Map<string, EndpointVersion[]> = new Map();
  protected transitions: Map<string, VersionTransition[]> = new Map();
  protected activeVersions: Map<string, string> = new Map(); // routeKey -> versionId
  private config: SeimConfig;

  constructor(config: SeimConfig) {
    this.config = config;
  }

  public async createVersion(routeKey: string, code: string, metadata: Partial<EndpointVersion['metadata']>): Promise<EndpointVersion> {
    const existingVersions = this.versions.get(routeKey) || [];
    const versionNumber = this.generateVersionNumber(existingVersions);
    
    const newVersion: EndpointVersion = {
      id: `${routeKey}::${versionNumber}::${Date.now()}::${Math.random().toString(36).slice(2, 8)}`,
      routeKey,
      version: versionNumber,
      type: metadata.createdBy === 'ai' ? 'optimized' : 'original',
      code,
      metadata: {
        createdAt: Date.now(),
        createdBy: metadata.createdBy || 'ai',
        reason: metadata.reason || 'New version created',
        commitHash: metadata.commitHash,
        pattern: metadata.pattern,
        confidence: metadata.confidence,
      },
      performance: {
        averageLatency: 0,
        p95Latency: 0,
        errorRate: 0,
        sampleSize: 0,
      },
      status: 'inactive',
      rollbackSafe: true, // Assume safe until proven otherwise
    };

    existingVersions.push(newVersion);
    this.versions.set(routeKey, existingVersions);
    
    return newVersion;
  }

  public async activateVersion(routeKey: string, versionId: string, transitionData: {
    reason: string;
    triggeredBy: 'auto' | 'manual';
    rolloutStrategy: 'immediate' | 'canary' | 'blue-green';
    rolloutPercentage: number;
  }): Promise<boolean> {
    const versions = this.versions.get(routeKey);
    if (!versions) return false;

    const targetVersion = versions.find(v => v.id === versionId);
    if (!targetVersion) return false;

    const previousActiveVersionId = this.activeVersions.get(routeKey);
    
    // Record transition
    const transition: VersionTransition = {
      id: `transition::${Date.now()}::${Math.random().toString(36).slice(2, 8)}`,
      routeKey,
      fromVersion: previousActiveVersionId || 'none',
      toVersion: versionId,
      transitionAt: Date.now(),
      reason: transitionData.reason,
      triggeredBy: transitionData.triggeredBy,
      rolloutStrategy: transitionData.rolloutStrategy,
      rolloutPercentage: transitionData.rolloutPercentage,
    };

    const existingTransitions = this.transitions.get(routeKey) || [];
    existingTransitions.push(transition);
    this.transitions.set(routeKey, existingTransitions);

    // Update version statuses
    versions.forEach(v => {
      if (v.id === versionId) {
        v.status = 'active';
      } else if (v.status === 'active') {
        v.status = 'inactive';
      }
    });

    this.activeVersions.set(routeKey, versionId);
    
    return true;
  }

  public async getActiveVersion(routeKey: string): Promise<EndpointVersion | undefined> {
    const activeVersionId = this.activeVersions.get(routeKey);
    if (!activeVersionId) return undefined;

    const versions = this.versions.get(routeKey);
    if (!versions) return undefined;

    return versions.find(v => v.id === activeVersionId);
  }

  public async getVersion(routeKey: string, versionId: string): Promise<EndpointVersion | undefined> {
    const versions = this.versions.get(routeKey);
    if (!versions) return undefined;

    return versions.find(v => v.id === versionId);
  }

  public async getAllVersions(routeKey: string): Promise<EndpointVersion[]> {
    return this.versions.get(routeKey) || [];
  }

  public async getTransitionHistory(routeKey: string): Promise<VersionTransition[]> {
    return this.transitions.get(routeKey) || [];
  }

  public async rollbackToVersion(routeKey: string, targetVersionId: string, reason: string): Promise<boolean> {
    const versions = this.versions.get(routeKey);
    if (!versions) return false;

    const targetVersion = versions.find(v => v.id === targetVersionId);
    if (!targetVersion || !targetVersion.rollbackSafe) {
      return false;
    }

    // Create a rollback version (new version with old code)
    const rollbackVersion = await this.createVersion(routeKey, targetVersion.code, {
      createdBy: 'manual',
      reason: `Rollback to ${targetVersion.version}: ${reason}`,
      pattern: targetVersion.metadata.pattern,
    });

    rollbackVersion.type = 'rollback';
    rollbackVersion.rollbackSafe = true;

    // Activate the rollback version
    return await this.activateVersion(routeKey, rollbackVersion.id, {
      reason: `Rollback: ${reason}`,
      triggeredBy: 'manual',
      rolloutStrategy: 'immediate',
      rolloutPercentage: 100,
    });
  }

  public async updateVersionPerformance(routeKey: string, versionId: string, performance: Partial<EndpointVersion['performance']>): Promise<boolean> {
    const versions = this.versions.get(routeKey);
    if (!versions) return false;

    const version = versions.find(v => v.id === versionId);
    if (!version) return false;

    Object.assign(version.performance, performance);
    return true;
  }

  public async markVersionUnsafe(routeKey: string, versionId: string): Promise<boolean> {
    const versions = this.versions.get(routeKey);
    if (!versions) return false;

    const version = versions.find(v => v.id === versionId);
    if (!version) return false;

    version.rollbackSafe = false;
    return true;
  }

  public async deprecateVersion(routeKey: string, versionId: string): Promise<boolean> {
    const versions = this.versions.get(routeKey);
    if (!versions) return false;

    const version = versions.find(v => v.id === versionId);
    if (!version) return false;

    version.status = 'deprecated';
    return true;
  }

  public async compareVersions(routeKey: string, versionId1: string, versionId2: string): Promise<{
    version1: EndpointVersion | undefined;
    version2: EndpointVersion | undefined;
    codeDiff: string;
    performanceDiff: object;
  }> {
    const versions = this.versions.get(routeKey) || [];
    const v1 = versions.find(v => v.id === versionId1);
    const v2 = versions.find(v => v.id === versionId2);

    if (!v1 || !v2) {
      return {
        version1: v1,
        version2: v2,
        codeDiff: 'One or both versions not found',
        performanceDiff: {},
      };
    }

    // Simple code diff (in production, use a proper diff library)
    const codeDiff = this.generateSimpleDiff(v1.code, v2.code);
    const performanceDiff = {
      latencyChange: v2.performance.averageLatency - v1.performance.averageLatency,
      errorRateChange: v2.performance.errorRate - v1.performance.errorRate,
    };

    return {
      version1: v1,
      version2: v2,
      codeDiff,
      performanceDiff,
    };
  }

  private generateVersionNumber(existingVersions: EndpointVersion[]): string {
    if (existingVersions.length === 0) return 'v1.0.0';
    
    const latestVersion = existingVersions[existingVersions.length - 1];
    const versionParts = latestVersion.version.replace('v', '').split('.').map(Number);
    
    // Increment patch version
    versionParts[2]++;
    
    return `v${versionParts.join('.')}`;
  }

  private generateSimpleDiff(code1: string, code2: string): string {
    // Simple line-by-line comparison (in production, use proper diff library)
    const lines1 = code1.split('\n');
    const lines2 = code2.split('\n');
    
    let diff = '';
    const maxLines = Math.max(lines1.length, lines2.length);
    
    for (let i = 0; i < maxLines; i++) {
      const line1 = lines1[i] || '';
      const line2 = lines2[i] || '';
      
      if (line1 !== line2) {
        if (line1 && !line2) {
          diff += `- ${line1}\n`;
        } else if (!line1 && line2) {
          diff += `+ ${line2}\n`;
        } else {
          diff += `- ${line1}\n`;
          diff += `+ ${line2}\n`;
        }
      }
    }
    
    return diff || 'No differences';
  }

  public async exportState(): Promise<object> {
    return {
      versions: Array.from(this.versions.entries()),
      transitions: Array.from(this.transitions.entries()),
      activeVersions: Array.from(this.activeVersions.entries()),
    };
  }

  public async importState(state: any): Promise<void> {
    this.versions = new Map(state.versions);
    this.transitions = new Map(state.transitions);
    this.activeVersions = new Map(state.activeVersions);
  }
}
