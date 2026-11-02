# T10 真实接入代码（窄范围）

本分支在 PR #2（fix/workers-preview-build，head 3988c1f）基础上实现 T10 硬需求，
不含真实店铺授权本身——真实授权需要用户在 TikTok 账号里改回调并点授权，
本代码无法代劳，详见文末“仍缺什么”。

## 改了什么

- `src/tiktok/crypto.ts`（新增）：Token 加密与回调 state 签发。
  - 只读 Workers env 的 `TOKEN_ENCRYPTION_KEY`，绝不硬编码、不进聊天、不进提交。
  - AES-256-GCM，随机 12 字节 IV，输出 base64(IV || 认证标签 16 字节 || 密文)。
  - 密钥解析兼容 64 位 hex（32 字节）与普通字符串（后者先 SHA-256 派生 32 字节）；
    换密钥后旧 Token 与旧 state 一律不可解、校验失败，属预期行为。
  - state：HMAC-SHA256，用途区分字符串 `tiktok-oauth-state-v1`，有效期 10 分钟，防重放。
- `src/tiktok/d1.ts`（新增）与 `migrations/d1/0001_shop_tokens.sql`（新增）：
  D1 店铺 Token 注册表 `shop_tokens`（SQLite 方言），字段含 shop_code（主键）、
  market、加密后的 access_token、refresh_token、过期时间（毫秒）、scope、
  创建/更新时间。本层只存密文，绝不存明文。market 为 `unknown` 时表示
  回调里未提供市场、不得凭空猜测，须以 Partner Center / Seller Center 授权记录为准。
- `src/tiktok/callback.ts`（新增）：`/api/tiktok/callback` 的真实处理顺序。
  1. code / state 缺失、空白、重复 → 400 INVALID_REQUEST，不回显入参；
  2. 无 `TOKEN_ENCRYPTION_KEY` → 503 TOKEN_ENCRYPTION_KEY_MISSING；
  3. state 非本站签发、过期、篡改 → 400 STATE_UNVERIFIED，日志只记事件名 state_unverified；
  4. 无 `TIKTOK_APP_KEY` / `TIKTOK_APP_SECRET` → 503 APP_CREDENTIALS_MISSING，
     中文明示“未配置应用凭证，无法换 Token”；
  5. 无 D1 绑定 → 503 DATABASE_UNAVAILABLE；
  6. code 换 Token 成功后加密落 D1，响应只返回 shop_code / market / expires_at，
     绝不返回任何 Token；换 Token 失败只返回上游错误类别，不回显原始报文。
  - 换 Token 端点与签名写法来自仓库 RESEARCH-2026-10-30.md 记载的第三方资料一致写法
   （`auth.tiktok-shops.com/api/v2/token/get`，GET，HMAC-SHA256 草案签名），
    尚未获官方文档复核——真实换 Token 成功前不得宣称已接入。
  - 店铺不一致保护：state 里的 shop_code 与换 Token 返回的 shop_id 不一致时拒绝落库。
  - 401 只刷新一次的口径属于 T2 只读适配器的读请求重试，不适用于首次 code 换 Token。
- `src/app.ts`（改）：健康检查与回调接线。
  - `/health`：D1 探针通过报 `configured_verified`，绑定存在但不可读报
    `configured_unverified`，无绑定且无 DATABASE_URL 时保持 `not_configured`；
    D1 绑定存在绝不等于已连真实店铺。
  - 回调日志只记事件名与错误码，绝不记录 code / state / Token / 密钥。
- `workers/entry.js`（改）：仍直接导入 `src/` 的 TypeScript，由 Wrangler 打包，
  不回退到依赖 dist/ 的旧入口；按请求从 `cloudflare:workers` 的 env 里读
  D1（DB）与 Secret（TOKEN_ENCRYPTION_KEY、TIKTOK_APP_KEY、TIKTOK_APP_SECRET）。
- `wrangler.jsonc`（改）：增加 D1 绑定（变量 DB、数据库 muse-erp、数据库 ID 来自
  Cloudflare 后台资源标识，非密钥，部署前请在后台核对一次）；Secret 只放后台，
  绝不写进本文件。
- `test/app.test.ts`（改）：旧的 501 占位测试改为 T10 的 state_unverified 测试。
- `test/t10.test.ts`（新增，8 个测试）：加密往返、state 校验、D1 模拟落库/读取、
  缺凭证错误路径、换 Token 成功加密落库、换 Token 失败与店铺不一致、健康检查、
  HTTP 路由不回显。D1 测试用本地模拟实现，明确标注为模拟，不是真实 D1。
- `.env.example`、`CLOUDFLARE.md`：同步 T10 的 Secret / 回调口径，旧 501 描述已更新。

## 测试证据（本地）

- 基线（PR #2 head，未改代码）：`npm test` 340/340 通过。
- 改后：`npm test` 348/348 通过（基线 340 + 新增 8），`npm run build` 通过。
- GMV 口径不变：全部状态订单原始金额合计（含未付款/已取消），按币种分列，
  不是实收；该口径由 T6/T9 现有测试继续覆盖，未改动。

## Cloudflare 后台现状（本代码不改动后台）

- D1 muse-erp 已建好并绑定（变量 DB），Secret TOKEN_ENCRYPTION_KEY 已设，
  根域 senaloerp.online 已切到 guify Worker，`/health` 已为 200，
  但 database 仍为 not_configured——正是因为旧代码还没读 D1。
  本分支代码部署后，健康检查应变为 configured_verified（D1 可读时），
  否则为 configured_unverified，不再只认 DATABASE_URL。

## 仍缺什么（未完成，不得宣称已完成真实接入）

1. 真实 App Secret：须由用户在安全环境注入 Cloudflare Secrets，
   绝不在聊天、代码、提交里出现；本代码缺失时只会明确报错，不会假装成功。
2. Partner Center：把重定向改成 `https://senaloerp.online/api/tiktok/callback` 并发布。
3. 卖家在 TikTok 账号里点授权，拿到真实 code 后走一次真实回调，验证换 Token、
   加密落 D1、D1 里可读回（解密验证）全链路。
4. 真实订单/商品/库存实读，并与 Seller Center 做 20 条抽查。
5. 真实日报（沿用 GMV 原始合计、非实收的注明）。
6. 签名官方复核（含换 Token 端点与签名算法的官方文档确认）。
7. 七天稳定性：只建计划与记录，未跑完不得宣称通过。
8. PR #2 本身仍为草稿、未合并到 main；本分支为新的草稿 PR，不擅自合并、
   不擅自部署生产；Preview 验证须以 Cloudflare Preview 部署结果为准。
