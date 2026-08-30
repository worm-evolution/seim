import * as fs from 'fs';
import * as path from 'path';
import { ApplicationRegistration, EngineeringPlan } from './types';

export interface ControlPlaneStore {
  saveApplication(application: ApplicationRegistration): Promise<void>;
  getApplication(id: string): Promise<ApplicationRegistration | undefined>;
  listApplications(): Promise<ApplicationRegistration[]>;
  savePlan(plan: EngineeringPlan): Promise<void>;
  getPlan(id: string): Promise<EngineeringPlan | undefined>;
  listPlans(): Promise<EngineeringPlan[]>;
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function safeId(value: string): string { return value.replace(/[^a-zA-Z0-9_-]/g, '_'); }

export class MemoryControlPlaneStore implements ControlPlaneStore {
  private applications = new Map<string, ApplicationRegistration>();
  private plans = new Map<string, EngineeringPlan>();
  public async saveApplication(value: ApplicationRegistration): Promise<void> { this.applications.set(value.id, clone(value)); }
  public async getApplication(id: string): Promise<ApplicationRegistration | undefined> { const value = this.applications.get(id); return value ? clone(value) : undefined; }
  public async listApplications(): Promise<ApplicationRegistration[]> { return Array.from(this.applications.values()).map(clone); }
  public async savePlan(value: EngineeringPlan): Promise<void> { this.plans.set(value.id, clone(value)); }
  public async getPlan(id: string): Promise<EngineeringPlan | undefined> { const value = this.plans.get(id); return value ? clone(value) : undefined; }
  public async listPlans(): Promise<EngineeringPlan[]> { return Array.from(this.plans.values()).map(clone).sort((a, b) => b.updatedAt - a.updatedAt); }
}

export class FileControlPlaneStore implements ControlPlaneStore {
  private applicationsDir: string;
  private plansDir: string;
  constructor(storagePath: string) {
    this.applicationsDir = path.join(storagePath, 'engineer', 'applications');
    this.plansDir = path.join(storagePath, 'engineer', 'plans');
    fs.mkdirSync(this.applicationsDir, { recursive: true });
    fs.mkdirSync(this.plansDir, { recursive: true });
  }
  public async saveApplication(value: ApplicationRegistration): Promise<void> { await this.write(this.applicationsDir, value.id, value); }
  public async getApplication(id: string): Promise<ApplicationRegistration | undefined> { return this.read(this.applicationsDir, id); }
  public async listApplications(): Promise<ApplicationRegistration[]> { return this.list(this.applicationsDir); }
  public async savePlan(value: EngineeringPlan): Promise<void> { await this.write(this.plansDir, value.id, value); }
  public async getPlan(id: string): Promise<EngineeringPlan | undefined> { return this.read(this.plansDir, id); }
  public async listPlans(): Promise<EngineeringPlan[]> { return (await this.list<EngineeringPlan>(this.plansDir)).sort((a, b) => b.updatedAt - a.updatedAt); }
  private async write<T>(dir: string, id: string, value: T): Promise<void> {
    const file = path.join(dir, `${safeId(id)}.json`);
    const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
    await fs.promises.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
    await fs.promises.rename(tmp, file);
  }
  private async read<T>(dir: string, id: string): Promise<T | undefined> {
    try { return JSON.parse(await fs.promises.readFile(path.join(dir, `${safeId(id)}.json`), 'utf8')) as T; } catch { return undefined; }
  }
  private async list<T>(dir: string): Promise<T[]> {
    try {
      const files = await fs.promises.readdir(dir);
      const result: T[] = [];
      for (const file of files.filter(name => name.endsWith('.json'))) {
        try { result.push(JSON.parse(await fs.promises.readFile(path.join(dir, file), 'utf8')) as T); } catch { /* ignore corrupt records */ }
      }
      return result;
    } catch { return []; }
  }
}

export interface ControlPlaneQueryClient { query(text: string, values?: unknown[]): Promise<{ rows: any[] }>; }

export class PostgresControlPlaneStore implements ControlPlaneStore {
  private initialized?: Promise<void>;
  constructor(private client: ControlPlaneQueryClient, private tableName = 'seim_engineer_control_plane') {
    if (!client || typeof client.query !== 'function') throw new Error('Postgres control-plane store requires a query-capable client');
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) throw new Error('Invalid control-plane table name');
  }
  private async initialize(): Promise<void> {
    if (!this.initialized) this.initialized = this.client.query(`CREATE TABLE IF NOT EXISTS ${this.tableName} (id TEXT PRIMARY KEY, kind TEXT NOT NULL, updated_at BIGINT NOT NULL, record JSONB NOT NULL)`).then(() => undefined);
    await this.initialized;
  }
  private async save(kind: string, id: string, updatedAt: number, value: unknown): Promise<void> {
    await this.initialize();
    await this.client.query(`INSERT INTO ${this.tableName} (id, kind, updated_at, record) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind, updated_at = EXCLUDED.updated_at, record = EXCLUDED.record`, [id, kind, updatedAt, JSON.stringify(value)]);
  }
  public async saveApplication(value: ApplicationRegistration): Promise<void> { await this.save('application', value.id, value.updatedAt, value); }
  public async getApplication(id: string): Promise<ApplicationRegistration | undefined> { return this.get('application', id) as Promise<ApplicationRegistration | undefined>; }
  public async listApplications(): Promise<ApplicationRegistration[]> { return this.list('application') as Promise<ApplicationRegistration[]>; }
  public async savePlan(value: EngineeringPlan): Promise<void> { await this.save('plan', value.id, value.updatedAt, value); }
  public async getPlan(id: string): Promise<EngineeringPlan | undefined> { return this.get('plan', id) as Promise<EngineeringPlan | undefined>; }
  public async listPlans(): Promise<EngineeringPlan[]> { return this.list('plan') as Promise<EngineeringPlan[]>; }
  private async get(kind: string, id: string): Promise<unknown> { await this.initialize(); const result = await this.client.query(`SELECT record FROM ${this.tableName} WHERE id = $1 AND kind = $2`, [id, kind]); return result.rows[0]?.record; }
  private async list(kind: string): Promise<unknown[]> { await this.initialize(); const result = await this.client.query(`SELECT record FROM ${this.tableName} WHERE kind = $1 ORDER BY updated_at DESC`, [kind]); return result.rows.map(row => row.record); }
}
