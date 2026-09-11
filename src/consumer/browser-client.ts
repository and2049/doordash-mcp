import { chromium } from 'playwright-core';
import { loadSession } from './session-store.js';
import { queries } from './queries.js';

export class ConsumerError extends Error {
  constructor(public readonly code: string) { super(code); }
}

export type ConsumerOperation = keyof typeof queries | 'account';

export async function consumerRequest(operation: ConsumerOperation, variables: Record<string, unknown> = {}, expectedAccountId?: string): Promise<unknown> {
  const saved = await loadSession().catch(() => { throw new ConsumerError('SESSION_UNREADABLE'); });
  if (!saved) throw new ConsumerError('SESSION_NOT_SAVED');
  if (!saved.accountId) throw new ConsumerError('SESSION_CHANGED_REATTACH');
  if (expectedAccountId && expectedAccountId !== saved.accountId) throw new ConsumerError('ACCOUNT_MISMATCH');
  const mutation = operation !== 'account' && queries[operation].startsWith('mutation ');
  let mayHaveMutated = false;
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222', { timeout: 10_000 })
    .catch(() => { throw new ConsumerError('BROWSER_UNAVAILABLE'); });
  try {
    const context = browser.contexts()[0];
    const page = context?.pages().find((page) => new URL(page.url()).origin === 'https://www.doordash.com');
    if (!context || !page) throw new ConsumerError('DOORDASH_TAB_REQUIRED');
    const path = operation === 'account' ? '/unified-gateway/contributor/v1/consumer_details' : `/graphql/${operation}`;
    const body = operation === 'account' ? null : JSON.stringify({ operationName: operation, variables, query: queries[operation] });
    mayHaveMutated = mutation;
    const response = await page.evaluate(async ({ path, body, accountId }) => {
      let dispatched = false;
      if ((globalThis as unknown as { location: { origin: string } }).location.origin !== 'https://www.doordash.com') return { status: 0, data: null };
      try {
        const accountPath = '/unified-gateway/contributor/v1/consumer_details';
        const accountResponse = await fetch(accountPath, { credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(20_000) });
        if (!accountResponse.ok) return { status: accountResponse.status, data: null };
        const account = await accountResponse.json() as unknown;
        if (!account || typeof account !== 'object' || !('consumer_id' in account) || account.consumer_id !== accountId) return { status: 409, data: null };
        if (path === accountPath) return { status: 200, data: account };
        dispatched = true;
        const response = await fetch(path, {
          method: body === null ? 'GET' : 'POST', credentials: 'same-origin', redirect: 'error',
          headers: body === null ? {} : { 'content-type': 'application/json' }, body,
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return { status: response.status, data: null, dispatched };
        const text = await response.text();
        if (text.length > 4_000_000) return { status: 0, data: null, dispatched };
        const finalResponse = await fetch(accountPath, { credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(20_000) });
        const finalAccount = finalResponse.ok ? await finalResponse.json() as unknown : null;
        if (!finalAccount || typeof finalAccount !== 'object' || !('consumer_id' in finalAccount) || finalAccount.consumer_id !== accountId) return { status: 409, data: null, dispatched };
        return { status: response.status, data: JSON.parse(text) as unknown, dispatched };
      } catch { return { status: 0, data: null, dispatched }; }
    }, { path, body, accountId: saved.accountId });
    mayHaveMutated = mutation && ('dispatched' in response && response.dispatched === true);
    const current = await loadSession();
    if (!current || current.accountId !== saved.accountId || current.savedAt !== saved.savedAt) throw new ConsumerError('SESSION_CHANGED_REATTACH');
    if (response.status === 409) throw new ConsumerError('ACCOUNT_MISMATCH');
    if (response.status === 401 || response.status === 403) throw new ConsumerError('REAUTHENTICATION_REQUIRED');
    if (response.status === 429) throw new ConsumerError('RATE_LIMITED');
    if (response.status !== 200 || response.data === null) throw new ConsumerError('PROVIDER_UNAVAILABLE');
    if (typeof response.data === 'object' && 'errors' in response.data) throw new ConsumerError('PROVIDER_QUERY_FAILED');
    return response.data;
  } catch (error) {
    if (mayHaveMutated) throw new ConsumerError('MUTATION_OUTCOME_UNKNOWN');
    if (error instanceof ConsumerError) throw error;
    throw new ConsumerError('BROWSER_REQUEST_FAILED');
  } finally {
    await browser.close().catch(() => {});
  }
}
