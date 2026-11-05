import Fastify, { LogController } from 'fastify';
import type { Config } from './config.js';
import { createLogStream } from './logging.js';
import { createGateway, type GatewayOptions } from './gateway/index.js';
import { registerGatewayRest } from './gateway/rest.js';
import { createMcpModule } from './gateway/mcp.js';
import { registerWeb } from './web/routes.js';
import { WebAuditLog, type WebOptions } from './web/service.js';
import { registerOAuth, type TiktokRuntime } from './tiktok/routes.js';
export type { TiktokRuntime } from './tiktok/routes.js';

export type DatabaseHealthStatus = 'configured_verified' | 'configured_unverified' | 'not_configured';

export interface RuntimeOptions {
  pluginTimeout?: number;
  /** Workers 下按请求读取 env.DB 的探针；未提供时回退到 DATABASE_URL 口径。 */
  databaseHealth?: () => Promise<DatabaseHealthStatus>;
  getRelease?: () => string | undefined;
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
    const release = runtimeOptions.getRelease?.();
    return { status: 'ok', service: 'muse-erp', version: '0.1.0', database: { status: databaseStatus }, ...(release ? { release } : {}) };
  });
  app.get('/', async (_request,reply) => {
    const ai=(runtimeOptions.tiktok?.getAiEnabled?runtimeOptions.tiktok.getAiEnabled():process.env.MUSE_AI_API_ENABLED)==='true';
    if(ai)return reply.code(302).header('Cache-Control','no-store').header('Location','/developers').send();
    const live=(runtimeOptions.tiktok?.getLiveEnabled?runtimeOptions.tiktok.getLiveEnabled():process.env.MUSE_LIVE_READ_ENABLED)==='true';
    return reply.code(302).header('Cache-Control','no-store').header('Location',live?'/live':'/web/').send();
  });
  registerOAuth(app, runtimeOptions.tiktok);
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
