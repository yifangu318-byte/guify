import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildApp } from '../src/app.js';
import { createMcpServer } from '../src/gateway/mcp-transport.js';
import { createMcpModule } from '../src/gateway/mcp.js';
import { createGateway } from '../src/gateway/index.js';
import { toolRegistry } from '../src/gateway/registry.js';
import { createWebSimulation, demoShopIds, demoWindow } from '../src/web/simulation.js';
import type { ToolName } from '../src/gateway/contracts.js';

const token = '<placeholder-mcp-test>', auth = `Bearer ${token}`;
const invalid = { error: true, message: 'Invalid request', code: 'INVALID_REQUEST' };
function inputFor(name: ToolName) {
  return { shop_id: demoShopIds[0],
    ...(name === 'get_shop_overview' ? demoWindow : {}),
    ...(['get_order_detail', 'diagnose_fulfillment_issue'].includes(name) ? { order_id: 'simulation-order-1' } : {}),
  };
}
function envelope(result: Awaited<ReturnType<Client['callTool']>>) {
  const content = result.content as Array<{ type: string; text: string }>;
  assert.equal(content[0]?.type, 'text');
  const body = JSON.parse(content[0]!.text);
  assert.deepEqual(result.structuredContent, body);
  assert.equal(result.isError, body.error);
  return body;
}
async function connected(options: { authorization?: string; tools?: ToolName[] } = {}) {
  let logs = '';
  const app = buildApp({ host: '127.0.0.1', port: 0 }, new Writable({ write(chunk, _enc, cb) { logs += chunk; cb(); } }), {
    ...createWebSimulation(), now: () => demoWindow.end_at,
    agents: [{ agent_id: 'simulation-test', bearer_token: token, shop_ids: [demoShopIds[0]],
      tools: options.tools ?? toolRegistry.map(tool => tool.name) }],
  });
  const server = createMcpServer(app.getDecorator('gateway'), options.authorization ?? auth);
  const [left, right] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'muse-local-test', version: '0.1.0' });
  await server.connect(right);
  await client.connect(left);
  return { app, client, logs: () => logs, close: async () => { await client.close(); await server.close(); await app.close(); } };
}

for (const tool of toolRegistry) {
  test(`technical MCP ${tool.name}: SDK result equals REST through the same app.gateway`, async t => {
    const f = await connected(); t.after(f.close);
    const input = inputFor(tool.name);
    const query = new URLSearchParams();
    let path = tool.path;
    for (const [key, value] of Object.entries(input)) {
      if (path.includes(`:${key}`)) path = path.replace(`:${key}`, String(value));
      else query.set(key, String(value));
    }
    const rest = await f.app.inject({ url: path + '?' + query, headers: { authorization: auth } });
    const result = envelope(await f.client.callTool({ name: tool.name, arguments: input }));
    assert.equal(rest.statusCode, 200);
    assert.deepEqual(result, rest.json());
    assert.equal(result.data.source, 'simulation');
    const audit = f.logs().trim().split('\n').map(line => JSON.parse(line)).filter(r => r.event === 'gateway_read');
    assert.equal(audit.length, 2);
    assert.ok(audit.every(r => r.tool === tool.name && r.status_code === 200));
    assert.ok(!f.logs().includes(token));
  });
}

test('technical MCP SDK rejects shop/tool escalation and preserves closed input validation', async t => {
  const f = await connected({ tools: ['get_products'] }); t.after(f.close);
  for (const call of [
    { name: 'get_products', arguments: { shop_id: demoShopIds[1] } },
    { name: 'get_orders', arguments: { shop_id: demoShopIds[0] } },
    { name: 'get_products', arguments: { shop_id: demoShopIds[0], authorization: auth } },
    { name: 'get_products', arguments: {} },
  ]) assert.deepEqual(envelope(await f.client.callTool(call)), invalid);
  assert.deepEqual(envelope(await f.client.callTool({ name: 'write_inventory', arguments: {} })),
    { error: true, message: 'Route not found', code: 'NOT_FOUND' });
  assert.ok(f.logs().includes('"status_code":403'));
  assert.ok(f.logs().includes('"status_code":400'));
  assert.ok(!f.logs().includes(token));
});

test('technical MCP caller metadata cannot replace a launcher-bound identity', async t => {
  const f = await connected({ authorization: 'Bearer <placeholder-invalid>' }); t.after(f.close);
  const result = await f.client.callTool({ name: 'get_products', arguments: { shop_id: demoShopIds[0] },
    _meta: { authorization: auth } });
  assert.deepEqual(envelope(result), invalid);
  assert.ok(f.logs().includes('"status_code":401'));
});

test('technical MCP module status follows explicit stdio connect and close', async () => {
  const mcp = createMcpModule(createGateway());
  assert.equal(mcp.transport, 'not_connected');
  const input = new PassThrough(), output = new PassThrough();
  try {
    await mcp.connectStdio(undefined, input, output);
    assert.equal(mcp.transport, 'stdio');
    await assert.rejects(mcp.connectStdio(undefined, input, output), /already started/);
  } finally { await mcp.close(); input.destroy(); output.destroy(); }
  assert.equal(mcp.transport, 'not_connected');
});

test('technical MCP stdio startup failure keeps not_connected and hides raw errors', async () => {
  const mcp = createMcpModule(createGateway());
  const input = new PassThrough(), output = new PassThrough();
  input.on = (() => { throw new Error('placeholder-private-error'); }) as typeof input.on;
  await assert.rejects(mcp.connectStdio(undefined, input, output), { message: 'MCP stdio connection failed' });
  assert.equal(mcp.transport, 'not_connected');
  await mcp.close(); input.destroy(); output.destroy();
});

for (const simulation of [true, false]) {
  test(`technical MCP real SDK stdio subprocess: ${simulation ? 'seven read tools' : 'default deny'}`, async t => {
    const transport = new StdioClientTransport({ command: process.execPath,
      args: ['--import', 'tsx', 'src/mcp-stdio.ts', ...(simulation ? ['--simulation'] : [])], stderr: 'pipe', env: {},
    });
    let stderr = '';
    transport.stderr?.on('data', chunk => { stderr += chunk; });
    const client = new Client({ name: 'muse-local-stdio-test', version: '0.1.0' });
    t.after(async () => { await client.close(); await transport.close(); });
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.name, 'muse-erp');
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(tool => tool.name), toolRegistry.map(tool => tool.name));
    assert.ok(listed.tools.every(tool => tool.annotations?.readOnlyHint === true && tool.inputSchema.additionalProperties === false));
    for (const tool of toolRegistry) {
      const body = envelope(await client.callTool({ name: tool.name, arguments: inputFor(tool.name) }));
      if (simulation) { assert.equal(body.error, false); assert.equal(body.data.source, 'simulation'); }
      else assert.deepEqual(body, invalid);
    }
    assert.ok(!stderr.includes('<placeholder-mcp-simulation>'));
  });
}
