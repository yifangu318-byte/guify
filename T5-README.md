# T5 — 订单、包裹、物流只读同步与超时检测

状态：**内存模拟骨架**。未接真实同步，未调用 T2 适配层，未注册业务 HTTP 路由；真实 PostgreSQL 持久化待 PG 就绪后通过仓库接口接入。此文档为新增文件，不替代任何已有项目文档；实现及运行证据待总控验收。

## 模块与数据边界

- `src/orders/models.ts`：Order、OrderItem、Package、TrackingEvent、OrderSnapshot 与运行时校验。
- `src/orders/repository.ts`：可替换 OrderRepository、内存 MemoryOrderRepository。
- `src/orders/service.ts`：按店只读查询、显式跨店汇总。
- `src/orders/sync.ts`：OrderSyncSource、MemoryOrderSyncSource、OrderSync、本地 OrderReconciliation。
- `src/orders/alerts.ts`：纯函数 detectTimeoutAlerts 和可配置默认阈值。

所有业务行均含 `shop_id`。订单按店唯一；明细以订单 + item_id 唯一，必须引用同店订单；包裹按店唯一，必须引用同店订单；轨迹以包裹 + event_id 唯一，必须引用同店包裹。同一个外部订单/包裹标识可出现在不同模拟店铺。SKU 标识为订单明细的历史标识，不要求当前商品快照仍存在该 SKU，不引入跨模块隐式查询。

金额 `total_amount`、`unit_price` 保留非负十进制文本，不转浮点数；数量为正安全整数。没有推断订单总额必须等于明细之和，后续运费、折扣等口径尚待真实接口验证。测试中 TST 币种、金额、数量、标识和时间均为占位数据。

买家字段只有 `buyer_ref` 占位标识；物流单号字段只有可空 `tracking_ref` 占位标识，轨迹描述只有 `status_description` 占位文本。这三类文本仅接受 `<placeholder-小写字母数字或连字符>` 格式，不能承载真实姓名、电话、地址、物流单号或原始轨迹描述。字段白名单在仓库、同步和查询边界重新校验，额外的姓名、电话、地址、凭证、原始物流字段不会被保存或返回；异常也只返回固定信封，不输出原始错误。

## 只读接口

所有接口为进程内 TypeScript 接口，与现有 T4 风格一致，不在 T5 接入 REST/MCP、页面或权限系统。

| 接口 | 行为 |
| --- | --- |
| `OrderQueries.listOrders(shop_id)` | 本店订单列表，包含状态 |
| `getOrder(shop_id, order_id)` | 订单及其明细、包裹，带店铺及 simulation 来源 |
| `listPackages(shop_id)` | 本店包裹列表，包含状态 |
| `listTracking(shop_id, package_id)` | 本店指定包裹轨迹，按发生时间升序 |
| `getSyncStates(shop_id)` | T3 SyncState 口径的同步元数据 |
| `getTimeoutAlerts(shop_id, now, thresholds?)` | 本店超时告警 |
| `summarize(shop_ids)` | 显式店铺集合的完整模拟快照 |
| `summarizeTimeoutAlerts(shop_ids, now, thresholds?)` | 显式店铺集合的告警汇总 |

所有查询返回既有 `Result<T>` 信封；这里只复用 T2 的类型，不实例化适配层。没有默认“全部店铺”，空集合得到空结果；集合去重，等待仓库之前复制集合及阈值，任何店查询失败时不返回部分汇总。每条返回业务行及告警都标注店铺。

## 模拟同步和丢事件对账

`OrderSync.syncShop(shop_id)` 从明确标记 `source: 'simulation'` 的模拟源读取完整快照，校验后原子替换单店四类资源。同一 OrderSync 实例内同店串行、不同店独立；可替换仓库必须履行原子替换契约。多进程锁、分页及增量同步尚未实现。

资源名为 `orders`、`order_items`、`packages`、`tracking_events`；同步元数据直接复用 T3 SyncState：资源、最后成功时间、游标、错误均可空，错误仅为 `SYNC_FAILED` 或 null。缺失资源补成未同步状态，未知资源 null 状态可保留；业务资源以外的字符串资源、重复状态和跨店状态会被拒绝。成功同步记录本地完成时间、保留源游标并清除错误；失败保留既有数据、游标与成功时间，只记录固定失败类别。首次失败不凭空生成订单或包裹。

`OrderReconciliation.receiveWebhook(event)` 是**本地模拟接收入口**，只接受 simulation 来源、显式店铺和事件标识、已知资源；事件仅提示重新读取模拟源，不把事件携带的业务数据写入仓库。`pollShop(shop_id)` 也通过同一个同步队列读取完整快照。因此即使完全丢失一次模拟发货事件，显式调用轮询仍可补齐订单状态、包裹状态和轨迹；重复或旧事件提示重复读取当前源，不重复追加业务行。

没有开放 Webhook HTTP 接收端点，没有官方验签、实际事件接入、定时调度或后台任务。轮询由测试/调用方显式调用；这些骨架测试不表示已验证 TikTok 的实际事件或对账机制。

## 超时规则

`detectTimeoutAlerts(shop_id, snapshot, now, thresholds?)` 为纯函数，所有时间使用 Unix 毫秒，配置使用正整数小时，并拒绝会使毫秒换算溢出的阈值。

| 类型 | 条件与计时基准 | 默认阈值 |
| --- | --- | --- |
| `pending_shipment_timeout` | 订单状态 pending_shipment；从 order_time 起严格超过阈值 | pendingShipmentHours = 48 |
| `logistics_stalled` | 包裹状态 in_transit，所属订单未 delivered/cancelled；从该包裹最新轨迹时间起严格超过阈值 | logisticsStalledHours = 72 |

刚到阈值与尚未到阈值均不告警；超过 1 毫秒即告警。无轨迹时物流规则回退到 `shipped_at`，两者均未知时不推断超时。轨迹按发生时间取最大值，不依赖输入顺序，也不混用其他包裹的轨迹；未来时间不触发超时。

告警字段仅有 `shop_id`、`order_id`、物流类的 `package_id`、`type`、`triggered_at`、`threshold_hours`。`triggered_at` 为调用者传入的检测时刻；不代表官方履约截止时刻。告警不含买家标识、物流占位文本、金额、数量或完整业务快照。不写告警表，不发消息，不实施发货或取消操作。

## 验证与限制

`npm test` 使用 Node 内置测试运行器；新增 39 项 T5 隔离测试。实际结果：总计 110 通过、0 失败；`npm run build` 通过。详细命令、文件清单和日志见 [T5-TEST-REPORT.md](T5-TEST-REPORT.md)。

尚待 PG 就绪后实现仓库持久化；订单状态和时限规则为本地可配置模拟约定，未宣称对应官方规则。未使用真实凭证或业务数据，未连接真实 TikTok，未向真实域名发请求，未做 T6–T10，未装 Docker、采购或部署生产。现有 Git 环境仍不是有效仓库，未做提交。
