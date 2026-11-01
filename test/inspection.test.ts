import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateInventoryRisk } from '../src/analytics/service.js';
import { detectStockAlerts } from '../src/products/alerts.js';
import { emptySnapshot as emptyProducts } from '../src/products/models.js';
import { detectTimeoutAlerts } from '../src/orders/alerts.js';
import { emptySnapshot as emptyOrders } from '../src/orders/models.js';
import { MemoryShopRepository } from '../src/shops/repository.js';
import { ShopQueries } from '../src/shops/service.js';
import { runInspection } from '../src/inspection/service.js';
import type { InspectionSnapshot } from '../src/inspection/models.js';

// All IDs, references, times, currency, quantities and sensitive markers are synthetic.
const A = 'placeholder-shop-a', B = 'placeholder-shop-b', SKU = 'placeholder-sku';
const ORDER = 'placeholder-order', PARCEL = 'placeholder-package', HOUR = 3_600_000;
const NOW = 100 * HOUR, WINDOW = { start_at: 0, end_at: NOW };
function refresh(s: InspectionSnapshot, threshold = 5) {
  s.inventory_risk = calculateInventoryRisk(s.shop_id, s.products, WINDOW, NOW, threshold);
  return s;
}
function seed(shop_id = A): InspectionSnapshot {
  const products = emptyProducts(shop_id), orders = emptyOrders(shop_id);
  products.products.push({ shop_id, product_id: 'placeholder-product', title: '<placeholder-title>',
    status: 'placeholder-active', category: null, updated_at: null });
  products.skus.push({ shop_id, product_id: 'placeholder-product', sku_id: SKU,
    price: '1.00', currency: 'TST', status: 'placeholder-active' });
  products.warehouses.push({ shop_id, warehouse_id: 'placeholder-warehouse',
    name: '<placeholder-warehouse>', warehouse_type: 'regular' });
  products.inventory.push({ shop_id, sku_id: SKU, warehouse_id: 'placeholder-warehouse', quantity: 5, updated_at: null });
  orders.orders.push({ shop_id, order_id: ORDER, buyer_ref: '<placeholder-buyer>', total_amount: '1.00', currency: 'TST',
    status: 'pending_shipment', created_at: NOW, order_time: NOW, updated_at: null });
  orders.packages.push({ shop_id, order_id: ORDER, package_id: PARCEL,
    tracking_ref: '<placeholder-tracking>', status: 'pending_shipment', shipped_at: null });
  return { shop_id, authorization: { shop_id, source: 'simulation', status: 'authorized', expires_at: null },
    products, orders, inventory_risk: calculateInventoryRisk(shop_id, products, WINDOW, NOW, 5) };
}
function moving(): InspectionSnapshot {
  const s = seed();
  s.orders.orders[0]!.status = 'shipped';
  Object.assign(s.orders.packages[0]!, { status: 'in_transit', shipped_at: 1000 });
  s.orders.tracking.push({ shop_id: A, package_id: PARCEL, event_id: 'placeholder-event',
    occurred_at: 2000, status_description: '<placeholder-in-transit>' });
  return s;
}
function warehouse(s: InspectionSnapshot, id: string, quantity: number) {
  s.products.warehouses.push({ ...s.products.warehouses[0]!, warehouse_id: id });
  s.products.inventory.push({ ...s.products.inventory[0]!, warehouse_id: id, quantity });
  return refresh(s);
}
const inspect = (s: InspectionSnapshot, now = NOW) => runInspection([s.shop_id], [s], now);

test('T7 stock zero emits only out-of-stock using T4 evidence', () => {
  const s = seed(); s.products.inventory[0]!.quantity = 0; refresh(s);
  const r = inspect(s), alert = detectStockAlerts(A, s.products.inventory, 5)[0]!;
  assert.deepEqual(r.stock, [{ shop_id: A, type: alert.type, entity_type: 'sku', entity_id: SKU,
    trigger_value: alert.quantity, threshold: alert.threshold }]);
  assert.equal(r.total_anomalies, 1);
});

test('T7 stock strictly below T6 threshold emits low-stock', () => {
  const s = seed(); s.products.inventory[0]!.quantity = 4; refresh(s);
  assert.deepEqual(inspect(s).stock, [{ shop_id: A, type: 'low_stock', entity_type: 'sku', entity_id: SKU,
    trigger_value: 4, threshold: 5 }]);
});

test('T7 positive stock equal to or above threshold does not trigger', () => {
  for (const quantity of [5, 6]) {
    const s = seed(); s.products.inventory[0]!.quantity = quantity; refresh(s);
    assert.deepEqual(inspect(s).stock, []); assert.equal(inspect(s).total_anomalies, 0);
  }
});

test('T7 T4 zero-threshold exception still reports zero stock, positive stock is safe', () => {
  for (const quantity of [0, 1]) {
    const s = seed(); s.products.inventory[0]!.quantity = quantity; refresh(s, 0);
    assert.equal(inspect(s).stock.length, quantity === 0 ? 1 : 0);
  }
});

test('T7 no missing stock row is converted to invented zero', () => {
  const s = seed(); s.products.inventory = []; refresh(s);
  assert.equal(inspect(s).total_anomalies, 0);
});

test('T7 pending shipment is safe before and at 48 hours, triggers one millisecond later', () => {
  const s = seed(); s.orders.orders[0]!.order_time = 1000;
  for (const delta of [-1, 0, 1]) {
    const now = 1000 + 48 * HOUR + delta, result = inspect(s, now);
    assert.equal(result.order_timeouts.length, delta > 0 ? 1 : 0);
    if (delta > 0) assert.deepEqual(result.order_timeouts, [{ shop_id: A, type: 'pending_shipment_timeout',
      entity_type: 'order', entity_id: ORDER, trigger_value: 48 * HOUR + 1, threshold: 48 * HOUR }]);
    assert.equal(result.order_timeouts.length, detectTimeoutAlerts(A, s.orders, now).length);
  }
});

test('T7 other order statuses do not generate pending shipment alerts', () => {
  for (const status of ['awaiting_payment', 'shipped', 'delivered', 'cancelled'] as const) {
    const s = seed(); s.orders.orders[0]!.status = status; s.orders.orders[0]!.order_time = 0;
    assert.deepEqual(inspect(s).order_timeouts, []);
  }
});

test('T7 logistics is safe before and at 72 hours, triggers one millisecond later', () => {
  const s = moving();
  for (const delta of [-1, 0, 1]) {
    const now = 2000 + 72 * HOUR + delta;
    assert.equal(inspect(s, now).order_timeouts.length, delta > 0 ? 1 : 0);
  }
  assert.deepEqual(inspect(s, 2001 + 72 * HOUR).order_timeouts, [{ shop_id: A, type: 'logistics_stalled',
    entity_type: 'package', entity_id: PARCEL, trigger_value: 72 * HOUR + 1, threshold: 72 * HOUR }]);
});

test('T7 logistics evidence uses latest unordered event, not shipment or an older event', () => {
  const s = moving();
  s.orders.tracking.push({ ...s.orders.tracking[0]!, event_id: 'placeholder-newer', occurred_at: 10 * HOUR },
    { ...s.orders.tracking[0]!, event_id: 'placeholder-older', occurred_at: 1500 });
  assert.equal(inspect(s, 82 * HOUR).order_timeouts.length, 0);
  assert.equal(inspect(s, 82 * HOUR + 1).order_timeouts[0]!.trigger_value, 72 * HOUR + 1);
});

test('T7 logistics without events falls back to shipped_at; unknown time stays unknown', () => {
  const s = moving(); s.orders.tracking = [];
  assert.equal(inspect(s, 1000 + 72 * HOUR).order_timeouts.length, 0);
  assert.equal(inspect(s, 1001 + 72 * HOUR).order_timeouts[0]!.trigger_value, 72 * HOUR + 1);
  s.orders.packages[0]!.shipped_at = null;
  assert.deepEqual(inspect(s).order_timeouts, []);
});

test('T7 delivered/cancelled orders or non-transit packages do not trigger logistics', () => {
  for (const status of ['delivered', 'cancelled'] as const) {
    const s = moving(); s.orders.orders[0]!.status = status;
    assert.deepEqual(inspect(s).order_timeouts, []);
  }
  for (const status of ['pending_shipment', 'delivered', 'cancelled'] as const) {
    const s = moving(); s.orders.packages[0]!.status = status;
    assert.deepEqual(inspect(s).order_timeouts, []);
  }
});

test('T7 future timestamps cannot cause order or logistics false positives', () => {
  const s = seed(); s.orders.orders[0]!.order_time = NOW + 1;
  assert.deepEqual(inspect(s).order_timeouts, []);
  const m = moving(); m.orders.tracking[0]!.occurred_at = NOW + 1;
  assert.deepEqual(inspect(m).order_timeouts, []);
});

for (const status of ['expired', 'revoked', 'unauthorized'] as const) {
  test(`T7 T3 ${status} appears in the authorization list separately`, () => {
    const s = seed(); s.authorization.status = status;
    const r = inspect(s);
    assert.deepEqual(r.authorization, [{ shop_id: A, type: 'authorization_abnormal', entity_type: 'shop',
      entity_id: A, trigger_value: status, threshold: 'authorized' }]);
    assert.deepEqual(r.stock, []); assert.deepEqual(r.order_timeouts, []);
    assert.equal(r.total_anomalies, 1);
  });
}

test('T7 T3 authorized and pending_verification statuses do not invent an authorization alert', () => {
  for (const status of ['authorized', 'pending_verification'] as const) {
    const s = seed(); s.authorization.status = status;
    assert.deepEqual(inspect(s).authorization, []);
  }
});

test('T7 receives T3 effective expiry at its exact boundary without changing authorization storage', async () => {
  for (const status of ['authorized', 'pending_verification'] as const) {
    const repo = new MemoryShopRepository([{ shop: { id: A, market: '<placeholder-market>',
      shopCode: '<placeholder-code>', shopName: '<placeholder-name>', status: 'inactive' },
      authorization: { shop_id: A, status, expires_at: NOW, source: 'simulation' } }]);
    const s = seed(), q = new ShopQueries(repo, { now: () => NOW });
    const auth = await q.getAuthorization(A);
    assert.equal(auth.error, false); if (auth.error) throw new Error('Expected authorization state');
    s.authorization = auth.data;
    assert.equal(inspect(s).authorization[0]!.trigger_value, 'expired');
    assert.equal((await repo.getAuthorization(A))!.status, status);
  }
});

test('T7 simultaneous categories have explicit time, scope, simulation source and correct total', () => {
  const s = moving(); s.products.inventory[0]!.quantity = 0; s.authorization.status = 'revoked'; refresh(s);
  s.orders.orders.push({ ...s.orders.orders[0]!, order_id: 'placeholder-pending', status: 'pending_shipment', order_time: 0 });
  const r = inspect(s);
  assert.equal(r.source, 'simulation'); assert.equal(r.inspected_at, NOW); assert.deepEqual(r.shop_ids, [A]);
  assert.equal(r.stock.length, 1); assert.equal(r.order_timeouts.length, 2); assert.equal(r.authorization.length, 1);
  assert.equal(r.total_anomalies, 4);
});

test('T7 explicit subset cannot inspect another supplied shop', () => {
  const a = seed(), b = seed(B); b.authorization.status = 'revoked';
  b.products.inventory[0]!.quantity = 0; refresh(b); b.orders.orders[0]!.order_time = 0;
  const r = runInspection([A], [a, b], NOW);
  assert.deepEqual(r.shop_ids, [A]); assert.equal(r.total_anomalies, 0);
  assert.ok(!JSON.stringify(r).includes(B));
});

test('T7 identical SKU/order/package identifiers in different shops remain isolated', () => {
  const a = moving(), b = moving();
  // Generate a valid B snapshot while reusing all entity identifiers.
  const remap = JSON.parse(JSON.stringify(b).split(A).join(B)) as InspectionSnapshot;
  for (const s of [a, remap]) { s.products.inventory[0]!.quantity = 0; refresh(s); s.authorization.status = 'expired'; }
  const r = runInspection([B, A, B], [a, remap], NOW);
  assert.deepEqual(r.shop_ids, [B, A]);
  for (const list of [r.stock, r.order_timeouts, r.authorization]) assert.deepEqual(list.map(a => a.shop_id), [B, A]);
  assert.equal(r.total_anomalies, 6);
});

test('T7 missing/malformed shop set never defaults to all shops', () => {
  for (const scope of [undefined, null, 'all', [''], [A, null]]) {
    assert.throws(() => runInspection(scope as string[], [seed()], NOW), { message: 'Invalid inspection request' });
  }
});

test('T7 explicit empty shop set returns zero despite available anomalies', () => {
  const s = moving(); s.authorization.status = 'revoked';
  assert.deepEqual(runInspection([], [s], NOW), { source: 'simulation', inspected_at: NOW, shop_ids: [],
    stock: [], order_timeouts: [], authorization: [], total_anomalies: 0 });
  assert.equal(runInspection([], [], NOW).total_anomalies, 0);
});

test('T7 selected shop with empty business snapshots returns zero rather than error', () => {
  const s = seed(); s.products = emptyProducts(A); s.orders = emptyOrders(A); refresh(s);
  assert.equal(inspect(s).total_anomalies, 0);
});

test('T7 unavailable/ambiguous selected shop fails without a partial successful result', () => {
  for (const snapshots of [[], [seed()], [seed(), seed(), seed(B)]]) {
    assert.throws(() => runInspection([A, B], snapshots, NOW), { message: 'Inspection snapshot unavailable or ambiguous' });
  }
});

test('T7 duplicate scope and same SKU/type in multiple warehouses yield one lowest-quantity evidence', () => {
  const s = seed(); s.products.inventory[0]!.quantity = 3;
  warehouse(s, 'placeholder-second-warehouse', 1); warehouse(s, 'placeholder-third-warehouse', 2);
  const r = runInspection([A, A], [s], NOW);
  assert.deepEqual(r.shop_ids, [A]); assert.equal(r.stock.length, 1); assert.equal(r.total_anomalies, 1);
  assert.equal(r.stock[0]!.trigger_value, 1);
  s.products.inventory.reverse(); refresh(s);
  assert.deepEqual(inspect(s).stock, r.stock);
});

test('T7 different stock types for the same SKU survive deduplication without warehouse pooling', () => {
  const s = seed(); s.products.inventory[0]!.quantity = 0;
  warehouse(s, 'placeholder-low', 1); warehouse(s, 'placeholder-high', 100);
  assert.deepEqual(inspect(s).stock.map(a => [a.type, a.trigger_value]), [['out_of_stock', 0], ['low_stock', 1]]);
});

test('T7 separate stalled packages of one order each retain their own evidence', () => {
  const s = moving(); s.orders.packages.push({ ...s.orders.packages[0]!, package_id: 'placeholder-second-package' });
  const r = runInspection([A, A], [s], NOW);
  assert.equal(r.order_timeouts.length, 2);
  assert.deepEqual(r.order_timeouts.map(a => a.entity_id), [PARCEL, 'placeholder-second-package']);
});

test('T7 malformed snapshots, cross-shop rows and broken references fail with fixed errors', () => {
  const corruptions: Array<(s: InspectionSnapshot) => void> = [
    s => { s.authorization.shop_id = B; },
    s => { Object.assign(s.authorization, { status: '<placeholder-private>' }); },
    s => { s.products.shop_id = B; },
    s => { s.products.inventory[0]!.shop_id = B; },
    s => { s.products.inventory[0]!.warehouse_id = 'placeholder-missing'; },
    s => { s.orders.orders[0]!.shop_id = B; },
    s => { s.orders.packages[0]!.order_id = 'placeholder-missing'; },
    s => { s.orders.orders.push({ ...s.orders.orders[0]! }); },
    s => { s.products.inventory.push({ ...s.products.inventory[0]! }); },
    s => { Object.assign(s.orders.orders[0]!, { buyer_ref: 'synthetic-invalid-sensitive-shape' }); },
  ];
  for (const corrupt of corruptions) {
    const s = seed(); corrupt(s);
    assert.throws(() => inspect(s), { message: 'Invalid inspection snapshot' });
  }
});

test('T7 T6 risk must match the T4 snapshot and shop; stale or fabricated alerts are rejected', () => {
  const corruptions: Array<(s: InspectionSnapshot) => void> = [
    s => { s.inventory_risk.shop_id = B; },
    s => { Object.assign(s.inventory_risk, { inventory_basis: 'historical' }); },
    s => { s.inventory_risk.window.end_at = s.inventory_risk.window.start_at; },
    s => { s.products.inventory[0]!.quantity = 0; },
    s => { s.inventory_risk.low_stock.push({ shop_id: A, sku_id: SKU, warehouse_id: 'placeholder-warehouse',
      quantity: 1, threshold: 5, type: 'low_stock' }); },
    s => { Object.assign(s, { inventory_risk: null }); },
  ];
  for (const corrupt of corruptions) {
    const s = seed(); corrupt(s);
    assert.throws(() => inspect(s), { message: 'Invalid inspection snapshot' });
  }
});

test('T7 invalid T6 thresholds and inspection clocks fail even at empty scope', () => {
  for (const threshold of [undefined, null, -1, 0.5, Infinity, NaN, '5', Number.MAX_SAFE_INTEGER + 1]) {
    const s = seed(); Object.assign(s.inventory_risk, { threshold });
    assert.throws(() => inspect(s), { message: 'Invalid inspection snapshot' });
  }
  for (const now of [undefined, null, -1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => runInspection([], [], now as number), { message: 'Invalid inspection request' });
  }
});

test('T7 rejects live provenance instead of relabeling it simulation', () => {
  for (const field of ['products', 'orders', 'inventory_risk', 'authorization'] as const) {
    const s = seed(); Object.assign(s[field], { source: 'live' });
    assert.throws(() => inspect(s), { message: 'Invalid inspection snapshot' });
  }
  const s = seed(); s.authorization.source = 'explicit_input';
  assert.equal(inspect(s).source, 'simulation'); // T3 explicitly supports this status source.
});

test('T7 only whitelisted evidence fields escape; sensitive extras and allowed source descriptions are omitted', () => {
  const s = moving(); s.products.inventory[0]!.quantity = 0; refresh(s); s.authorization.status = 'revoked';
  const extras = { access_token: '<placeholder-access>', app_secret: '<placeholder-secret>',
    refresh_token: '<placeholder-refresh>', shop_cipher: '<placeholder-cipher>', buyer_name: '<placeholder-name>',
    phone: '<placeholder-phone>', address: '<placeholder-address>', tracking_no: '<placeholder-private-tracking>' };
  s.orders.sync[0]!.last_cursor = '<placeholder-private-cursor>';
  for (const row of [s, s.authorization, s.products, ...s.products.products, ...s.products.skus,
    ...s.products.warehouses, ...s.products.inventory, ...s.products.sync, s.orders, ...s.orders.orders,
    ...s.orders.packages, ...s.orders.tracking, ...s.orders.sync, s.inventory_risk,
    s.inventory_risk.window, ...s.inventory_risk.out_of_stock]) Object.assign(row, extras);
  const r = inspect(s), output = JSON.stringify(r);
  for (const text of [...Object.keys(extras), ...Object.values(extras), 'buyer_ref', 'tracking_ref',
    'last_cursor', '<placeholder-private-cursor>', '<placeholder-title>', '<placeholder-buyer>',
    '<placeholder-tracking>', '<placeholder-in-transit>', 'total_amount', 'shopCode']) assert.ok(!output.includes(text), text);
  for (const row of [...r.stock, ...r.order_timeouts, ...r.authorization]) {
    assert.deepEqual(Object.keys(row).sort(), ['shop_id', 'type', 'entity_type', 'entity_id', 'trigger_value', 'threshold'].sort());
  }
});

test('T7 pure run accepts frozen input, is repeatable and returns independent results without writes', () => {
  const s = moving(); s.products.inventory[0]!.quantity = 0; refresh(s); s.authorization.status = 'expired';
  const before = structuredClone(s), ids = [A];
  function freeze(value: unknown) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  }
  freeze(s); freeze(ids);
  const first = runInspection(ids, [s], NOW), second = runInspection(ids, [s], NOW);
  assert.deepEqual(first, second); assert.deepEqual(s, before); assert.deepEqual(ids, [A]);
  first.shop_ids.push(B); first.stock[0]!.trigger_value = 999;
  assert.deepEqual(runInspection(ids, [s], NOW), second); assert.deepEqual(s, before);
});
