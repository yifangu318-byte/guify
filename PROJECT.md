# MUSE ERP — PROJECT.md（第五步确认版草案，2026-10-30）

> 状态：未确认开发。以下架构与任务须用户一次确认后，才进入 Codex 开发循环。确认前不写业务代码、不装生产依赖、不碰真实店铺。

## 产品目标

AI 原生 TikTok Shop 跨境电商 ERP，第一阶段仅服务用户自有/合法授权店铺，不做 SaaS、不做第三方租户体系，但底层必须支持多店扩展。

MVP 核心目标（产品文档 V1.0 §4）：让 Muse 能通过 MUSE ERP 准确获取店铺数据、发现运营问题、形成可验证的经营建议。

## 架构（推荐，待确认）

```
AI Agent（Muse / Codex / Gemini）
        │  REST + MCP（同源服务层，不各写一套）
        ▼
Agent Gateway（Fastify）
  - 身份与权限：Agent 身份、店铺白名单、工具级权限、写操作默认关闭
  - 审计：每次调用记 agent、店铺、工具、参数摘要（脱敏）、结果、耗时
        │
        ▼
业务服务层（TypeScript，薄核心，自研）
  店铺连接 / 商品 / 库存 / 订单 / 履约 / 财务概览 / 分析 / 巡检 / 日报
        │
        ▼
TikTok 适配层（自研，官方文档为准）
  签名 HMAC-SHA256 / Token 存储与刷新 / 按店隔离 / 429 退避 / Webhook + 轮询对账
        │
        ▼
PostgreSQL（Drizzle 0.45.x 迁移） + pg-boss（定时 + 异步任务）
        │
        ▼
Web 后台（MVP：Fastify + 轻量前端骨架；Next.js 推迟到云端阶段，见 DECISIONS.md D6）
```

关键原则：
- API First：能走官方 API 就不走浏览器自动化；浏览器只作 Seller Center 抽查核对，不作批量写入通道。
- Multi-Shop：所有业务记录必带 shop_id；任何查询默认按店铺隔离，跨店汇总必须显式标注店铺集合。
- Secure by Design：App Secret / Token / shop_cipher 只存加密存储与环境变量，绝不进代码仓库、日志、备份、聊天；日志默认脱敏。
- 模拟数据隔离：开发期模拟数据与真实业务数据用不同库/不同标记，绝不冒充真实接入。

## MVP 七模块（与任务对应）

1. 店铺连接：授权接入、店铺识别、授权状态、Token 安全管理与刷新、同步状态、多店扩展接口。
2. 商品及库存：商品列表/详情、SKU、库存、仓库（国内仓/海外仓区分）、缺货与库存异常检测。
3. 订单及履约：订单同步、列表/详情、状态、包裹与物流、待处理检测、发货时限异常。
4. 经营数据分析：店铺概览、订单量、GMV、热销商品、库存风险、运营异常汇总；每个指标注明数据来源、统计时间、适用店铺。
5. AI 经营巡检（定时）：缺货/低库存、订单即将超时、物流与履约异常、仓库配置异常、同步/授权异常；输出带证据的巡检结果。
6. Agent Gateway：只读工具先行，建议 7 个：get_shop_overview、get_orders、get_order_detail、get_products、get_inventory、get_shop_alerts、diagnose_fulfillment_issue；返回结构化数据、错误、执行状态、业务标识。
7. Web 后台（最小可用、响应式、适配手机）：店铺概览、商品、订单、库存与仓库、经营数据、异常中心、API 连接状态、Agent 任务与执行日志。

## 初步数据库结构（草案，开发时以迁移文件为准）

- shops：id、market、shop_code（卖家中心标识）、shop_name、status、created_at
- shop_authorizations：shop_id、service_id（非 Secret）、scopes（数组）、auth_status、expires_at、last_sync_at（Token 本体加密另存，不放明文字段）
- shop_tokens：shop_id、encrypted_access_token、encrypted_refresh_token、token_expires_at、refresh_expires_at（加密 + 轮换，访问审计）
- products：shop_id、product_id、title、status、category、updated_at（唯一：shop_id + product_id）
- skus：shop_id、product_id、sku_id、price、currency、status
- warehouses：shop_id、warehouse_id、warehouse_type（国内仓/海外仓/其他）、name
- inventory：shop_id、sku_id、warehouse_id、quantity、updated_at（唯一：shop_id + sku_id + warehouse_id）
- orders：shop_id、order_id、status、order_time、total_amount、currency
- order_items：order_id、sku_id、quantity、price
- packages：shop_id、order_id、package_id、tracking_no、carrier、ship_status
- finance_snapshots：shop_id、period、gmv、orders_count、settlement_amount、source（只做概览/对账，不做完整核算）
- alerts：shop_id、type、severity、entity_type、entity_id、evidence、status、created_at
- agent_tasks：id、agent_id、shop_id、tool、status、input_summary（脱敏）、result_summary、created_at、finished_at
- audit_logs：actor、shop_id、action、entity、result、created_at（不可改）
- sync_states：shop_id、resource、last_cursor、last_success_at、last_error

## MVP 验收标准（总控指令 §8，12 条，原文口径）

1. 能安装、启动、运行；2. 前后端与数据库正常协作；3. 能连接至少一个实际授权店铺；4. 能读真实订单、商品、库存及相关经营数据；5. 至少抽查 20 条实际业务记录与 Seller Center 核对；6. 至少三类可验证经营异常检测；7. Agent Gateway 能被至少一个实际可用 AI 客户端调用；8. 至少 10 个真实或明确标记隔离测试场景；9. 关键接口有合理异常处理与日志；10. 无已知严重权限越界及未授权写入；11. Web 后台能正常使用；12. 安装、配置、启动、恢复方法有文档。
- 七天稳定性：只建测试计划与记录，未跑完不得宣称通过。
- 外部阻塞（API 授权、连接器权限等）一律标记“阻塞/待验证”，不得用模拟数据冒充。

## 环境缺口（第一步已实测，第五步确认时一并定）

- 无 Docker、无 PostgreSQL 客户端、内存 7.7G 可用约 488M 偏紧。推荐见 DECISIONS.md D1/D2/D6。
- TikTok 应用授权现状、首接店铺、写操作边界，均待用户确认，见 DECISIONS.md。
