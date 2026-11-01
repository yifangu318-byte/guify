import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { TikTokReadOnlyAdapter, type AdapterOptions } from '../src/tiktok/client.js';
import { MemoryTokenStore, type ShopToken } from '../src/tiktok/tokens.js';
import { signDraft, verifyDraft } from '../src/tiktok/signing.js';
import { coverage } from '../src/tiktok/coverage.js';
import { createLogStream } from '../src/logging.js';
import { Writable } from 'node:stream';

// All credentials are literal placeholders; all transport/clock/random are injected.
const token = (shop_id = 'shop-a', expires_at = 1_000_000): ShopToken => ({ shop_id,
  access_token: '<placeholder-access>', refresh_token: '<placeholder-refresh>', expires_at });
async function fixture(overrides: Partial<AdapterOptions> = {}) {
  const store = new MemoryTokenStore();
  await store.set('shop-a', token());
  let time = 100_000;
  const sleeps: number[] = [], calls: Parameters<AdapterOptions['transport']>[0][] = [];
  let refreshes = 0;
  const options: AdapterOptions = { appKey: '<placeholder-key>', appSecret: '<placeholder-secret>', store,
    now: () => time, sleep: async ms => { sleeps.push(ms); time += ms; }, random: () => 0.5,
    minIntervalMs: 0, refreshAheadMs: 1000,
    refresh: async shop => { refreshes++; return { ...token(shop), access_token: '<placeholder-renewed>' }; },
    transport: async request => { calls.push(request); return { status: 200, data: { mock: true } }; }, ...overrides };
  return { client: new TikTokReadOnlyAdapter(options), store, sleeps, calls, refreshes: () => refreshes };
}
const request = { shop_id: 'shop-a', path: '/mock/products' };

test('T2 draft signing deterministic, sorted, timestamp seconds and known local HMAC vector', () => {
  const secret = '<placeholder-secret>';
  const actual = signDraft('/mock', { z: '2', a: '1', sign: 'ignored', access_token: '<placeholder-access>' }, secret, 123);
  const expected = createHmac('sha256', secret).update(secret + '/mocka1timestamp123z2' + secret).digest('hex');
  assert.equal(actual, expected);
  assert.equal(actual, signDraft('/mock', { a: '1', z: '2' }, secret, 123));
  assert.throws(() => signDraft('/mock', {}, secret, 1.5));
});
test('T2 draft tampering path, parameters, timestamp and signature is detected', () => {
  const secret = '<placeholder-secret>', signature = signDraft('/mock', { a: '1' }, secret, 123);
  assert.equal(verifyDraft('/mock', { a: '1' }, secret, 123, signature), true);
  for (const [path, a, timestamp] of [['/other', '1', 123], ['/mock', '2', 123], ['/mock', '1', 124]] as const) {
    assert.equal(verifyDraft(path, { a }, secret, timestamp, signature), false);
  }
  assert.equal(verifyDraft('/mock', { a: '1' }, secret, 123, 'invalid'), false);
});
test('T2 expiring token refreshed before transport and persisted only in memory', async () => {
  const f = await fixture(); await f.store.set('shop-a', token('shop-a', 100_999));
  assert.equal((await f.client.read(request)).error, false);
  assert.equal(f.refreshes(), 1);
  assert.equal(f.calls[0]?.access_token, '<placeholder-renewed>');
  assert.equal((await f.store.get('shop-a'))?.access_token, '<placeholder-renewed>');
});
test('T2 401 refresh retries with fresh token exactly once', async () => {
  const seen: string[] = [];
  const f = await fixture({ transport: async req => { seen.push(req.access_token); return { status: seen.length === 1 ? 401 : 200 }; } });
  assert.equal((await f.client.read(request)).error, false);
  assert.deepEqual(seen, ['<placeholder-access>', '<placeholder-renewed>']);
  assert.equal(f.refreshes(), 1);
});
test('T2 repeated 401 stops after one retry with uniform envelope', async () => {
  let attempts = 0;
  const f = await fixture({ transport: async () => { attempts++; return { status: 401 }; } });
  assert.deepEqual(await f.client.read(request), { error: true, message: 'Shop authorization rejected', code: 'UNAUTHORIZED' });
  assert.equal(attempts, 2); assert.equal(f.refreshes(), 1);
});
test('T2 proactive and reactive refresh failures stop without leaking exceptions', async () => {
  for (const expired of [true, false]) {
    let refreshes = 0, attempts = 0;
    const f = await fixture({ refresh: async () => { refreshes++; throw new Error('<placeholder-secret>'); },
      transport: async () => { attempts++; return { status: 401 }; } });
    if (expired) await f.store.set('shop-a', token('shop-a', 99_000));
    assert.deepEqual(await f.client.read(request), { error: true, message: 'Token refresh failed', code: 'TOKEN_REFRESH_FAILED' });
    assert.equal(refreshes, 1); assert.equal(attempts, expired ? 0 : 1);
  }
});
test('T2 429 exponential bounded backoff with injected jitter and eventual success', async () => {
  let attempts = 0;
  const f = await fixture({ backoffBaseMs: 100, backoffCapMs: 150,
    transport: async () => ({ status: ++attempts <= 2 ? 429 : 200 }) });
  assert.equal((await f.client.read(request)).error, false);
  assert.deepEqual(f.sleeps.filter(ms => ms > 0), [75, 112]); assert.equal(attempts, 3);
});
test('T2 exhausted 429 budget stops and maxRetries zero disables retries', async () => {
  for (const maxRetries of [0, 2]) {
    let attempts = 0;
    const f = await fixture({ maxRetries, transport: async () => { attempts++; return { status: 429 }; } });
    assert.deepEqual(await f.client.read(request), { error: true, message: 'Shop rate limit exceeded', code: 'RATE_LIMITED' });
    assert.equal(attempts, maxRetries + 1);
  }
});
test('T2 mandatory shop and reserved scope overrides rejected before transport', async () => {
  const f = await fixture();
  for (const req of [{ ...request, shop_id: '' }, { ...request, params: { shop_id: 'shop-b' } }, { ...request, params: { access_token: '<placeholder-other>' } }]) {
    assert.deepEqual(await f.client.read(req), { error: true, message: 'Invalid request', code: 'INVALID_REQUEST' });
  }
  assert.equal(f.calls.length, 0);
});
test('T2 per-shop tokens never mixed and store returns defensive copies', async () => {
  const f = await fixture();
  await f.store.set('shop-b', { ...token('shop-b'), access_token: '<placeholder-b>' });
  await Promise.all([f.client.read(request), f.client.read({ ...request, shop_id: 'shop-b' })]);
  assert.deepEqual(f.calls.map(c => [c.shop_id, c.params.shop_id, c.access_token]), [
    ['shop-a', 'shop-a', '<placeholder-access>'], ['shop-b', 'shop-b', '<placeholder-b>']]);
  const copy = (await f.store.get('shop-a'))!; copy.shop_id = 'shop-b';
  assert.equal((await f.store.get('shop-a'))?.shop_id, 'shop-a');
  await assert.rejects(f.store.set('shop-b', token('shop-a')));
});
test('T2 malicious store and cross-shop refresh fail closed', async () => {
  const f = await fixture({ store: { get: async () => token('shop-b'), set: async () => {} } });
  assert.deepEqual(await f.client.read(request), { error: true, message: 'Shop authorization unavailable', code: 'SHOP_TOKEN_INVALID' });
  assert.equal(f.calls.length, 0);
  const g = await fixture({ refresh: async () => token('shop-b') });
  await g.store.set('shop-a', token('shop-a', 0));
  assert.equal((await g.client.read(request) as { code: string }).code, 'TOKEN_REFRESH_FAILED');
  assert.equal(g.calls.length, 0);
});
test('T2 limiter serializes concurrent same-shop sends without delaying another shop', async () => {
  const times: Array<[string, number]> = []; let time = 100_000;
  const f = await fixture({ minIntervalMs: 100, now: () => time, sleep: async ms => { time += ms; },
    transport: async req => { times.push([req.shop_id, time]); return { status: 200 }; } });
  await f.store.set('shop-b', token('shop-b'));
  await f.client.read(request); await f.client.read({ ...request, shop_id: 'shop-b' });
  await Promise.all([f.client.read(request), f.client.read(request)]);
  assert.deepEqual(times, [['shop-a', 100_000], ['shop-b', 100_000], ['shop-a', 100_100], ['shop-a', 100_200]]);
});
test('T2 adapter logs reuse T1 stream; secrets and upstream body never emitted', async () => {
  let output = '';
  const stream = createLogStream(new Writable({ write(chunk, _enc, cb) { output += chunk; cb(); } }), {});
  const f = await fixture({ log: record => { stream.write(JSON.stringify(record) + '\n'); },
    transport: async () => ({ status: 500, data: { token: '<placeholder-access>', message: '<placeholder-secret>' } }) });
  const result = await f.client.read(request);
  assert.deepEqual(result, { error: true, message: 'Upstream request failed', code: 'UPSTREAM_ERROR' });
  assert.deepEqual(JSON.parse(output), { event: 'tiktok_draft_response', status: 500 });
  assert.ok(!JSON.stringify(result).includes('placeholder'));
});
test('T2 transport/store exceptions return safe error envelope', async () => {
  for (const overrides of [{ transport: async () => { throw new Error('<placeholder-access>'); } },
    { store: { get: async () => { throw new Error('<placeholder-refresh>'); }, set: async () => {} } }]) {
    const f = await fixture(overrides);
    assert.deepEqual(await f.client.read(request), { error: true, message: 'Adapter request failed', code: 'ADAPTER_ERROR' });
  }
});
test('T2 coverage contains every MVP read category with draft-only statuses', () => {
  assert.deepEqual(coverage.map(row => row.category), ['products', 'orders', 'inventory', 'fulfillment', 'finance_overview']);
  for (const row of coverage) { assert.ok(['draft', 'not_implemented'].includes(row.status)); assert.ok(row.operations.length > 0); }
});
test('T2 configuration rejects unbounded retries and expired refresh output', async () => {
  await assert.rejects(fixture({ maxRetries: Infinity }), { message: 'Invalid adapter configuration' });
  const f = await fixture({ refresh: async () => token('shop-a', 0) });
  await f.store.set('shop-a', token('shop-a', 0));
  assert.equal((await f.client.read(request) as { code: string }).code, 'TOKEN_REFRESH_FAILED');
});
