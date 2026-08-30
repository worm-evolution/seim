import { StorageAdapter } from './persistentVersionManager';
import { EndpointVersion, VersionTransition } from './versionManager';

export class RedisStorageAdapter implements StorageAdapter {
  private readonly client: any;
  private readonly ready: Promise<void>;
  private readonly prefix = 'seim';

  constructor(url?: string) {
    let redis;
    try {
      redis = require('redis');
    } catch {
      throw new Error('Redis storage requires the "redis" package. Install it with: npm install redis');
    }

    const connectionUrl = url || process.env.REDIS_URL || 'redis://localhost:6379';
    this.client = redis.createClient({ url: connectionUrl });
    // Redis clients emit an EventEmitter `error`; keep command/connect rejection as
    // the caller-visible failure without allowing an unhandled event to crash Node.
    this.client.on('error', () => undefined);
    this.ready = this.client.connect();
  }

  private routeToken(routeKey: string): string {
    return Buffer.from(routeKey, 'utf8').toString('base64url');
  }

  private key(routeKey: string, suffix: string): string {
    return `${this.prefix}:${this.routeToken(routeKey)}:${suffix}`;
  }

  private async registerRoute(routeKey: string): Promise<void> {
    await this.ready;
    await this.client.sAdd(`${this.prefix}:routes`, routeKey);
  }

  public async saveVersion(routeKey: string, version: EndpointVersion): Promise<void> {
    await this.registerRoute(routeKey);
    await Promise.all([
      this.client.hSet(this.key(routeKey, 'versions'), version.id, JSON.stringify(version)),
      this.client.zAdd(this.key(routeKey, 'version-order'), [{ score: version.metadata.createdAt, value: version.id }]),
    ]);
  }

  public async getVersions(routeKey: string): Promise<EndpointVersion[]> {
    await this.ready;
    const ids: string[] = await this.client.zRange(this.key(routeKey, 'version-order'), 0, -1);
    if (ids.length === 0) return [];
    const values: Array<string | null> = await this.client.hmGet(this.key(routeKey, 'versions'), ids);
    return values.filter((value): value is string => Boolean(value)).map(value => JSON.parse(value));
  }

  public async getVersion(routeKey: string, versionId: string): Promise<EndpointVersion | undefined> {
    await this.ready;
    const value = await this.client.hGet(this.key(routeKey, 'versions'), versionId);
    return value ? JSON.parse(value) : undefined;
  }

  public async saveTransition(routeKey: string, transition: VersionTransition): Promise<void> {
    await this.registerRoute(routeKey);
    await Promise.all([
      this.client.hSet(this.key(routeKey, 'transitions'), transition.id, JSON.stringify(transition)),
      this.client.zAdd(this.key(routeKey, 'transition-order'), [{ score: transition.transitionAt, value: transition.id }]),
    ]);
  }

  public async getTransitions(routeKey: string): Promise<VersionTransition[]> {
    await this.ready;
    const ids: string[] = await this.client.zRange(this.key(routeKey, 'transition-order'), 0, -1);
    if (ids.length === 0) return [];
    const values: Array<string | null> = await this.client.hmGet(this.key(routeKey, 'transitions'), ids);
    return values.filter((value): value is string => Boolean(value)).map(value => JSON.parse(value));
  }

  public async setActiveVersion(routeKey: string, versionId: string): Promise<void> {
    await this.registerRoute(routeKey);
    await this.client.set(this.key(routeKey, 'active'), versionId);
  }

  public async getActiveVersion(routeKey: string): Promise<string | undefined> {
    await this.ready;
    return (await this.client.get(this.key(routeKey, 'active'))) || undefined;
  }

  public async updateVersionPerformance(routeKey: string, versionId: string, performance: any): Promise<void> {
    const version = await this.getVersion(routeKey, versionId);
    if (!version) return;
    version.performance = { ...version.performance, ...performance };
    await this.saveVersion(routeKey, version);
  }

  public async listRouteKeys(): Promise<string[]> {
    await this.ready;
    return this.client.sMembers(`${this.prefix}:routes`);
  }

  public async close(): Promise<void> {
    try {
      await this.ready;
    } catch {
      return;
    }
    if (this.client.isOpen) await this.client.quit();
  }
}
