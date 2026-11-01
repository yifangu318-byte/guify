import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Result } from '../src/tiktok/client.js';
import { emptySnapshot, orderResources, orderStatuses, type OrderSnapshot } from '../src/orders/models.js';
import { MemoryOrderRepository, type OrderRepository } from '../src/orders/repository.js';
import { OrderQueries } from '../src/orders/service.js';
import { MemoryOrderSyncSource, OrderSync, OrderReconciliation, type OrderSyncSource,
  type SimulationOrderEvent } from '../src/orders/sync.js';
import { detectTimeoutAlerts, defaultTimeoutThresholds, type TimeoutThresholds } from '../src/orders/alerts.js';

// All identities, money, quantities, timestamps and sensitive test values are synthetic.
const A = 'placeholder-shop-a', B = 'placeholder-shop-b', HOUR = 3_600_000;
const ORDER = 'placeholder-order', PARCEL = 'placeholder-package';
function seed(shop_id = A): OrderSnapshot {
  return { ...emptySnapshot(shop_id),
    orders: [{ shop_id, order_id: ORDER, buyer_ref: '<placeholder-buyer>', total_amount: '2.00',
      currency: 'TST', status: 'pending_shipment', created_at: 1000, order_time: 1000, updated_at: null }],
    items: [{ shop_id, order_id: ORDER, item_id: 'placeholder-item', sku_id: 'placeholder-sku', quantity: 2, unit_price: '1.00' }],
    packages: [{ shop_id, order_id: ORDER, package_id: PARCEL, tracking_ref: '<placeholder-tracking>',
      status: 'pending_shipment', shipped_at: null }],
    tracking: [],
  };
}
function moving(shop_id = A): OrderSnapshot {
  const s = seed(shop_id); s.orders[0]!.status = 'shipped';
  Object.assign(s.packages[0]!, { status: 'in_transit', shipped_at: 1000 });
  s.tracking = [{ shop_id, package_id: PARCEL, event_id: 'placeholder-event', occurred_at: 2000,
    status_description: '<placeholder-in-transit>' }];
  return s;
}
function data<T>(r: Result<T>): T {
  assert.equal(r.error, false); if (r.error) throw new Error('Expected success'); return r.data;
}
const queryFailure = { error: true, code: 'ORDER_QUERY_FAILED', message: 'Order query failed' };
const syncFailure = { error: true, code: 'ORDER_SYNC_FAILED', message: 'Order simulation sync failed' };
const invalidRequest = { error: true, code: 'INVALID_REQUEST', message: 'Invalid request' };
const failingSource: OrderSyncSource = { source: 'simulation', readSnapshot: async () => { throw new Error('<placeholder-private-error>'); } };
function replacement(snapshot: OrderSnapshot): OrderRepository {
  return { getSnapshot: async () => snapshot, replaceSnapshot: async () => {} };
}

test('T5 simulated sync isolates identical order and package IDs in two shops', async () => {
  const a = seed(), b = moving(B), repo = new MemoryOrderRepository();
  b.orders[0]!.total_amount = '3.00'; b.items[0]!.quantity = 3;
  const sync = new OrderSync(repo, new MemoryOrderSyncSource([a, b]), { now: () => 3000 });
  const q = new OrderQueries(repo);
  for (const s of [a, b]) {
    const snapshot = data(await sync.syncShop(s.shop_id));
    assert.equal(snapshot.source, 'simulation');
    assert.deepEqual(data(await q.listOrders(s.shop_id)), s.orders);
    assert.deepEqual(data(await q.getOrder(s.shop_id, ORDER)), { shop_id: s.shop_id, source: 'simulation',
      order: s.orders[0], items: s.items, packages: s.packages });
    assert.deepEqual(data(await q.listPackages(s.shop_id)), s.packages);
    assert.deepEqual(data(await q.listTracking(s.shop_id, PARCEL)), s.tracking);
    assert.ok(snapshot.sync.every(row => row.shop_id === s.shop_id && row.last_success_at === 3000));
  }
  assert.equal(data(await q.listOrders(A))[0]!.status, 'pending_shipment');
  assert.equal(data(await q.listOrders(B))[0]!.status, 'shipped');
});

test('T5 detail filters items and packages by order within the same shop', async () => {
  const s = seed(), other = 'placeholder-order-other';
  s.orders.push({ ...s.orders[0]!, order_id: other });
  s.items.push({ ...s.items[0]!, order_id: other }); // Item IDs are scoped to an order.
  s.packages.push({ ...s.packages[0]!, order_id: other, package_id: 'placeholder-package-other' });
  const q = new OrderQueries(new MemoryOrderRepository([s]));
  const detail = data(await q.getOrder(A, ORDER));
  assert.equal(detail.items.length, 1); assert.equal(detail.packages.length, 1);
  assert.ok([...detail.items, ...detail.packages].every(row => row.order_id === ORDER));
  assert.equal(data(await q.getOrder(A, other)).packages[0]!.package_id, 'placeholder-package-other');
});

test('T5 all rows and parent references must belong to the same shop', () => {
  const corruptions = [
    (s: OrderSnapshot) => { s.shop_id = B; },
    ...(['orders', 'items', 'packages', 'sync'] as const).map(field => (s: OrderSnapshot) => { s[field][0]!.shop_id = B; }),
    (s: OrderSnapshot) => { s.tracking[0]!.shop_id = B; },
    (s: OrderSnapshot) => { s.items[0]!.order_id = 'placeholder-missing'; },
    (s: OrderSnapshot) => { s.packages[0]!.order_id = 'placeholder-missing'; },
    (s: OrderSnapshot) => { s.tracking[0]!.package_id = 'placeholder-missing'; },
  ];
  for (const corrupt of corruptions) {
    const s = moving(); corrupt(s);
    assert.throws(() => new MemoryOrderRepository([moving(B), s]), /Invalid order snapshot/);
  }
});

test('T5 duplicate identities fail while separate shops may reuse external IDs', () => {
  for (const field of ['orders', 'items', 'packages', 'tracking', 'sync'] as const) {
    const s = moving(); s[field].push({ ...s[field][0]! } as never);
    assert.throws(() => new MemoryOrderRepository([s]));
  }
  assert.throws(() => new MemoryOrderRepository([seed(), seed()]), /Duplicate order shop/);
  assert.doesNotThrow(() => new MemoryOrderRepository([seed(), seed(B)]));
});

test('T5 monetary values retain decimal text including precision beyond float range', async () => {
  for (const amount of ['0', '0.00', '1.20', '9007199254740993.123456789']) {
    const s = seed(); s.orders[0]!.total_amount = amount; s.items[0]!.unit_price = amount;
    const d = data(await new OrderQueries(new MemoryOrderRepository([s])).getOrder(A, ORDER));
    assert.equal(d.order.total_amount, amount); assert.equal(d.items[0]!.unit_price, amount);
  }
});

test('T5 monetary validation rejects floats, signs, exponents, whitespace and malformed text', () => {
  for (const amount of [1, -1, NaN, null, '', '-1.00', '+1.00', '1e2', '.50', '01.00', '1.', ' 1.00', '1.2.3']) {
    for (const field of ['total_amount', 'unit_price']) {
      const s = seed(); Object.assign(field === 'total_amount' ? s.orders[0]! : s.items[0]!, { [field]: amount });
      assert.throws(() => new MemoryOrderRepository([s]), /Invalid order snapshot/);
    }
  }
});

test('T5 item quantities require positive safe integers', () => {
  for (const quantity of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2', null]) {
    const s = seed(); Object.assign(s.items[0]!, { quantity }); assert.throws(() => new MemoryOrderRepository([s]));
  }
  for (const quantity of [1, 2, Number.MAX_SAFE_INTEGER]) {
    const s = seed(); s.items[0]!.quantity = quantity; assert.doesNotThrow(() => new MemoryOrderRepository([s]));
  }
});

test('T5 invalid timestamps, statuses and nested scalar shapes fail validation', () => {
  const corruptions = [
    (s: OrderSnapshot) => { s.orders[0]!.created_at = -1; },
    (s: OrderSnapshot) => { s.orders[0]!.order_time = Infinity; },
    (s: OrderSnapshot) => { s.orders[0]!.updated_at = 0.5; },
    (s: OrderSnapshot) => { s.packages[0]!.shipped_at = NaN; },
    (s: OrderSnapshot) => { s.tracking[0]!.occurred_at = Number.MAX_SAFE_INTEGER + 1; },
    (s: OrderSnapshot) => { Object.assign(s.orders[0]!, { status: '<placeholder-private>' }); },
    (s: OrderSnapshot) => { Object.assign(s.packages[0]!, { status: '<placeholder-private>' }); },
    (s: OrderSnapshot) => { Object.assign(s.items[0]!, { sku_id: { access_token: '<placeholder-access>' } }); },
    (s: OrderSnapshot) => { Object.assign(s.orders[0]!, { currency: [] }); },
  ];
  for (const corrupt of corruptions) { const s = moving(); corrupt(s); assert.throws(() => new MemoryOrderRepository([s])); }
});

test('T5 buyer, tracking reference and description fields only accept placeholders', async () => {
  for (const field of ['buyer_ref', 'tracking_ref', 'status_description']) {
    const s = moving();
    const row = field === 'buyer_ref' ? s.orders[0]! : field === 'tracking_ref' ? s.packages[0]! : s.tracking[0]!;
    Object.assign(row, { [field]: 'synthetic-non-placeholder-sensitive-value' });
    assert.throws(() => new MemoryOrderRepository([s]));
    assert.deepEqual(await new OrderQueries(replacement(s)).listOrders(A), queryFailure);
  }
  const s = seed(); s.packages[0]!.tracking_ref = null;
  assert.equal(data(await new OrderQueries(new MemoryOrderRepository([s])).listPackages(A))[0]!.tracking_ref, null);
});

test('T5 pending shipment boundaries before, exactly at and after threshold', () => {
  const s = seed(), boundary = 1000 + 2 * HOUR;
  assert.deepEqual(detectTimeoutAlerts(A, s, boundary - 1, { pendingShipmentHours: 2 }), []);
  assert.deepEqual(detectTimeoutAlerts(A, s, boundary, { pendingShipmentHours: 2 }), []);
  assert.deepEqual(detectTimeoutAlerts(A, s, boundary + 1, { pendingShipmentHours: 2 }), [{
    shop_id: A, order_id: ORDER, type: 'pending_shipment_timeout', triggered_at: boundary + 1, threshold_hours: 2,
  }]);
});

test('T5 pending timeout uses order_time rather than ingestion or update time', () => {
  const s = seed(); s.orders[0]!.created_at = 10 * HOUR; s.orders[0]!.updated_at = 20 * HOUR;
  assert.equal(detectTimeoutAlerts(A, s, 3 * HOUR, { pendingShipmentHours: 2 }).length, 1);
});

test('T5 only pending_shipment orders produce a pending timeout', () => {
  const s = seed();
  for (const status of orderStatuses) {
    s.orders[0]!.status = status;
    assert.equal(detectTimeoutAlerts(A, s, 100 * HOUR).length, status === 'pending_shipment' ? 1 : 0);
  }
});

test('T5 explicit defaults are 48 shipment hours and 72 stalled hours', () => {
  assert.deepEqual(defaultTimeoutThresholds, { pendingShipmentHours: 48, logisticsStalledHours: 72 });
  assert.deepEqual(detectTimeoutAlerts(A, seed(), 1000 + 48 * HOUR), []);
  assert.equal(detectTimeoutAlerts(A, seed(), 1001 + 48 * HOUR)[0]!.threshold_hours, 48);
  assert.deepEqual(detectTimeoutAlerts(A, moving(), 2000 + 72 * HOUR), []);
  assert.equal(detectTimeoutAlerts(A, moving(), 2001 + 72 * HOUR)[0]!.threshold_hours, 72);
});

test('T5 logistics uses latest unordered event and strict threshold boundaries', async () => {
  const s = moving(); s.tracking.push({ ...s.tracking[0]!, event_id: 'placeholder-older', occurred_at: 1500 });
  const q = new OrderQueries(new MemoryOrderRepository([s]));
  assert.deepEqual(data(await q.listTracking(A, PARCEL)).map(e => e.occurred_at), [1500, 2000]);
  const boundary = 2000 + 3 * HOUR;
  for (const now of [boundary - 1, boundary]) assert.deepEqual(detectTimeoutAlerts(A, s, now, { logisticsStalledHours: 3 }), []);
  assert.deepEqual(detectTimeoutAlerts(A, s, boundary + 1, { logisticsStalledHours: 3 }), [{
    shop_id: A, order_id: ORDER, package_id: PARCEL, type: 'logistics_stalled',
    triggered_at: boundary + 1, threshold_hours: 3,
  }]);
});

test('T5 another package fresh event cannot mask a stalled package', () => {
  const s = moving();
  s.packages.push({ ...s.packages[0]!, package_id: 'placeholder-fresh-package' });
  s.tracking.push({ ...s.tracking[0]!, package_id: 'placeholder-fresh-package', occurred_at: 3 * HOUR });
  const alerts = detectTimeoutAlerts(A, s, 3 * HOUR, { logisticsStalledHours: 2 });
  assert.deepEqual(alerts.map(a => a.type === 'logistics_stalled' && a.package_id), [PARCEL]);
});

test('T5 missing events fall back to shipped_at while unknown shipment time stays unknown', () => {
  const s = moving(); s.tracking = [];
  assert.deepEqual(detectTimeoutAlerts(A, s, 1000 + 2 * HOUR, { logisticsStalledHours: 2 }), []);
  assert.equal(detectTimeoutAlerts(A, s, 1001 + 2 * HOUR, { logisticsStalledHours: 2 }).length, 1);
  s.packages[0]!.shipped_at = null;
  assert.deepEqual(detectTimeoutAlerts(A, s, 100 * HOUR), []);
});

test('T5 delivered, cancelled and unshipped packages do not produce logistics alerts', () => {
  for (const status of ['pending_shipment', 'delivered', 'cancelled'] as const) {
    const s = moving(); s.packages[0]!.status = status; assert.deepEqual(detectTimeoutAlerts(A, s, 100 * HOUR), []);
  }
  for (const status of ['delivered', 'cancelled'] as const) {
    const s = moving(); s.orders[0]!.status = status; assert.deepEqual(detectTimeoutAlerts(A, s, 100 * HOUR), []);
  }
});

test('T5 future order or tracking timestamps do not cause false timeout alerts', () => {
  const s = seed(); s.orders[0]!.order_time = 100 * HOUR;
  assert.deepEqual(detectTimeoutAlerts(A, s, 10 * HOUR), []);
  const m = moving(); m.tracking[0]!.occurred_at = 100 * HOUR;
  assert.deepEqual(detectTimeoutAlerts(A, m, 10 * HOUR), []);
});

test('T5 invalid thresholds and clocks fail safely in pure and query APIs', async () => {
  const s = seed(), q = new OrderQueries(new MemoryOrderRepository([s]));
  for (const value of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, '2', null, undefined]) {
    for (const key of ['pendingShipmentHours', 'logisticsStalledHours']) {
      const settings = { [key]: value } as Partial<TimeoutThresholds>;
      assert.throws(() => detectTimeoutAlerts(A, s, 1000, settings), /Invalid timeout thresholds/);
      assert.deepEqual(await q.getTimeoutAlerts(A, 1000, settings), invalidRequest);
      assert.deepEqual(await q.summarizeTimeoutAlerts([], 1000, settings), invalidRequest);
    }
  }
  for (const now of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => detectTimeoutAlerts(A, s, now), /Invalid timeout clock/);
    assert.deepEqual(await q.getTimeoutAlerts(A, now), invalidRequest);
  }
});

test('T5 pure detector never mutates inputs and rejects mixed shop scope', () => {
  const s = moving(), before = structuredClone(s), settings = Object.freeze({ logisticsStalledHours: 1 });
  const first = detectTimeoutAlerts(A, s, 10 * HOUR, settings);
  assert.deepEqual(detectTimeoutAlerts(A, s, 10 * HOUR, settings), first);
  assert.deepEqual(s, before); assert.throws(() => detectTimeoutAlerts(B, s, 10 * HOUR));
  assert.deepEqual(detectTimeoutAlerts(A, emptySnapshot(A), 10 * HOUR), []);
});

test('T5 cross-shop snapshots require explicit sets and label every nested record', async () => {
  const q = new OrderQueries(new MemoryOrderRepository([seed(), moving(B)]));
  assert.deepEqual(data(await q.summarize([])), []);
  const snapshots = data(await q.summarize([B, A, B]));
  assert.deepEqual(snapshots.map(s => s.shop_id), [B, A]);
  for (const s of snapshots) for (const rows of [s.orders, s.items, s.packages, s.tracking, s.sync]) {
    assert.ok(rows.every(row => row.shop_id === s.shop_id));
  }
});

test('T5 cross-shop alert aggregation labels shop and deduplicates explicit scope', async () => {
  const q = new OrderQueries(new MemoryOrderRepository([seed(), moving(B)]));
  assert.deepEqual(data(await q.summarizeTimeoutAlerts([], 100 * HOUR)), []);
  const alerts = data(await q.summarizeTimeoutAlerts([B, A, B], 100 * HOUR));
  assert.deepEqual(alerts.map(a => [a.shop_id, a.type]), [[B, 'logistics_stalled'], [A, 'pending_shipment_timeout']]);
  assert.deepEqual(data(await q.summarizeTimeoutAlerts([A], 100 * HOUR)), [alerts[1]]);
});

test('T5 invalid or absent scope, missing entities and partial summaries return fixed errors', async () => {
  const q = new OrderQueries(new MemoryOrderRepository([seed()]));
  for (const scope of [undefined, null, 'all', [''], [A, null]]) {
    assert.deepEqual(await q.summarize(scope as string[]), invalidRequest);
    assert.deepEqual(await q.summarizeTimeoutAlerts(scope as string[], 100 * HOUR), invalidRequest);
  }
  for (const r of [await q.listOrders(''), await q.getOrder(A, ''), await q.listTracking(A, ''), await q.getTimeoutAlerts('', 1)]) {
    assert.deepEqual(r, invalidRequest);
  }
  assert.deepEqual(await q.listOrders(B), { error: true, code: 'SHOP_NOT_FOUND', message: 'Simulation shop not found' });
  assert.deepEqual(await q.getOrder(A, 'placeholder-missing'), { error: true, code: 'ORDER_NOT_FOUND', message: 'Order not found' });
  assert.deepEqual(await q.listTracking(A, 'placeholder-missing'), { error: true, code: 'PACKAGE_NOT_FOUND', message: 'Package not found' });
  assert.equal((await q.summarize([A, B])).error, true);
  assert.equal((await q.summarizeTimeoutAlerts([A, B], 100 * HOUR)).error, true);
});

test('T5 caller mutation during await cannot expand scope or change thresholds', async () => {
  const q = new OrderQueries(new MemoryOrderRepository([seed(), seed(B)]));
  const ids = [A], thresholds = { pendingShipmentHours: 1 };
  const pending = q.summarizeTimeoutAlerts(ids, 3 * HOUR, thresholds);
  ids.push(B); thresholds.pendingShipmentHours = 10;
  const alerts = data(await pending);
  assert.deepEqual(alerts.map(a => [a.shop_id, a.threshold_hours]), [[A, 1]]);
});

test('T5 SyncState preserves nullable metadata and fills missing resource states', async () => {
  const s = seed(); s.sync = [{ shop_id: A, resource: null, last_success_at: null, last_cursor: null, last_error: null }];
  const states = data(await new OrderQueries(new MemoryOrderRepository([s])).getSyncStates(A));
  assert.deepEqual(states.slice(0, 4), emptySnapshot(A).sync); assert.deepEqual(states[4], s.sync[0]);
  s.sync = []; assert.deepEqual((await new MemoryOrderRepository([s]).getSnapshot(A))!.sync, emptySnapshot(A).sync);
});

test('T5 malformed sync metadata and unsafe error strings fail at service boundary', async () => {
  const corruptions = [
    (s: OrderSnapshot) => { s.sync[0]!.resource = 'placeholder-unsupported'; },
    (s: OrderSnapshot) => { s.sync[0]!.last_success_at = -1; },
    (s: OrderSnapshot) => { Object.assign(s.sync[0]!, { last_error: '<placeholder-private-error>' }); },
    (s: OrderSnapshot) => { Object.assign(s.sync[0]!, { last_cursor: { access_token: '<placeholder-access>' } }); },
    (s: OrderSnapshot) => { s.sync.push({ ...s.sync[0]! }); },
  ];
  for (const corrupt of corruptions) {
    const s = seed(); corrupt(s); assert.throws(() => new MemoryOrderRepository([s]));
    assert.deepEqual(await new OrderQueries(replacement(s)).getSyncStates(A), queryFailure);
  }
});

test('T5 full sync replaces stale resources, sets success times and preserves cursors', async () => {
  const repo = new MemoryOrderRepository([moving(), seed(B)]), next = emptySnapshot(A);
  next.sync.forEach(s => { s.last_cursor = '<placeholder-cursor>'; s.last_error = 'SYNC_FAILED'; });
  const result = data(await new OrderSync(repo, new MemoryOrderSyncSource([next]), { now: () => 4000 }).syncShop(A));
  assert.deepEqual(result.orders, []); assert.deepEqual(result.items, []); assert.deepEqual(result.packages, []); assert.deepEqual(result.tracking, []);
  assert.deepEqual(result.sync, orderResources.map(resource => ({ shop_id: A, resource,
    last_success_at: 4000, last_cursor: '<placeholder-cursor>', last_error: null })));
  assert.deepEqual(await repo.getSnapshot(A), result); assert.deepEqual(await repo.getSnapshot(B), seed(B));
});

test('T5 failed sync retains prior data, cursor and success time using fixed error category', async () => {
  const old = moving(); old.sync.forEach(s => { s.last_success_at = 900; s.last_cursor = '<placeholder-cursor>'; });
  const repo = new MemoryOrderRepository([old, seed(B)]);
  assert.deepEqual(await new OrderSync(repo, failingSource).syncShop(A), syncFailure);
  const current = (await repo.getSnapshot(A))!;
  assert.deepEqual({ ...current, sync: old.sync }, old);
  assert.ok(current.sync.every(s => s.last_success_at === 900 && s.last_cursor === '<placeholder-cursor>' && s.last_error === 'SYNC_FAILED'));
  assert.deepEqual(await repo.getSnapshot(B), seed(B));
  const recovered = data(await new OrderSync(repo, new MemoryOrderSyncSource([old]), { now: () => 1000 }).syncShop(A));
  assert.ok(recovered.sync.every(s => s.last_success_at === 1000 && s.last_error === null));
});

test('T5 first sync failure exposes null last-success metadata without inventing business rows', async () => {
  const repo = new MemoryOrderRepository();
  assert.deepEqual(await new OrderSync(repo, failingSource).syncShop(A), syncFailure);
  const s = (await repo.getSnapshot(A))!;
  assert.deepEqual(s.orders, []); assert.deepEqual(s.packages, []);
  assert.ok(s.sync.every(s => s.last_success_at === null && s.last_cursor === null && s.last_error === 'SYNC_FAILED'));
});

test('T5 sync rejects wrong shop, non-simulation sources, broken relationships and invalid clocks', async () => {
  const malformed = moving(); malformed.tracking[0]!.package_id = 'placeholder-missing';
  for (const source of [
    new MemoryOrderSyncSource([seed(B)]),
    { source: 'simulation' as const, readSnapshot: async () => seed(B) },
    { source: 'simulation' as const, readSnapshot: async () => malformed },
    { source: 'real' as 'simulation', readSnapshot: async () => seed() },
  ]) {
    const repo = new MemoryOrderRepository([seed()]);
    assert.deepEqual(await new OrderSync(repo, source).syncShop(A), syncFailure);
    assert.deepEqual((await repo.getSnapshot(A))!.orders, seed().orders);
  }
  for (const now of [-1, 0.5, NaN, Infinity]) {
    assert.deepEqual(await new OrderSync(new MemoryOrderRepository(), new MemoryOrderSyncSource([seed()]), { now: () => now }).syncShop(A), syncFailure);
  }
});

test('T5 replacement repository scope and relationship violations fail across query methods', async () => {
  for (const corrupt of [
    (s: OrderSnapshot) => { s.shop_id = B; },
    (s: OrderSnapshot) => { s.items[0]!.order_id = 'placeholder-missing'; },
    (s: OrderSnapshot) => { s.packages[0]!.shop_id = B; },
    (s: OrderSnapshot) => { s.tracking[0]!.package_id = 'placeholder-missing'; },
  ]) {
    const s = moving(); corrupt(s); const q = new OrderQueries(replacement(s));
    for (const result of [await q.listOrders(A), await q.getOrder(A, ORDER), await q.listPackages(A),
      await q.listTracking(A, PARCEL), await q.getSyncStates(A), await q.getTimeoutAlerts(A, 100 * HOUR),
      await q.summarize([A]), await q.summarizeTimeoutAlerts([A], 100 * HOUR)]) assert.deepEqual(result, queryFailure);
  }
});

test('T5 sensitive extras never enter storage, sources, queries, sync results or alerts', async () => {
  const s = moving();
  const sensitive = { buyer_name: '<placeholder-private-name>', phone: '<placeholder-private-phone>',
    address: '<placeholder-private-address>', tracking_no: '<placeholder-private-tracking>',
    access_token: '<placeholder-access>', app_secret: '<placeholder-secret>',
    refresh_token: '<placeholder-refresh>', shop_cipher: '<placeholder-cipher>' };
  for (const row of [s, ...s.orders, ...s.items, ...s.packages, ...s.tracking, ...s.sync]) Object.assign(row, sensitive);
  const repo = new MemoryOrderRepository([s]), source = new MemoryOrderSyncSource([s]);
  const q = new OrderQueries(replacement(s));
  const output = JSON.stringify([await repo.getSnapshot(A), await source.readSnapshot(A),
    await new OrderSync(repo, { source: 'simulation', readSnapshot: async () => s }).syncShop(A),
    await q.getOrder(A, ORDER), await q.listTracking(A, PARCEL), await q.summarize([A]),
    await q.getTimeoutAlerts(A, 100 * HOUR), detectTimeoutAlerts(A, s, 100 * HOUR)]);
  for (const text of [...Object.keys(sensitive), ...Object.values(sensitive)]) assert.ok(!output.includes(text), text);
  const alert = detectTimeoutAlerts(A, s, 100 * HOUR)[0]!;
  assert.deepEqual(Object.keys(alert).sort(), ['shop_id', 'order_id', 'package_id', 'type', 'triggered_at', 'threshold_hours'].sort());
  const pending = detectTimeoutAlerts(A, seed(), 100 * HOUR)[0]!;
  assert.deepEqual(Object.keys(pending).sort(), ['shop_id', 'order_id', 'type', 'triggered_at', 'threshold_hours'].sort());
  for (const value of ['<placeholder-buyer>', '<placeholder-tracking>', '<placeholder-in-transit>', 'total_amount', 'unit_price']) {
    assert.ok(!JSON.stringify([alert, pending]).includes(value));
  }
});

test('T5 repository and source exceptions return fixed envelopes without raw error text', async () => {
  const repo: OrderRepository = { getSnapshot: async () => { throw new Error('<placeholder-private-error>'); },
    replaceSnapshot: async () => { throw new Error('<placeholder-access>'); } };
  assert.deepEqual(await new OrderQueries(repo).listOrders(A), queryFailure);
  assert.deepEqual(await new OrderSync(repo, failingSource).syncShop(A), syncFailure);
  assert.deepEqual(await new OrderSync({ getSnapshot: async () => seed(), replaceSnapshot: repo.replaceSnapshot },
    new MemoryOrderSyncSource([seed()])).syncShop(A), syncFailure);
  assert.deepEqual(await new OrderSync(repo, failingSource).syncShop(''), invalidRequest);
});

test('T5 memory repository, source, query and sync results all return defensive copies', async () => {
  const s = moving(), repo = new MemoryOrderRepository([s]), source = new MemoryOrderSyncSource([s]);
  s.orders[0]!.total_amount = '9.00'; s.tracking[0]!.occurred_at = 9000;
  (await repo.getSnapshot(A))!.items[0]!.quantity = 9;
  (await source.readSnapshot(A)).packages[0]!.tracking_ref = '<placeholder-mutated>';
  const q = new OrderQueries(repo); data(await q.getOrder(A, ORDER)).items[0]!.quantity = 9;
  data(await q.listTracking(A, PARCEL))[0]!.occurred_at = 9000;
  assert.deepEqual(await repo.getSnapshot(A), moving()); assert.deepEqual(await source.readSnapshot(A), moving());
  const result = data(await new OrderSync(repo, source, { now: () => 3000 }).syncShop(A));
  result.orders[0]!.total_amount = '9.00'; assert.equal((await repo.getSnapshot(A))!.orders[0]!.total_amount, '2.00');
});

test('T5 invalid replacements are atomic and valid replacements copy caller data', async () => {
  const repo = new MemoryOrderRepository([seed(), seed(B)]), bad = seed(); bad.items[0]!.order_id = 'placeholder-missing';
  await assert.rejects(repo.replaceSnapshot(A, bad)); await assert.rejects(repo.replaceSnapshot(A, seed(B)));
  assert.deepEqual(await repo.getSnapshot(A), seed()); assert.deepEqual(await repo.getSnapshot(B), seed(B));
  const next = seed(); await repo.replaceSnapshot(A, next); next.items[0]!.quantity = 9;
  assert.deepEqual(await repo.getSnapshot(A), seed());
});

test('T5 same-shop synchronization serializes, other shops progress and failures release queue', async () => {
  let release!: () => void, entered!: () => void, reads = 0;
  const gate = new Promise<void>(r => { release = r; });
  const started = new Promise<void>(r => { entered = r; });
  const source: OrderSyncSource = { source: 'simulation', readSnapshot: async shop => {
    if (shop === A) {
      reads++; if (reads === 1) { entered(); await gate; throw new Error('<placeholder-private-error>'); }
    }
    return seed(shop);
  } };
  const repo = new MemoryOrderRepository(), sync = new OrderSync(repo, source, { now: () => 1000 });
  const first = sync.syncShop(A); await started;
  const second = sync.syncShop(A);
  assert.equal(data(await sync.syncShop(B)).shop_id, B); assert.equal(reads, 1);
  release(); assert.deepEqual(await first, syncFailure); data(await second);
  assert.equal(reads, 2); assert.ok((await repo.getSnapshot(A))!.sync.every(s => s.last_error === null));
});

test('T5 polling reconciles a dropped webhook including order, package and tracking status', async () => {
  let snapshot = seed(), clock = 1000;
  const repo = new MemoryOrderRepository();
  const sync = new OrderSync(repo, { source: 'simulation', readSnapshot: async () => snapshot }, { now: () => clock });
  const reconciliation = new OrderReconciliation(sync), q = new OrderQueries(repo);
  data(await reconciliation.receiveWebhook({ source: 'simulation', shop_id: A, event_id: 'placeholder-first-event', resource: 'orders' }));
  snapshot = moving(); clock = 3000; // Drop the shipping webhook entirely.
  assert.equal(data(await q.getOrder(A, ORDER)).order.status, 'pending_shipment');
  assert.deepEqual(data(await q.listTracking(A, PARCEL)), []);
  data(await reconciliation.pollShop(A));
  assert.equal(data(await q.getOrder(A, ORDER)).order.status, 'shipped');
  assert.equal(data(await q.listPackages(A))[0]!.status, 'in_transit');
  assert.deepEqual(data(await q.listTracking(A, PARCEL)), snapshot.tracking);
  assert.ok(data(await q.getSyncStates(A)).every(s => s.last_success_at === 3000));
});

test('T5 duplicate or stale webhook hints reconcile the source rather than trusting payload', async () => {
  const repo = new MemoryOrderRepository(), source = new MemoryOrderSyncSource([moving()]);
  const reconciliation = new OrderReconciliation(new OrderSync(repo, source, { now: () => 3000 }));
  const hint = { source: 'simulation' as const, shop_id: A, event_id: 'placeholder-event', resource: 'orders' as const,
    payload: { status: 'cancelled', phone: '<placeholder-private-phone>' } };
  const first = data(await reconciliation.receiveWebhook(hint));
  assert.deepEqual(data(await reconciliation.receiveWebhook(hint)), first);
  assert.equal(first.orders[0]!.status, 'shipped'); assert.equal(first.orders.length, 1); assert.equal(first.tracking.length, 1);
  assert.ok(!JSON.stringify(first).includes('<placeholder-private-phone>'));
});

test('T5 invalid webhook hints fail before reading source; failed polling preserves prior data', async () => {
  let reads = 0;
  const repo = new MemoryOrderRepository([seed()]);
  const reconciliation = new OrderReconciliation(new OrderSync(repo, { source: 'simulation', readSnapshot: async () => {
    reads++; throw new Error('<placeholder-private-error>');
  } }));
  const good: SimulationOrderEvent = { source: 'simulation', shop_id: A, event_id: 'placeholder-event', resource: 'orders' };
  for (const event of [null, { ...good, source: 'real' }, { ...good, shop_id: '' }, { ...good, event_id: '' }, { ...good, resource: 'unsupported' }]) {
    assert.deepEqual(await reconciliation.receiveWebhook(event as SimulationOrderEvent), invalidRequest);
  }
  assert.equal(reads, 0); assert.deepEqual(await reconciliation.pollShop(A), syncFailure);
  assert.equal(reads, 1); assert.deepEqual((await repo.getSnapshot(A))!.orders, seed().orders);
});
