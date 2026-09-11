import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { config as loadDotEnv } from 'dotenv';
import { z } from 'zod';
import { ensureDevAuthContext } from '../src/auth/context.js';
import { loadEnv } from '../src/config/env.js';
import { encryptString, hashProviderId } from '../src/crypto/field-crypto.js';
import { createDatabase } from '../src/db/factory.js';
import { runMigrations } from '../src/db/migrate.js';
import { createRepositories } from '../src/db/repositories/index.js';
import { createLogger } from '../src/logging/logger.js';
import { EnvironmentSecretProvider } from '../src/secrets/environment-secret-provider.js';

let failureMessage = 'Invalid arguments. Use --help for usage.';
try {
  const { values } = parseArgs({
    options: {
      delivery: { type: 'string' },
      'provider-delivery-id': { type: 'string', default: 'dev-delivery-0001' },
      merchant: { type: 'string', default: 'Dev Merchant' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log('Usage: npm run seed:dev -- [--delivery <uuid>] [--provider-delivery-id <string>] [--merchant <name>]');
  } else {
    const deliveryId = z.uuid().parse(values.delivery ?? randomUUID());
    const providerDeliveryId = z.string().trim().min(1).parse(values['provider-delivery-id']);
    const merchantName = z.string().trim().min(1).parse(values.merchant);
    failureMessage = 'Development seed failed. Check environment configuration and database availability.';
    loadDotEnv({ quiet: true });
    const config = loadEnv();
    const logger = createLogger({ level: 'silent' });
    const key = await new EnvironmentSecretProvider(config).getDatabaseEncryptionKey();
    const db = await createDatabase(config, logger);
    try {
      await runMigrations(db, logger);
      const identifiers = await db.withTransaction(async (tx) => {
        const repos = createRepositories(tx);
        const context = await ensureDevAuthContext(repos, config, []);
        const hash = hashProviderId(providerDeliveryId, key);
        let delivery = await repos.deliveries.findByDoordashDeliveryIdHash(hash);
        if (delivery && delivery.tenantId !== context.tenantId) {
          throw new Error('Delivery belongs to another tenant.');
        }
        if (!delivery) {
          delivery = await repos.deliveries.create({
            tenantId: context.tenantId,
            doordashDeliveryIdHash: hash,
            doordashDeliveryIdEncrypted: key ? encryptString(providerDeliveryId, key) : null,
            merchantName,
            status: 'unknown',
          });
          await tx.query('UPDATE deliveries SET id = $1 WHERE id = $2', [deliveryId, delivery.id]);
          delivery = { ...delivery, id: deliveryId };
        }
        if (!await repos.deliveryAccess.find(delivery.id, context.userId)) {
          await repos.deliveryAccess.create({
            deliveryId: delivery.id,
            userId: context.userId,
            relationship: 'customer',
          });
        }
        return { tenant_id: context.tenantId, user_id: context.userId, delivery_ref: delivery.id };
      });
      console.log(JSON.stringify(identifiers));
    } finally {
      await db.close();
    }
  }
} catch {
  console.error(failureMessage);
  process.exitCode = 1;
}
