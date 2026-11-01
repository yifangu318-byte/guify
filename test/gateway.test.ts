import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { emptySnapshot as emptyOrders, type OrderSnapshot } from '../src/orders/models.js';
import { emptySnapshot as emptyProducts, type ProductSnapshot } from '../src/products/models.js';
import { MemoryShopRepository, type ShopSeed, type ShopRepository } from '../src/shops/repository.js';
import { MemoryOrderRepository } from '../src/orders/repository.js';
import { MemoryProductRepository } from '../src/products/repository.js';
import { ShopQueries } from '../src/shops/service.js';
import { OrderQueries } from '../src/orders/service.js';
import { ProductQueries } from '../src/products/service.js';
import { calculateInventoryRisk, calculateShopOverview } from '../src/analytics/service.js';
import { runInspection } from '../src/inspection/service.js';
import { detectTimeoutAlerts } from '../src/orders/alerts.js';
import { createGateway, type GatewayOptions } from '../src/gateway/index.js';
import { createMcpModule } from '../src/gateway/mcp.js';
import { attributeFulfillmentIssue } from '../src/gateway/service.js';
import { toolRegistry, type ToolDefinition } from '../src/gateway/registry.js';
import type { AgentGrant, ToolName, ToolOutputs } from '../src/gateway/contracts.js';
import type { Result } from '../src/tiktok/client.js';

// All identities, credentials, amounts, times and records are placeholders.
const A = 'placeholder-shop-a', B = 'placeholder-shop-b', MISSING = 'placeholder-shop-missing';
const ORDER = 'placeholder-order', PARCEL = 'placeholder-package', SKU = 'placeholder-sku';
const HOUR = 3_600_000, NOW = 100 * HOUR;
const WINDOW = { start_at: 0, end_at: NOW };
const TOKEN = '<placeholder-gateway-token>', AUTH = `Bearer ${TOKEN}`;
const invalid = { error: true, message: 'Invalid request', code: 'INVALID_REQUEST' };
const missing = { error: true, message: 'Route not found', code: 'NOT_FOUND' };
const internal = { error: true, message: 'Internal server error', code: 'INTERNAL_ERROR' };
function capture() {
  let text = '';
  return { stream: new Writable({ write(chunk, _encoding, callback) { text += chunk; callback(); } }), read: () => text };
}
function shop(shop_id = A): ShopSeed {
  return { shop: { id: shop_id, market: '<placeholder-market>', shopCode: '<placeholder-code>',
    shopName: '<placeholder-name>', status: 'inactive' },
  authorization: { shop_id, status: 'authorized', expires_at: null, source: 'simulation' } };
}
function orders(shop_id = A): OrderSnapshot {
  const snapshot = emptyOrders(shop_id);
  snapshot.orders.push({ shop_id, order_id: ORDER, buyer_ref: '<placeholder-private-buyer>',
    total_amount: shop_id === A ? '0.10' : '0.90', currency: 'TST', status: 'pending_shipment',
    created_at: 0, order_time: 0, updated_at: null });
  snapshot.items.push({ shop_id, order_id: ORDER, item_id: 'placeholder-item', sku_id: SKU, quantity: 1, unit_price: '0.10' });
  snapshot.packages.push({ shop_id, order_id: ORDER, package_id: PARCEL,
    tracking_ref: '<placeholder-private-tracking>', status: 'pending_shipment', shipped_at: null });
  return snapshot;
}
function products(shop_id = A): ProductSnapshot {
  const snapshot = emptyProducts(shop_id);
  snapshot.products.push({ shop_id, product_id: 'placeholder-product', title: '<placeholder-title>',
    status: 'placeholder-active', category: null, updated_at: null });
  snapshot.skus.push({ shop_id, product_id: 'placeholder-product', sku_id: SKU, price: '0.10', currency: 'TST', status: 'placeholder-active' });
  snapshot.warehouses.push({ shop_id, warehouse_id: 'placeholder-warehouse', name: '<placeholder-warehouse>', warehouse_type: 'regular' });
  snapshot.inventory.push({ shop_id, sku_id: SKU, warehouse_id: 'placeholder-warehouse', quantity: shop_id === A ? 0 : 9, updated_at: null });
  return snapshot;
}
function agent(): AgentGrant {
  return { agent_id: 'placeholder-agent', bearer_token: TOKEN, shop_ids: [A, B, MISSING], tools: toolRegistry.map(t => t.name) };
}
function fixture(overrides: GatewayOptions = {}) {
  const shops = new MemoryShopRepository([shop(), shop(B)]);
  const productRepo = new MemoryProductRepository([products(), products(B)]);
  const orderRepo = new MemoryOrderRepository([orders(), orders(B)]);
  const logs = capture();
  const options: GatewayOptions = { shops, products: productRepo, orders: orderRepo, agents: [agent()], now: () => NOW, ...overrides };
  const app = buildApp(loadConfig({}), logs.stream, options);
  const mcp = app.getDecorator<ReturnType<typeof createMcpModule>>('mcp');
  return { app, mcp, logs, shops, productRepo, orderRepo, options };
}
function inputFor(name: ToolName, shop_id = A): Record<string, string | number> {
  return { shop_id,
    ...(name === 'get_shop_overview' ? WINDOW : {}),
    ...(['get_order_detail', 'diagnose_fulfillment_issue'].includes(name) ? { order_id: ORDER } : {}),
    ...(['get_shop_alerts', 'diagnose_fulfillment_issue'].includes(name) ? { stock_threshold: 5 } : {}) };
}
function urlFor(tool: ToolDefinition, input = inputFor(tool.name)) {
  let url = tool.path;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (url.includes(`:${key}`)) url = url.replace(`:${key}`, encodeURIComponent(String(value)));
    else query.append(key, String(value));
  }
  return url + (query.size ? `?${query}` : '');
}
function data<T>(result: Result<T>): T {
  assert.equal(result.error, false);
  if (result.error) throw new Error('Expected simulation success');
  return result.data;
}

for (const tool of toolRegistry) {
  test(`T8 ${tool.name}: REST and MCP module success are identical and scoped`, async t => {
    const f = fixture(); t.after(() => f.app.close());
    const input = inputFor(tool.name);
    const response = await f.app.inject({ url: urlFor(tool, input), headers: { authorization: AUTH } });
    assert.equal(response.statusCode, 200);
    const moduleResult = await f.mcp.callTool(tool.name, input, AUTH);
    assert.deepEqual(response.json(), moduleResult);
    const body = data(moduleResult);
    assert.equal(body.source, 'simulation'); assert.equal(body.shop_id, A);
    assert.deepEqual(body.shop_ids, [A]); assert.equal(body.queried_at, NOW);
    assert.ok(!response.body.includes(B));
    assert.equal(f.mcp.transport, 'not_connected');
  });
  test(`T8 ${tool.name}: unknown shop returns fixed envelope via both entry points`, async t => {
    const f = fixture(); t.after(() => f.app.close());
    const input = inputFor(tool.name, MISSING);
    const response = await f.app.inject({ url: urlFor(tool, input), headers: { authorization: AUTH } });
    assert.equal(response.statusCode, 404); assert.deepEqual(response.json(), missing);
    assert.deepEqual(await f.mcp.callTool(tool.name, input, AUTH), missing);
  });
  test(`T8 ${tool.name}: mandatory fields are checked by the shared validator`, async t => {
    const f = fixture(); t.after(() => f.app.close());
    for (const key of tool.inputSchema.required) {
      const input = inputFor(tool.name); delete input[key];
      assert.deepEqual(await f.mcp.callTool(tool.name, input, AUTH), invalid);
      // Missing path segments have no matching route; missing query fields are 400.
      const url = urlFor(tool, input).replace(`:${key}`, '');
      const r = await f.app.inject({ url, headers: { authorization: AUTH } });
      assert.ok([400, 404].includes(r.statusCode));
      assert.deepEqual(r.json(), r.statusCode === 404 ? missing : invalid);
    }
  });
  test(`T8 ${tool.name}: explicit shop scope isolates reused order, SKU and package IDs`, async t => {
    const f = fixture(); t.after(() => f.app.close());
    for (const id of [A, B]) {
      const input = inputFor(tool.name, id);
      const r = await f.app.inject({ url: urlFor(tool, input), headers: { authorization: AUTH } });
      assert.equal(r.statusCode, 200); assert.equal(r.json().data.shop_id, id);
      assert.ok(!r.body.includes(id === A ? B : A));
      assert.deepEqual(r.json(), await f.mcp.callTool(tool.name, input, AUTH));
    }
  });
  test(`T8 ${tool.name}: agent whitelist rejects an ungranted shop before data queries`, async t => {
    const grant = agent(); grant.shop_ids = [A];
    const f = fixture({ agents: [grant] }); t.after(() => f.app.close());
    const input = inputFor(tool.name, B);
    const r = await f.app.inject({ url: urlFor(tool, input), headers: { authorization: AUTH } });
    assert.equal(r.statusCode, 403); assert.deepEqual(r.json(), invalid);
    assert.deepEqual(await f.mcp.callTool(tool.name, input, AUTH), invalid);
    assert.ok(f.logs.read().includes('"status_code":403'));
    assert.ok(!f.logs.read().includes(B));
  });
  test(`T8 ${tool.name}: T3 unauthorized shop is rejected despite an agent grant`, async t => {
    const s = shop(); s.authorization!.status = 'unauthorized';
    const f = fixture({ shops: new MemoryShopRepository([s]) }); t.after(() => f.app.close());
    const input = inputFor(tool.name);
    const r = await f.app.inject({ url: urlFor(tool, input), headers: { authorization: AUTH } });
    assert.equal(r.statusCode, 403); assert.deepEqual(r.json(), invalid);
    assert.deepEqual(await f.mcp.callTool(tool.name, input, AUTH), invalid);
  });
  test(`T8 ${tool.name}: every write method returns 404 without gateway execution or business mutation`, async t => {
    const f = fixture(); t.after(() => f.app.close());
    const before = [await f.productRepo.getSnapshot(A), await f.orderRepo.getSnapshot(A), await f.shops.getAuthorization(A)];
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const r = await f.app.inject({ method, url: urlFor(tool), headers: { authorization: AUTH }, payload: { quantity: 999 } });
      assert.equal(r.statusCode, 404); assert.deepEqual(r.json(), missing);
    }
    assert.ok(!f.logs.read().includes('gateway_read'));
    assert.deepEqual([await f.productRepo.getSnapshot(A), await f.orderRepo.getSnapshot(A), await f.shops.getAuthorization(A)], before);
  });
  test(`T8 ${tool.name}: tool-level permission and agent authentication are enforced`, async t => {
    const grant = agent(); grant.tools = grant.tools.filter(name => name !== tool.name);
    const f = fixture({ agents: [grant] }); t.after(() => f.app.close());
    const input = inputFor(tool.name);
    for (const auth of [undefined, 'Bearer <placeholder-wrong-token>', 'Basic <placeholder-wrong-token>', AUTH]) {
      const r = await f.app.inject({ url: urlFor(tool), headers: auth ? { authorization: auth } : {} });
      assert.equal(r.statusCode, auth === AUTH ? 403 : 401); assert.deepEqual(r.json(), invalid);
      assert.deepEqual(await f.mcp.callTool(tool.name, input, auth), invalid);
    }
    assert.ok(!f.logs.read().includes(TOKEN)); assert.ok(!f.logs.read().includes('placeholder-wrong-token'));
  });
}

test('T8 overview and catalog/inventory/detail values are actual T3–T6 query results', async t => {
  const f = fixture(); t.after(() => f.app.close());
  const overview = data(await f.mcp.callTool('get_shop_overview', inputFor('get_shop_overview'), AUTH)) as ToolOutputs['get_shop_overview'];
  assert.deepEqual(overview.overview, calculateShopOverview(A, orders(), WINDOW, NOW));
  assert.equal(overview.gmv_basis, 'all_order_statuses_raw_total');
  const pq = new ProductQueries(f.productRepo), oq = new OrderQueries(f.orderRepo);
  const ps = data(await f.mcp.callTool('get_products', { shop_id: A }, AUTH)) as ToolOutputs['get_products'];
  assert.deepEqual(ps.products, data(await pq.listProducts(A))); assert.deepEqual(ps.skus, data(await pq.listSkus(A)));
  const stock = data(await f.mcp.callTool('get_inventory', { shop_id: A }, AUTH)) as ToolOutputs['get_inventory'];
  assert.deepEqual(stock.inventory, data(await pq.listInventory(A))); assert.deepEqual(stock.warehouses, data(await pq.listWarehouses(A)));
  const detail = data(await f.mcp.callTool('get_order_detail', { shop_id: A, order_id: ORDER }, AUTH)) as ToolOutputs['get_order_detail'];
  assert.deepEqual(detail.items, data(await oq.getOrder(A, ORDER)).items);
  assert.ok(!JSON.stringify(detail).includes('buyer_ref')); assert.ok(!JSON.stringify(detail).includes('tracking_ref'));
});

test('T8 get_shop_alerts is the existing T7 inspection over the same T3–T6 evidence', async t => {
  const f = fixture(); t.after(() => f.app.close());
  const auth = data(await new ShopQueries(f.shops, { now: () => NOW }).getAuthorization(A));
  const expected = runInspection([A], [{ shop_id: A, authorization: auth, products: products(), orders: orders(),
    inventory_risk: calculateInventoryRisk(A, products(), { start_at: 0, end_at: 1 }, NOW, 5) }], NOW);
  const result = data(await f.mcp.callTool('get_shop_alerts', inputFor('get_shop_alerts'), AUTH)) as ToolOutputs['get_shop_alerts'];
  assert.deepEqual(result.inspection, expected); assert.equal(expected.total_anomalies, 2);
});

test('T8 diagnosis returns T5/T7 evidence for pending shipment and matching SKU only, without advice', async t => {
  const f = fixture(); t.after(() => f.app.close());
  const result = data(await f.mcp.callTool('diagnose_fulfillment_issue', inputFor('diagnose_fulfillment_issue'), AUTH)) as ToolOutputs['diagnose_fulfillment_issue'];
  assert.deepEqual(result.reasons.map(r => [r.category, r.scope]), [['pending_shipment_timeout', 'order'], ['inventory_abnormal', 'order_sku']]);
  assert.equal(result.causal_claim, 'not_established');
  assert.equal(result.reasons[0]!.evidence.trigger_value, NOW);
  assert.equal(result.reasons[0]!.evidence.threshold, 48 * HOUR);
  assert.deepEqual(Object.keys(result).sort(), ['source', 'shop_id', 'shop_ids', 'queried_at', 'order_id', 'status', 'causal_claim', 'reasons'].sort());
});

test('T8 logistics diagnosis requires the selected order/package and T5 plus T7 agreement', async t => {
  const o = orders(); o.orders[0]!.status = 'shipped';
  Object.assign(o.packages[0]!, { status: 'in_transit', shipped_at: 0 });
  o.tracking.push({ shop_id: A, package_id: PARCEL, event_id: 'placeholder-event', occurred_at: 2000, status_description: '<placeholder-transit>' });
  const f = fixture({ orders: new MemoryOrderRepository([o]) }); t.after(() => f.app.close());
  const result = data(await f.mcp.callTool('diagnose_fulfillment_issue', inputFor('diagnose_fulfillment_issue'), AUTH)) as ToolOutputs['diagnose_fulfillment_issue'];
  assert.equal(result.reasons[0]!.category, 'logistics_stalled'); assert.equal(result.reasons[0]!.evidence.entity_id, PARCEL);
  assert.equal(result.reasons[0]!.evidence.trigger_value, NOW - 2000);
  assert.equal(result.reasons[0]!.evidence.threshold, 72 * HOUR);
  const detail = data(await new OrderQueries(f.options.orders!).getOrder(A, ORDER));
  // Supply a real T7 result, then remove T5 corroboration: no timeout is invented.
  const p = products();
  const actual = runInspection([A], [{ shop_id: A, authorization: shop().authorization!, products: p, orders: o,
    inventory_risk: calculateInventoryRisk(A, p, WINDOW, NOW) }], NOW);
  assert.equal(attributeFulfillmentIssue(detail, [], actual).reasons.some(r => r.category === 'logistics_stalled'), false);
});

test('T8 diagnosis reports insufficient evidence for a healthy order, not anomalies of other orders/SKUs', async t => {
  const o = orders(); o.orders[0]!.order_time = NOW;
  o.orders.push({ ...o.orders[0]!, order_id: 'placeholder-other-order', order_time: 0 });
  o.items[0]!.sku_id = 'placeholder-other-sku';
  const f = fixture({ orders: new MemoryOrderRepository([o]) }); t.after(() => f.app.close());
  const result = data(await f.mcp.callTool('diagnose_fulfillment_issue', inputFor('diagnose_fulfillment_issue'), AUTH)) as ToolOutputs['diagnose_fulfillment_issue'];
  assert.equal(result.status, 'insufficient_evidence'); assert.deepEqual(result.reasons, []);
});

test('T8 authorization attribution uses a real T7 finding while outer requests still deny revoked shops', async t => {
  const s = shop(); s.authorization!.status = 'revoked';
  const f = fixture({ shops: new MemoryShopRepository([s]) }); t.after(() => f.app.close());
  const p = products(), o = orders(), detail = data(await new OrderQueries(f.orderRepo).getOrder(A, ORDER));
  const inspection = runInspection([A], [{ shop_id: A, authorization: s.authorization!, products: p, orders: o,
    inventory_risk: calculateInventoryRisk(A, p, WINDOW, NOW) }], NOW);
  const diagnosis = attributeFulfillmentIssue(detail, detectTimeoutAlerts(A, o, NOW), inspection);
  assert.equal(diagnosis.reasons.find(r => r.category === 'authorization_abnormal')!.evidence.trigger_value, 'revoked');
  assert.deepEqual(await f.mcp.callTool('diagnose_fulfillment_issue', inputFor('diagnose_fulfillment_issue'), AUTH), invalid);
});

test('T8 effective authorization expiration, revocation and pending verification fail closed', async t => {
  for (const status of ['authorized', 'pending_verification', 'expired', 'revoked'] as const) {
    const s = shop(); Object.assign(s.authorization!, { status, expires_at: NOW });
    const f = fixture({ shops: new MemoryShopRepository([s]) }); t.after(() => f.app.close());
    const r = await f.app.inject({ url: `/api/shops/${A}/orders`, headers: { authorization: AUTH } });
    assert.equal(r.statusCode, 403); assert.deepEqual(r.json(), invalid);
  }
});

test('T8 no credentials, sensitive extra fields, buyer/tracking references or cursors escape REST, module or audit', async t => {
  const s = shop(), p = products(), o = orders();
  const extras = { access_token: '<placeholder-private-access>', refresh_token: '<placeholder-private-refresh>',
    app_secret: '<placeholder-private-secret>', shop_cipher: '<placeholder-private-cipher>', buyer_name: '<placeholder-private-name>',
    phone: '<placeholder-private-phone>', address: '<placeholder-private-address>', tracking_no: '<placeholder-private-number>' };
  s.sync = [{ shop_id: A, resource: null, last_success_at: null, last_cursor: '<placeholder-private-cursor>', last_error: null }];
  o.sync[0]!.last_cursor = '<placeholder-private-cursor>';
  for (const row of [s.shop, s.authorization!, ...s.sync, p, ...p.products, ...p.skus, ...p.warehouses, ...p.inventory,
    ...p.sync, o, ...o.orders, ...o.items, ...o.packages, ...o.sync]) Object.assign(row, extras);
  // Replacement repositories bypass memory projection to test the service boundary.
  const shops: ShopRepository = { getShop: async () => s.shop, getAuthorization: async () => s.authorization, getSyncStates: async () => [...s.sync!] };
  const f = fixture({ shops, products: { getSnapshot: async () => p, replaceSnapshot: async () => assert.fail('write') },
    orders: { getSnapshot: async () => o, replaceSnapshot: async () => assert.fail('write') } });
  t.after(() => f.app.close());
  const output: unknown[] = [];
  for (const tool of toolRegistry) {
    const r = await f.app.inject({ url: urlFor(tool), headers: { authorization: AUTH } });
    assert.equal(r.statusCode, 200); output.push(r.json(), await f.mcp.callTool(tool.name, inputFor(tool.name), AUTH));
  }
  const text = JSON.stringify(output) + f.logs.read();
  for (const sensitive of [...Object.keys(extras), ...Object.values(extras), TOKEN,
    'buyer_ref', 'tracking_ref', 'last_cursor', 'shopCode', '<placeholder-private-buyer>', '<placeholder-private-tracking>', '<placeholder-private-cursor>']) {
    assert.ok(!text.includes(sensitive), sensitive);
  }
  const audits = f.logs.read().trim().split('\n').map(line => JSON.parse(line));
  assert.equal(audits.length, 14);
  assert.ok(audits.every(a => a.agent_id === 'placeholder-agent' && a.shop_id === A && a.result === 'OK' && a.duration_ms >= 0));
});

test('T8 extra parameters, scalar coercion, scope overrides and implicit multiple-shop requests are rejected', async t => {
  const f = fixture(); t.after(() => f.app.close());
  for (const query of [`shop_id=${B}`, `shop_ids=${A},${B}`, 'token=%3Cplaceholder-private-access%3E', 'unexpected=1', 'shop_id=']) {
    const r = await f.app.inject({ url: `/api/shops/${A}/orders?${query}`, headers: { authorization: AUTH } });
    assert.equal(r.statusCode, 400); assert.deepEqual(r.json(), invalid);
  }
  for (const input of [undefined, null, [], {}, { shop_ids: [A, B] }, { shop_id: [A, B] }, { shop_id: '' },
    { shop_id: A, shop_ids: [A, B] }, { shop_id: A, access_token: '<placeholder-private-access>' }]) {
    assert.deepEqual(await f.mcp.callTool('get_orders', input, AUTH), invalid);
  }
  for (const value of ['-1', '1.5', 'Infinity', 'NaN', '9007199254740992', '', '1e2', '1&stock_threshold=2']) {
    const r = await f.app.inject({ url: `/api/shops/${A}/alerts?stock_threshold=${value}`, headers: { authorization: AUTH } });
    assert.equal(r.statusCode, 400); assert.deepEqual(r.json(), invalid);
  }
  assert.deepEqual(await f.mcp.callTool('get_shop_overview', { shop_id: A, start_at: '0', end_at: NOW }, AUTH), invalid);
  assert.deepEqual(await f.mcp.callTool('get_shop_overview', { shop_id: A, start_at: NOW, end_at: NOW }, AUTH), invalid);
  assert.ok(!f.logs.read().includes('placeholder-private-access'));
});

test('T8 missing order IDs never return another shop/order detail or a fabricated diagnosis', async t => {
  const f = fixture(); t.after(() => f.app.close());
  for (const name of ['get_order_detail', 'diagnose_fulfillment_issue'] as const) {
    const tool = toolRegistry.find(t => t.name === name)!;
    const input = { ...inputFor(name), order_id: 'placeholder-missing-order' };
    const r = await f.app.inject({ url: urlFor(tool, input), headers: { authorization: AUTH } });
    assert.equal(r.statusCode, 404); assert.deepEqual(r.json(), missing);
    assert.deepEqual(await f.mcp.callTool(name, input, AUTH), missing);
  }
});

test('T8 repository exceptions, corrupt scope and live provenance use T1 internal-error envelope', async t => {
  for (const read of [async () => { throw new Error('<placeholder-raw-private-error>'); },
    async () => orders(B), async () => Object.assign(orders(), { source: 'live' }),
    async () => { const s = orders(); s.orders[0]!.order_id = '<placeholder-bad-id>'; s.packages[0]!.order_id = B; return s; }]) {
    const f = fixture({ orders: { getSnapshot: read, replaceSnapshot: async () => assert.fail('write') } });
    t.after(() => f.app.close());
    const r = await f.app.inject({ url: `/api/shops/${A}/orders`, headers: { authorization: AUTH } });
    assert.equal(r.statusCode, 500); assert.deepEqual(r.json(), internal);
    assert.deepEqual(await f.mcp.callTool('get_orders', { shop_id: A }, AUTH), internal);
    assert.ok(!f.logs.read().includes('placeholder-raw-private-error'));
  }
});

test('T8 missing snapshots are unavailable, complete empty snapshots are valid simulation reads', async t => {
  const f = fixture({ products: new MemoryProductRepository(), orders: new MemoryOrderRepository() });
  t.after(() => f.app.close());
  for (const tool of toolRegistry) assert.deepEqual(await f.mcp.callTool(tool.name, inputFor(tool.name), AUTH), missing);
  const empty = fixture({ products: new MemoryProductRepository([emptyProducts(A)]), orders: new MemoryOrderRepository([emptyOrders(A)]) });
  t.after(() => empty.app.close());
  const overview = data(await empty.mcp.callTool('get_shop_overview', inputFor('get_shop_overview'), AUTH)) as ToolOutputs['get_shop_overview'];
  assert.equal(overview.overview.order_count, 0); assert.equal(overview.overview.gmv.total_amount, '0');
  const alerts = data(await empty.mcp.callTool('get_shop_alerts', inputFor('get_shop_alerts'), AUTH)) as ToolOutputs['get_shop_alerts'];
  assert.equal(alerts.inspection.total_anomalies, 0);
});

test('T8 gateway results stay current with existing repositories and never create another business store', async t => {
  const f = fixture(); t.after(() => f.app.close());
  const before = data(await f.mcp.callTool('get_inventory', { shop_id: A }, AUTH)) as ToolOutputs['get_inventory'];
  const next = products(); next.inventory[0]!.quantity = 17;
  await f.productRepo.replaceSnapshot(A, next); // Explicit fixture update, not a gateway operation.
  const r = await f.app.inject({ url: `/api/shops/${A}/inventory`, headers: { authorization: AUTH } });
  assert.equal(before.inventory[0]!.quantity, 0); assert.equal(r.json().data.inventory[0].quantity, 17);
  assert.deepEqual(r.json(), await f.mcp.callTool('get_inventory', { shop_id: A }, AUTH));
  const after = await f.productRepo.getSnapshot(A);
  r.json().data.inventory[0].quantity = 999;
  assert.deepEqual(await f.productRepo.getSnapshot(A), after);
});

test('T8 grants and arguments are captured before awaiting; caller mutations cannot widen access', async () => {
  const grant = agent(); grant.shop_ids = [A];
  const options: GatewayOptions = { shops: new MemoryShopRepository([shop(), shop(B)]), products: new MemoryProductRepository([products()]),
    orders: new MemoryOrderRepository([orders()]), agents: [grant], now: () => NOW };
  const gateway = createGateway(options), mcp = createMcpModule(gateway), input = { shop_id: A };
  const pending = mcp.callTool('get_orders', input, AUTH);
  input.shop_id = B; (grant.shop_ids as string[]).push(B); grant.bearer_token = '<placeholder-new-token>';
  assert.equal(data(await pending).shop_id, A);
  assert.deepEqual(await mcp.callTool('get_orders', { shop_id: B }, AUTH), invalid);
  assert.deepEqual(await mcp.callTool('get_orders', { shop_id: A }, 'Bearer <placeholder-new-token>'), invalid);
});

test('T8 default application registers GET routes but grants nobody access, and exposes no fake MCP endpoint', async t => {
  const app = buildApp(loadConfig({}), capture().stream); t.after(() => app.close());
  assert.equal((await app.inject(`/api/shops/${A}/orders`)).statusCode, 401);
  for (const method of ['GET', 'POST'] as const) {
    const r = await app.inject({ method, url: '/mcp' }); assert.equal(r.statusCode, 404); assert.deepEqual(r.json(), missing);
  }
  assert.equal((await app.inject('/health')).statusCode, 200);
});

test('T8 unknown tool and invalid clock failures are safe and audited', async () => {
  const audits: unknown[] = [];
  const mcp = createMcpModule(createGateway({ agents: [agent()], now: () => NaN, audit: record => audits.push(record) }));
  assert.deepEqual(await mcp.callTool('<placeholder-private-tool>', { shop_id: A }, AUTH), missing);
  assert.deepEqual(await mcp.callTool('get_orders', { shop_id: A }, AUTH), internal);
  assert.equal(audits.length, 2); assert.ok(!JSON.stringify(audits).includes('placeholder-private-tool'));
});

test('T8 duplicate identities/tokens or unknown tool grants are invalid local configuration', () => {
  for (const agents of [[agent(), agent()], [agent(), { ...agent(), agent_id: 'placeholder-other-agent' }],
    [{ ...agent(), tools: ['placeholder-write-tool'] as unknown as ToolName[] }]]) {
    assert.throws(() => createGateway({ agents }), { message: 'Invalid gateway configuration' });
  }
});

test('T8 registry contains exactly seven closed, explicitly scoped read tools and cannot be mutated', () => {
  assert.equal(toolRegistry.length, 7); assert.ok(Object.isFrozen(toolRegistry));
  for (const tool of toolRegistry) {
    assert.equal(tool.annotations.readOnlyHint, true); assert.equal(tool.annotations.destructiveHint, false);
    assert.ok(tool.inputSchema.required.includes('shop_id')); assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.outputType, `ToolOutputs['${tool.name}']`); assert.ok(Object.isFrozen(tool.inputSchema.properties));
  }
});
