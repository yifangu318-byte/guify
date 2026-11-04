import { timingSafeEqual } from 'node:crypto';
import { verifyState } from './crypto.js';
import { createDefaultExchange, fetchAuthorizedShops, selectAuthorizedShop, TokenExchangeError, AuthorizedShopsError } from './callback.js';
import { D1OAuthStore, hash, type LifecycleDb, type Target, type SessionRow } from './vault.js';

export const requiredScopes = ['seller.authorization.info'];
export function parseTargets(value: string | undefined): Target[] {
  if (!value) return [];
  const rows: unknown = JSON.parse(value);
  if (!Array.isArray(rows) || rows.length > 100) throw new Error('Invalid authorization configuration');
  const ids = new Set<string>();
  return rows.map(row => {
    if (!row || typeof row !== 'object') throw new Error('Invalid authorization configuration');
    const { shopId, market, subjectId } = row;
    if (typeof shopId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(shopId) || ids.has(shopId)
      || !['MY','PH','SG','TH','VN'].includes(market) || (subjectId !== undefined && (typeof subjectId !== 'string' || !subjectId || subjectId.length > 256))) throw new Error('Invalid authorization configuration');
    // First enrollment may not know the app-specific seller open_id yet. Exact shop ID is still mandatory.
    ids.add(shopId); return { shopId, market, subjectId: subjectId ?? '' };
  });
}
export function authenticated(header: unknown, token: string | undefined): boolean {
  return typeof header === 'string' && !!token && token.length >= 32 && !/\s/.test(token)
    && timingSafeEqual(Buffer.from(hash(header)), Buffer.from(hash(`Bearer ${token}`)));
}
export function browserCookie(raw: string | undefined): string | undefined {
  const matches = (raw ?? '').split(';').map(x => x.trim()).filter(x => x.startsWith('__Host-muse_oauth='));
  const value = matches.length === 1 ? matches[0]!.slice('__Host-muse_oauth='.length) : '';
  return /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}
export interface CallbackDeps {
  secret?: string | undefined; appKey?: string | undefined; appSecret?: string | undefined;
  db?: LifecycleDb | undefined; browser?: string | undefined; targets?: Target[] | undefined;
  enabled?: boolean | undefined; environment?: string | undefined;
  relayUrl?: string | undefined; relaySecret?: string | undefined; relayAllowedOrigin?: string | undefined;
  fetchImpl?: typeof fetch | undefined; now?: (() => number) | undefined;
}
export interface CallbackOutcome { status: number; body: Record<string, unknown>; logEvent: string }
const failure = (status: number, code: string, message: string, logEvent = code.toLowerCase()): CallbackOutcome => ({ status, body: { error: true, code, message }, logEvent });
export async function handleTikTokCallback(query: { code?: unknown; state?: unknown }, deps: CallbackDeps): Promise<CallbackOutcome> {
  const { code, state } = query, now = (deps.now ?? Date.now)();
  if (typeof code !== 'string' || !code.trim() || code.length > 4096 || typeof state !== 'string' || !state.trim() || state.length > 4096)
    return failure(400, 'INVALID_REQUEST', 'Invalid callback request');
  if (!deps.secret) return failure(503, 'TOKEN_ENCRYPTION_KEY_MISSING', 'Token encryption key is not configured', 'missing_encryption_key');
  if (!verifyState(deps.secret, state, now).valid) return failure(400, 'STATE_UNVERIFIED', 'State verification failed', 'state_unverified');
  if (!deps.appKey || !deps.appSecret) return failure(503, 'APP_CREDENTIALS_MISSING', '未配置应用凭证，无法换 Token');
  if (!deps.enabled || !['test','staging','production'].includes(deps.environment ?? '') || !/^[a-fA-F0-9]{64}$/.test(deps.secret))
    return failure(503, 'OAUTH_UNAVAILABLE', 'Authorization is not enabled');
  if (!deps.db) return failure(503, 'DATABASE_UNAVAILABLE', 'Authorization storage unavailable');
  if (!deps.browser || !/^[a-f0-9]{64}$/.test(deps.browser)) return failure(400, 'STATE_UNVERIFIED', 'State verification failed');
  const store = new D1OAuthStore(deps.db);
  let claimed: SessionRow | null = null;
  try {
    await store.ready();
    const previous = await store.session(state, deps.browser, deps.appKey, now);
    if (!previous || !deps.targets?.some(t => t.shopId === previous.shop_id && t.market === previous.market && t.subjectId === previous.subject_id))
      return failure(400, 'STATE_UNVERIFIED', 'State verification failed');
    if (previous.status !== 'pending') {
      if (previous.status === 'succeeded' && previous.code_hash === hash(code) && previous.result_json)
        return { status: 200, body: JSON.parse(previous.result_json) as Record<string, unknown>, logEvent: 'callback_replayed' };
      return failure(409, 'CALLBACK_ALREADY_USED', 'Authorization already consumed; start a new authorization if required');
    }
    claimed = await store.claim(state, deps.browser, deps.appKey, code, now);
    if (!claimed) return failure(409, 'CALLBACK_ALREADY_USED', 'Authorization already consumed');
  } catch { return failure(503, 'DATABASE_UNAVAILABLE', 'Authorization storage unavailable'); }
  try {
    // Resolve global fetch at request time. Never capture the Worker startup fetch binding.
    const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    const exchanged = await createDefaultExchange(fetchImpl)({ code, appKey: deps.appKey, appSecret: deps.appSecret, nowMs: now });
    const existing = await store.authorization(deps.appKey,claimed.shop_id);
    if ((claimed.subject_id && exchanged.subjectId !== claimed.subject_id)
      || (existing && existing.subject_id !== exchanged.subjectId) || !requiredScopes.every(s => exchanged.scope.split(',').includes(s)))
      throw new TokenExchangeError(200, 'identity_or_scope_mismatch');
    const shops = await fetchAuthorizedShops({ accessToken: exchanged.accessToken, appKey: deps.appKey, appSecret: deps.appSecret,
      nowMs: (deps.now ?? Date.now)(), fetchImpl, relayUrl: deps.relayUrl, relaySecret: deps.relaySecret, relayAllowedOrigin: deps.relayAllowedOrigin });
    const selected = selectAuthorizedShop(shops, claimed.market, claimed.shop_id);
    if (!selected?.cipher) throw new AuthorizedShopsError(200, 'shops_no_match');
    const finished = (deps.now ?? Date.now)();
    if (finished >= claimed.expires_at || exchanged.expiresAtMs <= finished) throw new TokenExchangeError(200, 'expired');
    const body = await store.complete(claimed, exchanged, selected.cipher, deps.secret, requiredScopes, finished);
    return { status: 200, body, logEvent: 'success' };
  } catch (error) {
    try { await store.fail(claimed, (deps.now ?? Date.now)()); } catch { /* Consumed claims are never released or retried after an uncertain write. */ }
    if (error instanceof TokenExchangeError || error instanceof AuthorizedShopsError) {
      const outcome = failure(502, 'UPSTREAM_ERROR', 'Authorization failed; start a new authorization', 'upstream_error');
      const category = error instanceof TokenExchangeError ? error.upstreamCode : error.diagnostic;
      const safeCategories = ['invalid_seller_token','identity_or_scope_mismatch','expired','business_error','redirect_rejected','http_error','network','timeout','invalid_response','response_too_large','shops_empty','shops_invalid','shops_no_match','shops_internal_error','relay_unavailable','relay_config_invalid','relay_config_missing'];
      Object.assign(outcome.body,{ upstream_http:error.upstreamHttp, upstream_category: safeCategories.includes(String(category)) ? category : 'upstream_error',
        stage:error instanceof TokenExchangeError ? 'token_exchange' : 'authorized_shops' });
      return outcome;
    }
    return failure(503, 'DATABASE_UNAVAILABLE', 'Authorization could not be saved; start a new authorization');
  }
}
