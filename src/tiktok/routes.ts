import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { issueState } from './crypto.js';
import { authenticated, browserCookie, handleTikTokCallback, parseTargets } from './oauth.js';
import { D1OAuthStore, hash, type LifecycleDb } from './vault.js';
import { registerConnectionPage } from './connection-page.js';
import { registerLive } from '../live/routes.js';

export interface TiktokRuntime {
  getSecret?: () => string | undefined; getAppKey?: () => string | undefined; getAppSecret?: () => string | undefined;
  getServiceId?: () => string | undefined; getDb?: () => LifecycleDb | undefined;
  getRelayUrl?: () => string | undefined; getRelaySecret?: () => string | undefined; getRelayAllowedOrigin?: () => string | undefined;
  getAdminToken?: () => string | undefined; getTargets?: () => string | undefined;
  getEnvironment?: () => string | undefined; getEnabled?: () => string | undefined; getPublicUrl?: () => string | undefined;
  getLiveEnabled?: () => string | undefined;
  getProductLimit?: () => string | undefined;
  fetchImpl?: typeof fetch; now?: () => number;
}
export function registerOAuth(app: FastifyInstance, runtime: TiktokRuntime = {}) {
  registerConnectionPage(app);
  registerLive(app,runtime);
  const read = (getter: (() => string | undefined) | undefined, name: string) => getter ? getter() : process.env[name];
  const settings = () => ({
    secret: read(runtime.getSecret,'TOKEN_ENCRYPTION_KEY'), appKey: read(runtime.getAppKey,'TIKTOK_APP_KEY'), appSecret: read(runtime.getAppSecret,'TIKTOK_APP_SECRET'),
    serviceId: read(runtime.getServiceId,'TIKTOK_SERVICE_ID'), admin: read(runtime.getAdminToken,'MUSE_OAUTH_ADMIN_TOKEN'),
    targets: parseTargets(read(runtime.getTargets,'TIKTOK_SHOP_TARGETS')),
    environment: read(runtime.getEnvironment,'MUSE_ENV') ?? 'simulation', enabled: read(runtime.getEnabled,'TIKTOK_OAUTH_ENABLED') === 'true',
    publicUrl: read(runtime.getPublicUrl,'PUBLIC_URL'), db: runtime.getDb?.(),
    relayUrl: read(runtime.getRelayUrl,'RELAY_URL'), relaySecret: read(runtime.getRelaySecret,'RELAY_SECRET'), relayAllowedOrigin: read(runtime.getRelayAllowedOrigin,'RELAY_ALLOWED_ORIGIN'),
  });
  const error = (code: string, message: string) => ({ error: true, code, message });
  // Administrator-only preflight: never returns credential values, cipher text or seller subjects.
  app.get('/api/tiktok/connection', async (request,reply) => {
    reply.header('Cache-Control','no-store').header('Referrer-Policy','no-referrer');
    if (!authenticated(request.headers.authorization,read(runtime.getAdminToken,'MUSE_OAUTH_ADMIN_TOKEN')))
      return reply.code(401).send(error('UNAUTHORIZED','Authorization required'));
    const config = settings();
    let origin: URL | undefined;
    try {
      const candidate = new URL(config.publicUrl ?? '');
      if (candidate.protocol === 'https:' && !candidate.username && !candidate.password && !candidate.search && !candidate.hash && candidate.pathname === '/') origin = candidate;
    } catch { /* Report only a boolean configuration check. */ }
    if (request.headers['sec-fetch-site'] === 'cross-site' || (origin && (request.headers.host !== origin.host || (request.headers.origin && request.headers.origin !== origin.origin))))
      return reply.code(403).send(error('FORBIDDEN','Authorization origin rejected'));
    let database = false;
    if (config.db) { try { await new D1OAuthStore(config.db).ready(); database = true; } catch { /* No raw DB errors. */ } }
    const checks = {
      enabled: config.enabled && ['test','staging','production'].includes(config.environment),
      public_origin: !!origin, application: !!config.appKey && !!config.appSecret && !!config.serviceId?.trim(),
      encryption_key: !!config.secret && /^[a-fA-F0-9]{64}$/.test(config.secret), database, targets: config.targets.length > 0,
    };
    const targets = [];
    for (const target of config.targets) {
      let status = 'not_connected';
      if (database && config.db && config.appKey) {
        const row = await config.db.prepare('SELECT a.status, a.access_expires_at, a.refresh_expires_at FROM authorizations a JOIN authorized_shops s ON s.authorization_id=a.id WHERE s.app_hash=? AND s.tiktok_shop_id=?')
          .bind(hash(config.appKey),target.shopId).first<{status:string;access_expires_at:number;refresh_expires_at:number}>();
        if (row) status = row.status === 'active' && row.refresh_expires_at <= (runtime.now ?? Date.now)() ? 'reauthorize_required' : row.status;
      }
      targets.push({shop_id:target.shopId,market:target.market,status});
    }
    return {ready:Object.values(checks).every(Boolean),checks,targets};
  });
  app.get<{ Querystring: { market?: unknown; shop_id?: unknown } }>('/api/tiktok/authorize', async (request,reply) => {
    reply.header('Cache-Control','no-store').header('Referrer-Policy','no-referrer');
    const config = settings();
    if (!authenticated(request.headers.authorization,config.admin)) return reply.code(401).send(error('UNAUTHORIZED','Authorization required'));
    if (!config.enabled || !['test','staging','production'].includes(config.environment)) return reply.code(503).send(error('OAUTH_UNAVAILABLE','Authorization is not enabled'));
    let origin: URL;
    try {
      origin = new URL(config.publicUrl ?? '');
      if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error();
    } catch { return reply.code(503).send(error('OAUTH_UNAVAILABLE','Public origin unavailable')); }
    if (request.headers.host !== origin.host || (request.headers.origin && request.headers.origin !== origin.origin)
      || request.headers['sec-fetch-site'] === 'cross-site') return reply.code(403).send(error('FORBIDDEN','Authorization origin rejected'));
    const { market, shop_id } = request.query;
    const target = config.targets.find(t => t.market === market && t.shopId === shop_id);
    if (!target || Object.keys(request.query).some(k => !['market','shop_id'].includes(k))) return reply.code(400).send(error('INVALID_REQUEST','Invalid authorize request'));
    if (!config.secret || !/^[a-fA-F0-9]{64}$/.test(config.secret) || !config.serviceId?.trim() || !config.appKey || !config.appSecret || !config.db)
      return reply.code(503).send(error('OAUTH_UNAVAILABLE','Authorization configuration unavailable'));
    const now = runtime.now ?? Date.now;
    const binding = browserCookie(request.headers.cookie) ?? randomBytes(32).toString('hex');
    const issued = issueState(config.secret,{ market: target.market, shopCode: target.shopId, now });
    try { await new D1OAuthStore(config.db).issue(issued.state,binding,config.appKey,target,issued.expiresAt,now()); }
    catch { return reply.code(503).send(error('DATABASE_UNAVAILABLE','Authorization storage unavailable')); }
    reply.header('Set-Cookie',`__Host-muse_oauth=${binding}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`);
    const location = `https://services.tiktokshop.com/open/authorize?service_id=${encodeURIComponent(config.serviceId.trim())}&state=${encodeURIComponent(issued.state)}`;
    app.log.info({event:'tiktok_authorize_issued',market:target.market},'TikTok authorization issued');
    if (request.headers.accept?.includes('application/json')) return { authorization_url: location };
    return reply.code(302).header('Location',location).send();
  });
  app.get<{ Querystring: { code?: unknown; state?: unknown } }>('/api/tiktok/callback', async (request,reply) => {
    reply.header('Cache-Control','no-store').header('Referrer-Policy','no-referrer');
    const config = settings();
    // A configured origin also binds the callback host. The browser binding never comes from query input.
    if (config.publicUrl && request.headers.host !== new URL(config.publicUrl).host) return reply.code(400).send(error('STATE_UNVERIFIED','State verification failed'));
    const result = await handleTikTokCallback(request.query,{...config,browser:browserCookie(request.headers.cookie),fetchImpl:runtime.fetchImpl,now:runtime.now});
    app.log.info({event:'tiktok_callback',outcome:result.logEvent,status:result.status},'TikTok callback handled');
    return reply.code(result.status).send(result.body);
  });
  // No public diag-fetch route. Failures never trigger hidden cross-host probes.
}
