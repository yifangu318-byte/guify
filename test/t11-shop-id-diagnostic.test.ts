import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultExchange, handleTikTokCallback, TokenExchangeError, readDecryptedShopToken } from '../src/tiktok/callback.js';
import { issueState } from '../src/tiktok/crypto.js';
import { getEncryptedShopToken, type D1Binding, type D1Prepared } from '../src/tiktok/d1.js';

// All values below are synthetic test fixtures. They are not real credentials,
// codes, tokens, or shop identifiers, and must never be used against a live API.
const TEST_SECRET = 'synthetic-token-diag-secret-t11';
const NOW = 1_790_000_000_000;
const EXPIRE_SEC = Math.floor((NOW + 7_200_000) / 1000);

type FakeResponse = { ok: boolean; status: number; json: () => Promise<Record<string, unknown>> };

function fakeFetch(payload: Record<string, unknown>, ok = true, status = 200): typeof fetch {
  return (async () => ({ ok, status, json: async () => payload } as unknown as FakeResponse)) as unknown as typeof fetch;
}

/** Minimal mock D1, same contract as the T10/T11 test mocks (mock only, not real D1). */
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

function stateFor(nonce: string): string {
  return issueState(TEST_SECRET, { now: () => NOW, nonce, market: 'MY' }).state;
}

test('T11 shop diagnostic: numeric top-level shop_id succeeds with correct shop_code and expires_at', async () => {
  const db = new MockD1();
  const fetchImpl = fakeFetch({
    code: 0,
    data: { access_token: 'synthetic-access-diag', refresh_token: 'synthetic-refresh-diag', access_token_expire_in: EXPIRE_SEC, shop_id: 123456789 },
  });
  const good = await handleTikTokCallback({ code: 'synthetic-code-diag', state: stateFor('test-nonce-diag111') }, {
    secret: TEST_SECRET,
    appKey: 'synthetic-app-key',
    appSecret: 'synthetic-app-secret',
    db,
    fetchImpl,
    now: () => NOW,
  });
  assert.equal(good.status, 200);
  assert.deepEqual(good.body, { error: false, shop_code: '123456789', market: 'MY', expires_at: EXPIRE_SEC * 1000 });
  assert.ok(!JSON.stringify(good.body).includes('synthetic-access-diag'));
  const stored = await readDecryptedShopToken(db, TEST_SECRET, '123456789');
  assert.equal(stored?.accessToken, 'synthetic-access-diag');
  assert.equal(stored?.market, 'MY');
});

test('T11 shop diagnostic: numeric top-level shopId (camelCase) succeeds', async () => {
  const exchange = createDefaultExchange(fakeFetch({
    code: 0,
    data: { access_token: 'synthetic-access-diag', refresh_token: 'synthetic-refresh-diag', access_token_expire_in: EXPIRE_SEC, shopId: 555666777 },
  }));
  const result = await exchange({ code: 'synthetic-code-diag', appKey: 'synthetic-app-key', appSecret: 'synthetic-app-secret', nowMs: NOW });
  assert.equal(result.shopId, '555666777');
});

test('T11 shop diagnostic: shops[0] numeric still succeeds', async () => {
  const db = new MockD1();
  const fetchImpl = fakeFetch({
    code: 0,
    data: { access_token: 'synthetic-access-diag', refresh_token: 'synthetic-refresh-diag', access_token_expire_in: EXPIRE_SEC, shops: [{ shop_id: 987654321 }] },
  });
  const good = await handleTikTokCallback({ code: 'synthetic-code-diag', state: stateFor('test-nonce-diag222') }, {
    secret: TEST_SECRET,
    appKey: 'synthetic-app-key',
    appSecret: 'synthetic-app-secret',
    db,
    fetchImpl,
    now: () => NOW,
  });
  assert.equal(good.status, 200);
  assert.equal(good.body.shop_code, '987654321');
});

test('T11 shop diagnostic: shop missing -> 502 shop_missing and no D1 write', async () => {
  const db = new MockD1();
  const failed = await handleTikTokCallback({ code: 'synthetic-code-diag', state: stateFor('test-nonce-diag333') }, {
    secret: TEST_SECRET,
    appKey: 'synthetic-app-key',
    appSecret: 'synthetic-app-secret',
    db,
    exchange: async () => ({ accessToken: 'synthetic-access-diag', refreshToken: 'synthetic-refresh-diag', expiresAtMs: NOW + 3_600_000, scope: '' }),
    now: () => NOW,
  });
  assert.equal(failed.status, 502);
  assert.equal(failed.body.code, 'UPSTREAM_ERROR');
  assert.equal(failed.body.upstream_http, null);
  assert.equal(failed.body.upstream_code, 'shop_missing');
  assert.equal(db.store.size, 0);
  assert.equal(await getEncryptedShopToken(db, 'synthetic-shop-missing'), undefined);
});

test('T11 shop diagnostic: expires missing -> 502 expires_missing and no D1 write', async () => {
  const db = new MockD1();
  const failed = await handleTikTokCallback({ code: 'synthetic-code-diag', state: stateFor('test-nonce-diag444') }, {
    secret: TEST_SECRET,
    appKey: 'synthetic-app-key',
    appSecret: 'synthetic-app-secret',
    db,
    exchange: async () => ({ accessToken: 'synthetic-access-diag', refreshToken: 'synthetic-refresh-diag', shopId: 'synthetic-shop-9', scope: '' }),
    now: () => NOW,
  });
  assert.equal(failed.status, 502);
  assert.equal(failed.body.code, 'UPSTREAM_ERROR');
  assert.equal(failed.body.upstream_http, null);
  assert.equal(failed.body.upstream_code, 'expires_missing');
  assert.equal(db.store.size, 0);
});

test('T11 shop diagnostic: generic exchange error -> 502 exchange_error, not invalid_response', async () => {
  const db = new MockD1();
  const failed = await handleTikTokCallback({ code: 'synthetic-code-diag', state: stateFor('test-nonce-diag555') }, {
    secret: TEST_SECRET,
    appKey: 'synthetic-app-key',
    appSecret: 'synthetic-app-secret',
    db,
    exchange: async () => { throw new Error('synthetic generic exchange failure'); },
    now: () => NOW,
  });
  assert.equal(failed.status, 502);
  assert.equal(failed.body.code, 'UPSTREAM_ERROR');
  assert.equal(failed.body.upstream_http, null);
  assert.equal(failed.body.upstream_code, 'exchange_error');
  assert.ok(!JSON.stringify(failed.body).includes('synthetic generic exchange failure'));
});

test('T11 shop diagnostic: TokenExchangeError diagnostics unchanged', async () => {
  const db = new MockD1();
  const tikTokCode = await handleTikTokCallback({ code: 'synthetic-code-diag', state: stateFor('test-nonce-diag666') }, {
    secret: TEST_SECRET,
    appKey: 'synthetic-app-key',
    appSecret: 'synthetic-app-secret',
    db,
    exchange: async () => { throw new TokenExchangeError(200, 36004003); },
    now: () => NOW,
  });
  assert.equal(tikTokCode.status, 502);
  assert.equal(tikTokCode.body.upstream_http, 200);
  assert.equal(tikTokCode.body.upstream_code, 36004003);
  const network = await handleTikTokCallback({ code: 'synthetic-code-diag', state: stateFor('test-nonce-diag777') }, {
    secret: TEST_SECRET,
    appKey: 'synthetic-app-key',
    appSecret: 'synthetic-app-secret',
    db,
    exchange: async () => { throw new TokenExchangeError(null, 'network'); },
    now: () => NOW,
  });
  assert.equal(network.body.upstream_http, null);
  assert.equal(network.body.upstream_code, 'network');
});
