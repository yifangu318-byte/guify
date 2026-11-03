import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { buildApp, type TiktokRuntime } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AuthorizedShopsError, fetchAuthorizedShops, handleTikTokCallback, type CallbackDeps } from '../src/tiktok/callback.js';
import { issueState } from '../src/tiktok/crypto.js';
import type { D1Binding } from '../src/tiktok/d1.js';

// Synthetic fixtures only; all network and database operations are mocked.
const NOW = 1_790_000_000_000;
const RELAY_URL = 'https://synthetic-relay.invalid';
const RELAY_SECRET = 'synthetic-relay-secret';
const SECRET = 'synthetic-relay-encryption-key';
const SHOP = { id: 'synthetic-relay-shop', cipher: 'synthetic-relay-cipher', region: 'MY' };
const INPUT = {
  accessToken: 'synthetic-relay-access', appKey: 'synthetic-relay-app-key',
  appSecret: 'synthetic-relay-app-secret', nowMs: NOW,
};
const QUERY = {
  code: 'synthetic-relay-auth-code',
  state: issueState(SECRET, { now: () => NOW, nonce: 'synthetic-relay-nonce', market: 'MY' }).state,
};

function shopsResponse() {
  return Response.json({ code: 0, data: { shops: [SHOP] } });
}

async function callback(fetchImpl: typeof fetch, relay: Pick<CallbackDeps, 'relayUrl' | 'relaySecret'> = { relayUrl: RELAY_URL, relaySecret: RELAY_SECRET }) {
  const prepared: string[] = [];
  const db: D1Binding = { prepare(sql) { prepared.push(sql); throw new Error('synthetic unexpected DB access'); } };
  const outcome = await handleTikTokCallback(QUERY, {
    secret: SECRET, appKey: INPUT.appKey, appSecret: INPUT.appSecret, db, now: () => NOW,
    exchange: async () => ({ accessToken: INPUT.accessToken, refreshToken: 'synthetic-relay-refresh', expiresAtMs: NOW + 7_200_000, scope: '' }),
    fetchImpl, ...relay,
  });
  assert.deepEqual(prepared, []);
  return outcome;
}

function assertFailure(outcome: Awaited<ReturnType<typeof callback>>, diagnostic: string, http: number | null, extra = {}) {
  assert.deepEqual(outcome, {
    status: 502, logEvent: 'exchange_failed',
    body: { error: true, message: 'Authorized shops lookup failed', code: 'UPSTREAM_ERROR', upstream_http: http, upstream_code: diagnostic, ...extra },
  });
  // Exact body assertion also excludes all control fields and private values.
  assert.doesNotMatch(JSON.stringify(outcome), /synthetic|https?:|stack|control_/i);
}

test('T11 relay: success parses id/cipher and preserves the direct signed query and headers', async () => {
  let directQuery = '';
  let directHeaders = new Headers();
  await fetchAuthorizedShops({ ...INPUT, fetchImpl: async (url, init) => {
    directQuery = new URL(String(url)).search;
    directHeaders = new Headers(init?.headers);
    return shopsResponse();
  } });
  let calls = 0;
  const shops = await fetchAuthorizedShops({ ...INPUT, relayUrl: `${RELAY_URL}/`, relaySecret: RELAY_SECRET, fetchImpl: async (url, init) => {
    calls++;
    assert.equal(String(url), `${RELAY_URL}/forward${directQuery}`);
    assert.deepEqual([...new URL(String(url)).searchParams.keys()].sort(), ['app_key', 'sign', 'timestamp']);
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'manual');
    assert.equal(init?.body, JSON.stringify({ host: 'open-api.tiktokglobalshop.com', path: '/authorization/202309/shops' }));
    const expectedHeaders = new Headers(directHeaders);
    expectedHeaders.set('x-relay-secret', RELAY_SECRET);
    expectedHeaders.set('Content-Type', 'application/json');
    assert.deepEqual([...new Headers(init?.headers)], [...expectedHeaders]);
    return shopsResponse();
  } });
  assert.equal(calls, 1);
  assert.deepEqual(shops, [SHOP]);
});

for (const [status, diagnostic] of [[401, 'relay_unauthorized'], [400, 'relay_bad_target'], [502, 'relay_unavailable']] as const) {
  test(`T11 relay: HTTP ${status} maps to ${diagnostic} without parsing body or probing`, async () => {
    let calls = 0;
    const response = status === 502 ? Response.json({ error: 'Bad gateway' }, { status }) : new Response('synthetic-private-relay-body', { status });
    const outcome = await callback(async () => { calls++; return response; });
    assert.equal(calls, 1);
    assert.equal(response.bodyUsed, false);
    assertFailure(outcome, diagnostic, status);
  });
}

test('T11 relay: thrown fetch retains safe constructor only and never probes direct host', async () => {
  const error = new TypeError();
  Object.defineProperties(error, {
    message: { get() { assert.fail('must not read message'); } },
    stack: { get() { assert.fail('must not read stack'); } },
    name: { get() { assert.fail('must not read name'); } },
  });
  let calls = 0;
  const outcome = await callback(async url => {
    calls++;
    assert.equal(new URL(String(url)).origin, RELAY_URL);
    throw error;
  });
  assert.equal(calls, 1);
  assertFailure(outcome, 'relay_unavailable', null, { upstream_error_name: 'TypeError' });
});

for (const relaySecret of [undefined, '', ' \t ']) {
  test(`T11 relay: ${JSON.stringify(relaySecret)} secret fails closed before fetch`, async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => { calls++; return shopsResponse(); };
    await assert.rejects(fetchAuthorizedShops({ ...INPUT, relayUrl: RELAY_URL, relaySecret, fetchImpl }), error => {
      assert.ok(error instanceof AuthorizedShopsError);
      assert.equal(error.diagnostic, 'relay_config_missing');
      assert.equal(error.upstreamHttp, null);
      return true;
    });
    assertFailure(await callback(fetchImpl, { relayUrl: RELAY_URL, relaySecret }), 'relay_config_missing', null);
    assert.equal(calls, 0);
  });
}

for (const relayUrl of [undefined, '', '   ']) {
  test(`T11 relay: ${JSON.stringify(relayUrl)} URL preserves direct GET with no relay headers/body`, async () => {
    let calls = 0;
    const shops = await fetchAuthorizedShops({ ...INPUT, relayUrl, relaySecret: RELAY_SECRET, fetchImpl: async (url, init) => {
      calls++;
      assert.equal(new URL(String(url)).origin, 'https://open-api.tiktokglobalshop.com');
      assert.equal(new URL(String(url)).pathname, '/authorization/202309/shops');
      assert.equal(init?.method ?? 'GET', 'GET');
      assert.equal(init?.body, undefined);
      assert.deepEqual([...new Headers(init?.headers).keys()].sort(), ['accept', 'user-agent', 'x-tts-access-token']);
      return shopsResponse();
    } });
    assert.equal(calls, 1);
    assert.deepEqual(shops, [SHOP]);
  });
}

for (const { status, payload, diagnostic, http, extra } of [
  { status: 200, payload: { code: 40001, message: 'synthetic-private-upstream-body' }, diagnostic: 'shops_fetch_failed', http: 200, extra: { upstream_tiktok_code: 40001 } },
  { status: 429, payload: { code: 0 }, diagnostic: 'shops_fetch_failed', http: 429, extra: { upstream_tiktok_code: 0 } },
  { status: 200, payload: { code: 0, data: { shops: [] } }, diagnostic: 'shops_empty', http: 200 },
  { status: 200, payload: { code: 0, data: { shops: [{ id: SHOP.id }] } }, diagnostic: 'shops_cipher_missing', http: null },
  { status: 200, payload: { code: 0, data: { shops: [{ ...SHOP, region: 'SG' }, { ...SHOP, region: 'TH' }] } }, diagnostic: 'shops_no_match', http: null },
]) {
  test(`T11 relay: forwarded TikTok response preserves ${diagnostic} (HTTP ${status})`, async () => {
    const outcome = await callback(async () => Response.json(payload, { status }));
    assertFailure(outcome, diagnostic, http, extra);
  });
}

test('T11 relay: forwarded malformed JSON preserves shops_fetch_failed', async () => {
  assertFailure(await callback(async () => new Response('synthetic-invalid-json', { status: 503 })), 'shops_fetch_failed', 503);
});

for (const mode of ['getters', 'env', 'undefined-getter'] as const) {
  test(`T11 relay: callback route wires ${mode} with getter precedence and private logs`, async t => {
    const previous = { url: process.env.RELAY_URL, secret: process.env.RELAY_SECRET };
    process.env.RELAY_URL = 'https://synthetic-env-relay.invalid';
    process.env.RELAY_SECRET = 'synthetic-env-relay-secret';
    let logText = '';
    const logs = new Writable({ write(chunk, _encoding, done) { logText += chunk.toString(); done(); } });
    let tokenCalls = 0;
    let shopCalls = 0;
    const runtime: TiktokRuntime = {
      getSecret: () => SECRET, getAppKey: () => INPUT.appKey, getAppSecret: () => INPUT.appSecret,
      getDb: () => ({ prepare() { assert.fail('must not write on shops failure'); } }), now: () => NOW,
      fetchImpl: async (url, init) => {
        const parsed = new URL(String(url));
        if (parsed.hostname === 'auth.tiktok-shops.com') {
          tokenCalls++;
          return Response.json({ code: 0, data: { access_token: INPUT.accessToken, refresh_token: 'synthetic-relay-refresh', expires_in: 7200 } });
        }
        shopCalls++;
        if (mode === 'undefined-getter') {
          assert.equal(parsed.origin, 'https://open-api.tiktokglobalshop.com');
          assert.equal(new Headers(init?.headers).has('x-relay-secret'), false);
        } else {
          assert.equal(parsed.origin, mode === 'getters' ? RELAY_URL : 'https://synthetic-env-relay.invalid');
          assert.equal(new Headers(init?.headers).get('x-relay-secret'), mode === 'getters' ? RELAY_SECRET : 'synthetic-env-relay-secret');
        }
        return Response.json({ code: 0, data: { shops: [] } });
      },
      ...(mode === 'env' ? {} : { getRelayUrl: () => mode === 'getters' ? RELAY_URL : undefined, getRelaySecret: () => RELAY_SECRET }),
    };
    t.mock.method(globalThis, 'fetch', runtime.fetchImpl!);
    const app = buildApp(loadConfig({}), logs, {}, {}, { tiktok: runtime });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/tiktok/callback', query: QUERY });
      assert.equal(response.statusCode, 502);
      assert.equal(response.json().upstream_code, 'shops_empty');
      assert.equal(tokenCalls, 1);
      assert.equal(shopCalls, 1);
      assert.doesNotMatch(logText, /synthetic|x-relay-secret|access_token|sign=/i);
    } finally {
      await app.close();
      if (previous.url === undefined) delete process.env.RELAY_URL; else process.env.RELAY_URL = previous.url;
      if (previous.secret === undefined) delete process.env.RELAY_SECRET; else process.env.RELAY_SECRET = previous.secret;
    }
  });
}
