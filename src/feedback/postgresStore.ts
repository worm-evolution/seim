import type { DeliveryFeedbackRecord } from './types';
import type { FeedbackStore } from './store';

export interface FeedbackQueryClient { query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>; }

export class PostgresFeedbackStore implements FeedbackStore {
  private initialized?: Promise<void>;
  constructor(private client: FeedbackQueryClient, private tableName = 'seim_engineer_feedback') {
    if (!client || typeof client.query !== 'function') throw new Error('Postgres feedback store requires a query-capable client');
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) throw new Error('Invalid feedback table name');
  }
  public async claim(record: DeliveryFeedbackRecord): Promise<boolean> {
    await this.initialize();
    const result = await this.client.query(`INSERT INTO ${this.tableName} (delivery_id, fingerprint, updated_at, record) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (delivery_id) DO NOTHING RETURNING delivery_id`, [record.deliveryId, record.fingerprint || null, record.updatedAt, JSON.stringify(record)]);
    return !!result.rows[0];
  }
  public async save(record: DeliveryFeedbackRecord): Promise<void> {
    await this.initialize();
    await this.client.query(`INSERT INTO ${this.tableName} (delivery_id, fingerprint, updated_at, record) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (delivery_id) DO UPDATE SET fingerprint = EXCLUDED.fingerprint, updated_at = EXCLUDED.updated_at, record = EXCLUDED.record`, [record.deliveryId, record.fingerprint || null, record.updatedAt, JSON.stringify(record)]);
  }
  public async get(id: string): Promise<DeliveryFeedbackRecord | undefined> { await this.initialize(); const result = await this.client.query(`SELECT record FROM ${this.tableName} WHERE delivery_id = $1`, [id]); return result.rows[0]?.record; }
  public async list(): Promise<DeliveryFeedbackRecord[]> { await this.initialize(); const result = await this.client.query(`SELECT record FROM ${this.tableName} ORDER BY updated_at DESC`); return result.rows.map(row => row.record); }
  private async initialize(): Promise<void> {
    if (!this.initialized) this.initialized = this.client.query(`CREATE TABLE IF NOT EXISTS ${this.tableName} (delivery_id TEXT PRIMARY KEY, fingerprint TEXT, updated_at BIGINT NOT NULL, record JSONB NOT NULL)`).then(() => undefined);
    await this.initialized;
  }
}
