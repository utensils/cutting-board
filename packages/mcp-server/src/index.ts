// Executable entry point for the cutting-board MCP server.
//
// tsup prepends the `#!/usr/bin/env node` shebang. The server speaks JSON-RPC
// over stdio, so stdout MUST stay pure — all logging goes to stderr.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { WsBridgeClient } from "./bridge-client.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const bridge = new WsBridgeClient();
  const server = createServer({ bridge });
  const transport = new StdioServerTransport();

  const shutdown = () => {
    bridge.close();
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await server.connect(transport);
  process.stderr.write("[cutting-board-mcp] server connected over stdio\n");
}

main().catch((err) => {
  process.stderr.write(`[cutting-board-mcp] fatal: ${String(err)}\n`);
  process.exit(1);
});
