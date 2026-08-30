import * as fs from 'fs';
import * as path from 'path';
import type { DeliveryFeedbackRecord } from './types';

export interface FeedbackStore {
  claim(record: DeliveryFeedbackRecord): Promise<boolean>;
  save(record: DeliveryFeedbackRecord): Promise<void>;
  get(deliveryId: string): Promise<DeliveryFeedbackRecord | undefined>;
  list(): Promise<DeliveryFeedbackRecord[]>;
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function safeId(value: string): string { return value.replace(/[^a-zA-Z0-9_-]/g, '_'); }

export class MemoryFeedbackStore implements FeedbackStore {
  private records = new Map<string, DeliveryFeedbackRecord>();
  public async claim(record: DeliveryFeedbackRecord): Promise<boolean> {
    if (this.records.has(record.deliveryId)) return false;
    this.records.set(record.deliveryId, clone(record));
    return true;
  }
  public async save(record: DeliveryFeedbackRecord): Promise<void> { this.records.set(record.deliveryId, clone(record)); }
  public async get(id: string): Promise<DeliveryFeedbackRecord | undefined> { const value = this.records.get(id); return value ? clone(value) : undefined; }
  public async list(): Promise<DeliveryFeedbackRecord[]> { return Array.from(this.records.values()).map(clone).sort((a, b) => b.updatedAt - a.updatedAt); }
}

export class FileFeedbackStore implements FeedbackStore {
  private readonly directory: string;
  constructor(storagePath: string) {
    this.directory = path.join(storagePath, 'engineer', 'feedback');
    fs.mkdirSync(this.directory, { recursive: true });
  }
  public async claim(record: DeliveryFeedbackRecord): Promise<boolean> {
    const file = this.file(record.deliveryId);
    try {
      const handle = await fs.promises.open(file, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(record, null, 2), 'utf8'); } finally { await handle.close(); }
      return true;
    } catch (error: any) {
      if (error?.code === 'EEXIST') return false;
      throw error;
    }
  }
  public async save(record: DeliveryFeedbackRecord): Promise<void> {
    const file = this.file(record.deliveryId);
    const temporary = `${file}.tmp.${process.pid}.${Date.now()}`;
    await fs.promises.writeFile(temporary, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 });
    await fs.promises.rename(temporary, file);
  }
  public async get(id: string): Promise<DeliveryFeedbackRecord | undefined> {
    try { return JSON.parse(await fs.promises.readFile(this.file(id), 'utf8')) as DeliveryFeedbackRecord; } catch { return undefined; }
  }
  public async list(): Promise<DeliveryFeedbackRecord[]> {
    const records: DeliveryFeedbackRecord[] = [];
    for (const name of await fs.promises.readdir(this.directory).catch(() => [] as string[])) {
      if (!name.endsWith('.json')) continue;
      try { records.push(JSON.parse(await fs.promises.readFile(path.join(this.directory, name), 'utf8')) as DeliveryFeedbackRecord); } catch { /* ignore corrupt records */ }
    }
    return records.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  private file(id: string): string { return path.join(this.directory, `${safeId(id)}.json`); }
}
