import { PostgresEngineerStore, PostgresQueryClient } from '../src/engineer/postgresStore';
import { EngineerJob } from '../src/engineer/types';

describe('PostgresEngineerStore', () => {
  it('initializes, upserts, and reads durable jobs through a supplied client', async () => {
    const rows: Array<{ job: EngineerJob }> = [];
    const client: PostgresQueryClient = {
      async query(text: string, values?: unknown[]) {
        if (text.includes('SELECT job FROM') && text.includes('WHERE')) {
          return { rows: rows.filter(row => row.job.id === values?.[0]) };
        }
        if (text.includes('SELECT job FROM')) return { rows };
        if (text.includes('INSERT INTO')) {
          const job = JSON.parse(String(values?.[3])) as EngineerJob;
          const index = rows.findIndex(row => row.job.id === job.id);
          if (index >= 0) rows[index] = { job };
          else rows.push({ job });
        }
        return { rows: [] };
      },
    };
    const store = new PostgresEngineerStore(client, 'engineer_jobs_test');
    const job = { id: 'job-1', status: 'queued', updatedAt: 1 } as EngineerJob;

    await store.save(job);
    expect((await store.get(job.id))?.id).toBe(job.id);
    expect((await store.list())).toHaveLength(1);
  });
});
