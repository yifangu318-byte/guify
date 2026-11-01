import { httpServerHandler } from 'cloudflare:node';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';

// Reuse the existing routes and logging; Workers owns the HTTP lifecycle.
// Boot during startup so Fastify can compile its router. Startup cannot run timers.
const app = buildApp(loadConfig(), undefined, {}, {}, { pluginTimeout: 0 });
await app.ready();

export default httpServerHandler(app.server);
