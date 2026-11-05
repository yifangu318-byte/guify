import { httpServerHandler } from 'cloudflare:node';
import { env } from 'cloudflare:workers';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';

// Reuse the existing routes and logging; Workers owns the HTTP lifecycle.
// Boot during startup so Fastify can compile its router. Startup cannot run timers.
//
// Workers 说明：
// - 仍直接导入 src/ 的 TypeScript，由 Wrangler 打包，不回退到依赖本地先生成 dist/ 的旧入口。
// - D1 绑定变量名 DB、数据库 muse-erp、Secret TOKEN_ENCRYPTION_KEY 均来自 Cloudflare 后台，
//   不在代码、配置或提交里放任何密钥、Token、App Secret 值。
// - T11 授权接口另读 Dashboard 变量 TIKTOK_SERVICE_ID（非密钥值，仍只放后台，不写进代码）。
// - env 来自 cloudflare:workers，按请求解析；下面的 getter 只在请求处理时读取，
//   启动阶段不读取 env，因此本地 tsc（只编译 src/）不受影响。
// - 健康检查：env.DB 存在且 SELECT 1 可读时报 configured_verified；
//   绑定存在但不可读时报 configured_unverified；无绑定时报 not_configured。
//   D1 绑定存在绝不等于已连真实店铺。
const app = buildApp(loadConfig(), undefined, {}, {}, {
  pluginTimeout: 0,
  getRelease: () => env.MUSE_RELEASE,
  databaseHealth: async () => {
    try {
      const db = env.DB;
      if (!db) return 'not_configured';
      await db.prepare('SELECT 1 AS ok').first();
      return 'configured_verified';
    } catch {
      return 'configured_unverified';
    }
  },
  tiktok: {
    getSecret: () => env.TOKEN_ENCRYPTION_KEY,
    getAppKey: () => env.TIKTOK_APP_KEY,
    getAppSecret: () => env.TIKTOK_APP_SECRET,
    getRelayUrl: () => env.RELAY_URL,
    getRelaySecret: () => env.RELAY_SECRET,
    getServiceId: () => env.TIKTOK_SERVICE_ID,
    getDb: () => env.DB,
    getAdminToken: () => env.MUSE_OAUTH_ADMIN_TOKEN,
    getTargets: () => env.TIKTOK_SHOP_TARGETS,
    getEnvironment: () => env.MUSE_ENV,
    getEnabled: () => env.TIKTOK_OAUTH_ENABLED,
    getLiveEnabled: () => env.MUSE_LIVE_READ_ENABLED,
    getAiEnabled: () => env.MUSE_AI_API_ENABLED,
    getAiPublicEnabled: () => env.MUSE_AI_PUBLIC_ENABLED,
    getOfficialEnabled: () => env.MUSE_TIKTOK_API_ENABLED,
    getWriteEnabled: () => env.MUSE_TIKTOK_WRITE_ENABLED,
    getAdminPassword: () => env.MUSE_ADMIN_PASSWORD,
    getMultiShopEnabled: () => env.MUSE_MULTI_SHOP_ENABLED,
    getProductLimit: () => env.MUSE_LIVE_PRODUCT_LIMIT,
    getPublicUrl: () => env.PUBLIC_URL,
    getRelayAllowedOrigin: () => env.RELAY_ALLOWED_ORIGIN,
    now: Date.now,
  },
});
await app.ready();

export default httpServerHandler(app.server);
