import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptySnapshot as emptyOrders, orderStatuses, type OrderSnapshot } from '../src/orders/models.js';
import { emptySnapshot as emptyProducts, type ProductSnapshot } from '../src/products/models.js';
import { detectStockAlerts } from '../src/products/alerts.js';
import { MemoryProductRepository } from '../src/products/repository.js';
import { MemoryProductSyncSource, ProductSync } from '../src/products/sync.js';
import { MemoryOrderRepository } from '../src/orders/repository.js';
import { MemoryOrderSyncSource, OrderSync } from '../src/orders/sync.js';
import { sumDecimalAmounts } from '../src/analytics/decimal.js';
import type { AnalyticsSnapshot, AnalyticsWindow, MetricMetadata } from '../src/analytics/models.js';
import { calculateGmv, calculateShopOverview, rankBestSellingSkus, calculateInventoryRisk,
  summarizeAnalytics } from '../src/analytics/service.js';

// Every identity, timestamp, amount, unit and currency below is synthetic.
const A = 'placeholder-shop-a', B = 'placeholder-shop-b';
const WINDOW = Object.freeze({ start_at: 1000, end_at: 2000 }), NOW = 3000;
function orders(shop_id = A): OrderSnapshot {
  return { ...emptyOrders(shop_id),
    orders: [{ shop_id, order_id: 'placeholder-order', buyer_ref: '<placeholder-buyer>',
      total_amount: '0.10', currency: 'TST', status: 'pending_shipment',
      order_time: 1000, created_at: 1000, updated_at: null }],
    items: [{ shop_id, order_id: 'placeholder-order', item_id: 'placeholder-item',
      sku_id: 'placeholder-sku', quantity: 2, unit_price: '0.05' }],
  };
}
function addOrder(s: OrderSnapshot, id: string, time: number, amount = '0.20',
  status: OrderSnapshot['orders'][number]['status'] = 'delivered') {
  s.orders.push({ ...s.orders[0]!, order_id: id, order_time: time, total_amount: amount, status });
  s.items.push({ ...s.items[0]!, order_id: id });
}
function products(shop_id = A): ProductSnapshot {
  return { ...emptyProducts(shop_id),
    products: [{ shop_id, product_id: 'placeholder-product', title: '<placeholder-title>',
      status: 'placeholder-active', category: null, updated_at: null }],
    skus: [{ shop_id, product_id: 'placeholder-product', sku_id: 'placeholder-sku',
      price: '0.05', currency: 'TST', status: 'placeholder-active' }],
    warehouses: [{ shop_id, warehouse_id: 'placeholder-warehouse', name: '<placeholder-warehouse>', warehouse_type: 'regular' }],
    inventory: [{ shop_id, sku_id: 'placeholder-sku', warehouse_id: 'placeholder-warehouse', quantity: 0, updated_at: null }],
  };
}
function snapshot(shop_id = A): AnalyticsSnapshot { return { shop_id, products: products(shop_id), orders: orders(shop_id) }; }
function metadata(metric: MetricMetadata, shop_id = A) {
  assert.equal(metric.source, 'simulation'); assert.equal(metric.shop_id, shop_id);
  assert.deepEqual(metric.window, WINDOW); assert.equal(metric.calculated_at, NOW);
}

test('T6 per-shop overview counts orders, delivered and pending shipment with exact GMV', () => {
  const s = orders(); addOrder(s, 'placeholder-second', 1500);
  addOrder(s, 'placeholder-third', 1600, '0.30', 'shipped');
  const result = calculateShopOverview(A, s, WINDOW, NOW);
  assert.equal(result.order_count, 3); assert.equal(result.delivered_order_count, 1);
  assert.equal(result.pending_shipment_order_count, 1); assert.equal(result.gmv.total_amount, '0.60');
});

test('T6 window includes start and excludes end for orders, GMV and SKU units', () => {
  const s = orders(); addOrder(s, 'placeholder-before', 999, '9.00');
  addOrder(s, 'placeholder-last', 1999, '0.20');
  addOrder(s, 'placeholder-end', 2000, '9.00'); addOrder(s, 'placeholder-after', 2001, '9.00');
  const result = calculateShopOverview(A, s, WINDOW, NOW);
  assert.equal(result.order_count, 2); assert.equal(result.gmv.total_amount, '0.30');
  assert.equal(result.delivered_order_count, 1);
  assert.deepEqual(rankBestSellingSkus(A, s, WINDOW, NOW).items,
    [{ shop_id: A, sku_id: 'placeholder-sku', quantity: 4 }]);
});

test('T6 adjoining windows do not double-count their shared boundary', () => {
  const s = orders(); addOrder(s, 'placeholder-boundary', 2000, '0.20');
  const first = calculateShopOverview(A, s, WINDOW, NOW);
  const second = calculateShopOverview(A, s, { start_at: 2000, end_at: 3000 }, NOW);
  assert.equal(first.order_count, 1); assert.equal(second.order_count, 1);
  assert.equal(first.gmv.total_amount, '0.10'); assert.equal(second.gmv.total_amount, '0.20');
});

test('T6 time selection uses order_time rather than creation or update time', () => {
  const s = orders(); s.orders[0]!.created_at = 9999; s.orders[0]!.updated_at = 9999;
  assert.equal(calculateShopOverview(A, s, WINDOW, NOW).order_count, 1);
  s.orders[0]!.order_time = 2000; s.orders[0]!.created_at = 1000;
  assert.equal(calculateShopOverview(A, s, WINDOW, NOW).order_count, 0);
});

test('T6 raw simulation GMV and ranking explicitly include every T5 order status', () => {
  const s = orders();
  for (const status of orderStatuses) {
    s.orders[0]!.status = status;
    const result = calculateShopOverview(A, s, WINDOW, NOW);
    assert.equal(result.order_count, 1); assert.equal(result.gmv.total_amount, '0.10');
    assert.equal(result.delivered_order_count, status === 'delivered' ? 1 : 0);
    assert.equal(result.pending_shipment_order_count, status === 'pending_shipment' ? 1 : 0);
    assert.equal(rankBestSellingSkus(A, s, WINDOW, NOW).items[0]!.quantity, 2);
  }
});

test('T6 decimal GMV adds 0.10 and 0.20 without floating point loss', () => {
  const s = orders(); addOrder(s, 'placeholder-second', 1100);
  assert.equal(calculateGmv(A, s, WINDOW, NOW).total_amount, '0.30');
});

test('T6 GMV preserves arbitrary scale and amounts beyond Number precision', () => {
  const s = orders(); s.orders[0]!.total_amount = '9007199254740993.123456789';
  addOrder(s, 'placeholder-second', 1100, '0.000000011');
  addOrder(s, 'placeholder-third', 1200, '2');
  assert.equal(calculateGmv(A, s, WINDOW, NOW).total_amount, '9007199254740995.123456800');
});

test('T6 decimal helper handles empty input, varying scale, carry and row order', () => {
  assert.equal(sumDecimalAmounts([]), '0');
  assert.equal(sumDecimalAmounts(['0.009', '0.001']), '0.010');
  assert.equal(sumDecimalAmounts(['999.99', '0.01']), '1000.00');
  for (const values of [['1', '0.20', '0.003'], ['0.003', '1', '0.20']]) {
    assert.equal(sumDecimalAmounts(values), '1.203');
  }
});

test('T6 decimal helper rejects numeric money and invalid decimal text', () => {
  for (const amount of [0.1, NaN, null, '-1', '1e2', '01.0', '1.', '.1', ' 1']) {
    assert.throws(() => sumDecimalAmounts([amount as string]), { message: 'Invalid analytics amount' });
  }
});

test('T6 mixed currencies remain separate and never produce a fictitious scalar sum', () => {
  const s = orders(); addOrder(s, 'placeholder-second', 1100, '0.20');
  s.orders[1]!.currency = 'SIM'; addOrder(s, 'placeholder-third', 1200, '0.30');
  const gmv = calculateGmv(A, s, WINDOW, NOW);
  assert.equal(gmv.total_amount, null);
  assert.deepEqual(gmv.by_currency, [
    { shop_id: A, currency: 'SIM', total_amount: '0.20' },
    { shop_id: A, currency: 'TST', total_amount: '0.40' },
  ]);
  assert.deepEqual(calculateShopOverview(A, s, WINDOW, NOW).gmv, gmv);
});

test('T6 hot SKU ranking sums units across orders rather than counting lines', () => {
  const s = orders(); addOrder(s, 'placeholder-second', 1200);
  s.items[1]!.quantity = 5;
  s.items.push({ ...s.items[0]!, item_id: 'placeholder-other-item', sku_id: 'placeholder-other-sku', quantity: 6 });
  assert.deepEqual(rankBestSellingSkus(A, s, WINDOW, NOW).items, [
    { shop_id: A, sku_id: 'placeholder-sku', quantity: 7 },
    { shop_id: A, sku_id: 'placeholder-other-sku', quantity: 6 },
  ]);
});

test('T6 tied hot SKUs use ascending identifiers regardless of input order', () => {
  const s = orders(); s.items = ['placeholder-sku-z', 'placeholder-sku-a', 'placeholder-sku-A']
    .map((sku_id, i) => ({ ...s.items[0]!, sku_id, item_id: 'placeholder-item-' + i }));
  const expected = ['placeholder-sku-A', 'placeholder-sku-a', 'placeholder-sku-z'];
  assert.deepEqual(rankBestSellingSkus(A, s, WINDOW, NOW).items.map(i => i.sku_id), expected);
  s.items.reverse();
  assert.deepEqual(rankBestSellingSkus(A, s, WINDOW, NOW).items.map(i => i.sku_id), expected);
});

test('T6 hot SKU quantities fail explicitly on unsafe integer overflow', () => {
  const s = orders(); s.items[0]!.quantity = Number.MAX_SAFE_INTEGER;
  s.items.push({ ...s.items[0]!, item_id: 'placeholder-second-item', quantity: 1 });
  assert.throws(() => rankBestSellingSkus(A, s, WINDOW, NOW), { message: 'Analytics quantity overflow' });
});

test('T6 inventory risks match T4 at zero, below, equal and above threshold', () => {
  const s = products();
  for (const quantity of [0, 1, 2, 3]) {
    s.inventory[0]!.quantity = quantity;
    const result = calculateInventoryRisk(A, s, WINDOW, NOW, 2);
    assert.deepEqual([...result.out_of_stock, ...result.low_stock], detectStockAlerts(A, s.inventory, 2));
    assert.equal(result.out_of_stock.length, quantity === 0 ? 1 : 0);
    assert.equal(result.low_stock.length, quantity === 1 ? 1 : 0);
  }
});

test('T6 inventory keeps per-warehouse risk without pooling or inventing missing stock', () => {
  const s = products();
  s.warehouses.push({ ...s.warehouses[0]!, warehouse_id: 'placeholder-warehouse-b' });
  s.inventory.push({ ...s.inventory[0]!, warehouse_id: 'placeholder-warehouse-b', quantity: 100 });
  s.skus.push({ ...s.skus[0]!, sku_id: 'placeholder-missing-stock' });
  const result = calculateInventoryRisk(A, s, WINDOW, NOW, 2);
  assert.deepEqual(result.out_of_stock, detectStockAlerts(A, [s.inventory[0]!], 2));
  assert.deepEqual(result.low_stock, []);
});

test('T6 inventory uses the supplied current snapshot, not an invented historical window', () => {
  const s = products(); s.inventory[0]!.updated_at = 9000;
  const result = calculateInventoryRisk(A, s, WINDOW, NOW);
  assert.equal(result.inventory_basis, 'snapshot'); assert.equal(result.out_of_stock.length, 1);
  assert.equal(result.threshold, 0); assert.deepEqual(result.low_stock, []);
  s.inventory[0]!.quantity = 1;
  assert.deepEqual(calculateInventoryRisk(A, s, WINDOW, NOW).low_stock, []);
});

test('T6 inventory rejects invalid configurable thresholds including on empty scope', () => {
  for (const threshold of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, '2']) {
    assert.throws(() => calculateInventoryRisk(A, products(), WINDOW, NOW, threshold as number), /Invalid stock threshold/);
    assert.throws(() => summarizeAnalytics([], [], WINDOW, NOW, threshold as number), /Invalid stock threshold/);
  }
});

test('T6 every metric carries simulation source, shop, window and explicit calculation time', () => {
  const result = summarizeAnalytics([A], [snapshot()], WINDOW, NOW, 2);
  assert.deepEqual({ source: result.source, shop_ids: result.shop_ids, window: result.window, calculated_at: result.calculated_at },
    { source: 'simulation', shop_ids: [A], window: WINDOW, calculated_at: NOW });
  const row = result.shops[0]!;
  for (const metric of [row.overview, row.overview.gmv, row.gmv, row.best_sellers, row.inventory_risk]) metadata(metric);
});

test('T6 explicit cross-shop summary isolates reused IDs and labels all result rows', () => {
  const a = snapshot(), b = snapshot(B);
  b.orders.orders[0]!.total_amount = '0.90'; b.orders.items[0]!.quantity = 9;
  b.orders.orders[0]!.status = 'delivered'; b.products.inventory[0]!.quantity = 1;
  const result = summarizeAnalytics([B, A, B], [a, b], WINDOW, NOW, 2);
  assert.deepEqual(result.shop_ids, [B, A]); assert.deepEqual(result.shops.map(s => s.shop_id), [B, A]);
  assert.deepEqual(result.shops.map(s => s.gmv.total_amount), ['0.90', '0.10']);
  assert.deepEqual(result.shops.map(s => s.overview.delivered_order_count), [1, 0]);
  assert.deepEqual(result.shops.map(s => s.best_sellers.items[0]!.quantity), [9, 2]);
  for (const row of result.shops) {
    for (const metric of [row.overview, row.overview.gmv, row.gmv, row.best_sellers, row.inventory_risk]) metadata(metric, row.shop_id);
    for (const item of [...row.gmv.by_currency, ...row.best_sellers.items,
      ...row.inventory_risk.out_of_stock, ...row.inventory_risk.low_stock]) assert.equal(item.shop_id, row.shop_id);
  }
  const single = summarizeAnalytics([A], [a, b], WINDOW, NOW, 2);
  assert.equal(single.shops.length, 1); assert.ok(!JSON.stringify(single).includes(B));
});

test('T6 missing or malformed shop sets cannot imply all shops', () => {
  for (const scope of [undefined, null, 'all', [''], [A, null]]) {
    assert.throws(() => summarizeAnalytics(scope as string[], [snapshot()], WINDOW, NOW), /Invalid analytics request/);
  }
  assert.deepEqual(summarizeAnalytics([], [snapshot(), snapshot(B)], WINDOW, NOW).shops, []);
});

test('T6 selected shops require one unambiguous snapshot without partial output', () => {
  assert.throws(() => summarizeAnalytics([A, B], [snapshot()], WINDOW, NOW), /Analytics snapshot unavailable or ambiguous/);
  assert.throws(() => summarizeAnalytics([A], [snapshot(), snapshot()], WINDOW, NOW), /Analytics snapshot unavailable or ambiguous/);
  const invalid = snapshot(B); invalid.orders.shop_id = A;
  assert.throws(() => summarizeAnalytics([A, B], [snapshot(), invalid], WINDOW, NOW), /Invalid analytics snapshot/);
});

test('T6 empty snapshots and windows without orders return zeroes and empty lists', () => {
  const result = summarizeAnalytics([A], [{ shop_id: A, products: emptyProducts(A), orders: emptyOrders(A) }], WINDOW, NOW);
  const row = result.shops[0]!;
  assert.equal(row.overview.order_count, 0); assert.equal(row.overview.delivered_order_count, 0);
  assert.equal(row.overview.pending_shipment_order_count, 0); assert.equal(row.gmv.total_amount, '0');
  assert.deepEqual(row.gmv.by_currency, []); assert.deepEqual(row.best_sellers.items, []);
  assert.deepEqual(row.inventory_risk.out_of_stock, []); assert.deepEqual(row.inventory_risk.low_stock, []);
  assert.equal(calculateGmv(A, orders(), { start_at: 2000, end_at: 3000 }, NOW).total_amount, '0');
});

test('T6 invalid time windows and calculation clocks fail even for empty inputs', () => {
  for (const window of [null, {}, { start_at: 2000, end_at: 1000 }, { start_at: 1000, end_at: 1000 },
    ...[-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1000'].flatMap(time => [
      { start_at: time, end_at: 2000 }, { start_at: 1000, end_at: time }])]) {
    assert.throws(() => summarizeAnalytics([], [], window as AnalyticsWindow, NOW), /Invalid analytics request/);
    assert.throws(() => calculateGmv(A, emptyOrders(A), window as AnalyticsWindow, NOW), /Invalid analytics request/);
  }
  for (const clock of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, undefined]) {
    assert.throws(() => calculateShopOverview(A, orders(), WINDOW, clock as number), /Invalid analytics request/);
  }
});

test('T6 foreign shop records and broken T4/T5 relationships fail closed', () => {
  for (const corrupt of [
    (s: AnalyticsSnapshot) => { s.orders.orders[0]!.shop_id = B; },
    (s: AnalyticsSnapshot) => { s.orders.items[0]!.shop_id = B; },
    (s: AnalyticsSnapshot) => { s.orders.items[0]!.order_id = 'placeholder-missing'; },
    (s: AnalyticsSnapshot) => { s.orders.orders.push({ ...s.orders.orders[0]! }); },
    (s: AnalyticsSnapshot) => { s.products.inventory[0]!.shop_id = B; },
    (s: AnalyticsSnapshot) => { s.products.inventory[0]!.warehouse_id = 'placeholder-missing'; },
    (s: AnalyticsSnapshot) => { s.products.skus[0]!.product_id = 'placeholder-missing'; },
  ]) {
    const s = snapshot(); corrupt(s);
    assert.throws(() => summarizeAnalytics([A], [s], WINDOW, NOW), { message: 'Invalid analytics snapshot' });
  }
  assert.throws(() => calculateGmv(B, orders(A), WINDOW, NOW), /Invalid analytics snapshot/);
  assert.throws(() => calculateInventoryRisk(B, products(A), WINDOW, NOW), /Invalid analytics snapshot/);
});

test('T6 rejects non-simulation provenance and malformed decimal amounts', () => {
  for (const field of ['orders', 'products'] as const) {
    const s = snapshot(); Object.assign(s[field], { source: 'live' });
    assert.throws(() => summarizeAnalytics([A], [s], WINDOW, NOW), /Invalid analytics snapshot/);
  }
  for (const amount of [0.1, '-1', '1e2', null]) {
    const s = orders(); Object.assign(s.orders[0]!, { total_amount: amount });
    assert.throws(() => calculateGmv(A, s, WINDOW, NOW), /Invalid analytics snapshot/);
  }
});

test('T6 sensitive extra fields, buyer references, tracking and cursors never escape', () => {
  const s = snapshot();
  s.orders.packages = [{ shop_id: A, order_id: 'placeholder-order', package_id: 'placeholder-package',
    tracking_ref: '<placeholder-tracking>', status: 'pending_shipment', shipped_at: null }];
  s.orders.sync[0]!.last_cursor = '<placeholder-private-cursor>';
  const extras = { access_token: '<placeholder-access>', refresh_token: '<placeholder-refresh>',
    app_secret: '<placeholder-secret>', shop_cipher: '<placeholder-cipher>',
    buyer_name: '<placeholder-name>', phone: '<placeholder-phone>', address: '<placeholder-address>' };
  for (const value of [s, s.orders, ...s.orders.orders, ...s.orders.items, ...s.orders.packages, ...s.orders.sync,
    s.products, ...s.products.products, ...s.products.skus, ...s.products.warehouses, ...s.products.inventory, ...s.products.sync]) {
    Object.assign(value, extras);
  }
  const window = Object.assign({ ...WINDOW }, extras);
  const output = JSON.stringify(summarizeAnalytics([A], [s], window, NOW, 2));
  for (const text of [...Object.keys(extras), ...Object.values(extras), 'buyer_ref', 'tracking_ref', 'last_cursor',
    '<placeholder-buyer>', '<placeholder-tracking>', '<placeholder-private-cursor>', '<placeholder-title>']) {
    assert.ok(!output.includes(text), text);
  }
});

test('T6 malformed sensitive scalar fields produce fixed errors without echoing input', () => {
  const s = orders(); Object.assign(s.orders[0]!, { currency: { access_token: '<placeholder-access>' } });
  assert.throws(() => calculateGmv(A, s, WINDOW, NOW), { message: 'Invalid analytics snapshot' });
  const p = products(); Object.assign(p.inventory[0]!, { quantity: '<placeholder-secret>' });
  assert.throws(() => calculateInventoryRisk(A, p, WINDOW, NOW), { message: 'Invalid analytics snapshot' });
});

test('T6 computations are repeatable, do not mutate input and return independent copies', () => {
  const s = snapshot(), input = structuredClone(s), ids = [A], window = { ...WINDOW };
  const result = summarizeAnalytics(ids, [s], window, NOW, 2);
  assert.deepEqual(summarizeAnalytics(ids, [s], window, NOW, 2), result);
  assert.deepEqual(s, input); assert.deepEqual(ids, [A]); assert.deepEqual(window, WINDOW);
  result.shop_ids.push(B); result.window.start_at = 0;
  result.shops[0]!.inventory_risk.out_of_stock[0]!.quantity = 99;
  result.shops[0]!.overview.window.start_at = 1;
  assert.deepEqual(s, input); assert.deepEqual(window, WINDOW); assert.deepEqual(ids, [A]);
  assert.equal(result.shops[0]!.gmv.window.start_at, 1000);
  assert.equal(summarizeAnalytics(ids, [s], window, NOW, 2).shops[0]!.inventory_risk.out_of_stock[0]!.quantity, 0);
});

test('T6 uses actual T4/T5 in-memory sync snapshots and recomputes their metrics', async () => {
  const productRepo = new MemoryProductRepository(), orderRepo = new MemoryOrderRepository();
  const productSync = new ProductSync(productRepo, new MemoryProductSyncSource([products(), products(B)]), { now: () => NOW });
  const a = orders(); addOrder(a, 'placeholder-second', 1500);
  const orderSync = new OrderSync(orderRepo, new MemoryOrderSyncSource([a, orders(B)]), { now: () => NOW });
  const inputs: AnalyticsSnapshot[] = [];
  for (const id of [A, B]) {
    assert.equal((await productSync.syncShop(id)).error, false);
    assert.equal((await orderSync.syncShop(id)).error, false);
    inputs.push({ shop_id: id, products: (await productRepo.getSnapshot(id))!, orders: (await orderRepo.getSnapshot(id))! });
  }
  const result = summarizeAnalytics([A, B], inputs, WINDOW, NOW, 2);
  assert.deepEqual(result.shops.map(s => s.overview.order_count), [2, 1]);
  assert.deepEqual(result.shops.map(s => s.gmv.total_amount), ['0.30', '0.10']);
  assert.deepEqual(result.shops.map(s => s.best_sellers.items[0]!.quantity), [4, 2]);
  assert.deepEqual(await orderRepo.getSnapshot(A), inputs[0]!.orders);
  assert.deepEqual(await productRepo.getSnapshot(A), inputs[0]!.products);
});
