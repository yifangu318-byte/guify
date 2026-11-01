# MUSE ERP — TEST_REPORT.md

## T1（2026-10-30，总控亲自复核，非仅 Codex 自述）

### Codex 报告（2026-10-30 08:23，Codex exec 完成）
- 构建通过（TypeScript 严格模式），测试 9 通过 0 失败，迁移生成仅含 shops 七字段，再次生成无差异。
- start 与 dev 均实际启动并返回健康检查与 404 信封，随后停止。
- 六份原有 Markdown SHA-256 校验一致，未修改已有文件。
- 剩余问题自述：.git 为只读占位、未安装 PostgreSQL/psql、迁移未实库执行。

### 总控复核（2026-10-30，同日，本人实际运行）
- 代码已读：src/app.ts、config.ts、logging.ts、server.ts、db/schema.ts，结构简单，符合 T1 口径；src 内无硬编码凭证模式；测试中的凭证字符串均为占位符（a/b/c、<redacted> 等），非真实值。
- `npm test`：本人运行，9 通过 0 失败，与 Codex 报告一致。
- `npm run build`：本人运行，通过。
- `npm start` + curl：本人运行，GET /health 200，返回 `{"status":"ok","service":"muse-erp","version":"0.1.0","database":{"status":"not_configured"}}`；GET /missing 404，返回 `{"error":true,"message":"Route not found","code":"NOT_FOUND"}`；随后已停掉残留监听进程，3000 端口已释放。
- 文件核对：package.json（Fastify ^5.12.7、Drizzle ORM ~0.45.0）、src/、test/app.test.ts、drizzle/0000_great_skrulls.sql（shops 七字段，与 schema 一致）、README.md、.gitignore、.env.example（占位符，无真实值）均存在；项目目录下当前无 .git（Codex 自述的只读占位未落盘），版本提交暂无法做。

### T1 结论：通过（带保留）
- 通过项：骨架启动、健康检查、错误信封、配置、脱敏日志、测试、迁移文件生成。
- 保留项（不得改写为通过）：
  1. PostgreSQL 迁移未在实库执行：本机未装 PostgreSQL/psql，空库重建验收待验证；健康检查如实报 not_configured，不宣称已连接。
  2. Git 版本提交未做：项目目录无有效 .git 仓库，每个功能节点的版本提交待解决后再补。
- T1 未连接 TikTok、未用真实凭证或真实数据、未装 Docker、未采购、未部署生产。

## T2（2026-10-30，总控亲自复核）

### Codex 报告
- 实现前 9 通过，实现后 25 通过 0 失败（T1 9 + T2 16），构建通过。
- 新增 src/tiktok/{signing,tokens,client,coverage}.ts、test/tiktok.test.ts、T2-README.md、T2-TEST-REPORT.md。
- 诚实保留：Codex 沙箱内端口监听返回 EPERM，真实监听启动未在沙箱内通过，健康检查与 404 由 Fastify inject 验证；签名为草案，待 T10 官方文档与真实样本复核；真实加密 Token 存储、官方传输、超时取消、分布式限流未实现。

### 总控复核（同日，本人实际运行）
- 代码已读：coverage 仅 draft / not_implemented，signing 明确标注草案、待 T10 复核；src/tiktok 与测试中无外部 URL、无硬编码凭证模式。
- `npm test`：本人运行，25 通过 0 失败，与 Codex 报告一致。
- `npm run build`：本人运行，通过。
- `npm start` + curl（总控本机环境，非 Codex 沙箱）：GET /health 200，返回与 T1 一致的 not_configured 健康体；GET /missing 404 固定信封；随后已按进程号停掉监听进程，3000 端口已释放。Codex 沙箱的 EPERM 属于沙箱限制，不影响总控本机监听验证。
- 未接真实 TikTok、未向真实域名发请求、未用真实凭证。

### T2 结论：通过（带保留）
- 通过项：签名草案、Token 刷新两层、401 只重试一次、429 有界退避、按店隔离、脱敏、错误信封、覆盖登记、配置边界，16 个隔离场景全部通过。
- 保留项：签名未获官方验证；Token 存储仅内存测试实现；PG 实库迁移与 Git 提交保留问题仍未解决（与 T1 相同）。

## T3（2026-10-30，总控亲自复核）

### Codex 报告（2026-10-30，高推理重跑，session 01a18a38-506f-7661-8951-f5f30c407de2）
- 运行配置：模型 gpt-6.1-sol、推理档 high（运行头显与 Codex 自报一致；此前 T3 首次默认档运行已被总控停掉，本轮为按用户新配置重跑，复用首轮已写出的 src/shops/ 部分文件补完，未重复创建同名模块）。
- 修改前 npm test 37 通过（首轮 T3 已写 12 项），最终 npm test 45 通过 0 失败（T1 9 + T2 16 + T3 20），npm run build 通过；13 份 Markdown 原文 SHA-256 校验完整，T1/T2 测试文件未变。
- 修改文件：src/shops/{models,repository,service}.ts、test/shops.test.ts，追加 T3-README.md 与 T3-TEST-REPORT.md；未注册业务路由。
- 覆盖：多店隔离、未授权状态、授权过期、同步空值、跨店标注、敏感字段不外泄。
- 诚实保留：仍是内存骨架，真实 PostgreSQL 持久化待 PG 就绪；无有效 Git 仓库，未提交；未接真实授权、未用真实凭证、未连接 TikTok、未做 T4–T10。

### 总控复核（同日，本人实际运行）
- 代码已读：models.ts 授权状态五种（unauthorized / pending_verification / authorized / expired / revoked），状态来源只允许 explicit_input 或 simulation；SyncState 资源、成功时间、游标、错误均可为空，错误只允许固定类别 SYNC_FAILED，不存原始上游报文。service.ts 的 ShopQueries 只做状态检查，注释明确不调用适配层、Token 存储或网络；跨店汇总必须显式传店铺集合并去重，结果逐店标注；授权过期按 expires_at 与当前时间判定；日志只发固定事件与状态，复用 T1 脱敏流。
- grep 检查：src/shops/ 与 test/shops.test.ts 无外部 URL、无硬编码凭证模式、无真实店铺 code。
- `npm test`：本人运行，45 通过 0 失败，与 Codex 报告一致。
- `npm run build`：本人运行，通过。
- `npm start` + curl（总控本机）：GET /health 200（not_configured，与 T1/T2 一致）；GET /missing 404 固定信封；随后按明确进程号 9770 停掉服务，确认 3000 端口已释放（教训：npm start 的父进程号杀不掉 node 子进程，必须杀 node 进程号本身）。
- 未接真实 TikTok、未向真实域名发请求、未用真实凭证。

### T3 结论：通过（带保留）
- 通过项：店铺登记复用 shops 表字段、授权状态模型、同步状态模型、多店隔离与汇总标注、只读查询、敏感字段不外泄，20 个隔离场景全部通过。
- 保留项：真实 PostgreSQL 持久化待 PG 就绪；签名草案、Token 内存存储、PG 实库迁移与 Git 提交保留问题仍未解决（与 T1/T2 相同）；本模块未注册 Fastify 路由，只读查询以模块函数加测试交付，路由接入留待 T8/T9。

## T4（2026-10-30，总控亲自复核）

### Codex 报告
- 新增 src/products/{models,repository,service,sync,alerts}.ts、test/products.test.ts、T4-README.md、T4-TEST-REPORT.md、.t4-evidence/ 7 份日志；已有文件修改无，SHA-256 核对原有 37 个文件全部未变。
- 修改前 45 通过，最终 71 通过 0 失败（含新增 T4 26 项），build 通过；编译后模拟演示双店同步、零库存与低库存告警断言通过。
- 诚实保留：仍是内存模拟骨架，PG 持久化待就绪；无有效 Git 仓库；未接真实同步、未用真实凭证或真实业务数据、未做 T5–T10。
- 模型合规说明：Codex 自述“本次无法核验模型与推理档”，属实——Codex 进程内看不到 CLI 运行头。**总控从进程记录核对：本次调用参数确为 `-m gpt-6.1-sol -c model_reasoning_effort="high"`，配置合规，Codex 的无法核验不构成不合规。**今后 Codex 报告中模型栏以总控进程核对为准，不要求 Codex 自证。

### 总控复核（同日，本人实际运行）
- 代码已读：models 明确写明 T1 实际 schema 只有 shops，未宣称 products 已落库；商品/SKU/仓库/库存均带 shop_id，价格用十进制文本字符串避免浮点；仓库类型只分 regular / overseas / other，不写死国家仓映射；库存校验非负整数、SKU 与仓库归属校验、快照只投影已知标量字段。alerts 为纯函数：数量 0 为缺货、小于阈值为低库存、等于阈值不告警、缺失库存行不凭空补零。sync 只接受 source 为 simulation 的源，明确无适配层、fetch、URL、Token；同店同步串行、不同店独立。
- grep 检查：src/products/ 与 test/products.test.ts 无外部 URL、无硬编码凭证模式、无真实店铺 code。
- `npm test`：本人运行，71 通过 0 失败，与 Codex 报告一致。
- `npm run build`：本人运行，通过。
- `npm start` + curl：GET /health 200（not_configured）；GET /missing 404 固定信封；随后按 node 进程号 11049 停掉服务，确认 3000 端口已释放。
- 未接真实同步、未向真实域名发请求、未用真实凭证。

### T4 结论：通过（带保留）
- 通过项：商品/SKU/仓库/库存只读模型与内存同步、缺货与低库存检测、阈值边界、多店隔离与归属校验、同步空值、敏感字段过滤，26 个隔离场景全部通过。
- 保留项：内存模拟骨架，PG 持久化待就绪；签名草案、Token 内存存储、PG 实库迁移与 Git 提交保留问题仍未解决（与 T1–T3 相同）；本模块未注册 Fastify 路由，只读查询以模块函数加测试交付。

## T5（2026-10-30，总控亲自复核）

### Codex 报告
- 新增 src/orders/{models,repository,service,sync,alerts}.ts、test/orders.test.ts、T5-README.md、T5-TEST-REPORT.md、.t5-evidence/ 9 份验证文件；已有文件修改、删除无，SHA-256 核对原有 52 份文件全部未变。
- 实现前 71 通过，最终 110 通过 0 失败（含新增 T5 39 项），build 通过，新增测试严格 TypeScript 类型检查通过，编译产物冒烟 PASS。
- 默认阈值：待发货 48 小时、物流停滞 72 小时，均可配置；覆盖多店隔离、归属、十进制金额、超时前／刚到／超过阈值、物流停滞、显式跨店汇总、同步空值、敏感字段过滤，以及模拟 Webhook 丢失后的轮询补齐。
- 诚实保留：仍是内存模拟骨架，PG 持久化待就绪；Webhook 仅本地模拟入口，轮询由调用方显式执行；无有效 Git 仓库；未接真实同步、未用真实凭证或业务数据、未做 T6–T10。
- 模型栏按总控口径写为“由总控从进程记录核对”；本次调用参数确为 `-m gpt-6.1-sol -c model_reasoning_effort="high"`，配置合规。

### 总控复核（同日，本人实际运行）
- 代码已读：买家只存占位标识（buyer_ref 必须匹配 `<placeholder-…>` 格式），物流单号只允许占位或空；金额与单价用十进制文本校验；订单/明细/包裹/轨迹归属逐层校验，数量必须为正整数。alerts 为纯函数：阈值正整数小时且毫秒换算不溢出；超时判定为严格大于阈值，刚到阈值不告警；待发货用 order_time，在途包裹用最新轨迹时间、无轨迹时才回退 shipped_at，未知时间不凭空告警；已妥投或已取消的订单/包裹不参与物流停滞判定。
- grep 检查：src/orders/ 与 test/orders.test.ts 无外部 URL、无硬编码凭证模式、无真实店铺 code。
- `npm test`：本人运行，110 通过 0 失败，与 Codex 报告一致。
- `npm run build`：本人运行，通过。
- `npm start` + curl：GET /health 200（not_configured）；GET /missing 404 固定信封；随后按 node 进程号 13084 停掉服务，确认 3000 端口已释放。
- 未接真实同步、未向真实域名发请求、未用真实凭证。

### T5 结论：通过（带保留）
- 通过项：订单/明细/包裹/轨迹只读模型与内存同步、待发货与物流停滞超时检测、阈值边界、多店隔离与归属校验、同步空值、敏感字段过滤，39 个隔离场景全部通过。
- 保留项：内存模拟骨架，PG 持久化待就绪；Webhook 仅模拟入口；签名草案、Token 内存存储、PG 实库迁移与 Git 提交保留问题仍未解决（与 T1–T4 相同）；本模块未注册 Fastify 路由，只读查询以模块函数加测试交付。

## T6（2026-10-30，总控亲自复核）

### Codex 报告
- 新增 src/analytics/{models,decimal,service}.ts、test/analytics.test.ts（29 项）、T6-README.md、T6-TEST-REPORT.md、.t6-evidence/；已有文件修改、删除无，SHA-256 核对原有 69 份文件（含 17 份 Markdown）全部未变。
- 实现前 110 通过，最终 139 通过 0 失败 0 跳过，build 通过，新增测试严格 TypeScript 检查通过，编译产物双店冒烟 PASS。
- 口径自述：窗口含起点、不含终点；GMV 为全部状态订单的原始金额合计，按币种分列；库存风险基于当前快照；每项指标均带来源、窗口、店铺与计算时间。
- 诚实保留：持久化待 PG 就绪；无有效 Git 仓库；未接真实数据、未用真实凭证、未做 T7–T10。
- 模型栏写为“由总控从进程记录核对”；本次调用参数确为 `-m gpt-6.1-sol -c model_reasoning_effort="high"`，配置合规。

### 总控复核（同日，本人实际运行）
- 代码已读：纯函数计算，只读 T4/T5 快照，不读库、不发请求、不写日志、不做持久化。decimal 用 BigInt 系数按最大小数位累加，不丢精度、不做浮点累加。窗口过滤为 `order_time >= start_at && order_time < end_at`，与报告一致。GMV 代码注释明确写明“全部状态原始合计，含未付款/已取消，不是实收 GMV 或结算收入”——口径诚实，但**T10 真实日报必须沿用此注明，不得把该 GMV 当成实收或结算收入呈现**。热销按数量降序、并列按 SKU 标识升序，确定性排序；历史 SKU 不必在当前目录中。库存风险复用 T4 零库存/严格低于阈值口径，不跨仓汇总，库存基准明确标注为当前快照而非窗口内历史库存。跨店汇总必须显式传店铺集合，每店必须恰好一份快照，否则整批失败不返回局部结果；显式空集合返回空店。
- grep 检查：src/analytics/ 与 test/analytics.test.ts 无外部 URL、无硬编码凭证模式、无真实店铺 code。
- `npm test`：本人运行，139 通过 0 失败，与 Codex 报告一致。
- `npm run build`：本人运行，通过。
- `npm start` + curl：GET /health 200（not_configured）；GET /missing 404 固定信封；随后按 node 进程号 14385 停掉服务，确认 3000 端口已释放。
- 未接真实数据、未向真实域名发请求、未用真实凭证。

### T6 结论：通过（带保留）
- 通过项：按店概览、窗口 GMV（按币种分列）、热销排行确定性排序、库存风险与 T4 口径一致、指标元数据（来源 simulation、窗口、店铺、计算时间）、空数据零值、敏感字段过滤，29 个隔离场景全部通过。
- 保留项：GMV 口径为原始合计（含未付款/已取消），日报呈现时必须注明，不得等同实收；持久化待 PG 就绪；签名草案、Token 内存存储、PG 实库迁移与 Git 提交保留问题仍未解决（与 T1–T5 相同）；本模块未注册 Fastify 路由，只读计算以模块函数加测试交付。

## T7（2026-10-30，总控亲自复核）

### Codex 报告
- 新增 src/inspection/{models,service}.ts、test/inspection.test.ts（33 项）、T7-README.md、T7-TEST-REPORT.md、.t7-evidence/；原有 59 份文件（含 19 份 Markdown）摘要全部一致，无修改删除。
- 实现前 139 通过，最终 172 通过 0 失败 0 跳过，build 通过，新增测试严格 tsc --noEmit 通过，编译产物冒烟（ 三类异常、店铺隔离、输入不变）通过。
- 诚实保留：仍是模拟骨架，持久化待 PG 就绪；无有效 Git 仓库；未接真实数据、未发外部通知、未改业务数据、未做 T8–T10。
- 模型栏写为“由总控从进程记录核对”；本次调用参数确为 `-m gpt-6.1-sol -c model_reasoning_effort="high"`，配置合规。

### 总控复核（同日，本人实际运行）
- 代码已读：runInspection 为显式触发的同步纯函数，调用方供时间与店铺集合，不用时钟、不读库、不发请求、不写日志、不启动定时器、不做持久化、不注册路由。异常三类全部复用已有口径，不另起规则：库存复用 T4（零库存/严格低于阈值），且先把传入的 T6 库存风险与 T4 重算结果逐项比对，不一致整批失败，不用过期或混店证据；超时复用 T5（待发货 48 小时、物流停滞 72 小时、严格大于阈值）；授权直接用 T3 已解析的有效状态，只把 expired / revoked / unauthorized 列为异常，不重新解释 pending 或推断缺失授权。去重按店铺+关联标识+类型，库存按 SKU 保留最低仓数量、不跨仓汇总。缺失或多份快照整批失败，不返回零异常的成功；显式空集合或完整空快照才返回零异常。
- grep 检查：src/inspection/ 与 test/inspection.test.ts 无外部 URL、无硬编码凭证模式、无真实店铺 code、无 fetch/通知/ webhook 相关代码。
- `npm test`：本人运行，172 通过 0 失败，与 Codex 报告一致。
- `npm run build`：本人运行，通过。
- `npm start` + curl：GET /health 200（not_configured）；GET /missing 404 固定信封；随后按 node 进程号 15559 停掉服务，确认 3000 端口已释放。
- 未接真实数据、未向真实域名发请求、未用真实凭证、未发任何外部通知。

### T7 结论：通过（带保留）
- 通过项：三类异常（库存、订单超时、店铺授权）复用已有口径、T6 证据交叉校验、阈值边界、多店隔离与显式集合、去重、空数据、敏感字段过滤，33 个隔离场景全部通过。
- 保留项：纯函数骨架，定时调度与通知通道未接入（留待 T8/T9 定）；持久化待 PG 就绪；签名草案、Token 内存存储、PG 实库迁移与 Git 提交保留问题仍未解决（与 T1–T6 相同）；本模块未注册 Fastify 路由。

## T8（2026-10-30，总控亲自复核）

### Codex 报告
- 修改 src/app.ts（唯一修改的原文件），新增 src/gateway/{contracts,registry,errors,service,gateway,rest,mcp,index}.ts、test/gateway.test.ts、T8 两份说明文档、.t8-evidence/；21 份原有 Markdown、7 份原有测试摘要全部未变。
- 实现前 172 通过，最终 246 通过 0 失败 0 跳过（含新增 T8 74 项），build 通过，新增测试严格 tsc --noEmit 通过，编译产物冒烟（REST 200、模块结果一致、写请求 404）通过。
- 诚实保留：**MCP 传输层未接通**，本机缺少官方 SDK，只交付同源注册表与调用函数；仍是模拟骨架，持久化待 PG 就绪；未接真实数据、未做业务写操作、未做 T9–T10。
- 模型栏写为“由总控从进程记录核对”；本次调用参数确为 `-m gpt-6.1-sol -c model_reasoning_effort="high"`，配置合规。

### 总控复核（同日，本人实际运行）
- 代码已读：七个工具（get_shop_overview、get_orders、get_order_detail、get_products、get_inventory、get_shop_alerts、diagnose_fulfillment_issue），输入结构封闭（additionalProperties false，额外字段拒绝而非静默丢弃），多店一律显式传店铺集合；REST 为七个 GET 路由，路径参数不得被查询串覆盖；Gateway 鉴权为本地配置的 Bearer 授权，Token 只存 SHA-256 摘要并用 timingSafeEqual 比对，默认不授权任何人，未授权、工具未授权、店铺未授权分别返回 401/403 固定信封；服务层先过 T3 有效授权（仅 authorized 才放行），审计日志只含配置标识与固定摘要，不含原始参数、响应体与异常。get_order_detail 已剥离买家标识与物流单号；诊断只做 T5/T7 证据关联，causal_claim 固定为 not_established，不给写操作建议。mcp.ts 注释明确写明：不实现 MCP initialize、JSON-RPC、stdio、SSE 或 Streamable HTTP，不启动传输，transport 固定为 not_connected；未来官方 SDK 适配器必须调用同一 gateway。
- grep 检查：src/gateway/ 与 test/gateway.test.ts 无外部 URL、无硬编码凭证模式、无真实店铺 code；package.json 无 MCP SDK 依赖，与“本机缺少官方 SDK”一致。
- `npm test`：本人运行，246 通过 0 失败，与 Codex 报告一致。
- `npm run build`：本人运行，通过。
- `npm start` + curl（总控本机）：GET /health 200；无鉴权调 Gateway 路由返回 401 固定信封；POST 同路径返回 404（无写路由）；GET /missing 404；随后按 node 进程号 17462 停掉服务，确认 3000 端口已释放。
- 未接真实数据、未向真实域名发请求、未用真实凭证、未做业务写操作。

### T8 结论：通过（带保留，含一项 MVP 验收缺口）
- 通过项：REST 七个只读工具已接通、REST 与模块调用同源、鉴权与审计、只读与写方法隔离、敏感字段过滤，74 个隔离场景全部通过。
- 保留项：**MCP 传输层未接通，MVP 验收第 7 条“Gateway 能被实际 AI 客户端调用”目前只能算 REST 部分满足，MCP 客户端调用尚未验证，不得写成已通过。**补齐条件：引入官方 MCP TypeScript SDK、接通 stdio 或 Streamable HTTP 传输、用实际 MCP 客户端调通至少一个只读工具并留证据。其他保留：模拟骨架、持久化待 PG 就绪、签名草案、Token 内存存储、PG 实库迁移与 Git 提交问题仍未解决（与 T1–T7 相同）。

## T9（2026-10-30，总控亲自复核）

### Codex 报告
- 修改 src/app.ts（唯一修改的原文件），新增 src/web/{simulation,service,html,routes}.ts、test/web.test.ts、T9-README.md、T9-TEST-REPORT.md、.t9-evidence/；23 份原 Markdown、8 份原测试均未变。
- 实现前 246 通过，最终 320 通过 0 失败（含新增 T9 74 项），build 通过，新增测试严格 TypeScript 检查通过；编译产物冒烟：10 条页面路由返回 200，40 次写方法请求全部 404。
- 诚实保留：仍是模拟骨架，持久化待 PG 就绪；任务存储、MCP 传输及手机浏览器视觉实测尚未补齐；未接真实数据、未做业务写操作、未做 T10。
- 模型栏写为“由总控从进程记录核对”；本次调用参数确为 `-m gpt-6.1-sol -c model_reasoning_effort="high"`，配置合规。

### 总控复核（同日，本人实际运行）
- 代码已读：Web 路由只有 GET（routes.ts 仅 app.get），无 POST/PUT/PATCH/DELETE 业务路由；唯一的 form 为 method=get 的店铺与窗口选择表单，无写操作表单或按钮。演示数据与 Gateway 配置隔离，应用启动时一次性播种 simulation-shop-a/b，绝不在 Web 请求时播种；演示窗口为 2026-10-01 至 2026-11-01（UTC），演示店铺 GMV 37.50 = 3 单 × 12.50（含已取消单，与 T6 原始合计口径一致）。页面导航包括店铺概览、订单列表、商品与 SKU、库存与仓库、经营数据、巡检告警、API 连接状态、Agent 任务与执行日志；审计日志上限 100 条、不含参数、返回副本。
- grep 检查：src/web/ 与 test/web.test.ts 无外部 URL、无硬编码凭证模式、无真实店铺 code；“发货”类字样只出现在“待发货订单”统计标签中，非写操作。
- `npm test`：本人运行，320 通过 0 失败，与 Codex 报告一致。
- `npm run build`：本人运行，通过。
- `npm start` + curl（总控本机）：GET /health 200；GET /web/ 返回 HTML（标题“店铺概览 · MUSE ERP”）；GET /web/overview（simulation-shop-a，演示窗口）返回 HTML，正文含 simulation 标注、GMV 37.50 与“全部状态原始合计（含未付款、已取消），非实收，非结算收入；按币种分列，不跨币种相加”；POST 同路径返回 404；随后按 node 进程号 19506 停掉服务，确认 3000 端口已释放。
- 未接真实数据、未向真实域名发请求、未用真实凭证、未做业务写操作。

### T9 结论：通过（带保留）
- 通过项：Web 后台最小可用版已接通（服务端 HTML、无前端构建、符合内存偏紧约束）、只读四类以上页面、显式店铺与窗口选择、simulation 标注、GMV 口径注明、写方法隔离、HTML 转义与敏感字段过滤，74 个隔离场景全部通过。
- 保留项：演示数据，非真实店铺数据；任务存储与 MCP 传输未接通（页面如实标注未接通，不冒充）；手机浏览器视觉实测未做；持久化待 PG 就绪；签名草案、Token 内存存储、PG 实库迁移与 Git 提交保留问题仍未解决（与 T1–T8 相同）。

## 技术缺口补齐（2026-10-30，总控亲自复核，T10 之前的技术部分）

### Codex 报告
- MCP：npm view 核实官方 SDK 为 @modelcontextprotocol/sdk@1.32.2，已安装为生产依赖；npm run mcp:smoke 通过，实际 SDK 客户端经 stdio 调通 7 个模拟只读工具，与 REST 结果一致，复用同一 Gateway。
- PostgreSQL：apt 安装 16.15，服务 online、本地 peer 认证；db-verify 脚本通过首次迁移、重复迁移及删库重建；OID 16385 → 16407，重建后 shops 为 0 行；仅 shops 已迁移。
- Git：git init --initial-branch=main 成功；无提交、无暂存、无远程，未设置作者。
- 最终 npm test 333 通过 0 失败（含原有 320 项），build 通过；沙箱首轮 stdio 测试 2 项失败已保留证据，宿主复验全部通过；原有 25 份 Markdown、9 份测试文件均未修改。
- 剩余：其他业务表尚无迁移，业务仓储仍在内存，pg-boss 调度尚未接通；未接真实店铺、未做 T10。

### 总控复核（同日，本人实际运行，含一次纠正）
- `npm test`：本人运行，333 通过 0 失败，与 Codex 报告一致；`npm run build` 通过。
- MCP 纠正：本人首次运行 `npm run mcp:smoke` **失败**，断言在审计记录中找不到 status_code 403。查因：7 个工具调用与 REST 一致性均已通过，拒绝调用本身也返回固定信封，问题出在冒烟脚本在拒绝调用后立即解析 stderr，而 Gateway 审计经 Fastify/pino 异步日志，403 记录尚未落盘——是冒烟脚本的竞态，不是 Gateway 鉴权缺陷。总控已在 scripts/mcp-smoke.mjs 中加 5 秒有界等待（等 403 审计记录出现再断言），未改生产逻辑；重跑后 **PASS**：SDK initialize、tools/list、7 个只读工具、REST 一致性、店铺拒绝与共享 Gateway 审计（7 条 200 + 1 条 403）全部通过。Codex 的“宿主复验通过”应理解为该竞态偶发通过，总控的修复与重跑才是确定性证据。
- PostgreSQL：本人先查专用库现状（仅 shops 表、0 行、迁移记录 1 条），确认为空的专用模拟库后手动删库，再完整运行 db-verify 脚本，**PASS**：空库、幂等迁移、哨兵插入、删库重建、重建后迁移；OID 16433 → 16455，重建后 shops 0 行。脚本本身拒绝删已存在库，是正确的安全行为，本人删的是专用空模拟库，未动其他数据。
- Git：本人运行 git status，分支 main，全部文件为未追踪状态，无提交、无暂存、无远程，与 Codex 报告一致；.env.example 等均未追踪，未把凭证写进版本库。
- package.json 核对：@modelcontextprotocol/sdk 1.32.2、pg 8.23.1 已入依赖，新增脚本 mcp:stdio、mcp:smoke、db:migrate:local、db:verify:local；mcp-stdio 启动器明确只用模拟占位授权、不读 .env、不读真实配置，非模拟模式下无授权将走 Gateway 401，不存在无鉴权后门。
- 未接真实店铺、未用真实凭证、未向真实域名发请求。

### 技术缺口结论：通过（带保留）
- 通过项：MCP stdio 传输已接通（实际 SDK 客户端验证）、PostgreSQL 16 实库迁移与删库重建已验证、Git 仓库已初始化。
- 保留项：仅 shops 表有迁移，其他业务表无迁移、业务仓储仍在内存、pg-boss 未接通；MCP 目前只验证了模拟数据调用，真实店铺数据调用仍待 T10；Git 尚未提交（作者未定，不编造身份提交）。

## MVP 验收总账（T1–T9 代码完成，T10 待真实接入）
- 已通过（带保留）：骨架、适配层草案、店铺连接、商品库存、订单履约、经营分析、巡检、Gateway REST、Web 后台；测试累计 320 通过。
- 未通过、不得宣称通过：①未连任何真实授权店铺，未做 20 条 Seller Center 抽查，未出真实日报；②MCP 传输层模拟调用已接通，但真实店铺数据调用未验证，验收第 7 条仍不能写成完全通过；③PostgreSQL 实库迁移已验证，但仅 shops 表，其他业务表无迁移、业务仓储仍在内存；④Git 已初始化但未提交；⑤七天稳定性未跑（只能建计划，不能写通过）。
- T10 阻塞点：Partner Center 全球区登录仍待解决（浏览器出口美国导致地域跳转），或用户在自己设备登录后报应用类型、市场、Scope、已授权店铺；在此之前不得宣称已接通官方 API。

## 待填
- T10：按“Codex 报告 + 总控复核”两栏记录，不得只贴 Codex 自述。
