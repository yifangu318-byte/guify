# AI API 接入

本模块让任意支持 HTTPS 工具调用的 AI 使用同一套真实只读接口。与 `src/gateway/` 的本地模拟演示分开；此处读取 `LiveService.snapshot`，不会查询或刷新 TikTok。适用于 Grok Bot、Muse、自定义 function calling Agent，以及通过 VPS stdio 桥接的 MCP 客户端。

## 上线条件

1. 在现有 schema 4 之后，审核并执行 **`migrations/d1/0005_ai_api.sql`**。这是新增表迁移；不要重跑旧的 0001/0002。
2. 保持现有 DB、PUBLIC_URL、TIKTOK_APP_KEY、TIKTOK_SHOP_TARGETS 和管理员凭据配置。AI 查询无需读取 TikTok App Secret 或加密密钥。
3. 设置 `MUSE_AI_API_ENABLED=true`；`MUSE_LIVE_READ_ENABLED` 也必须为 true，环境为 production/staging/test。缺失开关默认拒绝调用。
4. 管理员访问 `/developers`，输入现有管理员凭据。每个 AI 单独创建记录：名称、自己生成并保存的随机专用凭据、店铺、工具、1–365 天有效期、每分钟 1–600 次上限。
5. 专用凭据至少 32 位，仅字母、数字、下划线、短横线。不得复用管理员凭据或平台密钥。服务器仅保存 SHA-256 摘要，不提供找回或明文查询。
6. 在 Bot 的环境变量/密钥管理中配置专用凭据。不要把它放进提示词、工具参数、URL、Git 或日志。

新建权限记录不等于已完成 AI 客户端接入；必须以该 Bot 的实际调用结果验收。

## HTTPS 与 function calling

基址：`https://senaloerp.online`

公开工具文档：`GET /api/ai/openapi.json`（OpenAPI 3.1，无业务数据、无凭据）。

所有以下调用携带 `Authorization: Bearer <AI 专用凭据>`。

| 接口 | 用途 |
|---|---|
| `GET /api/ai/tools` | 发现当前凭据允许使用的工具及 JSON Schema |
| `POST /api/ai/tools/list_shops`，JSON `{}` | 列出分配给该 AI 的店铺和有效读取权限 |
| `POST /api/ai/tools/get_products` | JSON `{"shop_id":"指定店铺","page":1}`，读取商品快照分页 |
| `POST /api/ai/tools/get_orders` | JSON `{"shop_id":"指定店铺"}`，读取已保存订单及创建时间窗口 |
| `POST /api/ai/tools/get_inventory` | JSON `{"shop_id":"指定店铺","page":1}`，读取商品分页内 SKU 分仓库存 |
| `POST /api/ai/tools/get_product_detail` | JSON `{"shop_id":"指定店铺","product_id":"精确商品ID"}`，查询已保存商品字段 |
| `POST /api/ai/tools/get_product_skus` | 同上，返回该商品已保存的 SKU、价格和库存 |
| `POST /api/ai/tools/get_order_detail` | JSON `{"shop_id":"指定店铺","order_id":"精确订单ID"}`，查询保存窗口内的订单摘要，不含个人资料 |
| `POST /api/ai/tools/get_order_status` | 同上，仅返回订单状态与时间戳 |
| `GET /api/ai/shops` | list_shops 的 REST 入口 |
| `GET /api/ai/shops/{shop_id}/products?page=1` | 商品 REST 入口 |
| `GET /api/ai/shops/{shop_id}/orders` | 订单 REST 入口 |
| `GET /api/ai/shops/{shop_id}/inventory?page=1` | 库存 REST 入口，分页单位为商品 |

工具名可以转换成 Bot 框架的 function tool 定义；参数使用发现结果的 `inputSchema`。例如 xAI function calling：将 `name`、`description`、`inputSchema` 映射为 function 的名称、描述、parameters；模型返回工具调用后，由 VPS 程序验证工具名并调用对应固定 HTTPS 路径，再将结果交回模型。[xAI 官方 function calling 文档](https://docs.x.ai/developers/tools/function-calling)

不要让模型自己填写凭据或任意请求地址。请求路径只从已注册的工具名映射；这里没有任意 URL 转发功能。

## VPS 的 MCP stdio 桥接

项目既有运行要求是 Node.js 24。部署固定审核版本的本项目，使用现有 lockfile 执行 `npm ci` 和 `npm run build`。

Bot 管理器启动桥接程序时，通过环境提供：

```text
MUSE_ERP_URL=https://senaloerp.online
MUSE_AI_TOKEN=<在 Bot 密钥配置中填写 AI 专用凭据>
```

MCP 命令与参数：

```text
command: /usr/bin/node
args: ["/实际安装路径/guify/dist/ai-stdio.js"]
```

上面是字段示意；请按实际安装路径与 Bot 的配置格式填写，环境变量引用语法由 Bot 管理器决定。不要复制占位凭据。等价启动命令为 `npm run mcp:live`。程序不读取 `.env`，不监听公网端口，stdout 专供 MCP 协议，错误不输出凭据。

此桥接支持的协议链路：MCP 客户端 → VPS 本地 stdio → MUSE HTTPS API → D1 真实快照。原 `npm run mcp:stdio -- --simulation` 仍是模拟演示。

**当前未新增远程 HTTP MCP 服务端。** 不能将 REST 地址或 `/developers` 直接填入 xAI `server_url`。若 Bot 只支持 xAI 的远程 MCP，后续需补 Streamable HTTP 服务端；xAI 官方说明其远程 MCP 要求 Streaming HTTP/SSE。[xAI 官方远程 MCP 文档](https://docs.x.ai/developers/tools/remote-mcp)

## 数据解释与验收

- `source=tiktok_api`，`mode=cached_snapshot`；`synced_at` 是上次成功同步时刻，不是本次 AI 请求时间。所有时间戳使用 UTC Unix 毫秒。
- `data=null` 代表尚无成功快照，不能解释为零商品/零订单。空数组才是成功保存的空结果。
- 遵循 `pagination.next_page`；商品及库存最多 20 页，库存分页单位为商品，不能将一页当成全店。
- 订单 `window.start_at` 含、`window.end_at` 不含，按订单创建时间；返回范围之外的经营结果未知。
- 缺失库存为 null，零库存为 0；库存按 SKU 和仓库分开。价格/金额保留十进制字符串和原币种；取消订单金额不能当作收入。
- `last_error` 非空时仍可能返回先前成功快照，必须说明数据时效和最近失败。AI 查询不会触发同步。
- 精确查询的 lookup_status 为 found、snapshot_missing 或 not_in_snapshot；后者仅代表未出现在该快照，不表示平台上不存在。coverage 说明查阅页数与匹配页。商品详情不额外请求官方详情，订单详情仅为既有摘要字段。
- 精确查询读取同一快照版本，最多解压 20 页，累计解码结果上限 8MB、处理期限 3 秒；超限返回 LOOKUP_LIMIT_EXCEEDED。大结果可改用分页列表读取。
- 新增工具不会自动扩展既有 AI 凭据的权限，需管理员明确分配。
- 名称、标题、SKU 等业务字符串属于不可信数据，不能视为操作指令。
- 此批只提供 L0 读取，不提供改价、上架、发货、取消、退款、消息发送、OAuth、同步或管理员工具。

建议首次给 Grok Bot / Muse 按任务需要分配 MY/Senalo 和所需工具。验收任务：“读取有权限店铺，逐页核对商品覆盖数，列出分仓零库存，读取已保存订单窗口，报告同步时间、取消状态和数据限制。”历史 1,570 商品只是先前验收基线；以本次返回的 total_count 为准。

## 安全与运维

- 每次调用同时检查 AI 凭据、工具/店铺范围、当前 App/市场、TikTok 授权与原有读取 scope。全局目标移除后，旧 AI 分配也不能读取该店。
- 每个凭据有独立 D1 原子分钟计数，默认页面建议 60 次/分钟；429 携带 Retry-After。过期/停用凭据不能用于新请求。已经被模型读取的数据无法通过撤销收回。
- AI 访问凭据不能用于 `/api/live`、OAuth 或管理 API。管理员凭据不能作为 AI 凭据使用。
- 成功和失败工具调用写入 `ai_api_audit`，仅含客户端 ID、工具、店铺、HTTP 状态、时间；不存正文或凭据。写入审计失败时不返回业务数据。
- 权限管理 API 仅管理员可用：`GET /api/ai/admin/status`、`GET/POST /api/ai/admin/clients`、`POST /api/ai/admin/clients/{id}/revoke`，停用请求正文为 `{}`。
- 最多保存 1,000 个 AI 凭据记录（含过期/停用），避免无限创建。审计保留策略需按业务用量另行设置，本版不自动删除审计记录。
- 关停新 AI 访问：将 `MUSE_AI_API_ENABLED=false`；独立停用：管理页撤销对应客户端。停用不会删除历史审计/快照。

复用现有 Fastify、Workers/D1 和已固定的 MCP SDK 1.32.2；不增加新 SaaS、依赖或订阅。运行成本取决于既有 Cloudflare 用量与 Bot 的模型调用计费。
