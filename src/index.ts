import 'dotenv/config';
import { destination, pino } from 'pino';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ensureDevAuthContext } from './auth/context.js';
import { SCOPES } from './auth/types.js';
import { loadEnv } from './config/env.js';
import { AppError, toSafeErrorResponse } from './errors.js';
import type { RuntimeHandle } from './http/types.js';
import { REDACT_PATHS } from './logging/logger.js';
import { createMcpServer } from './mcp/server.js';
import { buildRuntime } from './runtime.js';

const logger = pino({ name: 'doordash-mcp', redact: { paths: [...REDACT_PATHS], censor: '[REDACTED]' } }, destination(2));
let runtime: RuntimeHandle | undefined;
let mcp: McpServer | undefined;
let shutdown: Promise<void> | undefined;

function close(): Promise<void> {
  shutdown ??= (async () => {
    try { await mcp?.close(); } finally { await runtime?.close(); }
  })();
  return shutdown;
}

try {
  const config = loadEnv();
  logger.level = config.LOG_LEVEL;
  const transport = process.argv.includes('--stdio') ? 'stdio' : config.MCP_TRANSPORT;
  if (transport === 'stdio' && config.isProduction) throw new AppError('forbidden', 'Stdio transport is disabled in production.');
  runtime = await buildRuntime(config, logger);
  if (transport === 'stdio') {
    const auth = await ensureDevAuthContext(runtime.deps.repos, config, [SCOPES.deliveriesRead], logger);
    mcp = createMcpServer(runtime.deps, auth);
    await mcp.connect(new StdioServerTransport());
    process.stdin.once('end', () => { void close().catch(() => { process.exitCode = 1; }); });
  } else {
    await runtime.app.listen({ host: config.HOST, port: config.PORT });
  }
  logger.info({ transport }, 'Server started.');
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void close().catch(() => {
        logger.error('Shutdown failed.');
        process.exitCode = 1;
      });
    });
  }
} catch (error) {
  logger.error(toSafeErrorResponse(error, 'startup').body, 'Startup failed.');
  await close().catch(() => logger.error('Startup cleanup failed.'));
  process.exitCode = 1;
}
