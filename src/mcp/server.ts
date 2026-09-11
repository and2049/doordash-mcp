import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthContext } from '../auth/types.js';
import type { AppDeps } from '../http/types.js';
import { registerGetDeliveryStatusTool } from './tools/get-delivery-status.js';

export function createMcpServer(
  deps: Pick<AppDeps, 'logger' | 'deliveryStatusService' | 'auditService' | 'clock'>,
  auth: AuthContext,
): McpServer {
  const server = new McpServer({ name: 'doordash-mcp', version: '0.1.0' });
  registerGetDeliveryStatusTool(server, deps, auth);
  return server;
}
