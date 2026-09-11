import type { Pool, PoolClient } from 'pg';
import type { Database, QueryResult } from './database.js';

export class PgDatabase implements Database {
  constructor(private readonly pool: Pool, private readonly client?: PoolClient) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>> {
    const result = await (this.client ?? this.pool).query<Row>(text, values === undefined ? undefined : [...values]);
    const last = Array.isArray(result) ? result.at(-1) : result;
    return { rows: last?.rows ?? [], rowCount: last?.rowCount ?? 0 };
  }

  async withTransaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
    if (this.client) throw new Error('Nested transactions are not supported.');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(new PgDatabase(this.pool, client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (!this.client) await this.pool.end();
  }
}
