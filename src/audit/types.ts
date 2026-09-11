import type { AuditEntry } from '../domain/types.js';

export interface AuditService {
  record(entry: AuditEntry): Promise<void>;
}
