import { buildApp } from './app.js';
import { loadConfig } from './config.js';

async function main() {
  const config = loadConfig();
  const app = buildApp(config);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void app.close().catch(() => { process.exitCode = 1; });
    });
  }
  await app.listen({ port: config.port, host: config.host });
}

main().catch(() => {
  process.stderr.write('{"level":50,"msg":"Service startup failed; check configuration and port availability"}\n');
  process.exitCode = 1;
});
