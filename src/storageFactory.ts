import { StorageAdapter, FileStorageAdapter, MemoryStorageAdapter } from './persistentVersionManager';
import { RedisStorageAdapter } from './redisStorageAdapter';
import { SeimConfig } from './types';

export function createStorageAdapter(config: SeimConfig): StorageAdapter {
  const type = config.storage?.type ?? 'memory';

  if (type === 'redis') {
    const connection = config.storage?.connection || process.env.REDIS_URL;
    return new RedisStorageAdapter(connection);
  }

  if (type === 'file') {
    return new FileStorageAdapter(config.storagePath ?? './.seim-storage');
  }
  if (type === 'memory') {
    return new MemoryStorageAdapter();
  }
  throw new Error(`Unsupported storage.type: ${String(type)}`);
}
