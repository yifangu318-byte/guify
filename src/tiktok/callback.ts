import { decryptToken, encryptToken, verifyState } from './crypto.js';
import { ensureShopTokenSchema, getEncryptedShopToken, saveEncryptedShopToken, type D1Binding } from './d1.js';
import { signDraft } from './signing.js';

/**
 * T10 回调 /api/tiktok/callback 的真实接入逻辑（简体中文注释）。
 *
 * 处理顺序（缺一不可，绝不跳步假装成功）：
 * 1. code / state 缺失、空白、重复（数组）→ 400 INVALID_REQUEST，不回显任何入参；
 * 2. 无 TOKEN_ENCRYPTION_KEY → 503 TOKEN_ENCRYPTION_KEY_MISSING，无法验签也无法安全存 Token；
 * 3. state 非本站签发、过期、篡改 → 400 STATE_UNVERIFIED，日志只记事件名 state_unverified，
 *    绝不记录 code / state 本身；绝不用模拟 Token 冒充真实 Token；
 * 4. 无 TIKTOK_APP_KEY / TIKTOK_APP_SECRET → 503 APP_CREDENTIALS_MISSING，中文明示“未配置应用凭证，无法换 Token”；
 * 5. 无 D1 绑定 → 503 DATABASE_UNAVAILABLE，换到的 Token 无处安全保存时不得宣称授权成功；
 * 6. code 换 Token：真实调用只用环境变量里的 App Key / Secret；端点与签名写法来自仓库
 *    RESEARCH-2026-10-30.md 里记载的第三方资料一致写法（auth.tiktok-shops.com/api/v2/token/get，
 *    GET、HMAC-SHA256 草案签名），尚未获官方文档复核——真实换 Token 成功前不得宣称已接入，
 *    失败时只返回上游错误码类别，不回显上游原始报文、Token 或签名；
 * 7. 成功后：加密落 D1，响应只返回 shop_code / market / expires_at，绝不返回任何 Token。
 *
 * 401 只刷新一次的口径属于 T2 只读适配器的读请求重试（已有测试覆盖），不适用于
 * 首次 code 换 Token（此时尚无可刷新的旧 Token），换 Token 的 401 直接记为上游失败。
 * 店铺不一致保护：state 里带的 shop_code 若与换 Token 返回的 shop_id 不一致，
 * 直接拒绝落库，不把一个店的 Token 存到另一个店名下。
 */

export interface TokenExchangeResult {
  accessToken: string;
  refreshToken: string;
  expiresInSec: number;
  shopId?: string;
  scope: string;
}

export type TokenExchange = (input: { code: string; appKey: string; appSecret: string; nowMs: number }) => Promise<TokenExchangeResult>;

export interface CallbackDeps {
  secret?: string | undefined;
  appKey?: string | undefined;
  appSecret?: string | undefined;
  db?: D1Binding | undefined;
  exchange?: TokenExchange | undefined;
  fetchImpl?: typeof fetch | undefined;
  now?: (() => number) | undefined;
}

export interface CallbackOutcome {
  status: number;
  body: Record<string, unknown>;
  /** 仅供日志使用的事件名，绝不含 code / state / Token。 */
  logEvent: 'invalid_request' | 'state_unverified' | 'missing_encryption_key' | 'missing_app_credentials' | 'database_unavailable' | 'exchange_failed' | 'shop_mismatch' | 'success';
}

const invalidRequest = (): CallbackOutcome => ({ status: 400, body: { error: true, message: 'Invalid callback request', code: 'INVALID_REQUEST' }, logEvent: 'invalid_request' });

export function createDefaultExchange(fetchImpl: typeof fetch): TokenExchange {
  return async ({ code, appKey, appSecret, nowMs }) => {
    const timestamp = Math.floor(nowMs / 1000);
    const path = '/api/v2/token/get';
    const params = { app_key: appKey, auth_code: code, grant_type: 'authorized_code', timestamp: String(timestamp) };
    const sign = signDraft(path, params, appSecret, timestamp);
    const query = new URLSearchParams({ ...params, sign });
    let response: Response;
    try {
      response = await fetchImpl(`https://auth.tiktok-shops.com${path}?${query}`);
    } catch {
      throw new Error('Token exchange request failed');
    }
    if (!response.ok) throw new Error('Token exchange failed');
    let payload: Record<string, unknown>;
    try {
      payload = (await response.json()) as Record<string, unknown>;
    } catch {
      throw new Error('Token exchange failed');
    }
    const data = (payload.data && typeof payload.data === 'object' ? payload.data : payload) as Record<string, unknown>;
    const accessToken = data.access_token;
    const refreshToken = data.refresh_token;
    const expiresIn = data.expires_in;
    if (typeof accessToken !== 'string' || !accessToken || typeof refreshToken !== 'string' || !refreshToken || !Number.isSafeInteger(expiresIn) || (expiresIn as number) <= 0) {
      throw new Error('Token exchange failed');
    }
    const shopId = typeof data.shop_id === 'string' && data.shop_id ? data.shop_id : typeof data.shopId === 'string' && data.shopId ? data.shopId : undefined;
    const scope = Array.isArray(data.scope) ? (data.scope as unknown[]).map(String).join(',') : typeof data.scope === 'string' ? data.scope : '';
    return { accessToken, refreshToken, expiresInSec: expiresIn as number, ...(shopId ? { shopId } : {}), scope };
  };
}

export async function handleTikTokCallback(
  query: { code?: unknown; state?: unknown },
  deps: CallbackDeps,
): Promise<CallbackOutcome> {
  const nowMs = deps.now ? deps.now() : Date.now();
  const { code, state } = query;
  if (typeof code !== 'string' || !code.trim() || typeof state !== 'string' || !state.trim()) {
    return invalidRequest();
  }
  const secret = deps.secret?.trim();
  if (!secret) {
    return { status: 503, body: { error: true, message: 'Token encryption key is not configured; callback cannot be verified or stored safely.', code: 'TOKEN_ENCRYPTION_KEY_MISSING' }, logEvent: 'missing_encryption_key' };
  }
  const verified = verifyState(secret, state, nowMs);
  if (!verified.valid) {
    return { status: 400, body: { error: true, message: 'State verification failed', code: 'STATE_UNVERIFIED' }, logEvent: 'state_unverified' };
  }
  const appKey = deps.appKey?.trim();
  const appSecret = deps.appSecret?.trim();
  if (!appKey || !appSecret) {
    return { status: 503, body: { error: true, message: '未配置应用凭证，无法换 Token', code: 'APP_CREDENTIALS_MISSING' }, logEvent: 'missing_app_credentials' };
  }
  const db = deps.db;
  if (!db) {
    return { status: 503, body: { error: true, message: 'D1 database is not bound; token cannot be stored safely.', code: 'DATABASE_UNAVAILABLE' }, logEvent: 'database_unavailable' };
  }
  const exchange = deps.exchange ?? (deps.fetchImpl ? createDefaultExchange(deps.fetchImpl) : undefined);
  if (!exchange) {
    return { status: 503, body: { error: true, message: 'Token exchange transport is not available.', code: 'TOKEN_EXCHANGE_UNAVAILABLE' }, logEvent: 'exchange_failed' };
  }
  let exchanged: TokenExchangeResult;
  try {
    exchanged = await exchange({ code, appKey, appSecret, nowMs });
  } catch {
    return { status: 502, body: { error: true, message: 'Token exchange failed', code: 'UPSTREAM_ERROR' }, logEvent: 'exchange_failed' };
  }
  if (verified.shopCode && exchanged.shopId && verified.shopCode !== exchanged.shopId) {
    return { status: 400, body: { error: true, message: 'Shop mismatch between state and token', code: 'SHOP_MISMATCH' }, logEvent: 'shop_mismatch' };
  }
  const shopCode = verified.shopCode ?? exchanged.shopId;
  if (!shopCode) {
    return { status: 502, body: { error: true, message: 'Token exchange failed', code: 'UPSTREAM_ERROR' }, logEvent: 'exchange_failed' };
  }
  // market 未提供时明写 unknown，绝不凭空猜测为某个国家市场。
  const market = verified.market ?? 'unknown';
  const expiresAt = nowMs + exchanged.expiresInSec * 1000;
  try {
    await ensureShopTokenSchema(db);
    await saveEncryptedShopToken(db, {
      shopCode,
      market,
      accessTokenEnc: encryptToken(secret, exchanged.accessToken),
      refreshTokenEnc: encryptToken(secret, exchanged.refreshToken),
      expiresAt,
      scope: exchanged.scope,
    }, nowMs);
  } catch {
    return { status: 503, body: { error: true, message: 'D1 database is not available; token cannot be stored safely.', code: 'DATABASE_UNAVAILABLE' }, logEvent: 'database_unavailable' };
  }
  return { status: 200, body: { error: false, shop_code: shopCode, market, expires_at: expiresAt }, logEvent: 'success' };
}

/** 供适配层读取 D1 密文并解密（仅在持有密钥时调用，失败只报通用错误）。 */
export async function readDecryptedShopToken(db: D1Binding, secret: string, shopCode: string): Promise<{ shopCode: string; market: string; accessToken: string; refreshToken: string; expiresAt: number; scope: string } | undefined> {
  const record = await getEncryptedShopToken(db, shopCode);
  if (!record) return undefined;
  return {
    shopCode: record.shopCode,
    market: record.market,
    accessToken: decryptToken(secret, record.accessTokenEnc),
    refreshToken: decryptToken(secret, record.refreshTokenEnc),
    expiresAt: record.expiresAt,
    scope: record.scope,
  };
}
