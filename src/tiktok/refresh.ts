import { randomUUID } from 'node:crypto';
import { D1OAuthStore, seal, unseal } from './vault.js';
import { parseSellerToken } from './callback.js';
import { requestJson } from './http.js';

/** Internal only: credentials never cross REST/MCP. Refresh once per authorization, not per shop. */
export async function getValidAccessToken(store: D1OAuthStore, options: {
  appKey: string; appSecret: string; secret: string; shopId: string; fetchImpl?: typeof fetch; now?: () => number;
}): Promise<string> {
  const now = options.now ?? Date.now, started = now();
  const row = await store.authorization(options.appKey, options.shopId);
  if (!row || row.status !== 'active' || row.key_version !== 'v1') throw new Error('Reauthorization required');
  if (row.refresh_owner) {
    // Expired lease means an upstream rotation may have happened. Never steal and replay it.
    if ((row.refresh_until ?? 0) <= started) await store.db.prepare("UPDATE authorizations SET status='reauthorize_required',version=version+1,refresh_owner=NULL,refresh_until=NULL WHERE id=? AND version=? AND refresh_owner=?")
      .bind(row.id, row.version, row.refresh_owner).run();
    throw new Error('Authorization refresh unavailable');
  }
  if (row.access_expires_at > started + 60_000) return unseal(options.secret, row.access_enc, `${row.id}:access`);
  if (row.refresh_expires_at <= started) {
    await store.db.prepare("UPDATE authorizations SET status='reauthorize_required',version=version+1,refresh_owner=NULL,refresh_until=NULL WHERE id=? AND version=? AND refresh_owner IS NULL").bind(row.id,row.version).run();
    throw new Error('Reauthorization required');
  }
  const owner = randomUUID();
  const claimed = await store.db.prepare("UPDATE authorizations SET refresh_owner=?,refresh_until=? WHERE id=? AND version=? AND status='active' AND refresh_owner IS NULL RETURNING id")
    .bind(owner, started + 30_000, row.id, row.version).first();
  if (!claimed) throw new Error('Authorization refresh unavailable');
  try {
    const query = new URLSearchParams({ app_key: options.appKey, app_secret: options.appSecret,
      refresh_token: unseal(options.secret, row.refresh_enc, `${row.id}:refresh`), grant_type: 'refresh_token' });
    // No retries: a timeout cannot establish whether the refresh token was rotated.
    const fresh = parseSellerToken(await requestJson(options.fetchImpl ?? globalThis.fetch, `https://auth.tiktok-shops.com/api/v2/token/refresh?${query}`), now());
    const required = JSON.parse(row.required_scopes_json) as string[];
    if (fresh.subjectId !== row.subject_id || !required.every(scope => fresh.scope.split(',').includes(scope))) throw new Error();
    const saved = await store.db.prepare(`UPDATE authorizations SET access_enc=?,refresh_enc=?,access_expires_at=?,refresh_expires_at=?,scopes_json=?,
      version=version+1,refresh_owner=NULL,refresh_until=NULL,updated_at=? WHERE id=? AND version=? AND refresh_owner=? AND refresh_until>? AND status='active' RETURNING id`)
      .bind(seal(options.secret,fresh.accessToken,`${row.id}:access`),seal(options.secret,fresh.refreshToken,`${row.id}:refresh`),fresh.expiresAtMs,
        fresh.refreshExpiresAtMs,JSON.stringify(fresh.scope.split(',')),now(),row.id,row.version,owner,now()).first();
    if (!saved) throw new Error();
    return fresh.accessToken;
  } catch {
    await store.db.prepare("UPDATE authorizations SET status='reauthorize_required',version=version+1,refresh_owner=NULL,refresh_until=NULL WHERE id=? AND version=? AND refresh_owner=?")
      .bind(row.id,row.version,owner).run();
    throw new Error('Reauthorization required');
  }
}
