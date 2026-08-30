import { VersionManager, EndpointVersion, VersionTransition } from './versionManager';
import { SeimConfig } from './types';

export interface StorageAdapter {
  saveVersion(routeKey: string, version: EndpointVersion): Promise<void>;
  getVersions(routeKey: string): Promise<EndpointVersion[]>;
  getVersion(routeKey: string, versionId: string): Promise<EndpointVersion | undefined>;
  saveTransition(routeKey: string, transition: VersionTransition): Promise<void>;
  getTransitions(routeKey: string): Promise<VersionTransition[]>;
  setActiveVersion(routeKey: string, versionId: string): Promise<void>;
  getActiveVersion(routeKey: string): Promise<string | undefined>;
  updateVersionPerformance(routeKey: string, versionId: string, performance: any): Promise<void>;
  listRouteKeys(): Promise<string[]>;
  close?(): Promise<void>;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

export class MemoryStorageAdapter implements StorageAdapter {
  private versions = new Map<string, Map<string, EndpointVersion>>();
  private transitions = new Map<string, Map<string, VersionTransition>>();
  private activeVersions = new Map<string, string>();

  public async saveVersion(routeKey: string, version: EndpointVersion): Promise<void> {
    const routeVersions = this.versions.get(routeKey) ?? new Map<string, EndpointVersion>();
    routeVersions.set(version.id, clone(version));
    this.versions.set(routeKey, routeVersions);
  }

  public async getVersions(routeKey: string): Promise<EndpointVersion[]> {
    return [...(this.versions.get(routeKey)?.values() ?? [])]
      .sort((a, b) => a.metadata.createdAt - b.metadata.createdAt)
      .map(clone);
  }

  public async getVersion(routeKey: string, versionId: string): Promise<EndpointVersion | undefined> {
    const version = this.versions.get(routeKey)?.get(versionId);
    return version ? clone(version) : undefined;
  }

  public async saveTransition(routeKey: string, transition: VersionTransition): Promise<void> {
    const routeTransitions = this.transitions.get(routeKey) ?? new Map<string, VersionTransition>();
    routeTransitions.set(transition.id, clone(transition));
    this.transitions.set(routeKey, routeTransitions);
  }

  public async getTransitions(routeKey: string): Promise<VersionTransition[]> {
    return [...(this.transitions.get(routeKey)?.values() ?? [])]
      .sort((a, b) => a.transitionAt - b.transitionAt)
      .map(clone);
  }

  public async setActiveVersion(routeKey: string, versionId: string): Promise<void> {
    this.activeVersions.set(routeKey, versionId);
  }

  public async getActiveVersion(routeKey: string): Promise<string | undefined> {
    return this.activeVersions.get(routeKey);
  }

  public async updateVersionPerformance(routeKey: string, versionId: string, performance: any): Promise<void> {
    const version = this.versions.get(routeKey)?.get(versionId);
    if (version) version.performance = { ...version.performance, ...performance };
  }

  public async listRouteKeys(): Promise<string[]> {
    return [...new Set([
      ...this.versions.keys(),
      ...this.transitions.keys(),
      ...this.activeVersions.keys(),
    ])];
  }
}

interface StoredRouteState {
  routeKey: string;
  versions: EndpointVersion[];
  transitions: VersionTransition[];
  activeVersion?: string;
}

export class FileStorageAdapter implements StorageAdapter {
  private readonly storagePath: string;
  private readonly routeLocks = new Map<string, Promise<void>>();

  constructor(storagePath: string = './.seim-storage') {
    this.storagePath = storagePath;
    this.ensureStorageDirectory();
  }

  private ensureStorageDirectory(): void {
    const fs = require('fs');
    if (!fs.existsSync(this.storagePath)) fs.mkdirSync(this.storagePath, { recursive: true });
  }

  private getRouteFilePath(routeKey: string): string {
    const path = require('path');
    const encodedKey = Buffer.from(routeKey, 'utf8').toString('base64url');
    return path.join(this.storagePath, `route-${encodedKey}.json`);
  }

  private getLegacyRouteFilePath(routeKey: string): string {
    const path = require('path');
    const safeKey = routeKey.replace(/[^a-zA-Z0-9-_]/g, '_');
    return path.join(this.storagePath, `${safeKey}.json`);
  }

  private async readState(routeKey: string): Promise<StoredRouteState> {
    const fs = require('fs').promises;
    const candidates = [this.getRouteFilePath(routeKey), this.getLegacyRouteFilePath(routeKey)];
    for (const filePath of candidates) {
      try {
        const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
        if (parsed.routeKey === routeKey || (typeof parsed.routeKey !== 'string' && filePath === candidates[1])) {
          return {
            routeKey,
            versions: parsed.versions ?? [],
            transitions: parsed.transitions ?? [],
            activeVersion: parsed.activeVersion,
          };
        }
      } catch {
        // Try the next path or return an empty state.
      }
    }
    return { routeKey, versions: [], transitions: [] };
  }

  private async atomicWriteFile(filePath: string, content: string): Promise<void> {
    const fs = require('fs').promises;
    const tmpPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    await fs.writeFile(tmpPath, content, 'utf8');
    await fs.rename(tmpPath, filePath);
  }

  private async updateState(routeKey: string, update: (state: StoredRouteState) => void): Promise<void> {
    const previous = this.routeLocks.get(routeKey) ?? Promise.resolve();
    const operation = previous.then(async () => {
      const state = await this.readState(routeKey);
      update(state);
      await this.atomicWriteFile(this.getRouteFilePath(routeKey), JSON.stringify(state, null, 2));
    });
    const settled = operation.catch(() => undefined);
    this.routeLocks.set(routeKey, settled);
    try {
      await operation;
    } finally {
      if (this.routeLocks.get(routeKey) === settled) this.routeLocks.delete(routeKey);
    }
  }

  public async saveVersion(routeKey: string, version: EndpointVersion): Promise<void> {
    await this.updateState(routeKey, state => {
      const index = state.versions.findIndex(item => item.id === version.id);
      if (index >= 0) state.versions[index] = clone(version);
      else state.versions.push(clone(version));
    });
  }

  public async getVersions(routeKey: string): Promise<EndpointVersion[]> {
    return clone((await this.readState(routeKey)).versions);
  }

  public async getVersion(routeKey: string, versionId: string): Promise<EndpointVersion | undefined> {
    return (await this.getVersions(routeKey)).find(version => version.id === versionId);
  }

  public async saveTransition(routeKey: string, transition: VersionTransition): Promise<void> {
    await this.updateState(routeKey, state => {
      const index = state.transitions.findIndex(item => item.id === transition.id);
      if (index >= 0) state.transitions[index] = clone(transition);
      else state.transitions.push(clone(transition));
    });
  }

  public async getTransitions(routeKey: string): Promise<VersionTransition[]> {
    return clone((await this.readState(routeKey)).transitions);
  }

  public async setActiveVersion(routeKey: string, versionId: string): Promise<void> {
    await this.updateState(routeKey, state => { state.activeVersion = versionId; });
  }

  public async getActiveVersion(routeKey: string): Promise<string | undefined> {
    return (await this.readState(routeKey)).activeVersion;
  }

  public async updateVersionPerformance(routeKey: string, versionId: string, performance: any): Promise<void> {
    await this.updateState(routeKey, state => {
      const version = state.versions.find(item => item.id === versionId);
      if (version) version.performance = { ...version.performance, ...performance };
    });
  }

  public async listRouteKeys(): Promise<string[]> {
    const fs = require('fs').promises;
    const routeKeys = new Set<string>();
    let files: string[] = [];
    try {
      files = await fs.readdir(this.storagePath);
    } catch {
      return [];
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const path = require('path');
        const parsed = JSON.parse(await fs.readFile(path.join(this.storagePath, file), 'utf8'));
        if (typeof parsed.routeKey === 'string' && Array.isArray(parsed.versions)) routeKeys.add(parsed.routeKey);
      } catch {
        // Ignore unrelated or malformed JSON files in the shared storage directory.
      }
    }
    return [...routeKeys];
  }
}

export class PersistentVersionManager extends VersionManager {
  constructor(config: SeimConfig, private readonly storageAdapter: StorageAdapter) {
    super(config);
  }

  public override async createVersion(routeKey: string, code: string, metadata: any): Promise<EndpointVersion> {
    const version = await super.createVersion(routeKey, code, metadata);
    await this.storageAdapter.saveVersion(routeKey, version);
    return version;
  }

  public override async activateVersion(routeKey: string, versionId: string, transitionData: any): Promise<boolean> {
    const success = await super.activateVersion(routeKey, versionId, transitionData);
    if (!success) return false;

    for (const version of this.versions.get(routeKey) ?? []) {
      await this.storageAdapter.saveVersion(routeKey, version);
    }
    const routeTransitions = this.transitions.get(routeKey) ?? [];
    const transition = routeTransitions[routeTransitions.length - 1];
    if (transition) await this.storageAdapter.saveTransition(routeKey, transition);
    await this.storageAdapter.setActiveVersion(routeKey, versionId);
    return true;
  }

  public override async getActiveVersion(routeKey: string): Promise<EndpointVersion | undefined> {
    const activeVersionId = await this.storageAdapter.getActiveVersion(routeKey);
    return activeVersionId ? this.storageAdapter.getVersion(routeKey, activeVersionId) : undefined;
  }

  public override async getVersion(routeKey: string, versionId: string): Promise<EndpointVersion | undefined> {
    return this.storageAdapter.getVersion(routeKey, versionId);
  }

  public override async getAllVersions(routeKey: string): Promise<EndpointVersion[]> {
    return this.storageAdapter.getVersions(routeKey);
  }

  public override async getTransitionHistory(routeKey: string): Promise<VersionTransition[]> {
    return this.storageAdapter.getTransitions(routeKey);
  }

  public override async updateVersionPerformance(routeKey: string, versionId: string, performance: any): Promise<boolean> {
    const success = await super.updateVersionPerformance(routeKey, versionId, performance);
    if (success) await this.storageAdapter.updateVersionPerformance(routeKey, versionId, performance);
    return success;
  }

  public override async markVersionUnsafe(routeKey: string, versionId: string): Promise<boolean> {
    const success = await super.markVersionUnsafe(routeKey, versionId);
    const version = success ? this.versions.get(routeKey)?.find(item => item.id === versionId) : undefined;
    if (version) await this.storageAdapter.saveVersion(routeKey, version);
    return success;
  }

  public override async deprecateVersion(routeKey: string, versionId: string): Promise<boolean> {
    const success = await super.deprecateVersion(routeKey, versionId);
    const version = success ? this.versions.get(routeKey)?.find(item => item.id === versionId) : undefined;
    if (version) await this.storageAdapter.saveVersion(routeKey, version);
    return success;
  }

  public async loadState(routeKey: string): Promise<void> {
    const versions = await this.storageAdapter.getVersions(routeKey);
    if (versions.length === 0) return;
    this.versions.set(routeKey, versions);
    this.transitions.set(routeKey, await this.storageAdapter.getTransitions(routeKey));
    const activeVersionId = await this.storageAdapter.getActiveVersion(routeKey);
    if (activeVersionId) this.activeVersions.set(routeKey, activeVersionId);
  }

  public async loadAllStates(): Promise<void> {
    for (const routeKey of await this.storageAdapter.listRouteKeys()) await this.loadState(routeKey);
  }

  public async close(): Promise<void> {
    await this.storageAdapter.close?.();
  }
}
