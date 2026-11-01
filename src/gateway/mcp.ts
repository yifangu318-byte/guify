import type { AgentGateway } from './gateway.js';
import { toolRegistry } from './registry.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Readable, Writable } from 'node:stream';
import { createMcpServer } from './mcp-transport.js';

/** No transport starts implicitly. The stdio launcher must explicitly connect;
 * the default REST/Web process therefore still reports not_connected.
 */
export function createMcpModule(gateway: AgentGateway) {
  let transport: 'not_connected' | 'stdio' = 'not_connected';
  let server: ReturnType<typeof createMcpServer> | undefined;
  return Object.freeze({
    get transport() { return transport; },
    tools: toolRegistry,
    async callTool(name: unknown, input: unknown, authorization?: unknown) {
      return (await gateway.invoke(name, input, authorization)).body;
    },
    async connectStdio(authorization?: string, input?: Readable, output?: Writable) {
      if (server) throw new Error('MCP transport already started');
      const candidate = createMcpServer(gateway, authorization);
      server = candidate;
      candidate.onclose = () => { transport = 'not_connected'; server = undefined; };
      try {
        await candidate.connect(new StdioServerTransport(input, output));
        transport = 'stdio';
      } catch {
        await candidate.close().catch(() => {});
        server = undefined;
        transport = 'not_connected';
        throw new Error('MCP stdio connection failed');
      }
    },
    async close() {
      try { await server?.close(); }
      finally { server = undefined; transport = 'not_connected'; }
    },
  });
}
