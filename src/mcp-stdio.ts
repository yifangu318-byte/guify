import { buildApp } from './app.js';
import { createWebSimulation, demoShopIds, demoWindow } from './web/simulation.js';
import { toolRegistry } from './gateway/registry.js';

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--simulation')) {
    throw new Error('Invalid launcher arguments');
  }
  // Explicit, isolated demo opt-in. Never load .env or real credentials here.
  const simulation = args[0] === '--simulation';
  const placeholder = '<placeholder-mcp-simulation>';
  const app = buildApp({ host: '127.0.0.1', port: 0 }, process.stderr, simulation ? {
    ...createWebSimulation(), now: () => demoWindow.end_at,
    agents: [{ agent_id: 'simulation-mcp-client', bearer_token: placeholder,
      shop_ids: [demoShopIds[0]], tools: toolRegistry.map(tool => tool.name) }],
  } : {});
  // No HTTP listener; REST routes and stdio share app.gateway in this process.
  await app.ready();
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    void app.close().catch(() => { process.exitCode = 1; });
  };
  process.stdin.once('end', close);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, close);
  await app.getDecorator<ReturnType<typeof import('./gateway/mcp.js').createMcpModule>>('mcp')
    .connectStdio(simulation ? `Bearer ${placeholder}` : undefined);
}

main().catch(() => {
  process.stderr.write('{"level":50,"msg":"MCP stdio startup failed"}\n');
  process.exitCode = 1;
});
