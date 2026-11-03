import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { fetchAuthorizedShops, handleTikTokCallback, readDecryptedShopToken, selectAuthorizedShop } from '../src/tiktok/callback.js';
import { issueState } from '../src/tiktok/crypto.js';
import { getEncryptedShopToken, type D1Binding, type D1Prepared } from '../src/tiktok/d1.js';

// All values below are synthetic test fixtures. They are not real credentials,
// codes, tokens, ciphers, or shop identifiers, and must never be used against
// a live API.
const TEST_SECRET = 'synthetic-test-secret-cipher';
const NOW = 1_790_000_000_000;
const EXPIRE_SEC = Math.floor((NOW + 7_200_000) / 1000);
const TOKEN_PAYLOAD = {
  code: 0,
  data: { access_token: 'synthetic-access-cipher', refresh_token: 'synthetic-refresh-cipher', access_token_expire_in: EXPIRE_SEC },
};

type FakeResponse = { ok: boolean; status: number; json: () => Promise<Record<string, unknown>> };

function fakeResponse(payload: Record<string, unknown>, ok = true, status = 200): FakeResponse {
  return { ok, status, json: async () => payload };
}

/** Routes by host: token host -> token payload, shops host -> shops payload; captures shops requests. */
function routingFetch(shopsPayload: Record<string, unknown>, capture: { url?: string; headers?: Record<string, string>; tokenUrl?: string }): typeof fetch {
  return (async (url: string, init?: { headers?: Record<string, string> }) => {
    if (url.includes('open-api.tiktokglobalshop.com')) {
      capture.url = url;
      capture.headers = init?.headers ?? {};
      return fakeResponse(shopsPayload) as unknown as Response;
    }
    if (url.includes('auth.tiktok-shops.com')) {
      capture.tokenUrl = url;
      return fakeResponse(TOKEN_PAYLOAD) as unknown as Response;
    }
    throw new Error('synthetic unexpected fetch host');
  }) as unknown as typeof fetch;
}

/** Minimal mock D1 that stores all 9 shop_tokens columns including shop_cipher. */
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
      const [shopCode, market, accessTokenEnc, refreshTokenEnc, expiresAt, scope, shopCipher, createdAt, updatedAt] = this.args as [string, string, string, string, number, string, string, number, number];
      this.store.set(shopCode, { shop_code: shopCode, market, access_token_enc: accessTokenEnc, refresh_token_enc: refreshTokenEnc, expires_at: expiresAt, scope, shop_cipher: shopCipher, created_at: createdAt, updated_at: updatedAt });
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

function stateFor(nonce: string, market?: string): string {
  return issueState(TEST_SECRET, { now: () => NOW, nonce, ...(market ? { market } : {}) }).state;
}

function callbackDeps(db: MockD1, capture: { url?: string; headers?: Record<string, string>; tokenUrl?: string }, shopsPayload: Record<string, unknown>) {
  return {
    secret: TEST_SECRET,
    appKey: 'synthetic-app-key',
    appSecret: 'synthetic-app-secret',
    db,
    fetchImpl: routingFetch(shopsPayload, capture),
    now: () => NOW,
  };
}

const MY_SHOP = { id: 'synthetic-shop-my', cipher: 'synthetic-cipher-my', code: 'synthetic-local-my', name: 'synthetic my shop', region: 'MY', seller_type: 'CROSS_BORDER' };

test('T11 authorized shops: token shop missing + single MY shop -> success, cipher saved', async () => {
  const db = new MockD1();
  const capture: { url?: string; headers?: Record<string, string>; tokenUrl?: string } = {};
  const good = await handleTikTokCallback(
    { code: 'synthetic-code-cipher', state: stateFor('test-nonce-cipher1', 'MY') },
    callbackDeps(db, capture, { code: 0, data: { shops: [MY_SHOP] } }),
  );
  assert.equal(good.status, 200);
  assert.deepEqual(good.body, { error: false, shop_code: 'synthetic-shop-my', market: 'MY', expires_at: EXPIRE_SEC * 1000 });
  assert.ok(!JSON.stringify(good.body).includes('synthetic-cipher-my'));
  assert.ok(!JSON.stringify(good.body).includes('synthetic-access-cipher'));
  // Token request stays plain: no sign/timestamp in its query.
  const tokenUrl = new URL(capture.tokenUrl ?? '');
  assert.deepEqual([...tokenUrl.searchParams.keys()].sort(), ['app_key', 'app_secret', 'auth_code', 'grant_type']);
  const stored = await readDecryptedShopToken(db, TEST_SECRET, 'synthetic-shop-my');
  assert.equal(stored?.accessToken, 'synthetic-access-cipher');
  assert.equal(stored?.shopCipher, 'synthetic-cipher-my');
  assert.equal(stored?.market, 'MY');
  const raw = await getEncryptedShopToken(db, 'synthetic-shop-my');
  assert.equal(raw?.shopCipher, 'synthetic-cipher-my');
});

test('T11 authorized shops: multi-shop region matching selects MY, not first overall', async () => {
  const db = new MockD1();
  const capture: { url?: string; headers?: Record<string, string>; tokenUrl?: string } = {};
  const shops = [
    { id: 'synthetic-shop-sg', cipher: 'synthetic-cipher-sg', code: 'synthetic-local-sg', name: 'sg shop', region: 'SG', seller_type: 'CROSS_BORDER' },
    MY_SHOP,
    { id: 'synthetic-shop-th', cipher: 'synthetic-cipher-th', code: 'synthetic-local-th', name: 'th shop', region: 'TH', seller_type: 'CROSS_BORDER' },
  ];
  const good = await handleTikTokCallback(
    { code: 'synthetic-code-cipher', state: stateFor('test-nonce-cipher2', 'MY') },
    callbackDeps(db, capture, { code: 0, data: { shops } }),
  );
  assert.equal(good.status, 200);
  assert.equal(good.body.shop_code, 'synthetic-shop-my');
  const stored = await readDecryptedShopToken(db, TEST_SECRET, 'synthetic-shop-my');
  assert.equal(stored?.shopCipher, 'synthetic-cipher-my');
  assert.equal(db.store.size, 1);
  assert.equal(selectAuthorizedShop([{ id: 'a', region: 'SG' }, { id: 'b', region: 'MY' }], 'MY')?.id, 'b');
});

test('T11 authorized shops: single shop with different region is used (single-shop fallback)', async () => {
  const db = new MockD1();
  const capture: { url?: string; headers?: Record<string, string>; tokenUrl?: string } = {};
  const good = await handleTikTokCallback(
    { code: 'synthetic-code-cipher', state: stateFor('test-nonce-cipher3', 'MY') },
    callbackDeps(db, capture, { code: 0, data: { shops: [{ id: 'synthetic-shop-only', cipher: 'synthetic-cipher-only', code: 'synthetic-local-only', name: 'only shop', region: 'SG', seller_type: 'CROSS_BORDER' }] } }),
  );
  assert.equal(good.status, 200);
  assert.equal(good.body.shop_code, 'synthetic-shop-only');
});

test('T11 authorized shops: multi-shop no MY match -> shops_no_match, no D1 write', async () => {
  const db = new MockD1();
  const capture: { url?: string; headers?: Record<string, string>; tokenUrl?: string } = {};
  const shops = [
    { id: 'synthetic-shop-sg', cipher: 'synthetic-cipher-sg', code: 'synthetic-local-sg', name: 'sg shop', region: 'SG', seller_type: 'CROSS_BORDER' },
    { id: 'synthetic-shop-th', cipher: 'synthetic-cipher-th', code: 'synthetic-local-th', name: 'th shop', region: 'TH', seller_type: 'CROSS_BORDER' },
  ];
  const failed = await handleTikTokCallback(
    { code: 'synthetic-code-cipher', state: stateFor('test-nonce-cipher4', 'MY') },
    callbackDeps(db, capture, { code: 0, data: { shops } }),
  );
  assert.equal(failed.status, 502);
  assert.equal(failed.body.upstream_code, 'shops_no_match');
  assert.equal(db.store.size, 0);
});

test('T11 authorized shops: unknown market + multiple shops -> shops_no_match (never arbitrary)', async () => {
  const db = new MockD1();
  const capture: { url?: string; headers?: Record<string, string>; tokenUrl?: string } = {};
  const shops = [
    { id: 'synthetic-shop-sg', cipher: 'synthetic-cipher-sg', code: 'synthetic-local-sg', name: 'sg shop', region: 'SG', seller_type: 'CROSS_BORDER' },
    { id: 'synthetic-shop-th', cipher: 'synthetic-cipher-th', code: 'synthetic-local-th', name: 'th shop', region: 'TH', seller_type: 'CROSS_BORDER' },
  ];
  const failed = await handleTikTokCallback(
    { code: 'synthetic-code-cipher', state: stateFor('test-nonce-cipher5') },
    callbackDeps(db, capture, { code: 0, data: { shops } }),
  );
  assert.equal(failed.status, 502);
  assert.equal(failed.body.upstream_code, 'shops_no_match');
  assert.equal(db.store.size, 0);
});

test('T11 authorized shops: upstream code != 0 -> shops_fetch_failed with TikTok code, no D1 write', async () => {
  const db = new MockD1();
  const capture: { url?: string; headers?: Record<string, string>; tokenUrl?: string } = {};
  const failed = await handleTikTokCallback(
    { code: 'synthetic-code-cipher', state: stateFor('test-nonce-cipher6', 'MY') },
    callbackDeps(db, capture, { code: 40001, message: 'synthetic upstream message that must not leak', data: {} }),
  );
  assert.equal(failed.status, 502);
  assert.equal(failed.body.upstream_code, 'shops_fetch_failed');
  assert.equal(failed.body.upstream_tiktok_code, 40001);
  assert.ok(!JSON.stringify(failed.body).includes('synthetic upstream message'));
  assert.equal(db.store.size, 0);
});

test('T11 authorized shops: empty shops -> shops_empty, no D1 write', async () => {
  const db = new MockD1();
  const capture: { url?: string; headers?: Record<string, string>; tokenUrl?: string } = {};
  const failed = await handleTikTokCallback(
    { code: 'synthetic-code-cipher', state: stateFor('test-nonce-cipher7', 'MY') },
    callbackDeps(db, capture, { code: 0, data: { shops: [] } }),
  );
  assert.equal(failed.status, 502);
  assert.equal(failed.body.upstream_code, 'shops_empty');
  assert.equal(db.store.size, 0);
});

test('T11 authorized shops: selected shop cipher missing -> shops_cipher_missing, no D1 write', async () => {
  const db = new MockD1();
  const capture: { url?: string; headers?: Record<string, string>; tokenUrl?: string } = {};
  const failed = await handleTikTokCallback(
    { code: 'synthetic-code-cipher', state: stateFor('test-nonce-cipher8', 'MY') },
    callbackDeps(db, capture, { code: 0, data: { shops: [{ id: 'synthetic-shop-my', code: 'synthetic-local-my', name: 'my shop', region: 'MY', seller_type: 'CROSS_BORDER' }] } }),
  );
  assert.equal(failed.status, 502);
  assert.equal(failed.body.upstream_code, 'shops_cipher_missing');
  assert.equal(db.store.size, 0);
});

test('T11 authorized shops: request shape is signed app_key/timestamp/sign only, token header present', async () => {
  const capture: { url?: string; headers?: Record<string, string>; tokenUrl?: string } = {};
  const shops = await fetchAuthorizedShops({
    accessToken: 'synthetic-access-cipher',
    appKey: 'synthetic-app-key',
    appSecret: 'synthetic-app-secret',
    nowMs: NOW,
    fetchImpl: routingFetch({ code: 0, data: { shops: [MY_SHOP] } }, capture),
  });
  assert.equal(shops.length, 1);
  assert.equal(shops[0]?.id, 'synthetic-shop-my');
  const url = new URL(capture.url ?? '');
  assert.equal(url.hostname, 'open-api.tiktokglobalshop.com');
  assert.equal(url.pathname, '/authorization/202309/shops');
  assert.deepEqual([...url.searchParams.keys()].sort(), ['app_key', 'sign', 'timestamp']);
  assert.equal(url.searchParams.get('app_key'), 'synthetic-app-key');
  assert.equal(url.searchParams.get('timestamp'), String(Math.floor(NOW / 1000)));
  assert.equal(capture.headers?.['x-tts-access-token'], 'synthetic-access-cipher');
  // Independent HMAC check (not reusing signDraft): secret + path + sorted key+value + secret.
  const expectedSign = createHmac('sha256', 'synthetic-app-secret')
    .update(`synthetic-app-secret/authorization/202309/shopsapp_keysynthetic-app-keytimestamp${Math.floor(NOW / 1000)}synthetic-app-secret`)
    .digest('hex');
  assert.equal(url.searchParams.get('sign'), expectedSign);
  assert.match(url.searchParams.get('sign') ?? '', /^[a-f0-9]{64}$/);
});

test('T11 authorized shops: token-response shopId path makes NO shops call and saves cipher empty', async () => {
  const db = new MockD1();
  const shopsCalls = { count: 0 };
  const fetchImpl = (async (url: string) => {
    if (url.includes('open-api.tiktokglobalshop.com')) {
      shopsCalls.count += 1;
      throw new Error('synthetic shops call must not happen');
    }
    return fakeResponse({
      code: 0,
      data: { access_token: 'synthetic-access-cipher', refresh_token: 'synthetic-refresh-cipher', access_token_expire_in: EXPIRE_SEC, shop_id: 'synthetic-shop-direct' },
    }) as unknown as Response;
  }) as unknown as typeof fetch;
  const good = await handleTikTokCallback(
    { code: 'synthetic-code-cipher', state: stateFor('test-nonce-cipher9', 'MY') },
    { secret: TEST_SECRET, appKey: 'synthetic-app-key', appSecret: 'synthetic-app-secret', db, fetchImpl, now: () => NOW },
  );
  assert.equal(good.status, 200);
  assert.equal(good.body.shop_code, 'synthetic-shop-direct');
  assert.equal(shopsCalls.count, 0);
  const stored = await readDecryptedShopToken(db, TEST_SECRET, 'synthetic-shop-direct');
  assert.equal(stored?.shopCipher, '');
});
