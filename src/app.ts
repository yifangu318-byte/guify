import Fastify, { LogController } from 'fastify';
import type { Config } from './config.js';
import { createLogStream } from './logging.js';
import { createGateway, type GatewayOptions } from './gateway/index.js';
import { registerGatewayRest } from './gateway/rest.js';
import { createMcpModule } from './gateway/mcp.js';
import { registerWeb } from './web/routes.js';
import { WebAuditLog, type WebOptions } from './web/service.js';
import { handleTikTokCallback } from './tiktok/callback.js';
import { issueState } from './tiktok/crypto.js';
import type { D1Binding } from './tiktok/d1.js';

export type DatabaseHealthStatus = 'configured_verified' | 'configured_unverified' | 'not_configured';

export interface TiktokRuntime {
  getSecret?: () => string | undefined;
  getAppKey?: () => string | undefined;
  getAppSecret?: () => string | undefined;
  getRelayUrl?: () => string | undefined;
  getRelaySecret?: () => string | undefined;
  getServiceId?: () => string | undefined;
  getDb?: () => D1Binding | undefined;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface RuntimeOptions {
  pluginTimeout?: number;
  /** Workers 下按请求读取 env.DB 的探针；未提供时回退到 DATABASE_URL 口径。 */
  databaseHealth?: () => Promise<DatabaseHealthStatus>;
  tiktok?: TiktokRuntime;
}

export function buildApp(config: Config, destination?: NodeJS.WritableStream, gatewayOptions: GatewayOptions = {}, webOptions: WebOptions = {}, runtimeOptions: RuntimeOptions = {}) {
  const app = Fastify({
    ...runtimeOptions,
    logger: { level: 'info', stream: createLogStream(destination, { ...process.env, DATABASE_URL: config.databaseUrl }) },
    logController: new LogController({ disableRequestLogging: true }),
  });
  app.get('/health', async () => {
    // T10：D1 绑定存在且可读时报 configured_verified；绑定存在但不可读时报
    // configured_unverified；无绑定且无 DATABASE_URL 时保持 not_configured。
    // D1 绑定存在绝不等于已连真实店铺，真实店铺连接须另以授权记录为准。
    let databaseStatus: DatabaseHealthStatus;
    if (runtimeOptions.databaseHealth) {
      try {
        databaseStatus = await runtimeOptions.databaseHealth();
      } catch {
        databaseStatus = 'configured_unverified';
      }
    } else {
      databaseStatus = config.databaseUrl ? 'configured_unverified' : 'not_configured';
    }
    return { status: 'ok', service: 'muse-erp', version: '0.1.0', database: { status: databaseStatus } };
  });
  app.get<{ Querystring: { market?: unknown } }>('/api/tiktok/authorize', async (request, reply) => {
    // T11 authorize: browser navigation entry point only, NOT a Gateway/MCP tool.
    // Issues an ERP-signed state (market only, no shop_code in v1) and 302-redirects
    // to the ROW authorize host. Never reads App Key / App Secret here; never logs
    // state, Service ID, or the full redirect URL.
    reply.header('Cache-Control', 'no-store');
    const tiktok = runtimeOptions.tiktok;
    const marketRaw = request.query.market;
    const market = typeof marketRaw === 'string' ? marketRaw.trim() : undefined;
    const allowedMarkets = ['MY', 'PH', 'SG', 'TH', 'VN'];
    if (!market || !allowedMarkets.includes(market)) {
      app.log.info({ event: 'tiktok_authorize_invalid_request', status: 400 }, 'TikTok authorize rejected');
      return reply.code(400).send({ error: true, message: 'Invalid authorize request', code: 'INVALID_REQUEST' });
    }
    const secret = tiktok?.getSecret ? tiktok.getSecret() : process.env.TOKEN_ENCRYPTION_KEY;
    const serviceId = tiktok?.getServiceId ? tiktok.getServiceId() : process.env.TIKTOK_SERVICE_ID;
    if (!secret?.trim()) {
      app.log.info({ event: 'tiktok_authorize_missing_config', status: 503 }, 'TikTok authorize rejected');
      return reply.code(503).send({ error: true, message: 'Token encryption key is not configured; authorize cannot be issued safely.', code: 'TOKEN_ENCRYPTION_KEY_MISSING' });
    }
    if (!serviceId?.trim()) {
      app.log.info({ event: 'tiktok_authorize_missing_config', status: 503 }, 'TikTok authorize rejected');
      return reply.code(503).send({ error: true, message: 'Service ID is not configured; authorize cannot be issued.', code: 'SERVICE_ID_MISSING' });
    }
    const issued = issueState(secret.trim(), { market });
    const redirectUrl = `https://services.tiktokshop.com/open/authorize?service_id=${encodeURIComponent(serviceId.trim())}&state=${encodeURIComponent(issued.state)}`;
    app.log.info({ event: 'tiktok_authorize_issued', market, status: 302 }, 'TikTok authorize issued');
    return reply.code(302).header('Location', redirectUrl).send();
  });
  app.get<{ Querystring: { code?: unknown; state?: unknown } }>('/api/tiktok/callback', async (request, reply) => {
    // T10 真实回调：state 校验 + App 凭证检查 + 换 Token + 加密落 D1。
    // 日志只记事件名与错误码，绝不记录 code / state / Token / 密钥。
    reply.header('Cache-Control', 'no-store');
    const tiktok = runtimeOptions.tiktok;
    const outcome = await handleTikTokCallback(request.query, {
      secret: tiktok?.getSecret ? tiktok.getSecret() : process.env.TOKEN_ENCRYPTION_KEY,
      appKey: tiktok?.getAppKey ? tiktok.getAppKey() : process.env.TIKTOK_APP_KEY,
      appSecret: tiktok?.getAppSecret ? tiktok.getAppSecret() : process.env.TIKTOK_APP_SECRET,
      relayUrl: tiktok?.getRelayUrl ? tiktok.getRelayUrl() : process.env.RELAY_URL,
      relaySecret: tiktok?.getRelaySecret ? tiktok.getRelaySecret() : process.env.RELAY_SECRET,
      db: tiktok?.getDb ? tiktok.getDb() : undefined,
      ...(tiktok?.fetchImpl ? { fetchImpl: tiktok.fetchImpl } : {}),
      ...(tiktok?.now ? { now: tiktok.now } : {}),
    });
    app.log.info({ event: 'tiktok_callback', outcome: outcome.logEvent, status: outcome.status }, 'TikTok callback handled');
    return reply.code(outcome.status).send(outcome.body);
  });
  app.get('/api/tiktok/diag-fetch', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const tiktok = runtimeOptions.tiktok;
    const fetchImpl = tiktok?.fetchImpl ?? fetch;
    const timestamp = Math.floor((tiktok?.now ?? Date.now)() / 1000);
    const relayUrl = (tiktok?.getRelayUrl ? tiktok.getRelayUrl() : process.env.RELAY_URL)?.trim().replace(/\/+$/, '');
    const authUrl = 'https://auth.tiktok-shops.com/api/v2/token/get?app_key=diag-fake&app_secret=diag-fake&auth_code=diag-fake&grant_type=authorized_code';
    const shopsQuery = `app_key=diag-fake&timestamp=${timestamp}&sign=diag-fake`;
    const shopsUrl = `https://open-api.tiktokglobalshop.com/authorization/202309/shops?${shopsQuery}`;
    const headers = {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    };
    // These six probes use fixed synthetic inputs and never read upstream bodies.
    const definitions: Array<{ id: string; url: string | undefined; init: RequestInit }> = [
      { id: 'auth-no-headers', url: authUrl, init: { method: 'GET' } },
      { id: 'shops-no-headers', url: shopsUrl, init: { method: 'GET' } },
      { id: 'shops-headers', url: shopsUrl, init: { method: 'GET', headers } },
      { id: 'relay-health-no-headers', url: relayUrl ? `${relayUrl}/health` : undefined, init: { method: 'GET' } },
      {
        id: 'relay-forward-fake-secret', url: relayUrl ? `${relayUrl}/forward?${shopsQuery}` : undefined,
        init: {
          method: 'POST',
          headers: { ...headers, 'x-tts-access-token': 'diag-fake', 'x-relay-secret': 'diag-fake', 'Content-Type': 'application/json' },
          body: '{"host":"open-api.tiktokglobalshop.com","path":"/authorization/202309/shops"}',
        },
      },
      { id: 'auth-headers', url: authUrl, init: { method: 'GET', headers } },
    ];
    const probes: Array<{ id: string; responded: boolean; http: number | null; threw: string | null; skipped: boolean }> = [];
    for (const { id, url, init } of definitions) {
      if (url === undefined) {
        probes.push({ id, responded: false, http: null, threw: null, skipped: true });
        continue;
      }
      try {
        // Report the first HTTP response, including redirects and relay 401s.
        const response = await fetchImpl(url, { ...init, redirect: 'manual' });
        probes.push({ id, responded: true, http: response.status, threw: null, skipped: false });
      } catch (error) {
        // Built-in constructor labels cannot disclose error.name/message/stack
        // or arbitrary text from a custom constructor name.
        const constructor = [DOMException, TypeError, RangeError, ReferenceError, SyntaxError, URIError, EvalError, AggregateError, Error]
          .find(candidate => error instanceof candidate);
        probes.push({ id, responded: false, http: null, threw: constructor?.name ?? 'UnknownError', skipped: false });
      }
    }
    // Keep the original six probes unchanged. These two isolate request defaults
    // and a preceding JSON parse using synthetic credentials only.
    const mimicProbes: Array<{ id: string; responded: boolean; http: number | null; threw: string | null }> = [];
    const runMimicProbe = async (id: string, url: string, init: RequestInit) => {
      try {
        const response = await fetchImpl(url, init);
        mimicProbes.push({ id, responded: true, http: response.status, threw: null });
      } catch (error) {
        const constructor = [DOMException, TypeError, RangeError, ReferenceError, SyntaxError, URIError, EvalError, AggregateError, Error]
          .find(candidate => error instanceof candidate);
        mimicProbes.push({ id, responded: false, http: null, threw: constructor?.name ?? 'UnknownError' });
      }
    };
    const controlQuery = new URLSearchParams({
      app_key: 'synthetic-control-app-key',
      timestamp: String(timestamp),
      sign: 'synthetic-control-sign',
    });
    await runMimicProbe('control-mimic', `https://open-api.tiktokglobalshop.com/authorization/202309/shops?${controlQuery}`, { headers });
    try {
      const response = await fetchImpl(authUrl, { method: 'GET', redirect: 'manual' });
      // Sole body-reading exception: parse the fake token error, immediately
      // discard its value, and never expose parse/fetch errors or block shops.
      await response.json();
    } catch { /* A failed warm-up must not affect the following shops probe. */ }
    await runMimicProbe('callback-flow-mimic', shopsUrl, { method: 'GET', redirect: 'manual', headers });
    return { probes: [...probes, ...mimicProbes] };
  });
  app.setNotFoundHandler((_request, reply) => {
    return reply.code(404).send({ error: true, message: 'Route not found', code: 'NOT_FOUND' });
  });
  app.setErrorHandler((error, _request, reply) => {
    const candidate = error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined;
    const statusCode = typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 400 && candidate < 500 ? candidate : 500;
    app.log.error({ statusCode }, 'Request failed');
    return reply.code(statusCode).send({ error: true, message: statusCode === 500 ? 'Internal server error' : 'Invalid request', code: statusCode === 500 ? 'INTERNAL_ERROR' : 'INVALID_REQUEST' });
  });
  const webAudit = new WebAuditLog();
  const gateway = createGateway({ ...gatewayOptions, audit: record => {
    app.log.info(record, 'Gateway read');
    // Bounded, memory-only summaries for the T9 simulation log page.
    try { webAudit.record(record, (webOptions.now ?? Date.now)()); } catch { /* Web audit must not interrupt the existing audit sink. */ }
    gatewayOptions.audit?.(record);
  } });
  registerGatewayRest(app, gateway);
  registerWeb(app, webOptions, webAudit);
  // The stdio launcher attaches to this exact Gateway, also used by REST.
  const mcp = createMcpModule(gateway);
  app.addHook('onClose', async () => { await mcp.close(); });
  const gatewayApp = app.decorate('gateway', gateway).decorate('mcp', mcp);
  return gatewayApp;
}
