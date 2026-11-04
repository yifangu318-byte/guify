import { decryptToken } from './crypto.js';
import { getEncryptedShopToken, type D1Binding } from './d1.js';
import { signDraft } from './signing.js';
import { requestJson, UpstreamError } from './http.js';
export { handleTikTokCallback } from './oauth.js';
export type { CallbackDeps, CallbackOutcome } from './oauth.js';

export interface TokenExchangeResult {
  accessToken: string; refreshToken: string; expiresAtMs: number;
  refreshExpiresAtMs: number; subjectId: string; scope: string;
}
export interface AuthorizedShop { id: string; cipher?: string; region?: string }
export class TokenExchangeError extends Error {
  constructor(readonly upstreamHttp: number | null, readonly upstreamCode: number | string) { super('Token exchange failed'); }
}
export class AuthorizedShopsError extends Error {
  constructor(readonly upstreamHttp: number | null, readonly diagnostic: string, readonly upstreamCode: number | null = null) { super('Authorized shops lookup failed'); }
}
const timestamp = (raw: unknown): number => typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 ? (raw < 1e12 ? raw * 1000 : raw) : NaN;
export function parseSellerToken(data: Record<string, unknown>, now: number): TokenExchangeResult {
  const access = data.access_token, refresh = data.refresh_token, subject = data.open_id;
  const accessExpiry = timestamp(data.access_token_expire_in);
  const refreshExpiry = timestamp(data.refresh_token_expire_in);
  const scope = data.granted_scopes ?? data.scope;
  const scopes = Array.isArray(scope) ? scope : typeof scope === 'string' ? scope.split(/[ ,]+/).filter(Boolean) : [];
  if (data.user_type !== 0 || typeof subject !== 'string' || !subject || subject.length > 256
    || typeof access !== 'string' || !access || access.length > 16384
    || typeof refresh !== 'string' || !refresh || refresh.length > 16384
    || !Number.isSafeInteger(accessExpiry) || accessExpiry <= now
    || !Number.isSafeInteger(refreshExpiry) || refreshExpiry <= now
    || !scopes.length || !scopes.every(s => typeof s === 'string' && /^[a-zA-Z0-9_.&-]{1,128}$/.test(s))) {
    throw new TokenExchangeError(200, 'invalid_seller_token');
  }
  return { accessToken: access, refreshToken: refresh, subjectId: subject, expiresAtMs: accessExpiry,
    refreshExpiresAtMs: refreshExpiry, scope: [...new Set(scopes)].sort().join(',') };
}
export type TokenExchange = (input: { code: string; appKey: string; appSecret: string; nowMs: number }) => Promise<TokenExchangeResult>;
export function createDefaultExchange(fetchImpl: typeof fetch): TokenExchange {
  return async ({ code, appKey, appSecret, nowMs }) => {
    const query = new URLSearchParams({ app_key: appKey, app_secret: appSecret, auth_code: code, grant_type: 'authorized_code' });
    try { return parseSellerToken(await requestJson(fetchImpl, `https://auth.tiktok-shops.com/api/v2/token/get?${query}`), nowMs); }
    catch (e) { if (e instanceof TokenExchangeError) throw e; throw new TokenExchangeError(e instanceof UpstreamError ? e.http : null, e instanceof UpstreamError ? e.category : 'exchange_error'); }
  };
}
export function validRelay(url: string, allowedOrigin?: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash
      || parsed.pathname !== '/' || parsed.origin !== allowedOrigin || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(parsed.hostname)
      || /(^|\.)(localhost|local|internal|invalid)$/i.test(parsed.hostname)) throw new Error();
    return parsed.origin;
  } catch { throw new AuthorizedShopsError(null, 'relay_config_invalid'); }
}
export async function fetchAuthorizedShops(input: {
  accessToken: string; appKey: string; appSecret: string; nowMs: number; fetchImpl: typeof fetch;
  relayUrl?: string | undefined; relaySecret?: string | undefined; relayAllowedOrigin?: string | undefined;
}): Promise<AuthorizedShop[]> {
  const path = '/authorization/202309/shops', seconds = Math.floor(input.nowMs / 1000);
  const params = { app_key: input.appKey, timestamp: String(seconds) };
  const query = new URLSearchParams({ ...params, sign: signDraft(path, params, input.appSecret, seconds) });
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json', 'x-tts-access-token': input.accessToken };
  const relay = input.relayUrl ? validRelay(input.relayUrl, input.relayAllowedOrigin) : undefined;
  if (relay && !input.relaySecret?.trim()) throw new AuthorizedShopsError(null, 'relay_config_missing');
  let data: Record<string, unknown> | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      data = await requestJson(input.fetchImpl, relay ? `${relay}/forward?${query}` : `https://open-api.tiktokglobalshop.com${path}?${query}`, relay ? {
        method: 'POST', headers: { ...headers, 'x-relay-secret': input.relaySecret! }, body: JSON.stringify({ host: 'open-api.tiktokglobalshop.com', path }),
      } : { method: 'GET', headers });
      break;
    } catch (e) {
      // Only the read-only direct request is retried. Token exchange/refresh and opaque relays are never replayed.
      if (!relay && e instanceof UpstreamError && [429, 502, 503, 504].includes(e.http ?? 0) && attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 100 * 2 ** attempt)); continue;
      }
      throw new AuthorizedShopsError(e instanceof UpstreamError ? e.http : null, relay ? 'relay_unavailable' : e instanceof UpstreamError ? e.category : 'shops_internal_error', e instanceof UpstreamError ? e.upstreamCode : null);
    }
  }
  if (!Array.isArray(data?.shops) || !data.shops.length) throw new AuthorizedShopsError(200, 'shops_empty');
  const shops: AuthorizedShop[] = [];
  const ids = new Set<string>();
  for (const entry of data.shops) {
    if (!entry || typeof entry !== 'object') throw new AuthorizedShopsError(200, 'shops_invalid');
    const { id, cipher, region } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || ids.has(id)
      || typeof cipher !== 'string' || !cipher || cipher.length > 4096
      || typeof region !== 'string' || !/^[A-Z]{2}$/.test(region)) throw new AuthorizedShopsError(200, 'shops_invalid');
    ids.add(id); shops.push({ id, cipher, region });
  }
  return shops;
}
/** Never choose by list order, including same-market ambiguity and market mismatch. */
export function selectAuthorizedShop(shops: AuthorizedShop[], market: string | undefined, expectedId?: string): AuthorizedShop | undefined {
  const matches = shops.filter(shop => (!expectedId || shop.id === expectedId) && (!market || shop.region === market));
  return matches.length === 1 ? matches[0] : undefined;
}
/** Legacy ciphertext reader: not used by the verified authorization vault. */
export async function readDecryptedShopToken(db: D1Binding, secret: string, shopCode: string) {
  const record = await getEncryptedShopToken(db, shopCode);
  return record ? { shopCode: record.shopCode, market: record.market, accessToken: decryptToken(secret, record.accessTokenEnc),
    refreshToken: decryptToken(secret, record.refreshTokenEnc), expiresAt: record.expiresAt, scope: record.scope, shopCipher: record.shopCipher } : undefined;
}
