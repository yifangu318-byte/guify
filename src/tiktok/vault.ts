import { createHash, randomUUID, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { D1Binding, D1Prepared } from './d1.js';
import type { TokenExchangeResult } from './callback.js';
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export interface LifecycleDb extends D1Binding { batch(statements: D1Prepared[]): Promise<unknown[]> }
export interface Target { shopId: string; market: string; subjectId: string }
export interface SessionRow {
  state_hash: string; browser_hash: string; app_hash: string; shop_id: string; market: string; subject_id: string;
  expires_at: number; status: string; owner: string | null; code_hash: string | null; result_json: string | null;
}
export interface AuthorizationRow {
  id: string; app_hash: string; subject_id: string; access_enc: string; refresh_enc: string;
  access_expires_at: number; refresh_expires_at: number; scopes_json: string; required_scopes_json: string;
  status: string; version: number; refresh_owner: string | null; refresh_until: number | null; key_version: string;
}
/** Versioned vault encryption is bound to authorization + token purpose. Legacy ciphertext stays separate. */
export function seal(secret: string, value: string, context: string): string {
  if (!/^[a-fA-F0-9]{64}$/.test(secret)) throw new Error('Vault configuration unavailable');
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', Buffer.from(secret, 'hex'), iv);
  cipher.setAAD(Buffer.from(`muse:v1:${context}`));
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}
export function unseal(secret: string, value: string, context: string): string {
  try {
    if (!/^[a-fA-F0-9]{64}$/.test(secret)) throw new Error();
    const bytes = Buffer.from(value, 'base64'), decipher = createDecipheriv('aes-256-gcm', Buffer.from(secret, 'hex'), bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(`muse:v1:${context}`)); decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
  } catch { throw new Error('Vault unavailable'); }
}
export class D1OAuthStore {
  constructor(readonly db: LifecycleDb) {}
  async ready() {
    if (typeof this.db.batch !== 'function') throw new Error('Migration required');
    const row = await this.db.prepare('SELECT version FROM muse_schema_versions WHERE version = 3').first();
    if (!row) throw new Error('Migration required');
    // Validate all required tables/columns before consuming a one-time authorization code.
    await this.db.prepare('SELECT s.state_hash, a.write_id, a.refresh_until, p.cipher, e.event FROM oauth_sessions s LEFT JOIN authorizations a ON 0 LEFT JOIN authorized_shops p ON 0 LEFT JOIN oauth_audit e ON 0 LIMIT 1').first();
  }
  async issue(state: string, browser: string, app: string, target: Target, expires: number, now: number) {
    await this.ready();
    // D1 is the shared limiter; no per-isolate counters or timer cleanup assumptions.
    const mapped = await this.authorization(app,target.shopId);
    if (mapped && target.subjectId && mapped.subject_id !== target.subjectId) throw new Error('Shop identity conflict');
    const inserted = await this.db.prepare(`INSERT INTO oauth_sessions (state_hash,browser_hash,app_hash,shop_id,market,subject_id,expires_at,created_at)
      SELECT ?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM oauth_sessions WHERE created_at>?)<10 RETURNING state_hash`)
      .bind(hash(state), hash(browser), hash(app), target.shopId, target.market, target.subjectId, expires, now, now-60_000).first();
    if (!inserted) throw new Error('Authorization temporarily unavailable');
  }
  async session(state: string, browser: string, app: string, now: number): Promise<SessionRow | null> {
    return this.db.prepare('SELECT * FROM oauth_sessions WHERE state_hash=? AND browser_hash=? AND app_hash=? AND expires_at>?')
      .bind(hash(state), hash(browser), hash(app), now).first<SessionRow>();
  }
  async claim(state: string, browser: string, app: string, code: string, now: number): Promise<SessionRow | null> {
    return this.db.prepare("UPDATE oauth_sessions SET status='processing', owner=?, code_hash=? WHERE state_hash=? AND browser_hash=? AND app_hash=? AND expires_at>? AND status='pending' RETURNING *")
      .bind(randomUUID(), hash(code), hash(state), hash(browser), hash(app), now).first<SessionRow>();
  }
  async fail(row: SessionRow, now: number, result = 'reauthorize_required') {
    await this.db.batch([
      this.db.prepare("UPDATE oauth_sessions SET status='failed' WHERE state_hash=? AND owner=? AND status='processing'").bind(row.state_hash, row.owner),
      this.db.prepare('INSERT INTO oauth_audit(id,event,result,shop_id,created_at) VALUES (?,?,?,?,?)').bind(randomUUID(), 'oauth_callback', result, row.shop_id, now),
    ]);
  }
  async complete(row: SessionRow, token: TokenExchangeResult, cipher: string, secret: string, required: string[], now: number,shopId=row.shop_id,otherShops:Array<{id:string;market:string;cipher:string}>=[]) {
    const subjectId = row.subject_id || token.subjectId;
    const id = hash(`${row.app_hash}:${subjectId}`), internalId = hash(`${row.app_hash}:${shopId}`);
    const result = { error: false, shop_code: shopId, market: row.market, expires_at: token.expiresAtMs };
    const scopes = token.scope.split(',');
    await this.db.batch([
      this.db.prepare(`INSERT INTO authorizations(id,app_hash,subject_id,access_enc,refresh_enc,access_expires_at,refresh_expires_at,scopes_json,required_scopes_json,status,updated_at,write_id)
        SELECT ?,?,?,?,?,?,?,?,?,'active',?,? WHERE EXISTS (SELECT 1 FROM oauth_sessions WHERE state_hash=? AND owner=? AND status='processing')
        ON CONFLICT(id) DO UPDATE SET access_enc=excluded.access_enc,refresh_enc=excluded.refresh_enc,access_expires_at=excluded.access_expires_at,
        refresh_expires_at=excluded.refresh_expires_at,scopes_json=excluded.scopes_json,required_scopes_json=excluded.required_scopes_json,status='active',
        updated_at=excluded.updated_at,write_id=excluded.write_id,version=authorizations.version+1 WHERE authorizations.refresh_owner IS NULL`)
        .bind(id, row.app_hash, subjectId, seal(secret, token.accessToken, `${id}:access`), seal(secret, token.refreshToken, `${id}:refresh`), token.expiresAtMs,
          token.refreshExpiresAtMs, JSON.stringify(scopes), JSON.stringify(required), now, row.owner, row.state_hash, row.owner),
      this.db.prepare(`INSERT INTO authorized_shops(id,app_hash,tiktok_shop_id,authorization_id,market,cipher,updated_at)
        SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM authorizations WHERE id=? AND write_id=?)
        ON CONFLICT(id) DO UPDATE SET cipher=excluded.cipher,market=excluded.market,updated_at=excluded.updated_at WHERE authorized_shops.authorization_id=excluded.authorization_id`)
        .bind(internalId, row.app_hash, shopId, id, row.market, cipher, now, id, row.owner),
      ...otherShops.map(shop=>this.db.prepare(`UPDATE authorized_shops SET cipher=?,updated_at=? WHERE app_hash=? AND tiktok_shop_id=? AND market=? AND authorization_id=?
        AND EXISTS(SELECT 1 FROM authorizations WHERE id=? AND write_id=?)`).bind(shop.cipher,now,row.app_hash,shop.id,shop.market,id,id,row.owner)),
      this.db.prepare(`UPDATE oauth_sessions SET status='succeeded',result_json=? WHERE state_hash=? AND owner=? AND status='processing'
        AND EXISTS(SELECT 1 FROM authorizations a JOIN authorized_shops s ON s.authorization_id=a.id WHERE a.id=? AND a.write_id=? AND s.id=?)`)
        .bind(JSON.stringify(result), row.state_hash, row.owner, id, row.owner, internalId),
      this.db.prepare(`INSERT INTO oauth_audit(id,event,result,shop_id,created_at) SELECT ?,'oauth_callback','succeeded',?,? WHERE EXISTS(SELECT 1 FROM oauth_sessions WHERE state_hash=? AND owner=? AND status='succeeded')`)
        .bind(randomUUID(), shopId, now, row.state_hash, row.owner),
    ]);
    const saved = await this.db.prepare("SELECT status FROM oauth_sessions WHERE state_hash=? AND owner=? AND status='succeeded'").bind(row.state_hash, row.owner).first();
    if (!saved) throw new Error('Authorization write conflict');
    return result;
  }
  async authorization(app: string, shopId: string): Promise<AuthorizationRow | null> {
    return this.db.prepare('SELECT a.* FROM authorizations a JOIN authorized_shops s ON s.authorization_id=a.id WHERE s.app_hash=? AND s.tiktok_shop_id=?')
      .bind(hash(app), shopId).first<AuthorizationRow>();
  }
}
