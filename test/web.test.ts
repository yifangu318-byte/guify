import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { MemoryShopRepository, type ShopSeed } from '../src/shops/repository.js';
import { MemoryProductRepository } from '../src/products/repository.js';
import { MemoryOrderRepository } from '../src/orders/repository.js';
import { emptySnapshot as emptyProducts } from '../src/products/models.js';
import { emptySnapshot as emptyOrders } from '../src/orders/models.js';
import { WebAuditLog, type WebOptions } from '../src/web/service.js';
import type { GatewayOptions } from '../src/gateway/index.js';

const A = 'placeholder-web-a', B = 'placeholder-web-b';
const START = 1000, END = 2000, NOW = 400_000_000;
const routes = [
  ['/web/', '店铺概览'], ['/web/overview', '店铺概览'], ['/web/orders', '订单列表'],
  ['/web/orders/placeholder-order', '订单详情'], ['/web/products', '商品与 SKU'],
  ['/web/inventory', '库存与仓库'], ['/web/analytics', '经营数据'], ['/web/alerts', '巡检告警'],
  ['/web/connections', 'API 连接状态'], ['/web/agents', 'Agent 任务与执行日志'],
] as const;
const missing = { error: true, message: 'Route not found', code: 'NOT_FOUND' };
const invalid = { error: true, message: 'Invalid request', code: 'INVALID_REQUEST' };
const internal = { error: true, message: 'Internal server error', code: 'INTERNAL_ERROR' };
function shop(shop_id = A): ShopSeed {
  return { shop: { id: shop_id, shopCode: '<placeholder-private-code>', market: 'SIM', shopName: shop_id === A ? '模拟 A' : '模拟 B', status: 'inactive' },
    authorization: { shop_id, status: 'authorized', expires_at: null, source: 'simulation' },
    sync: [{ shop_id, resource: null, last_success_at: null, last_cursor: '<placeholder-private-cursor>', last_error: null }] };
}
function products(shop_id = A) {
  const s = emptyProducts(shop_id);
  s.products.push({ shop_id, product_id: 'placeholder-product', title: shop_id === A ? '模拟商品 A' : '模拟商品 B', status: 'active', category: null, updated_at: null });
  s.skus.push({ shop_id, product_id: 'placeholder-product', sku_id: 'placeholder-sku', price: '0.10', currency: 'TST', status: 'active' });
  s.warehouses.push({ shop_id, warehouse_id: 'placeholder-warehouse', name: '模拟仓库', warehouse_type: 'overseas' });
  s.inventory.push({ shop_id, sku_id: 'placeholder-sku', warehouse_id: 'placeholder-warehouse', quantity: shop_id === A ? 0 : 9, updated_at: null });
  return s;
}
function orders(shop_id = A) {
  const s = emptyOrders(shop_id);
  for (const [order_id, time, amount, status] of [
    ['placeholder-before', 999, '9.00', 'delivered'], ['placeholder-order', START, '0.10', 'awaiting_payment'],
    ['placeholder-last', 1999, '0.20', 'cancelled'], ['placeholder-end', END, '9.00', 'delivered'],
  ] as const) {
    s.orders.push({ shop_id, order_id, buyer_ref: '<placeholder-private-buyer>', total_amount: shop_id === A ? amount : '7.00', currency: 'TST',
      status, created_at: time, order_time: time, updated_at: null });
    s.items.push({ shop_id, order_id, item_id: 'placeholder-item', sku_id: 'placeholder-sku', quantity: 1, unit_price: amount });
    s.packages.push({ shop_id, order_id, package_id: `${order_id}-package`, tracking_ref: '<placeholder-private-tracking>', status: 'pending_shipment', shipped_at: null });
  }
  return s;
}
function fixture(overrides: WebOptions = {}, gateway: GatewayOptions = {}) {
  const simulation = { shops: new MemoryShopRepository([shop(), shop(B)]),
    products: new MemoryProductRepository([products(), products(B)]), orders: new MemoryOrderRepository([orders(), orders(B)]) };
  let logs = '';
  const destination = new Writable({ write(chunk, _encoding, cb) { logs += chunk; cb(); } });
  const options: WebOptions = { simulation, shop_ids: [A, B], now: () => NOW, ...overrides };
  const app = buildApp(loadConfig({}), destination, gateway, options);
  return { app, simulation, logs: () => logs };
}
const url = (path: string, shop_id = A, start_at = START, end_at = END) => `${path}?${new URLSearchParams({ shop_id, start_at: String(start_at), end_at: String(end_at) })}`;
const panel = (html: string) => html.split('<section class="panel">')[1]!.split('</main>')[0]!;

for (const [path, title] of routes) {
  test(`T9 ${path}: 200 HTML with simulation, explicit shop, query time and window`, async t => {
    const f = fixture(); t.after(() => f.app.close());
    const r = await f.app.inject(url(path));
    assert.equal(r.statusCode, 200); assert.match(r.headers['content-type']!, /text\/html; charset=utf-8/);
    assert.ok(r.body.includes(`<h1>${title}</h1>`)); assert.ok(r.body.includes('source: simulation'));
    assert.ok(r.body.includes(`适用店铺：${A}`)); assert.ok(r.body.includes(`(${NOW})`));
    assert.ok(r.body.includes(`(${START})`)); assert.ok(r.body.includes(`(${END})`));
    assert.match(r.body, /含起点、不含终点/); assert.match(r.body, /未接真实数据/);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.match(r.headers['content-security-policy']!, /default-src 'none'/);
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
  });
  test(`T9 ${path}: missing shop prompts without any repository reads or implicit all-shop data`, async t => {
    const fail = async (): Promise<never> => assert.fail('unscoped repository read');
    const f = fixture({ simulation: { shops: { getShop: fail, getAuthorization: fail, getSyncStates: fail },
      products: { getSnapshot: fail, replaceSnapshot: fail }, orders: { getSnapshot: fail, replaceSnapshot: fail } } });
    t.after(() => f.app.close());
    for (const suffix of ['', `?start_at=${START}&end_at=${END}`, '?shop_id=']) {
      const r = await f.app.inject(path + suffix);
      assert.equal(r.statusCode, 200); assert.match(panel(r.body), /请选择店铺/);
      assert.match(r.body, /source: simulation/); assert.ok(!panel(r.body).includes('0.10'));
      assert.ok(!r.body.includes(' selected'));
    }
  });
  test(`T9 ${path}: shop alone prompts for explicit window, no default calculation`, async t => {
    const f = fixture(); t.after(() => f.app.close());
    const r = await f.app.inject(`${path}?shop_id=${A}`);
    assert.equal(r.statusCode, 200); assert.match(panel(r.body), /请显式选择统计窗口/);
    assert.ok(!panel(r.body).includes('0.10')); assert.ok(!r.body.includes('name="start_at" type="number" min="0" max="9007199254740991" step="1" required value='));
  });
  test(`T9 ${path}: unknown shop uses fixed 404 envelope`, async t => {
    const f = fixture(); t.after(() => f.app.close());
    for (const query of [url(path, 'placeholder-unknown'), `${path}?shop_id=placeholder-unknown`]) {
      const r = await f.app.inject(query);
      assert.equal(r.statusCode, 404); assert.deepEqual(r.json(), missing);
    }
  });
  test(`T9 ${path}: all write methods rejected and snapshots unchanged`, async t => {
    const f = fixture(); t.after(() => f.app.close());
    const before = [await f.simulation.products.getSnapshot(A), await f.simulation.orders.getSnapshot(A), await f.simulation.shops.getAuthorization(A)];
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const r = await f.app.inject({ method, url: url(path), payload: { quantity: 999 } });
      assert.equal(r.statusCode, 404); assert.deepEqual(r.json(), missing);
    }
    await f.app.inject(url(path));
    assert.deepEqual([await f.simulation.products.getSnapshot(A), await f.simulation.orders.getSnapshot(A), await f.simulation.shops.getAuthorization(A)], before);
  });
  test(`T9 ${path}: only GET query form, no business action UI, local links retain shop/window`, async t => {
    const f = fixture(); t.after(() => f.app.close());
    const r = await f.app.inject(url(path));
    const forms = [...r.body.matchAll(/<form\b[^>]*>/g)].map(m => m[0]);
    assert.equal(forms.length, 1); assert.match(forms[0]!, /method="get"/);
    assert.equal((r.body.match(/<button\b/g) ?? []).length, 1); assert.match(r.body, /查询（只读）/);
    assert.doesNotMatch(r.body, /改价|改库存|取消订单|发客户消息|达人邀约|<script\b|\son[a-z]+\s*=/i);
    for (const match of r.body.matchAll(/href="([^"]*)"/g)) {
      const target = match[1]!;
      assert.ok(target.startsWith('/web/')); assert.ok(target.includes(`shop_id=${A}`));
      assert.ok(target.includes(`start_at=${START}`)); assert.ok(target.includes(`end_at=${END}`));
    }
    assert.match(r.body, /name="viewport"/); assert.match(r.body, /@media\(max-width:600px\)/);
    assert.match(r.body, /overflow-x:auto/); assert.match(r.body, /flex-wrap:wrap/);
  });
}

test('T9 order/overview/analytics share T6 boundaries and raw GMV including unpaid/cancelled', async t => {
  const f = fixture(); t.after(() => f.app.close());
  const list = panel((await f.app.inject(url('/web/orders'))).body);
  assert.ok(list.includes('placeholder-order')); assert.ok(list.includes('placeholder-last'));
  assert.ok(!list.includes('placeholder-before')); assert.ok(!list.includes('placeholder-end'));
  assert.match(list, /awaiting_payment/); assert.match(list, /cancelled/);
  for (const path of ['/web/overview', '/web/analytics']) {
    const r = await f.app.inject(url(path));
    assert.match(panel(r.body), /<dd>2<\/dd>/); assert.match(panel(r.body), /<td>0.30<\/td>/);
    assert.match(r.body, /全部状态原始合计（含未付款、已取消），非实收，非结算收入/);
  }
  for (const id of ['placeholder-before', 'placeholder-end', 'placeholder-missing']) {
    const r = await f.app.inject(url(`/web/orders/${id}`));
    assert.equal(r.statusCode, 404); assert.deepEqual(r.json(), missing);
  }
});

test('T9 mixed currencies stay separate and current inventory is never presented as window history', async t => {
  const s = orders(); s.orders.find(o => o.order_id === 'placeholder-last')!.currency = 'SIM';
  const f = fixture({ simulation: { shops: new MemoryShopRepository([shop()]), products: new MemoryProductRepository([products()]), orders: new MemoryOrderRepository([s]) } });
  t.after(() => f.app.close());
  const r = await f.app.inject(url('/web/analytics'));
  assert.match(r.body, /<td>SIM<\/td><td>0.20<\/td>/); assert.match(r.body, /<td>TST<\/td><td>0.10<\/td>/);
  assert.ok(!r.body.includes('<td>0.30</td>')); assert.match(r.body, /当前快照，非历史窗口库存/);
});

test('T9 shared external identifiers remain isolated per selected shop on every page', async t => {
  const f = fixture(); t.after(() => f.app.close());
  for (const [path] of routes) {
    const a = await f.app.inject(url(path)), b = await f.app.inject(url(path, B));
    assert.equal(a.statusCode, 200); assert.equal(b.statusCode, 200);
    assert.ok(!panel(a.body).includes('模拟 B')); assert.ok(!panel(b.body).includes('模拟 A'));
    assert.ok(!panel(a.body).includes('模拟商品 B')); assert.ok(!panel(b.body).includes('模拟商品 A'));
    if (path.includes('orders')) { assert.ok(!panel(a.body).includes('7.00')); assert.ok(panel(b.body).includes('7.00')); }
  }
});

test('T9 malformed, duplicate, multiple-shop, extra and partial query fields fail closed without echo', async t => {
  const f = fixture(); t.after(() => f.app.close());
  for (const suffix of [
    `shop_id=${A}&shop_id=${B}`, `shop_id=${A}&shop_ids=${B}`, 'shop_id=all,shops',
    `shop_id=${A}&start_at=0`, `shop_id=${A}&end_at=2`, `shop_id=${A}&start_at=2&end_at=2`,
    `shop_id=${A}&start_at=3&end_at=2`, `shop_id=${A}&start_at=0&end_at=1&end_at=2`,
    'shop_id=%3Cscript%3E', 'access_token=placeholder-private-secret',
    ...['-1', '0.1', 'Infinity', 'NaN', '9007199254740992', '1e3', '', ' 1'].map(s => `shop_id=${A}&start_at=${encodeURIComponent(s)}&end_at=2000`),
  ]) {
    const r = await f.app.inject(`/web/overview?${suffix}`);
    assert.equal(r.statusCode, 400, suffix); assert.deepEqual(r.json(), invalid);
  }
  assert.ok(!f.logs().includes('placeholder-private-secret'));
});

test('T9 sensitive extras/references/cursors never escape HTML or logs, including replacement repositories', async t => {
  const s = shop(), p = products(), o = orders();
  const extras = { access_token: '<placeholder-private-access>', refresh_token: '<placeholder-private-refresh>', app_secret: '<placeholder-private-secret>',
    shop_cipher: '<placeholder-private-cipher>', buyer_name: '<placeholder-private-name>', phone: '<placeholder-private-phone>', address: '<placeholder-private-address>', tracking_no: '<placeholder-private-number>' };
  for (const row of [s.shop, s.authorization!, ...s.sync!, p, ...p.products, ...p.skus, ...p.warehouses, ...p.inventory, ...p.sync,
    o, ...o.orders, ...o.items, ...o.packages, ...o.sync]) Object.assign(row, extras);
  const fail = async () => assert.fail('business mutation');
  const f = fixture({ simulation: { shops: { getShop: async () => s.shop, getAuthorization: async () => s.authorization, getSyncStates: async () => [...s.sync!] },
    products: { getSnapshot: async () => p, replaceSnapshot: fail }, orders: { getSnapshot: async () => o, replaceSnapshot: fail } } });
  t.after(() => f.app.close());
  let output = '';
  for (const [path] of routes) {
    const r = await f.app.inject({ url: url(path), headers: { authorization: 'Bearer <placeholder-private-auth>' } });
    assert.equal(r.statusCode, 200); output += r.body;
  }
  output += f.logs();
  for (const value of [...Object.keys(extras), ...Object.values(extras), ...Object.values(extras).map(v => v.replace('<', '&lt;').replace('>', '&gt;')),
    'buyer_ref', 'tracking_ref', 'last_cursor', 'shopCode', 'placeholder-private-code', 'placeholder-private-buyer', 'placeholder-private-tracking', 'placeholder-private-cursor', 'placeholder-private-auth']) {
    assert.ok(!output.includes(value), value);
  }
});

test('T9 HTML escaping protects product, shop, warehouse, currency and ID fields; links stay local', async t => {
  const s = shop(), p = products(), o = orders();
  const payload = '<script>alert("x")</script><img src=x onerror=alert(1)> & \'quoted\'';
  s.shop.shopName = payload; p.products[0]!.title = payload; p.warehouses[0]!.name = payload;
  p.skus[0]!.currency = payload; o.orders[1]!.currency = payload;
  const f = fixture({ simulation: { shops: new MemoryShopRepository([s]), products: new MemoryProductRepository([p]), orders: new MemoryOrderRepository([o]) } });
  t.after(() => f.app.close());
  for (const path of ['/web/overview', '/web/products', '/web/inventory', '/web/orders', '/web/orders/placeholder-order']) {
    const r = await f.app.inject(url(path));
    assert.equal(r.statusCode, 200); assert.ok(!r.body.includes(payload));
    assert.ok(r.body.includes('&lt;script&gt;')); assert.doesNotMatch(r.body, /<script\b|<img\b/);
    assert.match(r.headers['content-security-policy']!, /form-action 'self'/);
  }
});

test('T9 T3 authorization denies business pages but connections can display effective expired state', async t => {
  for (const status of ['unauthorized', 'revoked', 'pending_verification', 'authorized'] as const) {
    const s = shop(); Object.assign(s.authorization!, { status, expires_at: NOW });
    const f = fixture({ simulation: { shops: new MemoryShopRepository([s]), products: new MemoryProductRepository([products()]), orders: new MemoryOrderRepository([orders()]) } });
    t.after(() => f.app.close());
    for (const [path] of routes.filter(([p]) => p !== '/web/connections')) {
      const r = await f.app.inject(url(path)); assert.equal(r.statusCode, 403); assert.deepEqual(r.json(), invalid);
    }
    const r = await f.app.inject(url('/web/connections'));
    assert.equal(r.statusCode, 200); assert.match(r.body, /真实 API：未连接、未验证/);
    assert.match(r.body, /不读取商品或订单同步快照/);
    if (status === 'authorized') assert.match(r.body, /<td>expired<\/td>/);
  }
});

test('T9 live provenance, wrong scope, exceptions and invalid clocks use fixed internal envelope', async t => {
  for (const read of [async () => { throw new Error('<placeholder-private-exception>'); }, async () => orders(B),
    async () => Object.assign(orders(), { source: 'live' })]) {
    const f = fixture({ simulation: { shops: new MemoryShopRepository([shop()]), products: new MemoryProductRepository([products()]),
      orders: { getSnapshot: read, replaceSnapshot: async () => assert.fail('write') } } });
    t.after(() => f.app.close());
    const r = await f.app.inject(url('/web/orders'));
    assert.equal(r.statusCode, 500); assert.deepEqual(r.json(), internal); assert.ok(!f.logs().includes('placeholder-private-exception'));
  }
  for (const now of [NaN, -1, Infinity, 0.5]) {
    const f = fixture({ now: () => now }); t.after(() => f.app.close());
    const r = await f.app.inject(url('/web/overview')); assert.equal(r.statusCode, 500); assert.deepEqual(r.json(), internal);
  }
  const s = shop(); s.authorization!.source = 'explicit_input';
  const f = fixture({ simulation: { shops: new MemoryShopRepository([s]), products: new MemoryProductRepository([products()]), orders: new MemoryOrderRepository([orders()]) } });
  t.after(() => f.app.close());
  assert.equal((await f.app.inject(url('/web/connections'))).statusCode, 500);
});

test('T9 complete empty snapshots show empty state; missing snapshots never fabricate zero data', async t => {
  for (const present of [true, false]) {
    const f = fixture({ simulation: { shops: new MemoryShopRepository([shop()]), products: new MemoryProductRepository(present ? [emptyProducts(A)] : []),
      orders: new MemoryOrderRepository(present ? [emptyOrders(A)] : []) } });
    t.after(() => f.app.close());
    for (const path of ['/web/orders', '/web/products', '/web/inventory', '/web/alerts', '/web/overview']) {
      const r = await f.app.inject(url(path));
      assert.equal(r.statusCode, present ? 200 : 404);
      if (!present) assert.deepEqual(r.json(), missing);
      else assert.match(r.body, /暂无记录/);
    }
  }
});

test('T9 page reads current T4 snapshot and T7 evidence, no second stale business store', async t => {
  const f = fixture(); t.after(() => f.app.close());
  const alert = await f.app.inject(url('/web/alerts'));
  assert.match(panel(alert.body), /out_of_stock/);
  const next = products(); next.inventory[0]!.quantity = 3;
  await f.simulation.products.replaceSnapshot(A, next); // explicit test fixture update
  const current = await f.app.inject(url('/web/alerts'));
  assert.match(panel(current.body), /low_stock/); assert.ok(!panel(current.body).includes('out_of_stock'));
  assert.match((await f.app.inject(url('/web/inventory'))).body, /<td>3<\/td>/);
});

test('T9 Gateway audit page shows real in-process summaries only, with shop/window isolation', async t => {
  const TOKEN = '<placeholder-web-gateway-token>';
  const gateway: GatewayOptions = { shops: new MemoryShopRepository([shop(), shop(B)]), products: new MemoryProductRepository([products(), products(B)]),
    orders: new MemoryOrderRepository([orders(), orders(B)]), now: () => NOW,
    agents: [{ agent_id: 'placeholder-agent', bearer_token: TOKEN, shop_ids: [A, B], tools: ['get_orders'] }] };
  const f = fixture({}, gateway); t.after(() => f.app.close());
  const before = await f.app.inject(url('/web/agents', A, NOW, NOW + 1));
  assert.match(panel(before.body), /暂无记录/);
  for (const id of [A, B]) assert.equal((await f.app.inject({ url: `/api/shops/${id}/orders`, headers: { authorization: `Bearer ${TOKEN}` } })).statusCode, 200);
  const r = await f.app.inject(url('/web/agents', A, NOW, NOW + 1));
  assert.match(panel(r.body), /placeholder-agent/); assert.match(panel(r.body), /get_orders/);
  assert.equal((panel(r.body).match(/<td>get_orders<\/td>/g) ?? []).length, 1);
  assert.ok(!r.body.includes(TOKEN)); assert.match(r.body, /任务存储未接通/); assert.match(r.body, /MCP 传输层未接通/);
  assert.ok(!panel((await f.app.inject(url('/web/agents', A, NOW - 1, NOW))).body).includes('<td>get_orders</td>'));
  assert.ok(!panel((await f.app.inject(url('/web/agents', A, NOW + 1, NOW + 2))).body).includes('<td>get_orders</td>'));
});

test('T9 audit storage is capped at 100, omits parameters and returns copies', () => {
  const log = new WebAuditLog();
  for (let i = 0; i < 110; i++) log.record({ event: 'gateway_read', agent_id: 'placeholder-agent', shop_id: A,
    tool: 'get_orders', parameter_summary: { field_count: 1, valid: true }, result: 'OK', status_code: 200, duration_ms: 0 }, i);
  const scope = { shop_id: A, start_at: 0, end_at: 110 }, rows = log.read(scope);
  assert.equal(rows.length, 100); assert.equal(rows[0]!.recorded_at, 10);
  rows[0]!.agent_id = 'mutated'; assert.equal(log.read(scope)[0]!.agent_id, 'placeholder-agent');
  assert.ok(!JSON.stringify(rows).includes('parameter_summary'));
});

test('T9 Web clock failure cannot suppress existing Gateway audit sink or change its response', async t => {
  const records: unknown[] = [];
  const f = fixture({ now: () => { throw new Error('<placeholder-private-clock>'); } }, { audit: r => records.push(r) });
  t.after(() => f.app.close());
  const r = await f.app.inject(`/api/shops/${A}/orders`);
  assert.equal(r.statusCode, 401); assert.deepEqual(r.json(), invalid); assert.equal(records.length, 1);
  assert.ok(!f.logs().includes('placeholder-private-clock'));
});

test('T9 default app serves isolated demo and does not grant Gateway access or share its repositories', async t => {
  const sink = new Writable({ write(_chunk, _encoding, cb) { cb(); } });
  const app = buildApp(loadConfig({}), sink); t.after(() => app.close());
  assert.match((await app.inject('/web/')).body, /请选择店铺/);
  const query = 'shop_id=simulation-shop-a&start_at=1790812800000&end_at=1793491200000';
  const r = await app.inject(`/web/overview?${query}`);
  assert.equal(r.statusCode, 200); assert.match(r.body, /<td>37.50<\/td>/);
  assert.equal((await app.inject('/api/shops/simulation-shop-a/orders')).statusCode, 401);
  assert.equal((await app.inject('/health')).statusCode, 200);
});
