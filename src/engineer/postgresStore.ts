import { EngineerJob } from './types';
import { EngineerStore } from './store';

export interface PostgresQueryClient {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

/**
 * Postgres persistence without forcing a particular pg driver on consumers.
 * Pass a connected `pg.Pool` or compatible client from the host application.
 */
export class PostgresEngineerStore implements EngineerStore {
  private initialized?: Promise<void>;

  constructor(private client: PostgresQueryClient, private tableName = 'seim_engineer_jobs') {
    if (!client || typeof client.query !== 'function') throw new Error('Postgres engineer store requires a query-capable client');
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) throw new Error('Invalid engineer store table name');
  }

  public async initialize(): Promise<void> {
    if (!this.initialized) {
      this.initialized = this.client.query(`
        CREATE TABLE IF NOT EXISTS ${this.tableName} (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          updated_at BIGINT NOT NULL,
          job JSONB NOT NULL
        )
      `).then(() => undefined);
    }
    await this.initialized;
  }

  public async save(job: EngineerJob): Promise<void> {
    await this.initialize();
    await this.client.query(`
      INSERT INTO ${this.tableName} (id, status, updated_at, job)
      VALUES ($1, $2, $3, $4::jsonb)
      ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, updated_at = EXCLUDED.updated_at, job = EXCLUDED.job
    `, [job.id, job.status, job.updatedAt, JSON.stringify(job)]);
  }

  public async get(id: string): Promise<EngineerJob | undefined> {
    await this.initialize();
    const result = await this.client.query(`SELECT job FROM ${this.tableName} WHERE id = $1`, [id]);
    return result.rows[0]?.job;
  }

  public async list(): Promise<EngineerJob[]> {
    await this.initialize();
    const result = await this.client.query(`SELECT job FROM ${this.tableName} ORDER BY updated_at DESC`);
    return result.rows.map(row => row.job);
  }
}
