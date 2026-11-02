import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultExchange, handleTikTokCallback, TokenExchangeError, readDecryptedShopToken } from '../src/tiktok/callback.js';
import { issueState } from '../src/tiktok/crypto.js';
import { getEncryptedShopToken, type D1Binding, type D1Prepared } from '../src/tiktok/d1.js';

// All values below are synthetic test fixtures. They are not real credentials,
// codes, tokens, or shop identifiers, and must never be used against a live API.
const TEST_SECRET = 'synthetic-token-fix-secret-t11';
const NOW = 1_790_000_000_000;
const EXPIRE_SEC = Math.floor((NOW + 7_200_000) / 1000);

type FakeResponse = { ok: boolean; status: number; json: () => Promise<Record<string, unknown>> };

function fakeFetch(capture: { url?: string }, payload: Record<string, unknown>, ok = true, status = 200): typeof fetch {
  return (async (url: string) => {
    capture.url = url;
    return { ok, status, json: async () => payload } as unknown as FakeResponse;
  }) as unknown as typeof fetch;
}

function queryOf(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

/** Minimal mock D1, same contract as the T10 test mock (mock only, not real D1). */
class MockD1Prepared implements D1Prepared {
  private args: unknown[] = [];
  constructor(private readonly store: Map<string, Record<string, unknown>>, private readonly sql: string) {}
  bind(...args: unknown[]): D1Prepared {
    const next = new MockD1Prepared(this.store, this.sql);
    next.args = args;
    return next;
  }
  async run(): Promise<unknown> {
    if (/INSERT INTO shop_tokens/i.test(this.sql)) {
      const [shopCode, market, accessTokenEnc, refreshTokenEnc, expiresAt, scope, createdAt, updatedAt] = this.args as [string, string, string, string, number, string, number, number];
      this.store.set(shopCode, { shop_code: shopCode, market, access_token_enc: accessTokenEnc, refresh_token_enc: refreshTokenEnc, expires_at: expiresAt, scope, created_at: createdAt, updated_at: updatedAt });
    }
    return { success: true };
  }
  async first<T = Record<string, unknown>>(): Promise<T | null> {
    if (/FROM shop_tokens WHERE shop_code/i.test(this.sql)) {
      return (this.store.get(String(this.args[0])) ?? null) as T;
    }
    return null;
  }
  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    return { results: [...this.store.values()] as T[] };
  }
}

class MockD1 implements D1Binding {
  readonly store = new Map<string, Record<string, unknown>>();
  prepare(sql: string): D1Prepared {
    return new MockD1Prepared(this.store, sql);
  }
}

test('T11 token fix: plain params only — app_secret present, sign/timestamp absent', async () => {
  const capture: { url?: string } = {};
  const exchange = createDefaultExchange(fakeFetch(capture, {
    code: 0,
    data: { access_token: 'synthetic-access-fix', refresh_token: 'synthetic-refresh-fix', access_token_expire_in: EXPIRE_SEC, shops: [{ shop_id: 'synthetic-shop-1', shop_cipher: 'synthetic-cipher-1' }], scope: 'synthetic.scope' },
  }));
  const result = await exchange({ code: 'synthetic-code-fix', appKey: 'synthetic-app-key', appSecret: 'synthetic-app-secret', nowMs: NOW });
  const params = queryOf(capture.url ?? '');
  assert.deepEqual([...params.keys()].sort(), ['app_key', 'app_secret', 'auth_code', 'grant_type']);
  assert.equal(params.get('app_key'), 'synthetic-app-key');
  assert.equal(params.get('app_secret'), 'synthetic-app-secret');
  assert.equal(params.get('auth_code'), 'synthetic-code-fix');
  assert.equal(params.get('grant_type'), 'authorized_code');
  assert.equal(new URL(capture.url ?? '').pathname, '/api/v2/token/get');
  assert.equal(result.shopId, 'synthetic-shop-1');
  assert.equal(result.expiresAtMs, EXPIRE_SEC * 1000);
});

test('T11 token fix: ms timestamp expiry + shops list, scope string preserved', async () => {
  const capture: { url?: string } = {};
  const exchange = createDefaultExchange(fakeFetch(capture, {
    code: '0',
    data: { access_token: 'synthetic-access-fix', refresh_token: 'synthetic-refresh-fix', access_token_expire_in: NOW + 3_600_000, shops: [{ shop_id: 987654321 }], scope: 'a,b' },
  }));
  const result = await exchange({ code: 'synthetic-code-fix', appKey: 'synthetic-app-key', appSecret: 'synthetic-app-secret', nowMs: NOW });
  assert.equal(result.expiresAtMs, NOW + 3_600_000);
  assert.equal(result.shopId, '987654321');
  assert.equal(result.scope, 'a,b');
});

test('T11 token fix: fallback expires_in + top-level shop_id + array scope', async () => {
  const exchange = createDefaultExchange(fakeFetch({}, {
    code: 0,
    data: { access_token: 'synthetic-access-fix', refresh_token: 'synthetic-refresh-fix', expires_in: 7200, shop_id: 'synthetic-shop-2', scope: ['x', 'y'] },
  }));
  const result = await exchange({ code: 'synthetic-code-fix', appKey: 'synthetic-app-key', appSecret: 'synthetic-app-secret', nowMs: NOW });
  assert.equal(result.expiresAtMs, NOW + 7_200_000);
  assert.equal(result.shopId, 'synthetic-shop-2');
  assert.equal(result.scope, 'x,y');
});

test('T11 token fix: upstream code != 0 fails with that code, no tokens returned', async () => {
  const exchange = createDefaultExchange(fakeFetch({}, { code: 40001, message: 'synthetic upstream message that must not leak', data: {} }));
  await assert.rejects(
    () => exchange({ code: 'synthetic-code-fix', appKey: 'synthetic-app-key', appSecret: 'synthetic-app-secret', nowMs: NOW }),
    (error: unknown) => {
      assert.ok(error instanceof TokenExchangeError);
      assert.equal((error as TokenExchangeError).upstreamHttp, 200);
      assert.equal((error as TokenExchangeError).upstreamCode, 40001);
      assert.ok(!String(error).includes('synthetic upstream message'));
      return true;
    },
  );
});

test('T11 token fix: HTTP non-OK and missing tokens fail safely', async () => {
  const httpFail = createDefaultExchange(fakeFetch({}, { code: 40101, message: 'synthetic' }, false, 401));
  await assert.rejects(
    () => httpFail({ code: 'synthetic-code-fix', appKey: 'synthetic-app-key', appSecret: 'synthetic-app-secret', nowMs: NOW }),
    (error: unknown) => error instanceof TokenExchangeError && (error as TokenExchangeError).upstreamHttp === 401 && (error as TokenExchangeError).upstreamCode === 40101,
  );
  const missingTokens = createDefaultExchange(fakeFetch({}, { code: 0, data: { access_token_expire_in: EXPIRE_SEC, shops: [{ shop_id: 'synthetic-shop-1' }] } }));
  await assert.rejects(
    () => missingTokens({ code: 'synthetic-code-fix', appKey: 'synthetic-app-key', appSecret: 'synthetic-app-secret', nowMs: NOW }),
    (error: unknown) => error instanceof TokenExchangeError && (error as TokenExchangeError).upstreamCode === 'invalid_response',
  );
  const networkFail = createDefaultExchange((async () => { throw new Error('synthetic network failure'); }) as unknown as typeof fetch);
  await assert.rejects(
    () => networkFail({ code: 'synthetic-code-fix', appKey: 'synthetic-app-key', appSecret: 'synthetic-app-secret', nowMs: NOW }),
    (error: unknown) => error instanceof TokenExchangeError && (error as TokenExchangeError).upstreamHttp === null && (error as TokenExchangeError).upstreamCode === 'network',
  );
});

test('T11 token fix: callback diagnostic carries only http/code, never code/token/secret', async () => {
  const db = new MockD1();
  const state = issueState(TEST_SECRET, { now: () => NOW, nonce: 'test-nonce-fix12345', market: 'MY' }).state;
  const failed = await handleTikTokCallback({ code: 'synthetic-code-fix', state }, {
    secret: TEST_SECRET, appKey: 'synthetic-app-key', appSecret: 'synthetic-app-secret', db, now: () => NOW,
    exchange: async () => { throw new TokenExchangeError(200, 40001); },
  });
  assert.equal(failed.status, 502);
  assert.equal(failed.body.code, 'UPSTREAM_ERROR');
  assert.equal(failed.body.upstream_http, 200);
  assert.equal(failed.body.upstream_code, 40001);
  assert.ok(!JSON.stringify(failed.body).includes('synthetic-code-fix'));
  assert.ok(!JSON.stringify(failed.body).includes('synthetic-app-secret'));
});

test('T11 token fix: full callback with timestamp + shops succeeds, encrypts, expires correctly', async () => {
  const db = new MockD1();
  const state = issueState(TEST_SECRET, { now: () => NOW, nonce: 'test-nonce-fix67890', market: 'MY' }).state;
  const fetchImpl = fakeFetch({}, {
    code: 0,
    data: { access_token: 'synthetic-access-fix', refresh_token: 'synthetic-refresh-fix', access_token_expire_in: EXPIRE_SEC, shops: [{ shop_id: 'synthetic-shop-1', shop_cipher: 'synthetic-cipher-1' }], scope: 'synthetic.scope' },
  });
  const good = await handleTikTokCallback({ code: 'synthetic-code-fix', state }, {
    secret: TEST_SECRET, appKey: 'synthetic-app-key', appSecret: 'synthetic-app-secret', db, fetchImpl, now: () => NOW,
  });
  assert.equal(good.status, 200);
  assert.deepEqual(good.body, { error: false, shop_code: 'synthetic-shop-1', market: 'MY', expires_at: EXPIRE_SEC * 1000 });
  assert.ok(!JSON.stringify(good.body).includes('synthetic-access-fix'));
  const read = await readDecryptedShopToken(db, TEST_SECRET, 'synthetic-shop-1');
  assert.equal(read?.accessToken, 'synthetic-access-fix');
  assert.equal(read?.expiresAt, EXPIRE_SEC * 1000);
  assert.equal((await getEncryptedShopToken(db, 'synthetic-shop-1'))?.market, 'MY');
});
