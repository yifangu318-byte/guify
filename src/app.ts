import Fastify, { LogController } from 'fastify';
import type { Config } from './config.js';
import { createLogStream } from './logging.js';
import { createGateway, type GatewayOptions } from './gateway/index.js';
import { registerGatewayRest } from './gateway/rest.js';
import { createMcpModule } from './gateway/mcp.js';
import { registerWeb } from './web/routes.js';
import { WebAuditLog, type WebOptions } from './web/service.js';

export function buildApp(config: Config, destination?: NodeJS.WritableStream, gatewayOptions: GatewayOptions = {}, webOptions: WebOptions = {}, runtimeOptions: { pluginTimeout?: number } = {}) {
  const app = Fastify({
    ...runtimeOptions,
    logger: { level: 'info', stream: createLogStream(destination, { ...process.env, DATABASE_URL: config.databaseUrl }) },
    logController: new LogController({ disableRequestLogging: true }),
  });
  app.get('/health', async () => ({
    status: 'ok', service: 'muse-erp', version: '0.1.0',
    database: { status: config.databaseUrl ? 'configured_unverified' : 'not_configured' },
  }));
  app.get<{ Querystring: { code?: unknown; state?: unknown } }>('/api/tiktok/callback', async (request, reply) => {
    // Presence checks only: no exchange, state verification, storage or logging.
    // Real authorization and CSRF state verification belong to T10.
    reply.header('Cache-Control', 'no-store');
    const { code, state } = request.query;
    if (typeof code !== 'string' || !code.trim() || typeof state !== 'string' || !state.trim()) {
      return reply.code(400).send({ error: true, message: 'Invalid callback request', code: 'INVALID_REQUEST' });
    }
    return reply.code(501).send({ error: true, code: 'NOT_IMPLEMENTED',
      message: 'Placeholder: real code exchange is intentionally not wired yet; it will be completed in T10 after a real callback URL is published.' });
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
