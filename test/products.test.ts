import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Result } from '../src/tiktok/client.js';
import { emptySnapshot, productResources, type ProductSnapshot } from '../src/products/models.js';
import { MemoryProductRepository, type ProductRepository } from '../src/products/repository.js';
import { ProductQueries } from '../src/products/service.js';
import { MemoryProductSyncSource, ProductSync, type ProductSyncSource } from '../src/products/sync.js';
import { detectStockAlerts } from '../src/products/alerts.js';

// Entirely synthetic: IDs, TST currency, 1.00 price and all quantities are placeholders.
const A = 'placeholder-shop-a', B = 'placeholder-shop-b';
function seed(shop_id = A): ProductSnapshot {
  return { ...emptySnapshot(shop_id),
    products: [{ shop_id, product_id: 'placeholder-product', title: '<placeholder-title>',
      status: 'placeholder-active', category: null, updated_at: null }],
    skus: [{ shop_id, product_id: 'placeholder-product', sku_id: 'placeholder-sku',
      price: '1.00', currency: 'TST', status: 'placeholder-active' }],
    warehouses: [{ shop_id, warehouse_id: 'placeholder-warehouse', name: '<placeholder-warehouse>', warehouse_type: 'regular' }],
    inventory: [{ shop_id, sku_id: 'placeholder-sku', warehouse_id: 'placeholder-warehouse', quantity: 0, updated_at: null }],
  };
}
function data<T>(r: Result<T>): T {
  assert.equal(r.error, false); if (r.error) throw new Error('Expected success'); return r.data;
}
const failingSource: ProductSyncSource = { source: 'simulation', readSnapshot: async () => { throw new Error('<placeholder-secret>'); } };
const queryFailure = { error: true, code: 'PRODUCT_QUERY_FAILED', message: 'Product query failed' };
const syncFailure = { error: true, code: 'PRODUCT_SYNC_FAILED', message: 'Product simulation sync failed' };
// Bypass memory validation to exercise the actual service trust boundary.
function replacement(snapshot: ProductSnapshot): ProductRepository {
  return { getSnapshot: async () => snapshot, replaceSnapshot: async () => {} };
}

test('T4 simulated sync isolates products, details, SKUs, warehouses and inventory for two shops', async () => {
  const a = seed(), b = seed(B); b.products[0]!.title = '<placeholder-title-b>'; b.inventory[0]!.quantity = 7;
  const repo = new MemoryProductRepository(), source = new MemoryProductSyncSource([a, b]);
  const sync = new ProductSync(repo, source, { now: () => 1000 });
  const q = new ProductQueries(repo);
  for (const s of [a, b]) {
    const snapshot = data(await sync.syncShop(s.shop_id));
    assert.equal(snapshot.source, 'simulation');
    assert.deepEqual(data(await q.listProducts(s.shop_id)), s.products);
    assert.deepEqual(data(await q.getProduct(s.shop_id, 'placeholder-product')), s.products[0]);
    assert.deepEqual(data(await q.listSkus(s.shop_id)), s.skus);
    assert.deepEqual(data(await q.listWarehouses(s.shop_id)), s.warehouses);
    assert.deepEqual(data(await q.listInventory(s.shop_id)), s.inventory);
    assert.ok(snapshot.sync.every(state => state.shop_id === s.shop_id && state.last_success_at === 1000));
  }
  assert.equal(data(await q.listInventory(A))[0]!.quantity, 0);
  assert.equal(data(await q.listInventory(B))[0]!.quantity, 7);
});

test('T4 SKU product ownership and inventory references must exist within the same shop', () => {
  const corruptions = [
    (s: ProductSnapshot) => { s.skus[0]!.product_id = 'placeholder-missing'; },
    (s: ProductSnapshot) => { s.skus[0]!.shop_id = B; },
    (s: ProductSnapshot) => { s.products[0]!.shop_id = B; },
    (s: ProductSnapshot) => { s.warehouses[0]!.shop_id = B; },
    (s: ProductSnapshot) => { s.inventory[0]!.shop_id = B; },
    (s: ProductSnapshot) => { s.inventory[0]!.sku_id = 'placeholder-missing'; },
    (s: ProductSnapshot) => { s.inventory[0]!.warehouse_id = 'placeholder-missing'; },
    (s: ProductSnapshot) => { s.sync[0]!.shop_id = B; },
  ];
  for (const corrupt of corruptions) {
    const s = seed(); corrupt(s);
    assert.throws(() => new MemoryProductRepository([seed(B), s]));
  }
});

test('T4 duplicate identities are rejected but identical external IDs in different shops are valid', () => {
  for (const field of ['products', 'skus', 'warehouses', 'inventory', 'sync'] as const) {
    const s = seed(); s[field].push({ ...s[field][0]! } as never);
    assert.throws(() => new MemoryProductRepository([s]));
  }
  assert.throws(() => new MemoryProductRepository([seed(), seed()]), /Duplicate product shop/);
  assert.doesNotThrow(() => new MemoryProductRepository([seed(), seed(B)]));
});

test('T4 inventory rejects negative, fractional, nonfinite, unsafe and nonnumeric quantities', async () => {
  for (const quantity of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0', null]) {
    const s = seed(); Object.assign(s.inventory[0]!, { quantity });
    assert.throws(() => new MemoryProductRepository([s]), { message: 'Invalid inventory' });
    assert.throws(() => detectStockAlerts(A, s.inventory), { message: 'Invalid inventory' });
    assert.deepEqual(await new ProductQueries(replacement(s)).listInventory(A), queryFailure);
  }
  for (const quantity of [0, 1, Number.MAX_SAFE_INTEGER]) {
    const s = seed(); s.inventory[0]!.quantity = quantity;
    assert.doesNotThrow(() => new MemoryProductRepository([s]));
  }
});

test('T4 stock rule boundaries: zero, below, equal and above threshold', () => {
  const s = seed();
  for (const [quantity, expected] of [[0, 'out_of_stock'], [1, 'low_stock'], [2, undefined], [3, undefined]] as const) {
    s.inventory[0]!.quantity = quantity;
    const alerts = detectStockAlerts(A, s.inventory, 2);
    assert.equal(alerts.length, expected ? 1 : 0);
    if (expected) assert.deepEqual(alerts[0], { shop_id: A, sku_id: 'placeholder-sku',
      warehouse_id: 'placeholder-warehouse', quantity, threshold: 2, type: expected });
  }
});

test('T4 default threshold is zero and zero always produces one out-of-stock alert', () => {
  const s = seed();
  assert.equal(detectStockAlerts(A, s.inventory)[0]!.type, 'out_of_stock');
  assert.equal(detectStockAlerts(A, s.inventory)[0]!.threshold, 0);
  s.inventory[0]!.quantity = 1;
  assert.deepEqual(detectStockAlerts(A, s.inventory), []);
  assert.deepEqual(detectStockAlerts(A, []), []);
});

test('T4 threshold must be a nonnegative safe integer across pure and service APIs', async () => {
  const q = new ProductQueries(new MemoryProductRepository([seed()]));
  for (const threshold of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2', null]) {
    assert.throws(() => detectStockAlerts(A, seed().inventory, threshold as number), { message: 'Invalid stock threshold' });
    for (const r of [await q.getStockAlerts(A, threshold as number), await q.summarizeStockAlerts([A], threshold as number)]) {
      assert.deepEqual(r, { error: true, code: 'INVALID_REQUEST', message: 'Invalid request' });
    }
  }
});

test('T4 alerts preserve per-warehouse scope without pooling or mutating inputs', () => {
  const s = seed(); s.inventory.push({ ...s.inventory[0]!, warehouse_id: 'placeholder-warehouse-other', quantity: 8 });
  const before = structuredClone(s.inventory);
  assert.equal(detectStockAlerts(A, s.inventory, 2).length, 1);
  assert.deepEqual(s.inventory, before);
  assert.throws(() => detectStockAlerts(B, s.inventory), { message: 'Invalid inventory' });
  assert.throws(() => detectStockAlerts(A, [...s.inventory, s.inventory[0]!]));
});

test('T4 warehouse types are data fields with no country mapping', async () => {
  const s = seed();
  for (const warehouse_type of ['regular', 'overseas', 'other'] as const) {
    s.warehouses[0]!.warehouse_type = warehouse_type;
    const q = new ProductQueries(new MemoryProductRepository([s]));
    assert.equal(data(await q.listWarehouses(A))[0]!.warehouse_type, warehouse_type);
  }
  Object.assign(s.warehouses[0]!, { warehouse_type: 'placeholder-country' });
  assert.throws(() => new MemoryProductRepository([s]));
});

test('T4 cross-shop summaries require explicit sets and label every nested row', async () => {
  const a = seed(), b = seed(B); b.inventory[0]!.quantity = 1;
  const q = new ProductQueries(new MemoryProductRepository([a, b]));
  assert.deepEqual(data(await q.summarize([])), []);
  assert.deepEqual(data(await q.summarizeStockAlerts([])), []);
  const rows = data(await q.summarize([B, A, B]));
  assert.deepEqual(rows.map(s => s.shop_id), [B, A]);
  for (const s of rows) for (const list of [s.products, s.skus, s.warehouses, s.inventory, s.sync]) {
    assert.ok(list.every(row => row.shop_id === s.shop_id));
  }
  const alerts = data(await q.summarizeStockAlerts([B, A], 2));
  assert.deepEqual(alerts.map(s => [s.shop_id, s.type]), [[B, 'low_stock'], [A, 'out_of_stock']]);
  assert.deepEqual(data(await q.summarizeStockAlerts([B], 2)), [alerts[0]]);
  for (const scope of [undefined, null, 'all', [''], [A, null]]) {
    assert.equal((await q.summarize(scope as string[])).error, true);
    assert.equal((await q.summarizeStockAlerts(scope as string[])).error, true);
  }
});

test('T4 caller mutation cannot expand cross-shop scope during await', async () => {
  const q = new ProductQueries(new MemoryProductRepository([seed(), seed(B)]));
  const ids = [A], pending = q.summarizeStockAlerts(ids); ids.push(B);
  assert.deepEqual(data(await pending).map(s => s.shop_id), [A]);
});

test('T4 unknown shop, missing product and empty scope fail with safe errors', async () => {
  const q = new ProductQueries(new MemoryProductRepository([seed()]));
  assert.deepEqual(await q.getProduct(A, 'placeholder-missing'), { error: true, code: 'PRODUCT_NOT_FOUND', message: 'Product not found' });
  assert.deepEqual(await q.listProducts(B), { error: true, code: 'SHOP_NOT_FOUND', message: 'Simulation shop not found' });
  for (const result of [await q.listProducts(''), await q.getProduct(A, ''), await q.getStockAlerts('')]) {
    assert.deepEqual(result, { error: true, code: 'INVALID_REQUEST', message: 'Invalid request' });
  }
  const result = await q.summarize([A, B]);
  assert.equal(result.error, true);
  assert.ok(!JSON.stringify(result).includes('<placeholder-title>'));
});

test('T4 unsynchronized states reuse all T3 nullable fields including unknown resource', async () => {
  const s = seed(); s.sync = [{ shop_id: A, resource: null, last_success_at: null, last_cursor: null, last_error: null }];
  const states = data(await new ProductQueries(new MemoryProductRepository([s])).getSyncStates(A));
  assert.deepEqual(states.slice(0, 4), emptySnapshot(A).sync);
  assert.deepEqual(states[4], s.sync[0]);
  s.sync = [];
  assert.deepEqual(data(await new ProductQueries(new MemoryProductRepository([s])).getSyncStates(A)), emptySnapshot(A).sync);
});

test('T4 successful full snapshot sync replaces stale data, sets time, preserves cursors and clears errors', async () => {
  const old = seed(); old.inventory[0]!.quantity = 7;
  const next = emptySnapshot(A);
  next.sync.forEach(s => { s.last_cursor = '<placeholder-cursor>'; s.last_error = 'SYNC_FAILED'; });
  const repo = new MemoryProductRepository([old]);
  const result = data(await new ProductSync(repo, new MemoryProductSyncSource([next]), { now: () => 1000 }).syncShop(A));
  assert.deepEqual(result.products, []); assert.deepEqual(result.inventory, []);
  assert.deepEqual(result.sync, productResources.map(resource => ({ shop_id: A, resource,
    last_success_at: 1000, last_cursor: '<placeholder-cursor>', last_error: null })));
  assert.deepEqual(await repo.getSnapshot(A), result);
});

test('T4 failed sync retains prior data, successful time and cursor with fixed error category', async () => {
  const old = seed(); old.sync.forEach(s => { s.last_success_at = 900; s.last_cursor = '<placeholder-cursor>'; });
  const repo = new MemoryProductRepository([old, seed(B)]);
  assert.deepEqual(await new ProductSync(repo, failingSource).syncShop(A), syncFailure);
  const current = (await repo.getSnapshot(A))!;
  assert.deepEqual(current.inventory, old.inventory);
  assert.deepEqual(current.products, old.products);
  assert.ok(current.sync.every(s => s.last_success_at === 900 && s.last_cursor === '<placeholder-cursor>' && s.last_error === 'SYNC_FAILED'));
  assert.deepEqual(await repo.getSnapshot(B), seed(B));
});

test('T4 first failed sync records null success and null cursors, never a successful connection', async () => {
  const repo = new MemoryProductRepository();
  assert.deepEqual(await new ProductSync(repo, failingSource).syncShop(A), syncFailure);
  const snapshot = (await repo.getSnapshot(A))!;
  assert.equal(snapshot.source, 'simulation'); assert.deepEqual(snapshot.products, []);
  assert.ok(snapshot.sync.every(s => s.last_success_at === null && s.last_cursor === null && s.last_error === 'SYNC_FAILED'));
});

test('T4 invalid source scope or data cannot partially replace an existing snapshot', async () => {
  for (const bad of [seed(B), (() => { const s = seed(); s.inventory[0]!.quantity = -1; return s; })()]) {
    const repo = new MemoryProductRepository([seed()]);
    const source: ProductSyncSource = { source: 'simulation', readSnapshot: async () => bad };
    assert.deepEqual(await new ProductSync(repo, source).syncShop(A), syncFailure);
    assert.deepEqual((await repo.getSnapshot(A))!.inventory, seed().inventory);
  }
});

test('T4 invalid sync clocks and non-simulation provenance fail closed', async () => {
  for (const now of [-1, 0.5, NaN, Infinity]) {
    const repo = new MemoryProductRepository();
    assert.deepEqual(await new ProductSync(repo, new MemoryProductSyncSource([seed()]), { now: () => now }).syncShop(A), syncFailure);
    assert.ok((await repo.getSnapshot(A))!.sync.every(s => s.last_success_at === null));
  }
  const s = seed(); Object.assign(s, { source: 'live' });
  assert.throws(() => new MemoryProductRepository([s]));
  let reads = 0;
  const source = { source: 'live', readSnapshot: async () => { reads++; return seed(); } } as unknown as ProductSyncSource;
  assert.deepEqual(await new ProductSync(new MemoryProductRepository(), source).syncShop(A), syncFailure);
  assert.equal(reads, 0);
});

test('T4 sync retries recover from failure and subsequent queries stay read only', async () => {
  const repo = new MemoryProductRepository(); let calls = 0;
  const source: ProductSyncSource = { source: 'simulation', readSnapshot: async () => {
    if (++calls === 1) throw new Error('<placeholder-secret>'); return seed();
  } };
  const sync = new ProductSync(repo, source, { now: () => 1000 });
  assert.deepEqual(await sync.syncShop(A), syncFailure);
  data(await sync.syncShop(A));
  const q = new ProductQueries(repo), before = await repo.getSnapshot(A);
  data(await q.listProducts(A)); data(await q.getStockAlerts(A));
  assert.equal(calls, 2); assert.deepEqual(await repo.getSnapshot(A), before);
  assert.ok(before!.sync.every(s => s.last_error === null && s.last_success_at === 1000));
});

test('T4 same-shop syncs serialize while another shop can complete independently', async () => {
  const repo = new MemoryProductRepository(); const seen: string[] = [];
  let unblock!: () => void, started!: () => void, count = 0;
  const gate = new Promise<void>(r => { unblock = r; });
  const firstStarted = new Promise<void>(r => { started = r; });
  const source: ProductSyncSource = { source: 'simulation', readSnapshot: async id => {
    seen.push(id); if (id === A && ++count === 1) { started(); await gate; } return seed(id);
  } };
  const sync = new ProductSync(repo, source, { now: () => 1000 });
  const first = sync.syncShop(A); await firstStarted;
  const second = sync.syncShop(A); data(await sync.syncShop(B));
  assert.deepEqual(seen, [A, B]); unblock();
  data(await first); data(await second); assert.deepEqual(seen, [A, B, A]);
});

test('T4 repositories, sources and query results protect seeds and returned copies', async () => {
  const s = seed(), repo = new MemoryProductRepository([s]), source = new MemoryProductSyncSource([s]);
  s.products[0]!.title = '<placeholder-mutated>'; s.inventory[0]!.quantity = 9;
  const row = (await repo.getSnapshot(A))!; row.skus[0]!.price = '9.00'; row.sync[0]!.last_cursor = '<placeholder-mutated>';
  const sourceRow = await source.readSnapshot(A); sourceRow.products[0]!.title = '<placeholder-mutated>';
  const q = new ProductQueries(repo); data(await q.listInventory(A))[0]!.quantity = 9;
  assert.deepEqual(await repo.getSnapshot(A), seed()); assert.deepEqual(await source.readSnapshot(A), seed());
  const next = seed(); await repo.replaceSnapshot(A, next); next.inventory[0]!.quantity = 9;
  assert.deepEqual(await repo.getSnapshot(A), seed());
});

test('T4 invalid replacements are atomic and cannot overwrite another shop', async () => {
  const repo = new MemoryProductRepository([seed(), seed(B)]), bad = seed(); bad.inventory[0]!.quantity = -1;
  await assert.rejects(repo.replaceSnapshot(A, bad)); await assert.rejects(repo.replaceSnapshot(A, seed(B)));
  assert.deepEqual(await repo.getSnapshot(A), seed()); assert.deepEqual(await repo.getSnapshot(B), seed(B));
});

test('T4 replacement repository metadata and scope violations fail at every query boundary', async () => {
  const corruptions = [
    (s: ProductSnapshot) => { s.shop_id = B; },
    (s: ProductSnapshot) => { s.skus[0]!.product_id = 'placeholder-missing'; },
    (s: ProductSnapshot) => { Object.assign(s.products[0]!, { title: { access_token: '<placeholder-access>' } }); },
    (s: ProductSnapshot) => { Object.assign(s.sync[0]!, { last_error: '<placeholder-secret>' }); },
    (s: ProductSnapshot) => { s.sync[0]!.last_success_at = -1; },
    (s: ProductSnapshot) => { Object.assign(s.sync[0]!, { last_cursor: { access_token: '<placeholder-access>' } }); },
    (s: ProductSnapshot) => { s.sync.push({ ...s.sync[0]! }); },
  ];
  for (const corrupt of corruptions) {
    const s = seed(); corrupt(s); const q = new ProductQueries(replacement(s));
    for (const r of [await q.listProducts(A), await q.getProduct(A, 'placeholder-product'), await q.listSkus(A),
      await q.listWarehouses(A), await q.listInventory(A), await q.getSyncStates(A), await q.getStockAlerts(A),
      await q.summarize([A]), await q.summarizeStockAlerts([A])]) assert.deepEqual(r, queryFailure);
  }
});

test('T4 sensitive extra properties are discarded from storage, source, sync, queries and alerts', async () => {
  const s = seed();
  const sensitive = { access_token: '<placeholder-access>', refresh_token: '<placeholder-refresh>',
    app_secret: '<placeholder-secret>', shop_cipher: '<placeholder-cipher>' };
  for (const row of [s, ...s.products, ...s.skus, ...s.warehouses, ...s.inventory, ...s.sync]) Object.assign(row, sensitive);
  const repo = new MemoryProductRepository([s]);
  const q = new ProductQueries(replacement(s));
  const synced = await new ProductSync(repo, { source: 'simulation', readSnapshot: async () => s }).syncShop(A);
  const output = JSON.stringify([await repo.getSnapshot(A), await new MemoryProductSyncSource([s]).readSnapshot(A),
    synced, await q.summarize([A]), await q.summarizeStockAlerts([A]), detectStockAlerts(A, s.inventory)]);
  for (const text of [...Object.keys(sensitive), ...Object.values(sensitive)]) assert.ok(!output.includes(text));
  const alert = data(await q.getStockAlerts(A))[0]!;
  assert.deepEqual(Object.keys(alert).sort(), ['shop_id', 'sku_id', 'warehouse_id', 'quantity', 'threshold', 'type'].sort());
  assert.ok(!JSON.stringify(alert).includes('<placeholder-title>'));
  assert.ok(!JSON.stringify(alert).includes('price'));
});

test('T4 source and repository exceptions never expose raw errors', async () => {
  const repo: ProductRepository = { getSnapshot: async () => { throw new Error('<placeholder-secret>'); },
    replaceSnapshot: async () => { throw new Error('<placeholder-access>'); } };
  assert.deepEqual(await new ProductQueries(repo).listProducts(A), queryFailure);
  assert.deepEqual(await new ProductSync(repo, failingSource).syncShop(A), syncFailure);
  const unavailable: ProductRepository = { getSnapshot: async () => seed(), replaceSnapshot: repo.replaceSnapshot };
  assert.deepEqual(await new ProductSync(unavailable, new MemoryProductSyncSource([seed()])).syncShop(A), syncFailure);
  assert.deepEqual(await new ProductSync(repo, failingSource).syncShop(''), { error: true, code: 'INVALID_REQUEST', message: 'Invalid request' });
});

test('T4 prices are decimal text and invalid shapes or timestamps are rejected', () => {
  for (const price of [-1, 'NaN', '-1.00', '1e2', '', '1.2.3']) {
    const s = seed(); Object.assign(s.skus[0]!, { price }); assert.throws(() => new MemoryProductRepository([s]));
  }
  const s = seed(); s.inventory[0]!.updated_at = -1;
  assert.throws(() => new MemoryProductRepository([s]));
});
