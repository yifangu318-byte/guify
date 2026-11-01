import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { createLogStream } from '../src/logging.js';
import { MemoryShopRepository, type ShopRepository, type ShopSeed } from '../src/shops/repository.js';
import { ShopQueries } from '../src/shops/service.js';
import type { Result } from '../src/tiktok/client.js';

const seed = (id = 'placeholder-shop-a'): ShopSeed => ({
  shop: { id, market: '<placeholder-market>', shopCode: '<placeholder-code>', shopName: '<placeholder-name>', status: 'inactive' },
  authorization: { shop_id: id, status: 'authorized', expires_at: 2000, source: 'simulation' },
  sync: [{ shop_id: id, resource: 'placeholder-resource', last_success_at: null, last_cursor: null, last_error: null }],
});
function data<T>(result: Result<T>): T { assert.equal(result.error, false); if (result.error) throw new Error('Expected success'); return result.data; }
const queries = (seeds: ShopSeed[]) => new ShopQueries(new MemoryShopRepository(seeds), { now: () => 1000 });

test('T3 single-shop queries isolate authorization and sync', async () => {
  const a = seed(), b = seed('placeholder-shop-b'); b.authorization!.status = 'revoked'; b.sync![0]!.last_cursor = '<placeholder-cursor-b>';
  const q = queries([a, b]);
  assert.equal(data(await q.getAuthorization(a.shop.id)).status, 'authorized');
  assert.equal(data(await q.getAuthorization(b.shop.id)).status, 'revoked');
  assert.equal(data(await q.getSyncStates(a.shop.id))[0]!.last_cursor, null);
  assert.equal(data(await q.getSyncStates(b.shop.id))[0]!.last_cursor, '<placeholder-cursor-b>');
});
test('T3 missing authorization returns unauthorized and emits safe audit', async () => {
  const s = seed(); delete s.authorization;
  let output = '';
  const stream = createLogStream(new Writable({ write(chunk, _encoding, cb) { output += chunk; cb(); } }), {});
  const q = new ShopQueries(new MemoryShopRepository([s]), { log: record => { stream.write(JSON.stringify(record) + '\n'); } });
  assert.equal(data(await q.getAuthorization(s.shop.id)).status, 'unauthorized');
  assert.deepEqual(JSON.parse(output), { event: 'shop_status_read', status: 'unauthorized', result: 'status_returned' });
});
test('T3 expiry boundary and revoked status are deterministic without mutation', async () => {
  for (const status of ['authorized', 'pending_verification', 'revoked', 'unauthorized', 'expired'] as const) {
    const s = seed(); s.authorization!.status = status; s.authorization!.expires_at = 1000;
    const repo = new MemoryShopRepository([s]);
    const q = new ShopQueries(repo, { now: () => 1000 });
    assert.equal(data(await q.getAuthorization(s.shop.id)).status, ['authorized', 'pending_verification'].includes(status) ? 'expired' : status);
    assert.equal((await repo.getAuthorization(s.shop.id))!.status, status);
  }
});
test('T3 null expiry means unknown expiry, never inferred real verification', async () => {
  const s = seed(); s.authorization!.expires_at = null; s.authorization!.status = 'pending_verification';
  assert.deepEqual(data(await queries([s]).getAuthorization(s.shop.id)), s.authorization);
});
test('T3 null sync fields and absent sync rows remain explicit', async () => {
  const s = seed();
  assert.deepEqual(data(await queries([s]).getSyncStates(s.shop.id)), s.sync);
  delete s.sync;
  assert.deepEqual(data(await queries([s]).getSyncStates(s.shop.id)), []);
});
test('T3 cross-shop summary requires explicit set and labels every row', async () => {
  const a = seed(), b = seed('placeholder-shop-b'); const q = queries([a, b]);
  assert.deepEqual(data(await q.summarize([])), []);
  const rows = data(await q.summarize([b.shop.id, b.shop.id]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.shop_id, b.shop.id);
  assert.equal(rows[0]!.authorization.shop_id, b.shop.id);
  assert.equal(rows[0]!.sync[0]!.shop_id, b.shop.id);
  assert.equal((await q.summarize(undefined as unknown as string[])).error, true);
});
test('T3 unknown shop and invalid scope return fixed envelopes', async () => {
  const q = queries([seed()]);
  assert.deepEqual(await q.getAuthorization('placeholder-missing'), { error: true, code: 'SHOP_NOT_FOUND', message: 'Shop not found' });
  assert.deepEqual(await q.getSyncStates(''), { error: true, code: 'INVALID_REQUEST', message: 'Invalid request' });
  assert.equal((await q.summarize([seed().shop.id, 'placeholder-missing'])).error, true);
});
test('T3 credentials in extra fields are neither stored nor returned nor logged', async () => {
  const s = seed();
  for (const value of [s.shop, s.authorization!, s.sync![0]!]) Object.assign(value, { access_token: '<placeholder-access>', refresh_token: '<placeholder-refresh>', shop_cipher: '<placeholder-cipher>' });
  const repo = new MemoryShopRepository([s]); const logs: unknown[] = [];
  const q = new ShopQueries(repo, { now: () => 1000, log: r => { logs.push(r); } });
  const output = JSON.stringify([await repo.getShop(s.shop.id), await repo.getAuthorization(s.shop.id), await repo.getSyncStates(s.shop.id), await q.summarize([s.shop.id]), logs]);
  for (const sensitive of ['access_token', 'refresh_token', 'shop_cipher', '<placeholder-access>', '<placeholder-refresh>', '<placeholder-cipher>']) assert.ok(!output.includes(sensitive));
});
test('T3 repository rejects mixed shop scopes, duplicate registrations and unsafe errors', () => {
  const a = seed(); a.authorization!.shop_id = 'placeholder-shop-b';
  assert.throws(() => new MemoryShopRepository([a]), /Invalid authorization state/);
  const b = seed(); b.sync![0]!.shop_id = 'placeholder-shop-b';
  assert.throws(() => new MemoryShopRepository([b]), /Invalid sync state/);
  assert.throws(() => new MemoryShopRepository([seed(), seed()]), /Invalid shop registration/);
  const c = seed(); Object.assign(c.sync![0]!, { last_error: '<placeholder-secret>' });
  assert.throws(() => new MemoryShopRepository([c]), /Invalid sync state/);
});
test('T3 repository protects seed and query copies', async () => {
  const s = seed(), id = s.shop.id; const repo = new MemoryShopRepository([s]);
  s.shop.shopName = 'changed'; s.authorization!.status = 'revoked'; s.sync![0]!.last_cursor = 'changed';
  (await repo.getShop(id))!.shopName = 'changed-again';
  (await repo.getAuthorization(id))!.status = 'expired';
  (await repo.getSyncStates(id))[0]!.last_cursor = 'changed-again';
  assert.equal((await repo.getShop(id))!.shopName, '<placeholder-name>');
  assert.equal((await repo.getAuthorization(id))!.status, 'authorized');
  assert.equal((await repo.getSyncStates(id))[0]!.last_cursor, null);
});
test('T3 replacement repository scope mismatch and exceptions fail closed', async () => {
  const repo = new MemoryShopRepository([seed()]);
  const q = new ShopQueries({ getShop: async () => seed('placeholder-shop-b').shop, getAuthorization: repo.getAuthorization.bind(repo), getSyncStates: repo.getSyncStates.bind(repo) });
  assert.deepEqual(await q.getAuthorization(seed().shop.id), { error: true, code: 'SHOP_SCOPE_INVALID', message: 'Shop scope mismatch' });
  const bad = new ShopQueries({ getShop: async () => { throw new Error('<placeholder-secret>'); }, getAuthorization: repo.getAuthorization.bind(repo), getSyncStates: repo.getSyncStates.bind(repo) });
  assert.deepEqual(await bad.getAuthorization(seed().shop.id), { error: true, code: 'SHOP_QUERY_FAILED', message: 'Shop query failed' });
});
test('T3 caller mutation cannot expand cross-shop scope during await', async () => {
  const a = seed(), b = seed('placeholder-shop-b'), ids = [a.shop.id];
  const pending = queries([a, b]).summarize(ids); ids.push(b.shop.id);
  assert.deepEqual(data(await pending).map(r => r.shop_id), [a.shop.id]);
});

// Exercise a replacement repository directly, without memory's seed validation.
function replacement(s: ShopSeed): ShopRepository {
  return { getShop: async () => s.shop, getAuthorization: async () => s.authorization,
    getSyncStates: async () => [...(s.sync ?? [])] };
}

test('T3 unknown resource supports an entirely null unsynchronized state', async () => {
  const s = seed(); s.sync![0]!.resource = null; delete s.authorization;
  const q = queries([s]);
  assert.deepEqual(data(await q.getSyncStates(s.shop.id)), [{ shop_id: s.shop.id,
    resource: null, last_success_at: null, last_cursor: null, last_error: null }]);
  const summary = data(await q.summarize([s.shop.id]))[0]!;
  assert.equal(summary.authorization.status, 'unauthorized');
  assert.deepEqual(summary.sync, s.sync);
});

test('T3 explicit two-shop summary labels distinct authorization and sync metadata', async () => {
  const a = seed(), b = seed('placeholder-shop-b');
  b.authorization!.status = 'pending_verification'; b.authorization!.source = 'explicit_input';
  Object.assign(b.sync![0]!, { last_success_at: 900, last_cursor: '<placeholder-cursor-b>', last_error: 'SYNC_FAILED' });
  const rows = data(await queries([a, b]).summarize([b.shop.id, a.shop.id]));
  assert.deepEqual(rows.map(r => [r.shop_id, r.shop.id, r.authorization.shop_id, r.sync[0]!.shop_id]),
    [b, a].map(s => [s.shop.id, s.shop.id, s.shop.id, s.shop.id]));
  assert.deepEqual(rows.map(r => r.authorization), [b.authorization, a.authorization]);
  assert.deepEqual(rows.map(r => r.sync), [b.sync, a.sync]);
});

test('T3 expiry immediately before and after clock preserves explicit provenance', async () => {
  for (const expires_at of [999, 1000, 1001, null]) {
    const s = seed(); s.authorization!.expires_at = expires_at; s.authorization!.source = 'explicit_input';
    const result = data(await queries([s]).getAuthorization(s.shop.id));
    assert.equal(result.status, expires_at !== null && expires_at <= 1000 ? 'expired' : 'authorized');
    assert.equal(result.source, 'explicit_input');
    assert.equal(result.expires_at, expires_at);
  }
});

test('T3 replacement repository invalid metadata never enters responses or logs', async () => {
  const corruptions = [
    (s: ShopSeed) => Object.assign(s.authorization!, { status: '<placeholder-secret>' }),
    (s: ShopSeed) => Object.assign(s.authorization!, { source: '<placeholder-secret>' }),
    (s: ShopSeed) => Object.assign(s.authorization!, { expires_at: '<placeholder-secret>' }),
    (s: ShopSeed) => Object.assign(s.authorization!, { expires_at: NaN }),
    (s: ShopSeed) => Object.assign(s.sync![0]!, { last_error: '<placeholder-secret>' }),
    (s: ShopSeed) => Object.assign(s.sync![0]!, { last_success_at: -1 }),
    (s: ShopSeed) => Object.assign(s.sync![0]!, { last_cursor: { access_token: '<placeholder-access>' } }),
    (s: ShopSeed) => Object.assign(s.shop, { shopName: { access_token: '<placeholder-access>' } }),
    (s: ShopSeed) => { s.sync = [...s.sync!, { ...s.sync![0]! }]; },
  ];
  for (const corrupt of corruptions) {
    const s = seed(), logs: unknown[] = []; corrupt(s);
    const q = new ShopQueries(replacement(s), { now: () => 1000, log: r => { logs.push(r); } });
    for (const result of [await q.getAuthorization(s.shop.id), await q.getSyncStates(s.shop.id), await q.summarize([s.shop.id])]) {
      assert.deepEqual(result, { error: true, code: 'SHOP_QUERY_FAILED', message: 'Shop query failed' });
    }
    assert.deepEqual(logs, []);
  }
});

test('T3 replacement authorization and sync scope mismatches are rejected', async () => {
  for (const field of ['authorization', 'sync'] as const) {
    const s = seed();
    if (field === 'authorization') s.authorization!.shop_id = 'placeholder-shop-b';
    else s.sync![0]!.shop_id = 'placeholder-shop-b';
    const q = new ShopQueries(replacement(s));
    assert.deepEqual(await q.summarize([s.shop.id]), { error: true, code: 'SHOP_SCOPE_INVALID', message: 'Shop scope mismatch' });
  }
});

test('T3 replacement repository extra credential fields are discarded at query boundary', async () => {
  const s = seed(), logs: unknown[] = [];
  for (const value of [s.shop, s.authorization!, s.sync![0]!]) {
    Object.assign(value, { access_token: '<placeholder-access>', refresh_token: '<placeholder-refresh>',
      app_secret: '<placeholder-secret>', shop_cipher: '<placeholder-cipher>' });
  }
  const q = new ShopQueries(replacement(s), { now: () => 1000, log: r => { logs.push(r); } });
  const output = JSON.stringify([data(await q.getAuthorization(s.shop.id)), data(await q.getSyncStates(s.shop.id)),
    data(await q.summarize([s.shop.id])), logs]);
  for (const sensitive of ['access_token', 'refresh_token', 'app_secret', 'shop_cipher',
    '<placeholder-access>', '<placeholder-refresh>', '<placeholder-secret>', '<placeholder-cipher>']) assert.ok(!output.includes(sensitive));
});

test('T3 seed authorization requires recognized status, source and safe expiry', () => {
  for (const invalid of [{ status: 'connected' }, { source: 'real_authorization' }, { expires_at: -1 },
    { expires_at: Infinity }, { expires_at: 0.5 }]) {
    const s = seed(); Object.assign(s.authorization!, invalid);
    assert.throws(() => new MemoryShopRepository([s]), { message: 'Invalid authorization state' });
  }
});

test('T3 invalid clock fails safely and audit sink errors cannot break status reads', async () => {
  const s = seed();
  for (const now of [NaN, Infinity, -1, 0.5]) {
    const q = new ShopQueries(new MemoryShopRepository([s]), { now: () => now });
    assert.deepEqual(await q.getAuthorization(s.shop.id), { error: true, code: 'SHOP_QUERY_FAILED', message: 'Shop query failed' });
  }
  const q = new ShopQueries(new MemoryShopRepository([s]), { now: () => 1000,
    log: () => { throw new Error('<placeholder-secret>'); } });
  assert.equal(data(await q.getAuthorization(s.shop.id)).status, 'authorized');
});
