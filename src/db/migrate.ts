import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEnv } from '../config/env.js';
import { createLogger } from '../logging/logger.js';
import type { Logger } from '../logging/logger.js';
import type { Database } from './database.js';
import { createDatabase } from './factory.js';

export async function runMigrations(
  db: Database,
  logger: Logger,
  options: { migrationsDir?: string } = {},
): Promise<{ applied: string[]; skipped: string[] }> {
  const directory = options.migrationsDir ?? fileURLToPath(new URL('../../migrations/', import.meta.url));
  const names = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  return db.withTransaction(async (tx) => {
    await tx.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const existing = await tx.query<{ name: string }>('SELECT name FROM schema_migrations');
    const known = new Set(existing.rows.map((row) => row.name));
    const applied: string[] = [];
    const skipped: string[] = [];
    for (const name of names) {
      if (known.has(name)) {
        skipped.push(name);
        continue;
      }
      await tx.query(await readFile(join(directory, name), 'utf8'));
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      applied.push(name);
    }
    logger.info({ applied, skipped }, 'Database migrations processed');
    return { applied, skipped };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = loadEnv();
    const logger = createLogger({ level: config.LOG_LEVEL });
    const db = await createDatabase(config, logger);
    try {
      await runMigrations(db, logger);
    } finally {
      await db.close();
    }
  } catch {
    process.stderr.write('Database migration failed. Check database configuration and migration files.\n');
    process.exitCode = 1;
  }
}
