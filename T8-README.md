# T8 — Agent Gateway（模拟只读骨架）

- 日期：2026-10-30。模型：由总控从进程记录核对。
- 范围：仅 T8。REST 已在 Fastify app 注册并以 inject 实际调用验证。MCP **传输层未接通**，当前交付模块内工具注册表和同源调用函数，不能声称实际 AI 客户端已通过 MCP 调用。
- 数据仍为 T3–T7 内存/模拟快照，所有成功输出标注 `source: simulation`、`shop_id`、显式 `shop_ids: [shop_id]` 和 Unix 毫秒 `queried_at`。时间表示本次读取/计算时间，不表示上游同步成功时间。无新增持久化；持久化待 PG 就绪。

## 入口与结构

`src/gateway/contracts.ts` 显式定义七组输入和输出（`ToolInputs` / `ToolOutputs`），复用 T3–T7 的业务类型。`registry.ts` 提供不可修改的只读清单、闭合输入 JSON Schema 和共用验证器。各输入都必须显式提供 `shop_id`；本轮全部为单店工具，不提供隐式全店或多店汇总接口，数组店铺和额外 `shop_ids` 均拒绝。

| 工具 | GET 路由 | 额外输入 | 输出数据字段 |
| --- | --- | --- | --- |
| get_shop_overview | `/api/shops/:shop_id/overview` | 必填查询参数 `start_at`, `end_at` | `overview`, `gmv_basis` |
| get_orders | `/api/shops/:shop_id/orders` | 无 | `orders` |
| get_order_detail | `/api/shops/:shop_id/orders/:order_id` | 必填路径参数 `order_id` | `order`, `items`, `packages` |
| get_products | `/api/shops/:shop_id/products` | 无 | `products`, `skus` |
| get_inventory | `/api/shops/:shop_id/inventory` | 无 | `inventory`, `warehouses` |
| get_shop_alerts | `/api/shops/:shop_id/alerts` | 可选查询参数 `stock_threshold`，默认 0 | `inspection`（原 T7 结果） |
| diagnose_fulfillment_issue | `/api/shops/:shop_id/orders/:order_id/fulfillment-diagnosis` | 必填路径参数 `order_id`；可选 `stock_threshold`，默认 0 | `order_id`, `status`, `causal_claim`, `reasons` |

所有成功响应为 `{ error: false, data: { source, shop_id, shop_ids, queried_at, ...工具数据 } }`。概览窗口沿用 T6 的起点包含、终点不包含；GMV 是包含未付款/已取消订单的原始金额合计、按币种分列，`gmv_basis` 明示 `all_order_statuses_raw_total`，不能称作实收或结算收入。告警沿用 T4/T6 库存规则和 T5 默认 48/72 小时严格超时规则。

REST 从路径和查询参数构造输入，数值查询参数转换为安全非负整数；模块函数输入须直接传 number。两者随后进入同一 `AgentGateway.invoke` → `GatewayService.run`。后者只调用 T3 `ShopQueries`、T4 `ProductQueries`、T5 `OrderQueries`、T6 计算函数及 T7 `runInspection`，没有第二份库存/GMV/超时规则，没有另一套业务数据存储。

## 权限、错误与审计

`buildApp(config, logDestination?, gatewayOptions?)` 的第三参数允许注入现有仓库实例、Agent 授权配置与时钟；`createGateway(options)` 也可独立组合使用。默认服务已注册全部 GET 路由，但没有 Agent 凭证、没有店铺/商品/订单种子，默认拒绝业务访问，不自动生成示例业务记录。配置注入是当前本地骨架接线方式，不是对外登记接口。

`gatewayOptions.agents` 项为 `{ agent_id, bearer_token, shop_ids, tools }`。可信调用方配置店铺白名单和工具权限，REST 请求用 `Authorization: Bearer <placeholder-gateway-token>`。Gateway 的授权索引只保存凭证摘要，复制授权集合，不能通过请求内 `agent_id`、`shop_id` 查询覆盖或修改授权。模块调用也必须通过相同凭证校验：

```ts
const mcp = app.getDecorator<ReturnType<typeof createMcpModule>>('mcp');
const result = await mcp.callTool(
  'get_orders', { shop_id: 'placeholder-shop-a' },
  'Bearer <placeholder-gateway-token>',
);
// createMcpModule 从 src/gateway/mcp.ts 导出。
```

Agent 校验通过后还须满足 T3 有效授权状态为 `authorized`。未授权、过期、撤销或待核验店铺都拒绝读取，诊断工具不能越过此限制。

- 缺少或错误 Agent 凭证：401；店铺白名单/工具权限拒绝或 T3 非 authorized：403；参数缺失/非法：400。以上响应固定为 T1 `{error:true,message:"Invalid request",code:"INVALID_REQUEST"}`。
- 已获白名单但未知店铺/订单：404，固定为 T1 `{error:true,message:"Route not found",code:"NOT_FOUND"}`。不在白名单的未知店铺优先按 403 拒绝，避免探测店铺存在性。缺少路径段没有路由匹配时也是 404。
- 仓库异常、混店数据、非模拟快照：500，固定为 T1 `{error:true,message:"Internal server error",code:"INTERNAL_ERROR"}`。原始服务错误、异常文本和参数不回显。
- 只注册七个 GET 业务路由，关闭其自动 HEAD；POST/PUT/PATCH/DELETE 均返回 404，不调用工具、不写业务数据。`/health` 保持原 T1 行为。
- 每次模块/REST 工具调用记录 Agent、已获白名单的店铺、工具名、字段数量/校验结果、执行结果、HTTP 状态和耗时，复用 T1 脱敏日志。日志不记录凭证、原始参数、响应体、游标和异常文本；审计为现有日志流，不是 PG 审计表。日志外部回调失败不泄漏异常，不改变读结果。
- 输出通过 T3–T5 字段投影，Gateway 进一步去除买家引用、物流引用；额外 Token/Secret/shop_cipher、买家姓名/电话/地址、原始游标不会出现在输出或审计中。

## 履约诊断边界

诊断读取同一组商品/订单快照并调用 T7。超时同时要求 T5 告警和 T7 证据匹配本订单/包裹；库存仅关联本订单 SKU，店铺级授权信号单独标注作用域。证据只允许待发货超时、物流停滞、库存异常和授权异常，不把其他订单或其他 SKU 的告警归到本订单，也不推断没有证据的原因。

`reasons` 每项含 `category`、`scope`、T7 原始类型的字段投影 `evidence`（店铺、实体、触发值、阈值），`causal_claim` 固定为 `not_established`。没有相关证据时返回 `insufficient_evidence`。不生成改价、改库存、发货、取消等写操作建议。内部归因函数能映射 T7 授权异常，测试直接用真实 T7 模拟计算结果验证；对外权限门会先拒绝当前未授权店铺，因此不会为了展示授权异常而开放其订单读取。此次没有历史巡检结果存储。

T7 库存风险输入使用同一商品快照和 T6 `calculateInventoryRisk`；其必需窗口固定为 `[0,1)`，库存基准仍是当前快照，窗口不参与库存或超时判定。诊断将已捕获订单快照传给 T5 `OrderQueries.getOrder`，避免诊断过程中再次读取新版本的订单。商品与订单仓库之间尚无数据库事务快照保证。

## MCP 实际状态与 T10 前接通条件

本地检查 `@modelcontextprotocol/sdk/package.json`、`@modelcontextprotocol/sdk/server/mcp.js` 均为 `ERR_MODULE_NOT_FOUND`，常见全局安装位置也不存在 SDK（见 `.t8-evidence/mcp-sdk-check.log`）。本轮未安装依赖，未访问包仓库或任何真实域名。

`createMcpModule(gateway)` 提供 `tools` 和 `callTool`，明确报告 `transport: not_connected`。没有 MCP initialize、JSON-RPC、stdio、SSE、Streamable HTTP 或 `/mcp` 端点；REST/MCP 一致性测试验证的是 **REST 与模块入口**，不能替代 MCP 客户端/传输层验收。

T10 前仍需：在允许获取官方依赖的环境准备并锁定官方 SDK；把注册表和 `callTool` 接到官方 MCP 服务与选定传输；为该传输配置可信 Agent 身份映射和同一权限/脱敏审计；使用至少一个实际 AI 客户端完成握手、工具发现、正常调用与拒绝调用，并记录证据。这些本轮没有执行。

## 运行验证与保留项

执行记录和结果见 `T8-TEST-REPORT.md`，可独立复跑 `node .t8-evidence/smoke.mjs`（需先 build），全部使用 Fastify inject，无监听端口、无网络请求。REST 接入已验证；真实监听、远程客户端和实际 MCP 客户端尚未验收。

仍是模拟骨架；PG 数据与审计持久化待 PG 就绪；T7 定时/通知仍未接入；项目当前没有有效 Git 仓库，未提交。未修改既有 Markdown，未接真实数据/真实 TikTok，未用真实凭证，未做业务写操作，未做 T9–T10，未装 Docker，未采购，未部署生产。
