import { decryptToken, encryptToken, verifyState } from './crypto.js';
import { ensureShopTokenSchema, getEncryptedShopToken, saveEncryptedShopToken, type D1Binding } from './d1.js';
import { signDraft } from './signing.js';
// NOTE: the token/get endpoint (see step 6) takes app_secret as a plain query
// param and no signature, so it must NOT use signDraft. The authorized-shops
// fallback (see step 6b) IS a signed business API and uses signDraft; the
// business-API signing in signing.ts is untouched and still used by client.ts.

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
 * 6. code 换 Token（T11 修正，2026-11-02）：真实调用只用环境变量里的 App Key / Secret；
 *    端点 auth.tiktok-shops.com/api/v2/token/get，GET，查询参数只有
 *    app_key / app_secret / auth_code / grant_type=authorized_code，不带 sign、不带
 *    timestamp。此写法为多方第三方资料一致佐证，官方 Partner Center 文档页本次只返回
 *    登录骨架、未能官方终验——真实换 Token 成功前不得宣称已接入。响应解析兼容两种
 *    形态：access_token_expire_in 时间戳（秒或毫秒）优先，expires_in 秒数作回退；
 *    店铺号优先取 data.shops[0].shop_id（v1 单店流程，多店选择留待第四步），回退
 *    data.shop_id / data.shopId（字符串或安全整数，数字形式转字符串；只认同名字段，
 *    绝不拿 seller_id、open_id 或本地店铺码冒充店铺号）。换 Token 返回里经常根本
 *    没有店铺号（2026-11-03 实测 shop_missing 即属此情形），此时不丢弃 Token，
 *    改走 6b 授权店铺接口补齐店铺号与 shop_cipher；
 * 6b. 授权店铺补齐（T11，2026-11-03）：仅当换 Token 未返回店铺号时调用一次
 *    GET open-api.tiktokglobalshop.com/authorization/202309/shops，查询参数只有
 *    app_key / timestamp（秒）/ sign（signDraft：secret + path + 有序参数 +
 *    secret 的 HMAC-SHA256，与现有业务签名草案一致），请求头
 *    x-tts-access-token 为刚换到的新 Token；不带 shop_cipher、不带 version
 *    查询参数（version 只在路径里）、不带 shop_id 查询参数。
 *    配置非空 RELAY_URL 时改为 POST {RELAY_URL}/forward?{原查询串}，签名不变，
 *    JSON 正文固定为 host=open-api.tiktokglobalshop.com、path=/authorization/202309/shops；
 *    头带 x-relay-secret（RELAY_SECRET）及原有三个请求头、Content-Type: application/json，
 *    不跟随重定向。未配置 RELAY_URL 时保留上述直连；配置 URL 但 Secret 缺失或空白
 *    时以 relay_config_missing 失败，绝不请求。中转 401 / 400 / 502 分别映射为
 *    relay_unauthorized / relay_bad_target / relay_unavailable，不按店铺正文解析；
 *    请求中转抛错也为 relay_unavailable，仅附安全构造函数名，不跑直连对照探测。
 *    直连抛错仍为 shops_fetch_thrown，并仅在此时附无凭证对照探测的 control 字段。
 *    中转返回的其他响应与直连使用相同的店铺解析规则。响应 code 为 0 才
 *    算成功；data.shops[] 每家店的 id 即店铺号、cipher 即 shop_cipher、code
 *    是本地码（绝不能当店铺号）、region 是市场。选店规则：state 带市场且非
 *    unknown 时优先选 region 等于该市场的店；单店时直接用它；多店且无市场匹
 *    配时失败（绝不随便挑第一家）。shop_cipher 与店铺号、市场一样存明文
 *    TEXT（它本身不是 Token，Token 仍加密存），但绝不出现在任何响应与日志里。
 *    此步失败时只返回上游类别诊断（shops_fetch_thrown / shops_internal_error /
 *    shops_fetch_failed / shops_empty / shops_cipher_missing / shops_no_match /
 *    relay_config_missing / relay_unauthorized / relay_bad_target / relay_unavailable），
 *    异常只附安全的构造函数名，绝不回显上游报文、Token 或 cipher；
 *    补齐失败则不落库，Token 作废、下次重新授权；
 * 7. 成功后：加密落 D1（含 shop_cipher），响应只返回 shop_code / market /
 *    expires_at，绝不返回任何 Token 或 cipher。
 *
 * 401 只刷新一次的口径属于 T2 只读适配器的读请求重试（已有测试覆盖），不适用于
 * 首次 code 换 Token（此时尚无可刷新的旧 Token），换 Token 的 401 直接记为上游失败。
 * 店铺不一致保护：state 里带的 shop_code 若与换 Token 返回的 shop_id 不一致，
 * 直接拒绝落库，不把一个店的 Token 存到另一个店名下。
 */

export interface TokenExchangeResult {
  accessToken: string;
  refreshToken: string;
  /** Duration fallback (seconds), used only when expiresAtMs is absent (legacy/custom exchanges). */
  expiresInSec?: number;
  /** Absolute expiry in Unix milliseconds, preferred when the upstream returns a timestamp. */
  expiresAtMs?: number;
  shopId?: string;
  /** Only set by the authorized-shops fallback; token-response path leaves it unset (Step 4 backfill). */
  shopCipher?: string;
  scope: string;
}

/**
 * One authorized shop, as returned by GET /authorization/202309/shops.
 * id = shop_id, cipher = shop_cipher, code = local shop code (NEVER shop_id).
 * cipher may be absent in malformed entries; the caller rejects those.
 */
export interface AuthorizedShop {
  id: string;
  cipher?: string;
  region?: string;
}

interface ShopsControlDiagnostic {
  control_responded: boolean;
  control_http: number | null;
  control_threw_name: string | null;
}

/**
 * Authorized-shops failure carrying only safe diagnostics: the upstream HTTP
 * status (or null on network failure), a diagnostic category, and the TikTok
 * error code when one was returned (or null), and a safe error constructor
 * name for a thrown fetch, plus control reachability fields only on that path.
 * Never carries a token, cipher, upstream message,
 * stack, URL, or body.
 */
export class AuthorizedShopsError extends Error {
  readonly upstreamHttp: number | null;
  readonly diagnostic: 'shops_fetch_thrown' | 'shops_fetch_failed' | 'shops_empty' | 'shops_cipher_missing' | 'shops_no_match' | 'relay_config_missing' | 'relay_unauthorized' | 'relay_bad_target' | 'relay_unavailable';
  readonly upstreamCode: number | string | null;
  readonly upstreamErrorName: string | null;
  declare readonly control_responded?: boolean;
  declare readonly control_http?: number | null;
  declare readonly control_threw_name?: string | null;
  constructor(upstreamHttp: number | null, diagnostic: AuthorizedShopsError['diagnostic'], upstreamCode: number | string | null, upstreamErrorName: string | null = null, control?: ShopsControlDiagnostic) {
    super('Authorized shops lookup failed');
    this.name = 'AuthorizedShopsError';
    this.upstreamHttp = upstreamHttp;
    this.diagnostic = diagnostic;
    this.upstreamCode = upstreamCode;
    this.upstreamErrorName = upstreamErrorName;
    if (control) {
      this.control_responded = control.control_responded;
      this.control_http = control.control_http;
      this.control_threw_name = control.control_threw_name;
    }
  }
}

function shopsErrorName(error: unknown): string {
  // Fixed constructor labels only: error.name and custom constructor names
  // can contain arbitrary text. Never read the thrown value's message/stack.
  for (const constructor of [DOMException, TypeError, RangeError, ReferenceError, SyntaxError, URIError, EvalError, AggregateError, Error]) {
    if (error instanceof constructor) return constructor.name;
  }
  return 'UnknownError';
}

function authorizedShopId(value: unknown): string | undefined {
  if (typeof value === 'string' && value) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return undefined;
}

/**
 * Fetch authorized shops with the freshly exchanged access token. Only used
 * when the token response carried no shopId. Query keys are exactly
 * app_key/timestamp/sign; the access token travels only in the
 * x-tts-access-token header. Never logs or returns tokens or ciphers.
 */
export async function fetchAuthorizedShops(input: {
  accessToken: string;
  appKey: string;
  appSecret: string;
  relayUrl?: string | undefined;
  relaySecret?: string | undefined;
  nowMs: number;
  fetchImpl: typeof fetch;
}): Promise<AuthorizedShop[]> {
  const relayUrl = input.relayUrl?.trim();
  if (relayUrl && !input.relaySecret?.trim()) {
    throw new AuthorizedShopsError(null, 'relay_config_missing', null);
  }
  const timestamp = Math.floor(input.nowMs / 1000);
  const path = '/authorization/202309/shops';
  const params = { app_key: input.appKey, timestamp: String(timestamp) };
  const sign = signDraft(path, params, input.appSecret, timestamp);
  const query = new URLSearchParams({ ...params, sign });
  const headers = {
    Accept: 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  };
  let response: Response;
  try {
    response = relayUrl ? await input.fetchImpl(`${relayUrl.replace(/\/+$/, '')}/forward?${query}`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        ...headers,
        'x-tts-access-token': input.accessToken,
        'x-relay-secret': input.relaySecret!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ host: 'open-api.tiktokglobalshop.com', path }),
    }) : await input.fetchImpl(`https://open-api.tiktokglobalshop.com${path}?${query}`, {
      headers: {
        'x-tts-access-token': input.accessToken,
        ...headers,
      },
    });
  } catch (error) {
    const upstreamErrorName = shopsErrorName(error);
    if (relayUrl) {
      throw new AuthorizedShopsError(null, 'relay_unavailable', null, upstreamErrorName);
    }
    let control: ShopsControlDiagnostic;
    try {
      // One credential-free reachability probe, only after the real fetch throws.
      // Deliberately fake key/sign: never sign this request or read its body.
      const controlQuery = new URLSearchParams({
        app_key: 'synthetic-control-app-key',
        timestamp: String(timestamp),
        sign: 'synthetic-control-sign',
      });
      const controlResponse = await input.fetchImpl(`https://open-api.tiktokglobalshop.com${path}?${controlQuery}`, { headers });
      control = { control_responded: true, control_http: controlResponse.status, control_threw_name: null };
    } catch (controlError) {
      control = { control_responded: false, control_http: null, control_threw_name: shopsErrorName(controlError) };
    }
    // The control result never replaces the original failure or error name.
    throw new AuthorizedShopsError(null, 'shops_fetch_thrown', null, upstreamErrorName, control);
  }
  // Relay failures are transport diagnostics, never TikTok shops envelopes.
  if (relayUrl) {
    if (response.status === 401) throw new AuthorizedShopsError(401, 'relay_unauthorized', null);
    if (response.status === 400) throw new AuthorizedShopsError(400, 'relay_bad_target', null);
    if (response.status === 502) throw new AuthorizedShopsError(502, 'relay_unavailable', null);
  }
  let payload: Record<string, unknown> | undefined;
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new AuthorizedShopsError(response.status, 'shops_fetch_failed', null);
  }
  if (!payload || typeof payload !== 'object') {
    throw new AuthorizedShopsError(response.status, 'shops_fetch_failed', null);
  }
  // TikTok envelope: code 0 (number or string "0") = success; any other code = failure.
  // The upstream message/body is deliberately NOT carried forward.
  if ('code' in payload) {
    const upstreamCode = payload.code;
    const isSuccess = upstreamCode === 0 || upstreamCode === '0';
    if (!isSuccess) {
      throw new AuthorizedShopsError(response.status, 'shops_fetch_failed', sanitizeUpstreamCode(upstreamCode));
    }
  }
  if (!response.ok) {
    throw new AuthorizedShopsError(response.status, 'shops_fetch_failed', sanitizeUpstreamCode(payload.code ?? null));
  }
  const data = (payload.data && typeof payload.data === 'object' ? payload.data : payload) as Record<string, unknown>;
  const shops = data.shops;
  if (!Array.isArray(shops) || shops.length === 0) {
    throw new AuthorizedShopsError(response.status, 'shops_empty', null);
  }
  const parsed: AuthorizedShop[] = [];
  for (const entry of shops) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const id = authorizedShopId(record.id);
    if (!id) continue;
    const cipher = typeof record.cipher === 'string' && record.cipher ? record.cipher : undefined;
    const region = typeof record.region === 'string' && record.region ? record.region : undefined;
    parsed.push({ id, ...(cipher ? { cipher } : {}), ...(region ? { region } : {}) });
  }
  if (parsed.length === 0) {
    throw new AuthorizedShopsError(response.status, 'shops_empty', null);
  }
  return parsed;
}

/** Select one shop: region match first, single shop as fallback, else no match. Never arbitrary. */
export function selectAuthorizedShop(shops: AuthorizedShop[], market: string | undefined): AuthorizedShop | undefined {
  if (market && market !== 'unknown') {
    const matched = shops.find(shop => shop.region === market);
    if (matched) return matched;
    if (shops.length === 1) return shops[0];
    return undefined;
  }
  if (shops.length === 1) return shops[0];
  return undefined;
}

/**
 * Exchange failure carrying only safe diagnostic categories: the upstream HTTP
 * status (or null on network failure) and the TikTok error code (or a category
 * string). Never carries an auth code, state, token, secret, sign, message, or body.
 */
export class TokenExchangeError extends Error {
  readonly upstreamHttp: number | null;
  readonly upstreamCode: number | string;
  constructor(upstreamHttp: number | null, upstreamCode: number | string) {
    super('Token exchange failed');
    this.name = 'TokenExchangeError';
    this.upstreamHttp = upstreamHttp;
    this.upstreamCode = upstreamCode;
  }
}

function sanitizeUpstreamCode(value: unknown): number | string {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)) return value;
  return 'invalid_response';
}

function toExpiresAtMs(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw <= 0) return undefined;
  // Seconds (< 1e12) vs milliseconds (>= 1e12) timestamp; never treat a duration
  // as a timestamp here — durations arrive via expires_in and are handled separately.
  return raw >= 1_000_000_000_000 ? raw : raw * 1000;
}

function shopIdFromData(data: Record<string, unknown>): string | undefined {
  const shops = data.shops;
  if (Array.isArray(shops) && shops.length > 0) {
    const first = shops[0] as Record<string, unknown>;
    const id = first?.shop_id ?? first?.shopId;
    if (typeof id === 'string' && id) return id;
    if (typeof id === 'number' && Number.isSafeInteger(id)) return String(id);
  }
  if (typeof data.shop_id === 'string' && data.shop_id) return data.shop_id;
  if (typeof data.shop_id === 'number' && Number.isSafeInteger(data.shop_id)) return String(data.shop_id);
  if (typeof data.shopId === 'string' && data.shopId) return data.shopId;
  if (typeof data.shopId === 'number' && Number.isSafeInteger(data.shopId)) return String(data.shopId);
  return undefined;
}

export type TokenExchange = (input: { code: string; appKey: string; appSecret: string; nowMs: number }) => Promise<TokenExchangeResult>;

export interface CallbackDeps {
  secret?: string | undefined;
  appKey?: string | undefined;
  appSecret?: string | undefined;
  relayUrl?: string | undefined;
  relaySecret?: string | undefined;
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
    const path = '/api/v2/token/get';
    // Plain params only: no sign, no timestamp. app_secret travels as a query
    // param to the auth host only (server-to-server); it is never logged or echoed.
    const query = new URLSearchParams({ app_key: appKey, app_secret: appSecret, auth_code: code, grant_type: 'authorized_code' });
    let response: Response;
    try {
      response = await fetchImpl(`https://auth.tiktok-shops.com${path}?${query}`);
    } catch {
      throw new TokenExchangeError(null, 'network');
    }
    let payload: Record<string, unknown> | undefined;
    try {
      payload = (await response.json()) as Record<string, unknown>;
    } catch {
      throw new TokenExchangeError(response.status, 'invalid_response');
    }
    if (!payload || typeof payload !== 'object') {
      throw new TokenExchangeError(response.status, 'invalid_response');
    }
    // TikTok envelope: code 0 (number or string "0") = success; any other code = failure.
    // The upstream message/body is deliberately NOT carried forward.
    if ('code' in payload) {
      const upstreamCode = payload.code;
      const isSuccess = upstreamCode === 0 || upstreamCode === '0';
      if (!isSuccess) {
        throw new TokenExchangeError(response.status, sanitizeUpstreamCode(upstreamCode));
      }
    }
    if (!response.ok) {
      throw new TokenExchangeError(response.status, sanitizeUpstreamCode(payload.code ?? 'invalid_response'));
    }
    const data = (payload.data && typeof payload.data === 'object' ? payload.data : payload) as Record<string, unknown>;
    const accessToken = data.access_token;
    const refreshToken = data.refresh_token;
    if (typeof accessToken !== 'string' || !accessToken || typeof refreshToken !== 'string' || !refreshToken) {
      throw new TokenExchangeError(response.status, 'invalid_response');
    }
    const timestampMs = toExpiresAtMs(data.access_token_expire_in);
    const expiresIn = data.expires_in;
    const expiresInSec = typeof expiresIn === 'number' && Number.isSafeInteger(expiresIn) && expiresIn > 0 ? expiresIn : undefined;
    // Always carry an absolute expiry: timestamp when present, otherwise the
    // duration converted against nowMs. expiresInSec stays as the duration field.
    const expiresAtMs = timestampMs ?? (expiresInSec !== undefined ? nowMs + expiresInSec * 1000 : undefined);
    if (expiresAtMs === undefined) {
      throw new TokenExchangeError(response.status, 'invalid_response');
    }
    const shopId = shopIdFromData(data);
    const scope = Array.isArray(data.scope) ? (data.scope as unknown[]).map(String).join(',') : typeof data.scope === 'string' ? data.scope : '';
    return {
      accessToken,
      refreshToken,
      ...(expiresInSec !== undefined ? { expiresInSec } : {}),
      expiresAtMs,
      ...(shopId ? { shopId } : {}),
      scope,
    };
  };
}

function exchangeDiagnostic(error: unknown): { upstream_http: number | null; upstream_code: number | string } {
  if (error && typeof error === 'object') {
    const candidate = error as { upstreamHttp?: unknown; upstreamCode?: unknown };
    const http = typeof candidate.upstreamHttp === 'number' && Number.isInteger(candidate.upstreamHttp) ? candidate.upstreamHttp : null;
    const code = typeof candidate.upstreamCode === 'number' || typeof candidate.upstreamCode === 'string' ? sanitizeUpstreamCode(candidate.upstreamCode) : 'invalid_response';
    // Only trust the pair when it came from TokenExchangeError; a generic error
    // with stray fields must not fabricate a diagnostic.
    if (error instanceof TokenExchangeError) return { upstream_http: http, upstream_code: code };
  }
  // Generic (non-TokenExchangeError) exchange failure: distinct from TokenExchangeError
  // categories (network / invalid_response / TikTok code) so it is never confused
  // with a shop-missing or expires-missing outcome below.
  return { upstream_http: null, upstream_code: 'exchange_error' };
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
  } catch (error) {
    const diagnostic = exchangeDiagnostic(error);
    return { status: 502, body: { error: true, message: 'Token exchange failed', code: 'UPSTREAM_ERROR', ...diagnostic }, logEvent: 'exchange_failed' };
  }
  if (verified.shopCode && exchanged.shopId && verified.shopCode !== exchanged.shopId) {
    return { status: 400, body: { error: true, message: 'Shop mismatch between state and token', code: 'SHOP_MISMATCH' }, logEvent: 'shop_mismatch' };
  }
  // market 未提供时明写 unknown，绝不凭空猜测为某个国家市场。
  const market = verified.market ?? 'unknown';
  let shopCode = verified.shopCode ?? exchanged.shopId;
  let shopCipher = exchanged.shopCipher ?? '';
  if (!shopCode) {
    // Token response carried no shopId: resolve it via authorized shops.
    // No fetch transport means no safe resolution — keep the legacy
    // shop_missing diagnostic (production always passes fetch via entry.js).
    if (!deps.fetchImpl) {
      return { status: 502, body: { error: true, message: 'Token exchange failed', code: 'UPSTREAM_ERROR', upstream_http: null, upstream_code: 'shop_missing' }, logEvent: 'exchange_failed' };
    }
    let shops: AuthorizedShop[];
    try {
      shops = await fetchAuthorizedShops({
        accessToken: exchanged.accessToken,
        appKey,
        appSecret,
        relayUrl: deps.relayUrl,
        relaySecret: deps.relaySecret,
        nowMs,
        fetchImpl: deps.fetchImpl,
      });
    } catch (error) {
      if (error instanceof AuthorizedShopsError) {
        return {
          status: 502,
          body: {
            error: true,
            message: 'Authorized shops lookup failed',
            code: 'UPSTREAM_ERROR',
            upstream_http: error.upstreamHttp,
            upstream_code: error.diagnostic,
            ...(error.upstreamCode !== null ? { upstream_tiktok_code: error.upstreamCode } : {}),
            ...(error.upstreamErrorName !== null ? { upstream_error_name: error.upstreamErrorName } : {}),
            ...(error.diagnostic === 'shops_fetch_thrown' ? {
              control_responded: error.control_responded,
              control_http: error.control_http,
              control_threw_name: error.control_threw_name,
            } : {}),
          },
          logEvent: 'exchange_failed',
        };
      }
      return { status: 502, body: { error: true, message: 'Authorized shops lookup failed', code: 'UPSTREAM_ERROR', upstream_http: null, upstream_code: 'shops_internal_error', upstream_error_name: shopsErrorName(error) }, logEvent: 'exchange_failed' };
    }
    const selected = selectAuthorizedShop(shops, verified.market);
    if (!selected) {
      return { status: 502, body: { error: true, message: 'Authorized shops lookup failed', code: 'UPSTREAM_ERROR', upstream_http: null, upstream_code: 'shops_no_match' }, logEvent: 'exchange_failed' };
    }
    if (!selected.cipher) {
      return { status: 502, body: { error: true, message: 'Authorized shops lookup failed', code: 'UPSTREAM_ERROR', upstream_http: null, upstream_code: 'shops_cipher_missing' }, logEvent: 'exchange_failed' };
    }
    shopCode = selected.id;
    shopCipher = selected.cipher;
  }
  const expiresAt = typeof exchanged.expiresAtMs === 'number' && Number.isSafeInteger(exchanged.expiresAtMs)
    ? exchanged.expiresAtMs
    : typeof exchanged.expiresInSec === 'number' && Number.isSafeInteger(exchanged.expiresInSec) && exchanged.expiresInSec > 0
      ? nowMs + exchanged.expiresInSec * 1000
      : NaN;
  if (!Number.isSafeInteger(expiresAt)) {
    return { status: 502, body: { error: true, message: 'Token exchange failed', code: 'UPSTREAM_ERROR', upstream_http: null, upstream_code: 'expires_missing' }, logEvent: 'exchange_failed' };
  }
  try {
    await ensureShopTokenSchema(db);
    await saveEncryptedShopToken(db, {
      shopCode,
      market,
      accessTokenEnc: encryptToken(secret, exchanged.accessToken),
      refreshTokenEnc: encryptToken(secret, exchanged.refreshToken),
      expiresAt,
      scope: exchanged.scope,
      shopCipher,
    }, nowMs);
  } catch {
    return { status: 503, body: { error: true, message: 'D1 database is not available; token cannot be stored safely.', code: 'DATABASE_UNAVAILABLE' }, logEvent: 'database_unavailable' };
  }
  return { status: 200, body: { error: false, shop_code: shopCode, market, expires_at: expiresAt }, logEvent: 'success' };
}

/** 供适配层读取 D1 密文并解密（仅在持有密钥时调用，失败只报通用错误）。 */
export async function readDecryptedShopToken(db: D1Binding, secret: string, shopCode: string): Promise<{ shopCode: string; market: string; accessToken: string; refreshToken: string; expiresAt: number; scope: string; shopCipher: string } | undefined> {
  const record = await getEncryptedShopToken(db, shopCode);
  if (!record) return undefined;
  return {
    shopCode: record.shopCode,
    market: record.market,
    accessToken: decryptToken(secret, record.accessTokenEnc),
    refreshToken: decryptToken(secret, record.refreshTokenEnc),
    expiresAt: record.expiresAt,
    scope: record.scope,
    shopCipher: record.shopCipher,
  };
}
