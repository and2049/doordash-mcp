import type { AuditLogRepository } from '../db/repositories/types.js';
import type { Logger } from '../logging/logger.js';
import { sanitizeAuditMetadata } from '../logging/redact.js';
import type { AuditService } from './types.js';

export function createAuditService(deps: { repo: AuditLogRepository; logger: Logger }): AuditService {
  return {
    async record(entry) {
      const { action, outcome, requestId, tenantId, deliveryId } = entry;
      const fields = { action, outcome, requestId, tenantId, deliveryId };
      try {
        await deps.repo.insert({ ...entry, metadata: sanitizeAuditMetadata(entry.metadata ?? {}) });
        deps.logger.info(fields, 'Audit recorded.');
      } catch {
        deps.logger.error(fields, 'Audit recording failed.');
      }
    },
  };
}
