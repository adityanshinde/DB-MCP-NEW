import { StdioServerTransport } from './mcp-sdk-runtime.mjs';

import { createMcpServer } from './lib/mcp/createMcpServer';
import { installProcessGuards } from './lib/runtime/processGuards';

installProcessGuards();

async function main(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);
}

main().catch((error) => {
  console.error('[mcp-stdio] Fatal error:', error);
  process.exitCode = 1;
});