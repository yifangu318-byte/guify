import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildApp } from '../dist/app.js';
import { createWebSimulation, demoShopIds, demoWindow } from '../dist/web/simulation.js';
import { toolRegistry } from '../dist/gateway/registry.js';
import { Writable } from 'node:stream';

// Only synthetic data; never read .env, database configuration or real grants.
const transport = new StdioClientTransport({ command: process.execPath,
  args: ['dist/mcp-stdio.js', '--simulation'], stderr: 'pipe', env: {},
});
let audit = '';
transport.stderr.on('data', chunk => { audit += chunk; });
// Record the actual SDK JSON-RPC exchange, not just an application assertion.
const send = transport.send.bind(transport);
transport.send = async (message, options) => {
  console.log(JSON.stringify({ direction: 'client_to_server', message }));
  await send(message, options);
};
const client = new Client({ name: 'muse-local-sdk-smoke', version: '0.1.0' });
const app = buildApp({ host: '127.0.0.1', port: 0 }, new Writable({ write(_c, _e, cb) { cb(); } }), {
  ...createWebSimulation(), now: () => demoWindow.end_at,
  agents: [{ agent_id: 'simulation-rest-comparison', bearer_token: '<placeholder-smoke>',
    shop_ids: [demoShopIds[0]], tools: toolRegistry.map(tool => tool.name) }],
});
try {
  await client.connect(transport, { timeout: 5000 });
  console.log(JSON.stringify({ phase: 'initialized', server: client.getServerVersion(), capabilities: client.getServerCapabilities() }));
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 7);
  console.log(JSON.stringify({ phase: 'tools_list', tools: listed.tools }));
  for (const tool of toolRegistry) {
    const input = { shop_id: demoShopIds[0],
      ...(tool.name === 'get_shop_overview' ? demoWindow : {}),
      ...(['get_order_detail', 'diagnose_fulfillment_issue'].includes(tool.name) ? { order_id: 'simulation-order-1' } : {}) };
    const result = await client.callTool({ name: tool.name, arguments: input });
    assert.equal(result.isError, false);
    const body = JSON.parse(result.content[0].text);
    assert.deepEqual(result.structuredContent, body);
    assert.equal(body.data.source, 'simulation');
    let path = tool.path;
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(input)) {
      if (path.includes(`:${key}`)) path = path.replace(`:${key}`, String(value));
      else query.set(key, String(value));
    }
    const rest = await app.inject({ url: path + '?' + query, headers: { authorization: 'Bearer <placeholder-smoke>' } });
    assert.equal(rest.statusCode, 200);
    assert.deepEqual(body, rest.json());
    console.log(JSON.stringify({ phase: 'tools_call', tool: tool.name, rest_equal: true, result }));
  }
  const denied = await client.callTool({ name: 'get_products', arguments: { shop_id: demoShopIds[1] } });
  assert.equal(denied.isError, true);
  console.log(JSON.stringify({ phase: 'shop_denied', result: denied }));
  // Gateway audit goes through the async Fastify/pino logger; the denial
  // record may still be buffered when callTool resolves. Wait for it
  // (bounded) instead of asserting on a possibly incomplete stderr snapshot.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const seen = audit.trim().split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } });
    if (seen.some(r => r && r.status_code === 403)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const records = audit.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(records.filter(r => r.event === 'gateway_read' && r.status_code === 200).length, 7);
  assert.ok(records.some(r => r.status_code === 403));
  console.log(JSON.stringify({ phase: 'server_stderr_audit', records }));
  console.log('PASS: actual SDK stdio initialize, tools/list, seven read calls, REST equality, shop denial and shared Gateway audit');
} finally {
  await client.close();
  await transport.close();
  await app.close();
}
