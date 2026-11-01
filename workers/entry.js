import { httpServerHandler } from 'cloudflare:node';
import { buildApp } from '../dist/app.js';
import { loadConfig } from '../dist/config.js';

// Reuse the existing routes and logging; Workers owns the HTTP lifecycle.
// Boot during startup so Fastify can compile its router. Startup cannot run timers.
const app = buildApp(loadConfig(), undefined, {}, {}, { pluginTimeout: 0 });
await app.ready();

export default httpServerHandler(app.server);
