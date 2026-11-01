# T2 — TikTok 只读适配层骨架

2026-10-30：仅隔离模拟测试，未接真实 API，未经官方验证。T3–T10 未实现。
原有 T1 配置、服务、日志、数据库和九项测试未修改；不增加凭证环境变量。
本文件为新增文档，原有 Markdown 均保留。

## 文件与调用边界

- `src/tiktok/client.ts`：`TikTokReadOnlyAdapter`，必需注入 `TokenStore`、`refresh`、`transport`；仅暴露 GET 请求描述，没有 fetch、默认域名、网络客户端或授权路由。调用 `read({ shop_id, path, params })`，必须提供 shop_id，不允许参数覆盖授权/签名/店铺字段。
- `src/tiktok/tokens.ts`：TokenStore 接口与测试专用 MemoryTokenStore。所有 Token 只在内存中保留、按店校验、复制读写，不写日志或文件。真实加密存储、轮换和审计留待后续任务。
- `src/tiktok/signing.ts`：HMAC-SHA256 草案。时间戳为 Unix 整数秒，由注入时钟的毫秒值向下取整；覆盖传入 timestamp，排除 sign/access_token，其余键按 JavaScript sort 的大小写敏感顺序排序（ASCII 参数名），原始 key/value 直接拼接，不做 URL 编码；拼接 path 与参数、前后包 secret，再以 secret 作 HMAC key，输出小写十六进制。仅支持草案 GET 路径，不包含请求体。测试向量只验证本地算法一致性，不能证明官方兼容性。**须在 T10 对照 Partner Center 官方文档和真实店铺样本复核**，包括编码、参数排除、签名串和接口方法。
- `src/tiktok/coverage.ts`：商品、订单、库存、履约、财务概览的意图登记，仅 draft / not_implemented，不代表任何接口已接通。
- `test/tiktok.test.ts`：16 项隔离测试，所有依赖注入，无网络请求、真实凭证或真实业务数据。

## 刷新、限流与错误

Token expires_at 为 Unix 毫秒。默认到期前 60 秒刷新；刷新本身只调用一次，失败立即返回 TOKEN_REFRESH_FAILED。一次 read 遇到 401 后最多再刷新一次并重发一次，重复 401 返回 UNAUTHORIZED。若该 read 已提前刷新，仍有独立的一次 401 刷新机会。刷新结果必须属于同店且有效期超过提前刷新窗口。刷新、存储和传输异常不回显原文。

同一适配器实例每店串行执行，避免并发刷新与突发请求；店之间使用各自 Token 和发送时间。每次发送（含重试）默认间隔至少 100ms。429 默认最多重试 2 次，允许配置 0–10 次；第 n 次退避上界 min(cap, base × 2^n)，n 从 0 开始，实际延时 floor(上界/2 + random × 上界/2)，默认 base=250ms、cap=10000ms。401 与 429 各有独立有限预算，不会无限重试。

配置通过 AdapterOptions 显式注入：refreshAheadMs、minIntervalMs、maxRetries、backoffBaseMs、backoffCapMs；时钟、sleep、random 也可注入以确定性测试。T1 的 loadConfig、HOST/PORT/DATABASE_URL 行为不变。日志可接入 T1 app.log 或 createLogStream，复用 redact 且只发固定事件名/状态码，不记录请求、Token、响应体或原始异常。错误沿用 T1 `{ error: true, message, code }` 信封；成功为 `{ error: false, data }`，data 是注入传输的模拟结果。

## 启动与验证

在项目根目录、已有 Node 24 / npm 依赖环境执行：

```sh
npm test
npm run build
npm start
# 另一终端
curl http://127.0.0.1:3000/health
```

服务启动仍只提供 T1 健康检查，T2 不注册业务 API。只跑 T2：

```sh
node --import tsx --test --test-isolation=none test/tiktok.test.ts
```

## 本次运行证据

- 实现前 `npm test`：9 通过、0 失败。
- 实现后 `npm test`：25 通过、0 失败（T1 9 + T2 16），无跳过或待办。
- `npm run build`：TypeScript 严格模式构建成功，退出码 0。
- 具体启动冒烟记录见新增 `T2-TEST-REPORT.md`；不替代总控独立验收。

## 剩余问题与明确未做事项

签名、官方端点/字段、Scope、区域及真实店铺身份均待 T10 核验。适配层为单进程测试骨架：没有分布式限流、队列容量控制、取消/超时管理、持久化加密 Token 或官方传输实现；调用方注入的传输/刷新需自行约束时间。按店时间状态在实例内保留，实例应只用于有限测试店铺。

未连接真实 TikTok，未向 tiktokshop.com 发请求，未使用真实凭证；未做 T3–T10，未安装 Docker、未采购、未部署生产。T1 的 PG 实库迁移及 Git 提交保留问题没有在 T2 解决。待总控独立复核，不能将本报告称为总控已验收。
