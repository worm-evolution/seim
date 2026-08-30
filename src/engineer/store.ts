import * as fs from 'fs';
import * as path from 'path';
import { EngineerJob } from './types';

export interface EngineerStore {
  save(job: EngineerJob): Promise<void>;
  get(id: string): Promise<EngineerJob | undefined>;
  list(): Promise<EngineerJob[]>;
}

export class MemoryEngineerStore implements EngineerStore {
  private jobs = new Map<string, EngineerJob>();
  public async save(job: EngineerJob): Promise<void> { this.jobs.set(job.id, JSON.parse(JSON.stringify(job))); }
  public async get(id: string): Promise<EngineerJob | undefined> {
    const job = this.jobs.get(id);
    return job ? JSON.parse(JSON.stringify(job)) : undefined;
  }
  public async list(): Promise<EngineerJob[]> { return Array.from(this.jobs.values()).map(job => JSON.parse(JSON.stringify(job))); }
}

export class FileEngineerStore implements EngineerStore {
  private readonly dir: string;
  constructor(storagePath: string) {
    this.dir = path.join(storagePath, 'engineer', 'jobs');
    fs.mkdirSync(this.dir, { recursive: true });
  }
  public async save(job: EngineerJob): Promise<void> {
    const file = path.join(this.dir, `${job.id.replace(/[^a-zA-Z0-9-_]/g, '_')}.json`);
    const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
    await fs.promises.writeFile(tmp, JSON.stringify(job, null, 2), 'utf8');
    await fs.promises.rename(tmp, file);
  }
  public async get(id: string): Promise<EngineerJob | undefined> {
    try { return JSON.parse(await fs.promises.readFile(path.join(this.dir, `${id.replace(/[^a-zA-Z0-9-_]/g, '_')}.json`), 'utf8')) as EngineerJob; }
    catch { return undefined; }
  }
  public async list(): Promise<EngineerJob[]> {
    try {
      const files = await fs.promises.readdir(this.dir);
      const jobs: EngineerJob[] = [];
      for (const file of files.filter(name => name.endsWith('.json'))) {
        try { jobs.push(JSON.parse(await fs.promises.readFile(path.join(this.dir, file), 'utf8')) as EngineerJob); } catch { /* ignore corrupt records */ }
      }
      return jobs.sort((a, b) => b.updatedAt - a.updatedAt);
    } catch { return []; }
  }
}
