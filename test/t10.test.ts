import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { decryptToken, deriveKey, encryptToken, issueState, verifyState } from '../src/tiktok/crypto.js';
import { getEncryptedShopToken, probeD1, saveEncryptedShopToken, type D1Binding, type D1Prepared } from '../src/tiktok/d1.js';
import { handleTikTokCallback, readDecryptedShopToken } from '../src/tiktok/callback.js';

// 测试专用合成密钥，非真实密钥；仅用于本地测试，绝不对应任何真实店铺。
const TEST_SECRET = 'synthetic-test-secret-t10-only';
const NOW = 1_790_000_000_000;

/**
 * 本地模拟 D1（明确标注为模拟，不是真实 D1）。
 * 只实现回调/D1 层用到的 prepare/bind/run/first/all 最小约定，
 * 支持 shop_tokens 的 INSERT/SELECT 与 SELECT 1 探针，不模拟完整 SQL。
 */
class MockD1Prepared implements D1Prepared {
  constructor(private readonly store: Map<string, Record<string, unknown>>, private readonly sql: string) {}
  private args: unknown[] = [];
  bind(...args: unknown[]): D1Prepared {
    const next = new MockD1Prepared(this.store, this.sql);
    next.args = args;
    return next;
  }
  async run(): Promise<unknown> {
    if (/CREATE TABLE/i.test(this.sql)) return { success: true };
    if (/INSERT INTO shop_tokens/i.test(this.sql)) {
      const [shopCode, market, accessTokenEnc, refreshTokenEnc, expiresAt, scope, createdAt, updatedAt] = this.args as [string, string, string, string, number, string, number, number];
      this.store.set(shopCode, { shop_code: shopCode, market, access_token_enc: accessTokenEnc, refresh_token_enc: refreshTokenEnc, expires_at: expiresAt, scope, created_at: createdAt, updated_at: updatedAt });
      return { success: true };
    }
    return { success: true };
  }
  async first<T = Record<string, unknown>>(): Promise<T | null> {
    if (/SELECT 1 AS ok/i.test(this.sql)) return { ok: 1 } as T;
    if (/FROM shop_tokens WHERE shop_code/i.test(this.sql)) {
      const row = this.store.get(String(this.args[0]));
      return (row ?? null) as T;
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

function capture() {
  let text = '';
  const stream = new Writable({ write(chunk, _encoding, callback) { text += chunk.toString(); callback(); } });
  return { stream, read: () => text };
}

test('T10 加密往返：hex 密钥与字符串密钥均可用，错密钥不可解', () => {
  const hexKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  assert.equal(deriveKey(hexKey).length, 32);
  assert.equal(deriveKey(TEST_SECRET).length, 32);
  assert.notDeepEqual(deriveKey(hexKey), deriveKey(TEST_SECRET));
  for (const key of [hexKey, TEST_SECRET]) {
    const blob = encryptToken(key, 'synthetic-access-token-t10');
    assert.equal(decryptToken(key, blob), 'synthetic-access-token-t10');
    assert.notEqual(blob, 'synthetic-access-token-t10');
    assert.throws(() => decryptToken('synthetic-wrong-key-t10', blob), { message: 'Token decryption failed' });
    assert.throws(() => decryptToken(key, '!!!not-base64!!!'), { message: 'Token decryption failed' });
  }
});

test('T10 state 签发与校验：本站签发通过，篡改/过期/超期均失败', () => {
  const issued = issueState(TEST_SECRET, { now: () => NOW, nonce: 'test-nonce-12345678', shopCode: 'TEST_SHOP', market: 'MY' });
  const ok = verifyState(TEST_SECRET, issued.state, NOW + 60_000);
  assert.equal(ok.valid, true);
  if (ok.valid) {
    assert.equal(ok.shopCode, 'TEST_SHOP');
    assert.equal(ok.market, 'MY');
  }
  assert.deepEqual(verifyState(TEST_SECRET, issued.state, NOW + 10 * 60 * 1000 + 1), { valid: false, reason: 'expired' });
  const tampered = `${issued.state.slice(0, -1)}${issued.state.endsWith('0') ? '1' : '0'}`;
  assert.equal(verifyState(TEST_SECRET, tampered, NOW).valid, false);
  assert.equal(verifyState('synthetic-other-key-t10', issued.state, NOW).valid, false);
  assert.equal(verifyState(TEST_SECRET, 'not-a-state', NOW).valid, false);
});

test('T10 D1 模拟：落库、读取、冲突更新均可用，密文不含明文', async () => {
  const db = new MockD1();
  assert.equal(await probeD1(db), true);
  const accessEnc = encryptToken(TEST_SECRET, 'synthetic-access-t10');
  const refreshEnc = encryptToken(TEST_SECRET, 'synthetic-refresh-t10');
  await saveEncryptedShopToken(db, { shopCode: 'TEST_SHOP', market: 'MY', accessTokenEnc: accessEnc, refreshTokenEnc: refreshEnc, expiresAt: NOW + 3600_000, scope: 'test.scope' }, NOW);
  const saved = await getEncryptedShopToken(db, 'TEST_SHOP');
  assert.ok(saved);
  assert.equal(saved.market, 'MY');
  assert.ok(!saved.accessTokenEnc.includes('synthetic-access-t10'));
  assert.equal(await getEncryptedShopToken(db, 'NO_SUCH_SHOP'), undefined);
  const read = await readDecryptedShopToken(db, TEST_SECRET, 'TEST_SHOP');
  assert.equal(read?.accessToken, 'synthetic-access-t10');
  assert.equal(read?.refreshToken, 'synthetic-refresh-t10');
});

test('T10 回调：缺凭证时明确报错，不用模拟 Token 冒充成功', async () => {
  const db = new MockD1();
  const state = issueState(TEST_SECRET, { now: () => NOW, nonce: 'test-nonce-abcdef12' }).state;
  const noSecret = await handleTikTokCallback({ code: 'synthetic-code', state }, { db, now: () => NOW });
  assert.equal(noSecret.status, 503);
  assert.equal(noSecret.body.code, 'TOKEN_ENCRYPTION_KEY_MISSING');
  const noCreds = await handleTikTokCallback({ code: 'synthetic-code', state }, { secret: TEST_SECRET, db, now: () => NOW });
  assert.equal(noCreds.status, 503);
  assert.equal(noCreds.body.code, 'APP_CREDENTIALS_MISSING');
  assert.equal(noCreds.body.message, '未配置应用凭证，无法换 Token');
  const noDb = await handleTikTokCallback({ code: 'synthetic-code', state }, { secret: TEST_SECRET, appKey: 'synthetic-app-key', appSecret: 'synthetic-app-secret', now: () => NOW });
  assert.equal(noDb.status, 503);
  assert.equal(noDb.body.code, 'DATABASE_UNAVAILABLE');
});

test('T10 回调：换 Token 成功后加密落 D1，响应不含任何 Token', async () => {
  const db = new MockD1();
  const state = issueState(TEST_SECRET, { now: () => NOW, nonce: 'test-nonce-12345678', shopCode: 'TEST_SHOP', market: 'MY' }).state;
  const good = await handleTikTokCallback({ code: 'synthetic-code-t10', state }, {
    secret: TEST_SECRET, appKey: 'synthetic-app-key', appSecret: 'synthetic-app-secret', db, now: () => NOW,
    exchange: async () => ({ accessToken: 'synthetic-access-t10', refreshToken: 'synthetic-refresh-t10', expiresInSec: 3600, shopId: 'TEST_SHOP', scope: 'test.scope' }),
  });
  assert.equal(good.status, 200);
  assert.deepEqual(good.body, { error: false, shop_code: 'TEST_SHOP', market: 'MY', expires_at: NOW + 3600_000 });
  assert.ok(!JSON.stringify(good.body).includes('synthetic-access-t10'));
  const read = await readDecryptedShopToken(db, TEST_SECRET, 'TEST_SHOP');
  assert.equal(read?.accessToken, 'synthetic-access-t10');
});

test('T10 回调：换 Token 失败与店铺不一致均不落库、不假装成功', async () => {
  const db = new MockD1();
  const state = issueState(TEST_SECRET, { now: () => NOW, nonce: 'test-nonce-12345678', shopCode: 'TEST_SHOP', market: 'MY' }).state;
  const failed = await handleTikTokCallback({ code: 'synthetic-code-t10', state }, {
    secret: TEST_SECRET, appKey: 'synthetic-app-key', appSecret: 'synthetic-app-secret', db, now: () => NOW,
    exchange: async () => { throw new Error('synthetic-upstream-failure'); },
  });
  assert.equal(failed.status, 502);
  assert.equal(failed.body.code, 'UPSTREAM_ERROR');
  assert.equal(await getEncryptedShopToken(db, 'TEST_SHOP'), undefined);
  const mismatch = await handleTikTokCallback({ code: 'synthetic-code-t10', state }, {
    secret: TEST_SECRET, appKey: 'synthetic-app-key', appSecret: 'synthetic-app-secret', db, now: () => NOW,
    exchange: async () => ({ accessToken: 'synthetic-access-t10', refreshToken: 'synthetic-refresh-t10', expiresInSec: 3600, shopId: 'OTHER_SHOP', scope: '' }),
  });
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.body.code, 'SHOP_MISMATCH');
  assert.equal(await getEncryptedShopToken(db, 'TEST_SHOP'), undefined);
});

test('T10 健康检查：D1 探针通过报 configured_verified，无绑定保持 not_configured', async t => {
  const verifiedApp = buildApp(loadConfig({}), capture().stream, {}, {}, { databaseHealth: async () => 'configured_verified' });
  t.after(() => verifiedApp.close());
  assert.equal((await verifiedApp.inject('/health')).json().database.status, 'configured_verified');
  const unverifiedApp = buildApp(loadConfig({}), capture().stream, {}, {}, { databaseHealth: async () => 'configured_unverified' });
  t.after(() => unverifiedApp.close());
  assert.equal((await unverifiedApp.inject('/health')).json().database.status, 'configured_unverified');
  const plainApp = buildApp(loadConfig({}), capture().stream);
  t.after(() => plainApp.close());
  assert.equal((await plainApp.inject('/health')).json().database.status, 'not_configured');
});

test('T10 回调经 HTTP 路由：state 未校验通过时不回显入参，只记 state_unverified', async t => {
  const logs = capture();
  const app = buildApp(loadConfig({}), logs.stream, {}, {}, { tiktok: { getSecret: () => TEST_SECRET } });
  t.after(() => app.close());
  const response = await app.inject('/api/tiktok/callback?code=synthetic-code-t10&state=synthetic-state-t10');
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().code, 'STATE_UNVERIFIED');
  assert.ok(logs.read().includes('state_unverified'));
  assert.ok(!`${response.body}${logs.read()}`.includes('synthetic-code-t10'));
  assert.ok(!`${response.body}${logs.read()}`.includes('synthetic-state-t10'));
});
