import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { Transaction } from '@electric-sql/pglite';
import type { Database, QueryResult } from './database.js';

export class PgliteDatabase implements Database {
  constructor(private readonly connection: PGlite | Transaction) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>> {
    if (values === undefined) {
      const result = (await this.connection.exec(text)).at(-1);
      return { rows: (result?.rows ?? []) as Row[], rowCount: result?.affectedRows ?? result?.rows.length ?? 0 };
    }
    const result = await this.connection.query<Row>(text, [...values]);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  }

  async withTransaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
    if (!(this.connection instanceof PGlite)) throw new Error('Nested transactions are not supported.');
    return this.connection.transaction((tx) => fn(new PgliteDatabase(tx)));
  }

  async close(): Promise<void> {
    if (this.connection instanceof PGlite) await this.connection.close();
  }
}

export async function createPgliteDatabase(options: { dataDir?: string } = {}): Promise<Database> {
  const dataDir = options.dataDir === ':memory:' ? undefined : options.dataDir;
  if (dataDir) await mkdir(dirname(dataDir), { recursive: true });
  const connection = await PGlite.create(dataDir);
  return new PgliteDatabase(connection);
}
