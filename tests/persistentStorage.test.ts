import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { mergeConfig } from '../src/config';
import {
  FileStorageAdapter,
  MemoryStorageAdapter,
  PersistentVersionManager,
} from '../src/persistentVersionManager';
import { createStorageAdapter } from '../src/storageFactory';

const transition = {
  reason: 'verified deployment',
  triggeredBy: 'manual' as const,
  rolloutStrategy: 'immediate' as const,
  rolloutPercentage: 100,
};

describe('persistent version storage', () => {
  let storagePath: string;

  beforeEach(() => {
    storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'seim-storage-'));
  });

  afterEach(() => {
    fs.rmSync(storagePath, { recursive: true, force: true });
  });

  it('uses a real in-memory adapter without creating storage files', async () => {
    const config = mergeConfig({ storage: { type: 'memory' }, storagePath });
    const adapter = createStorageAdapter(config);

    expect(adapter).toBeInstanceOf(MemoryStorageAdapter);
    expect(fs.readdirSync(storagePath)).toEqual([]);
  });

  it('restores active versions, statuses, transitions, and route keys after restart', async () => {
    const config = mergeConfig({ storage: { type: 'file' }, storagePath });
    const first = new PersistentVersionManager(config, new FileStorageAdapter(storagePath));
    const v1 = await first.createVersion('GET /api/users', 'return usersV1', { createdBy: 'manual', reason: 'baseline' });
    const v2 = await first.createVersion('GET /api/users', 'return usersV2', { createdBy: 'ai', reason: 'optimize' });
    await first.activateVersion('GET /api/users', v1.id, transition);
    await first.activateVersion('GET /api/users', v2.id, transition);

    const second = new PersistentVersionManager(config, new FileStorageAdapter(storagePath));
    await second.loadAllStates();

    expect((await second.getActiveVersion('GET /api/users'))?.id).toBe(v2.id);
    expect((await second.getVersion('GET /api/users', v1.id))?.status).toBe('inactive');
    expect((await second.getVersion('GET /api/users', v2.id))?.status).toBe('active');
    const transitions = await second.getTransitionHistory('GET /api/users');
    expect(transitions).toHaveLength(2);
    expect(transitions[1].fromVersion).toBe(v1.id);
  });

  it('persists exactly one new version for a rollback', async () => {
    const config = mergeConfig({ storage: { type: 'file' }, storagePath });
    const manager = new PersistentVersionManager(config, new FileStorageAdapter(storagePath));
    const v1 = await manager.createVersion('POST /api/orders', 'return original', { createdBy: 'manual', reason: 'baseline' });
    const v2 = await manager.createVersion('POST /api/orders', 'return optimized', { createdBy: 'ai', reason: 'optimize' });
    await manager.activateVersion('POST /api/orders', v2.id, transition);

    expect(await manager.rollbackToVersion('POST /api/orders', v1.id, 'regression')).toBe(true);
    const versions = await manager.getAllVersions('POST /api/orders');
    expect(versions).toHaveLength(3);
    expect(versions[2].type).toBe('rollback');
    expect((await manager.getActiveVersion('POST /api/orders'))?.id).toBe(versions[2].id);
  });

  it('persists rollback-safety and deprecation changes', async () => {
    const config = mergeConfig({ storage: { type: 'file' }, storagePath });
    const first = new PersistentVersionManager(config, new FileStorageAdapter(storagePath));
    const version = await first.createVersion('GET /api/report', 'return report', { createdBy: 'manual', reason: 'baseline' });
    await first.markVersionUnsafe('GET /api/report', version.id);
    await first.deprecateVersion('GET /api/report', version.id);

    const second = new PersistentVersionManager(config, new FileStorageAdapter(storagePath));
    await second.loadAllStates();
    const restored = await second.getVersion('GET /api/report', version.id);
    expect(restored?.rollbackSafe).toBe(false);
    expect(restored?.status).toBe('deprecated');
  });

  it('rejects fictional storage modes and volatile production storage', () => {
    expect(() => mergeConfig({ storage: { type: 'sqlite' as any } })).toThrow('Unsupported storage.type');
    expect(() => mergeConfig({ environment: 'production', storage: { type: 'memory' } })).toThrow('persistent storage');
    expect(() => mergeConfig({ environment: 'production', storage: { type: 'file' }, storagePath })).not.toThrow();
  });
});
