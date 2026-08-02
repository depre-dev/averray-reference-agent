import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { registerMcpProcess } from "./bundle-registry.js";

export function jsonContent(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

export async function runStdioServer(server: McpServer): Promise<void> {
  // Before connect, because connecting is the moment the tool list this process
  // holds becomes the answer the agent will give until it is restarted. That is
  // exactly what the record is a record of. See bundle-registry.ts.
  registerMcpProcess();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

