import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { requireScope } from '../../auth/context.js';
import { SCOPES } from '../../auth/types.js';
import type { AuthContext } from '../../auth/types.js';
import { toSafeErrorResponse } from '../../errors.js';
import type { AppDeps } from '../../http/types.js';

export function registerGetDeliveryStatusTool(
  server: McpServer,
  deps: Pick<AppDeps, 'logger' | 'deliveryStatusService' | 'auditService' | 'clock'>,
  auth: AuthContext,
): void {
  server.registerTool('get_delivery_status', {
    description: 'Returns the current status of deliveries the authenticated user is authorized to view. Cannot place, change, or cancel orders. Never includes addresses, driver details, or coordinates.',
    inputSchema: { delivery_ref: z.string().min(1) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args) => {
    const requestId = randomUUID();
    const entry = {
      tenantId: auth.tenantId, userId: auth.userId, deliveryId: null,
      action: 'mcp.get_delivery_status', requestId, metadata: {},
    };
    try {
      requireScope(auth, SCOPES.deliveriesRead);
      const output = await deps.deliveryStatusService.getDeliveryStatus(auth, args);
      await deps.auditService.record({ ...entry, outcome: 'success' });
      return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: { ...output } };
    } catch (error) {
      const safe = toSafeErrorResponse(error, requestId);
      const outcome = [401, 403, 404].includes(safe.status) ? 'denied' : 'error';
      await deps.auditService.record({ ...entry, outcome });
      deps.logger.error({ requestId, outcome }, 'MCP tool invocation failed.');
      return { isError: true, content: [{ type: 'text', text: safe.body.error.message }] };
    }
  });
}
