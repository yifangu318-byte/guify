import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { AuthorizedShopsError, fetchAuthorizedShops, handleTikTokCallback } from '../src/tiktok/callback.js';
import { issueState } from '../src/tiktok/crypto.js';
import type { D1Binding, D1Prepared } from '../src/tiktok/d1.js';

// Synthetic fixtures only. All fetches and D1 operations are local mocks.
const SECRET = 'synthetic-diagnostics-encryption-key';
const NOW = 1_790_000_000_000;
const EXPIRES_AT = NOW + 7_200_000;
const MY_SHOP = { id: 'synthetic-diagnostics-shop-my', region: 'MY', cipher: 'synthetic-diagnostics-cipher' };
const PRIVATE_TEXT = 'synthetic-private-message https://synthetic.invalid/shops?app_key=synthetic-key&sign=synthetic-sign token=synthetic-access cipher=synthetic-cipher';

function stubGlobalFetch(t: TestContext, implementation: typeof fetch = async () => { throw new URIError(PRIVATE_TEXT); }) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = implementation;
  t.after(() => { globalThis.fetch = originalFetch; });
}

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

test('T11 shops diagnostics: standard client headers preserve token header and fail-closed empty shops', async () => {
  const requests: Array<{ init: RequestInit | undefined }> = [];
  const result = await callback(async (_url, init) => {
    requests.push({ init });
    return Response.json({ code: 0, data: { shops: [] } });
  });
  assert.equal(requests.length, 1);
  const headers = new Headers(requests[0]?.init?.headers);
  assert.equal(headers.get('Accept'), 'application/json');
  assert.equal(headers.get('User-Agent'), 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
  assert.equal(headers.get('x-tts-access-token'), 'synthetic-diagnostics-access');
  assert.deepEqual([...headers.keys()].sort(), ['accept', 'user-agent', 'x-tts-access-token']);
  assertFailure(result, 'shops_empty', 200);
});

test('T11 shops diagnostics: real and control throws retain only safe constructor names', async t => {
  stubGlobalFetch(t);
  const error = new TypeError(PRIVATE_TEXT);
  error.name = PRIVATE_TEXT;
  error.stack = PRIVATE_TEXT;
  const controlError = new RangeError(PRIVATE_TEXT);
  controlError.name = PRIVATE_TEXT;
  controlError.stack = PRIVATE_TEXT;
  let requests = 0;
  const result = await callback(async () => { throw ++requests === 1 ? error : controlError; });
  assert.equal(requests, 3);
  assertFailure(result, 'shops_fetch_thrown', null, {
    upstream_error_name: 'TypeError', control_responded: false, control_http: null, control_threw_name: 'RangeError',
    bisect_known_host: { responded: false, http: null, threw: 'RangeError' },
    bisect_bare_fetch: { responded: false, http: null, threw: 'URIError' },
  });
});

for (const status of [400, 200]) {
  test(`T11 shops diagnostics: control HTTP ${status} preserves original failure without reading its JSON error body`, async t => {
    stubGlobalFetch(t);
    const requests: Array<{ url: URL; headers: Headers }> = [];
    const controlResponse = Response.json({ code: 40001, message: PRIVATE_TEXT }, { status });
    const result = await callback(async (url, init) => {
      requests.push({ url: new URL(String(url)), headers: new Headers(init?.headers) });
      if (requests.length === 1) throw new TypeError(PRIVATE_TEXT);
      return controlResponse;
    });
    assert.equal(requests.length, 3);
    const [real, control] = requests;
    assert.ok(real && control);
    assert.equal(control.url.origin, 'https://open-api.tiktokglobalshop.com');
    assert.equal(control.url.pathname, '/authorization/202309/shops');
    assert.equal(control.url.origin, real.url.origin);
    assert.equal(control.url.pathname, real.url.pathname);
    assert.deepEqual([...control.url.searchParams.keys()].sort(), ['app_key', 'sign', 'timestamp']);
    assert.equal(control.url.searchParams.get('app_key'), 'synthetic-control-app-key');
    assert.equal(control.url.searchParams.get('sign'), 'synthetic-control-sign');
    assert.equal(control.url.searchParams.get('timestamp'), String(Math.floor(NOW / 1000)));
    assert.notEqual(control.url.searchParams.get('app_key'), real.url.searchParams.get('app_key'));
    assert.notEqual(control.url.searchParams.get('sign'), real.url.searchParams.get('sign'));
    assert.equal(real.headers.get('x-tts-access-token'), 'synthetic-diagnostics-access');
    assert.equal(control.headers.has('x-tts-access-token'), false);
    const expectedHeaders = new Headers(real.headers);
    expectedHeaders.delete('x-tts-access-token');
    assert.deepEqual([...control.headers], [...expectedHeaders]);
    assert.deepEqual([...control.headers.keys()].sort(), ['accept', 'user-agent']);
    assert.equal(controlResponse.bodyUsed, false);
    assertFailure(result, 'shops_fetch_thrown', null, {
      upstream_error_name: 'TypeError', control_responded: true, control_http: status, control_threw_name: null,
      bisect_known_host: { responded: true, http: status, threw: null },
      bisect_bare_fetch: { responded: false, http: null, threw: 'URIError' },
    });
  });
}

for (const responded of [true, false]) {
  test(`T11 shops diagnostics: thrown error itself carries exactly three control fields and two bisect fields (responded=${responded})`, async t => {
    stubGlobalFetch(t);
    let requests = 0;
    await assert.rejects(fetchAuthorizedShops({
      accessToken: 'synthetic-diagnostics-access',
      appKey: 'synthetic-diagnostics-app-key',
      appSecret: 'synthetic-diagnostics-app-secret',
      nowMs: NOW,
      fetchImpl: async () => {
        if (++requests === 1) throw new TypeError(PRIVATE_TEXT);
        if (!responded) throw { name: PRIVATE_TEXT, message: PRIVATE_TEXT };
        return Response.json({ code: 40001, message: PRIVATE_TEXT }, { status: 400 });
      },
    }), error => {
      assert.ok(error instanceof AuthorizedShopsError);
      assert.equal(error.diagnostic, 'shops_fetch_thrown');
      assert.equal(error.upstreamHttp, null);
      assert.equal(error.upstreamCode, null);
      assert.equal(error.upstreamErrorName, 'TypeError');
      assert.equal(error.control_responded, responded);
      assert.equal(error.control_http, responded ? 400 : null);
      assert.equal(error.control_threw_name, responded ? null : 'UnknownError');
      assert.deepEqual(error.bisect_known_host, { responded, http: responded ? 400 : null, threw: responded ? null : 'UnknownError' });
      assert.deepEqual(error.bisect_bare_fetch, { responded: false, http: null, threw: 'URIError' });
      assert.deepEqual(Object.keys(error).sort(), [
        'bisect_bare_fetch', 'bisect_known_host',
        'control_http', 'control_responded', 'control_threw_name', 'diagnostic', 'name',
        'upstreamCode', 'upstreamErrorName', 'upstreamHttp',
      ]);
      assert.doesNotMatch(JSON.stringify(error), /synthetic|https?:|app_key|sign=|token=|cipher=|stack/i);
      return true;
    });
    assert.equal(requests, 3);
  });
}

for (const knownResponded of [true, false]) {
  for (const bareResponded of [true, false]) {
    test(`T11 shops diagnostics: bisect probes preserve request shapes and safe results (known=${knownResponded}, bare=${bareResponded})`, async t => {
      const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
      const order: string[] = [];
      const controlResponse = Response.json({ message: PRIVATE_TEXT }, { status: 400 });
      const knownResponse = Response.json({ message: PRIVATE_TEXT }, { status: 302 });
      const bareResponse = Response.json({ message: PRIVATE_TEXT }, { status: 429 });
      // Only status may be accessed: any body, JSON, text, or other access fails.
      const statusOnly = (response: Response) => new Proxy(response, {
        get(target, property) {
          if (property === 'then') return undefined; // Promise resolution checks thenables.
          assert.equal(property, 'status');
          return target.status;
        },
      });
      const knownError = new ReferenceError(PRIVATE_TEXT);
      knownError.name = PRIVATE_TEXT;
      knownError.stack = PRIVATE_TEXT;
      let bareRequest: { url: string; init: RequestInit | undefined } | undefined;
      stubGlobalFetch(t, async (url, init) => {
        order.push('bare-fetch');
        bareRequest = { url: String(url), init };
        if (!bareResponded) throw { name: PRIVATE_TEXT, message: PRIVATE_TEXT, stack: PRIVATE_TEXT };
        return statusOnly(bareResponse);
      });
      const result = await callback(async (url, init) => {
        requests.push({ url: String(url), init });
        if (requests.length === 1) {
          order.push('real');
          throw new TypeError(PRIVATE_TEXT);
        }
        if (requests.length === 2) {
          order.push('control');
          return statusOnly(controlResponse);
        }
        order.push('known-host');
        if (!knownResponded) throw knownError;
        return statusOnly(knownResponse);
      });
      assert.deepEqual(order, ['real', 'control', 'known-host', 'bare-fetch']);
      assert.equal(requests.length, 3);
      assert.deepEqual(requests[2], { url: 'https://example.com/', init: { method: 'GET', redirect: 'manual' } });
      const control = requests[1];
      assert.ok(control && bareRequest);
      assert.equal(bareRequest.url, control.url);
      assert.deepEqual(bareRequest.init, control.init);
      assert.deepEqual(Object.keys(bareRequest.init ?? {}), ['headers']);
      assert.deepEqual([...new Headers(bareRequest.init?.headers).keys()].sort(), ['accept', 'user-agent']);
      assert.equal(new Headers(bareRequest.init?.headers).has('x-tts-access-token'), false);
      const bareUrl = new URL(bareRequest.url);
      assert.equal(bareUrl.origin, 'https://open-api.tiktokglobalshop.com');
      assert.equal(bareUrl.pathname, '/authorization/202309/shops');
      assert.deepEqual([...bareUrl.searchParams], [
        ['app_key', 'synthetic-control-app-key'],
        ['timestamp', String(Math.floor(NOW / 1000))],
        ['sign', 'synthetic-control-sign'],
      ]);
      assert.equal(controlResponse.bodyUsed, false);
      assert.equal(knownResponse.bodyUsed, false);
      assert.equal(bareResponse.bodyUsed, false);
      assertFailure(result, 'shops_fetch_thrown', null, {
        upstream_error_name: 'TypeError', control_responded: true, control_http: 400, control_threw_name: null,
        bisect_known_host: { responded: knownResponded, http: knownResponded ? 302 : null, threw: knownResponded ? null : 'ReferenceError' },
        bisect_bare_fetch: { responded: bareResponded, http: bareResponded ? 429 : null, threw: bareResponded ? null : 'UnknownError' },
      });
    });
  }
}

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

test('T11 shops diagnostics: non-Error fetch throw uses a fixed safe fallback', async t => {
  stubGlobalFetch(t);
  const result = await callback(async () => { throw PRIVATE_TEXT; });
  assertFailure(result, 'shops_fetch_thrown', null, {
    upstream_error_name: 'UnknownError', control_responded: false, control_http: null, control_threw_name: 'UnknownError',
    bisect_known_host: { responded: false, http: null, threw: 'UnknownError' },
    bisect_bare_fetch: { responded: false, http: null, threw: 'URIError' },
  });
});

test('T11 shops diagnostics: custom Error name cannot become response text', async t => {
  stubGlobalFetch(t);
  const CustomError = class extends Error {};
  Object.defineProperty(CustomError, 'name', { value: PRIVATE_TEXT });
  const result = await callback(async () => { throw new CustomError(PRIVATE_TEXT); });
  assertFailure(result, 'shops_fetch_thrown', null, {
    upstream_error_name: 'Error', control_responded: false, control_http: null, control_threw_name: 'Error',
    bisect_known_host: { responded: false, http: null, threw: 'Error' },
    bisect_bare_fetch: { responded: false, http: null, threw: 'URIError' },
  });
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
  let requests = 0;
  const result = await callback(async () => {
    requests++;
    return Response.json({ code: 0, data: { shops: [MY_SHOP] } });
  });
  assert.equal(requests, 1);
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
