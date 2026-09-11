import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { ConsumerError } from './browser-client.js';
import { protectSession, sessionPath } from './session-store.js';

const operationSchema = z.object({
  accountId: z.string(), cartId: z.string(), requestId: z.string(), digest: z.string(), createdAt: z.string(),
  state: z.enum(['pending', 'submitted', 'unknown']), orderUuid: z.string().optional(),
});
export type OrderOperation = z.infer<typeof operationSchema>;

export class OrderOperations {
  constructor(private readonly directory?: string) {}

  private path(accountId: string, cartId: string): string {
    const key = createHash('sha256').update(JSON.stringify([accountId, cartId])).digest('hex');
    return join(this.directory ?? join(dirname(sessionPath()), 'order-operations'), `${key}.dpapi`);
  }

  async get(accountId: string, cartId: string): Promise<OrderOperation | null> {
    let bytes: Buffer;
    try { bytes = await readFile(this.path(accountId, cartId)); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
      throw new ConsumerError('OPERATION_RECORD_UNREADABLE');
    }
    try {
      const record = operationSchema.parse(JSON.parse((await protectSession(bytes, true)).toString('utf8')) as unknown);
      if (record.accountId !== accountId || record.cartId !== cartId) throw new ConsumerError('ACCOUNT_MISMATCH');
      return record;
    } catch { throw new ConsumerError('OPERATION_RECORD_UNREADABLE'); }
  }

  async claim(record: OrderOperation): Promise<boolean> {
    const path = this.path(record.accountId, record.cartId);
    const bytes = await protectSession(Buffer.from(JSON.stringify(operationSchema.parse(record))));
    await mkdir(dirname(path), { recursive: true });
    let file;
    try { file = await open(path, 'wx', 0o600); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') return false;
      throw new ConsumerError('OPERATION_RECORD_WRITE_FAILED');
    }
    try { await file.writeFile(bytes); await file.sync(); }
    finally { await file.close(); }
    return true;
  }

  async finish(record: OrderOperation): Promise<void> {
    const path = this.path(record.accountId, record.cartId);
    const temporary = `${path}.${randomUUID()}.tmp`;
    const bytes = await protectSession(Buffer.from(JSON.stringify(operationSchema.parse(record))));
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }
}
