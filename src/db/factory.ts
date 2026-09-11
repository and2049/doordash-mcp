import { Pool } from 'pg';
import type { AppConfig } from '../config/env.js';
import { Errors } from '../errors.js';
import type { Logger } from '../logging/logger.js';
import type { Database } from './database.js';
import { PgDatabase } from './pg.js';
import { createPgliteDatabase } from './pglite.js';

export async function createDatabase(config: AppConfig, logger: Logger): Promise<Database> {
  if (config.databaseDriver === 'pg') {
    if (!config.DATABASE_URL) throw Errors.integrationNotConfigured();
    logger.info({ driver: 'pg' }, 'Database driver selected');
    return new PgDatabase(new Pool({ connectionString: config.DATABASE_URL }));
  }
  logger.info({ driver: 'pglite', dataDir: config.PGLITE_DATA_DIR }, 'Database driver selected');
  return createPgliteDatabase({ dataDir: config.PGLITE_DATA_DIR });
}
