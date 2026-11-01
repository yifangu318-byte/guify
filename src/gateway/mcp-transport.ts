import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { AgentGateway } from './gateway.js';
import { toolRegistry } from './registry.js';

/** Use the low-level SDK server to preserve the existing JSON schemas and the
 * Gateway's closed-input validator verbatim. Identity is bound by the local
 * launcher, never taken from tool arguments or client-supplied metadata.
 */
export function createMcpServer(gateway: AgentGateway, authorization?: string) {
  const server = new Server({ name: 'muse-erp', version: '0.1.0' }, {
    capabilities: { tools: {} },
    instructions: 'Read-only local simulation. No real shop or TikTok connection.',
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolRegistry.map(tool => ({
      name: tool.name, description: tool.description,
      inputSchema: { ...tool.inputSchema, required: [...tool.inputSchema.required] },
      annotations: { ...tool.annotations },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const reply = await gateway.invoke(request.params.name, request.params.arguments, authorization);
    return {
      isError: reply.body.error,
      content: [{ type: 'text' as const, text: JSON.stringify(reply.body) }],
      structuredContent: { ...reply.body },
    };
  });
  return server;
}
