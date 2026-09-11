import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createConsumerMcpServer } from './mcp.js';

const server = createConsumerMcpServer();
server.connect(new StdioServerTransport()).catch(() => {
  console.error('Consumer MCP startup failed.');
  process.exitCode = 1;
});
