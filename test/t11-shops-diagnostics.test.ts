import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleTikTokCallback } from '../src/tiktok/callback.js';
import { issueState } from '../src/tiktok/crypto.js';
import type { D1Binding, D1Prepared } from '../src/tiktok/d1.js';

// Synthetic fixtures only. All fetches and D1 operations are local mocks.
const SECRET = 'synthetic-diagnostics-encryption-key';
const NOW = 1_790_000_000_000;
const EXPIRES_AT = NOW + 7_200_000;
const MY_SHOP = { id: 'synthetic-diagnostics-shop-my', region: 'MY', cipher: 'synthetic-diagnostics-cipher' };
const PRIVATE_TEXT = 'synthetic-private-message https://synthetic.invalid/shops?app_key=synthetic-key&sign=synthetic-sign token=synthetic-access cipher=synthetic-cipher';

async function callback(fetchImpl: typeof fetch) {
  const prepared: string[] = [];
  const writes: Array<{ sql: string; args: unknown[] }> = [];
  const db: D1Binding = {
    prepare(sql) {
      prepared.push(sql);
      let args: unknown[] = [];
      const statement: D1Prepared = {
        bind(...values) { args = values; return statement; },
        async run() { writes.push({ sql, args }); return { success: true }; },
        async first() { return null; },
        async all() { return { results: [] }; },
      };
      return statement;
    },
  };
  const outcome = await handleTikTokCallback(
    { code: 'synthetic-diagnostics-auth-code', state: issueState(SECRET, { now: () => NOW, nonce: 'synthetic-diagnostics-nonce', market: 'MY' }).state },
    {
      secret: SECRET,
      appKey: 'synthetic-diagnostics-app-key',
      appSecret: 'synthetic-diagnostics-app-secret',
      db,
      now: () => NOW,
      // Skip token HTTP exchange so fetchImpl exercises only the shops path.
      exchange: async () => ({ accessToken: 'synthetic-diagnostics-access', refreshToken: 'synthetic-diagnostics-refresh', expiresAtMs: EXPIRES_AT, scope: '' }),
      fetchImpl,
    },
  );
  return { outcome, prepared, writes };
}

function responseFetch(payload: unknown, status = 200): typeof fetch {
  return async () => Response.json(payload, { status });
}

function assertFailure(result: Awaited<ReturnType<typeof callback>>, diagnostic: string, http: number | null, extra: Record<string, unknown> = {}) {
  assert.deepEqual(result.outcome, {
    status: 502,
    body: { error: true, message: 'Authorized shops lookup failed', code: 'UPSTREAM_ERROR', upstream_http: http, upstream_code: diagnostic, ...extra },
    logEvent: 'exchange_failed',
  });
  // No schema operation, prepare, or write is allowed before shops succeeds.
  assert.deepEqual(result.prepared, []);
  assert.deepEqual(result.writes, []);
  assert.doesNotMatch(JSON.stringify(result.outcome.body), /synthetic|https?:|app_key|sign=|token=|cipher=|stack/i);
}

test('T11 shops diagnostics: fetch TypeError has only its constructor name and no private text', async () => {
  const error = new TypeError(PRIVATE_TEXT);
  error.name = PRIVATE_TEXT;
  error.stack = PRIVATE_TEXT;
  const result = await callback(async () => { throw error; });
  assertFailure(result, 'shops_fetch_thrown', null, { upstream_error_name: 'TypeError' });
});

test('T11 shops diagnostics: internal plain Error outside handled response branches is distinct', async () => {
  const error = new Error(PRIVATE_TEXT);
  error.name = PRIVATE_TEXT;
  error.stack = PRIVATE_TEXT;
  const result = await callback(async () => ({
    status: 200,
    json: async () => ({ code: 0, data: { shops: [MY_SHOP] } }),
    get ok() { throw error; },
  }) as Response);
  assertFailure(result, 'shops_internal_error', null, { upstream_error_name: 'Error' });
});

test('T11 shops diagnostics: invalid null response is an internal TypeError', async () => {
  const result = await callback(async () => null as unknown as Response);
  assertFailure(result, 'shops_internal_error', null, { upstream_error_name: 'TypeError' });
});

test('T11 shops diagnostics: non-Error fetch throw uses a fixed safe fallback', async () => {
  const result = await callback(async () => { throw PRIVATE_TEXT; });
  assertFailure(result, 'shops_fetch_thrown', null, { upstream_error_name: 'UnknownError' });
});

test('T11 shops diagnostics: custom Error name cannot become response text', async () => {
  const CustomError = class extends Error {};
  Object.defineProperty(CustomError, 'name', { value: PRIVATE_TEXT });
  const result = await callback(async () => { throw new CustomError(PRIVATE_TEXT); });
  assertFailure(result, 'shops_fetch_thrown', null, { upstream_error_name: 'Error' });
});

test('T11 shops diagnostics: JSON parse failure keeps HTTP status and legacy category', async () => {
  const result = await callback(async () => new Response('synthetic-invalid-json', { status: 503 }));
  assertFailure(result, 'shops_fetch_failed', 503);
});

test('T11 shops diagnostics: TikTok rejection keeps its code and HTTP status', async () => {
  const result = await callback(responseFetch({ code: 40001, message: PRIVATE_TEXT }, 200));
  assertFailure(result, 'shops_fetch_failed', 200, { upstream_tiktok_code: 40001 });
});

test('T11 shops diagnostics: non-OK response keeps HTTP status and returned TikTok code', async () => {
  const result = await callback(responseFetch({ code: 0, message: PRIVATE_TEXT }, 429));
  assertFailure(result, 'shops_fetch_failed', 429, { upstream_tiktok_code: 0 });
});

test('T11 shops diagnostics: non-OK response without TikTok code keeps HTTP status', async () => {
  const result = await callback(responseFetch({ message: PRIVATE_TEXT }, 502));
  assertFailure(result, 'shops_fetch_failed', 502, { upstream_tiktok_code: 'invalid_response' });
});

for (const [label, shops] of [['empty', []], ['non-array', {}]] as const) {
  test(`T11 shops diagnostics: ${label} shops keeps shops_empty`, async () => {
    const result = await callback(responseFetch({ code: 0, data: { shops } }));
    assertFailure(result, 'shops_empty', 200);
  });
}

test('T11 shops diagnostics: selected shop without cipher keeps shops_cipher_missing', async () => {
  const result = await callback(responseFetch({ code: 0, data: { shops: [{ id: MY_SHOP.id, region: 'MY' }] } }));
  assertFailure(result, 'shops_cipher_missing', null);
});

test('T11 shops diagnostics: multiple shops without market match keeps shops_no_match', async () => {
  const result = await callback(responseFetch({ code: 0, data: { shops: [
    { ...MY_SHOP, region: 'SG' },
    { ...MY_SHOP, id: 'synthetic-diagnostics-shop-th', region: 'TH' },
  ] } }));
  assertFailure(result, 'shops_no_match', null);
});

test('T11 shops diagnostics: single MY shop preserves success body and saves selected shop', async () => {
  const result = await callback(responseFetch({ code: 0, data: { shops: [MY_SHOP] } }));
  assert.deepEqual(result.outcome, {
    status: 200,
    body: { error: false, shop_code: MY_SHOP.id, market: 'MY', expires_at: EXPIRES_AT },
    logEvent: 'success',
  });
  const inserts = result.writes.filter(write => /INSERT INTO shop_tokens/.test(write.sql));
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0]?.args[0], MY_SHOP.id);
  assert.equal(inserts[0]?.args[1], 'MY');
  assert.equal(inserts[0]?.args[6], MY_SHOP.cipher);
});
