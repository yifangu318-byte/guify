# T7 — AI 经营巡检只读骨架

本轮只实现 T7 的本地、规则驱动巡检骨架。未接真实数据，未调用外部模型、真实 TikTok 或真实域名，未发任何外部通知，未改业务数据。巡检结果只返回给调用方，持久化待 PG 就绪。本轮用户明确要求优先于 TASKS.md 中原有的 pg-boss、写 alerts 表和自动重试描述；这里没有启动定时器或注册路由，调度接入留待 T8/T9，本轮未实现 T8–T10。

## 输入与调用

入口是 `src/inspection/service.ts` 的同步纯函数：

```ts
runInspection(
  shop_ids: readonly string[],
  snapshots: readonly InspectionSnapshot[],
  inspected_at: number,
): InspectionResult
```

`inspected_at` 必须由调用方显式传入 Unix 毫秒时间，不读取系统时钟。`shop_ids` 必须显式传入，不提供“默认全部店铺”。重复店铺 ID 按首次出现顺序去重，不在集合中的快照不会参与巡检。每个选中店铺必须恰好一份完整输入；缺失或重复快照会抛固定错误，不返回部分成功结果，也不把数据缺失当作业务健康。

每份 `InspectionSnapshot` 包括：

| 字段 | 既有来源及约束 |
| --- | --- |
| `shop_id` | 显式店铺标识 |
| `authorization` | T3 `AuthorizationState`，由调用方先通过 `ShopQueries.getAuthorization` 或 `summarize` 取得有效状态；过期判定已由 T3 完成，T7 直接使用状态、不重算过期规则 |
| `products` | T4 `ProductSnapshot`，`source` 必须是 `simulation` |
| `orders` | T5 `OrderSnapshot`，`source` 必须是 `simulation` |
| `inventory_risk` | T6 `calculateInventoryRisk` 或 `summarizeAnalytics(...).shops[n].inventory_risk` 的指标结果，使用与当前 T4 快照一致的结果和阈值 |

T3 本身允许 `simulation` 或 `explicit_input` 的状态来源；接受后者不代表真实接入已验证。T4/T5/T6 不接受其他来源，输出来源始终固定为 `simulation`。T7 通过既有 T4/T5 校验器检查店铺归属与父子引用，不接受混店数据。T6 指标必须带合法窗口、计算时间、`inventory_basis: 'snapshot'`，且其库存告警与 T4 快照重新检测的结果完全相符；过时或混用的指标明确报错，不转成零异常。

本轮只消费 T6 的库存风险指标；不会另行对 GMV、订单量或热销排行创造异常规则。T6 订单统计窗口不用于过滤 T5 超时检测：巡检针对传入完整订单快照，避免漏掉窗口外仍待处理的老订单。

## 复用的判定口径

| 类别 | 调用/复用 | 触发条件 |
| --- | --- | --- |
| `stock` | T4 `detectStockAlerts`；阈值来自 T6 指标 | 数量为 0 是 `out_of_stock`；正库存严格小于阈值是 `low_stock`；正库存刚到阈值不触发。阈值为 0 时，零库存仍按 T4 规则报缺货 |
| `order_timeouts` | T5 `detectTimeoutAlerts` 的默认阈值 | 待发货从 `order_time` 起严格超过 48 小时；在途包裹从最新轨迹（无轨迹时回退 `shipped_at`）起严格超过 72 小时；刚到阈值不触发，超过 1 毫秒触发 |
| `authorization` | T3 已解析状态 | `expired`、`revoked`、`unauthorized` 单列；`authorized`、`pending_verification` 不凭空产生异常 |

库存不跨仓求和，不把缺失库存行补成 0。物流继续沿用 T5 对未知时间、已妥投/已取消订单或包裹的处理。超时证据只在 T5 返回告警后投影，不另写判定分支。T7 不重新解释未授权状态，也不尝试刷新凭证。

## 输出、单位与去重

每次结果含 `source: 'simulation'`、`inspected_at`、`shop_ids`、三类异常数组和 `total_anomalies`（各数组去重后条目数之和）。异常条目恰好只有六个字段：

| 字段 | 含义 |
| --- | --- |
| `shop_id` | 店铺标识 |
| `type` | 既有缺货/低库存/待发货超时/物流停滞类型，或 `authorization_abnormal` |
| `entity_type` | `sku`、`order`、`package`、`shop` |
| `entity_id` | 对应 SKU/订单/包裹/店铺标识，包裹标识不是物流单号 |
| `trigger_value` | 库存数量；超时已持续毫秒数；或异常授权状态 |
| `threshold` | T6 库存数量阈值；T5 48/72 小时转换的毫秒数；授权期望状态 `authorized` |

去重键为 `(shop_id, entity_id, type)`，同键只返回一条。库存先逐仓检测，再按 SKU 去重；同 SKU 同类型若有多仓触发，保留最低库存数量作为证据，不做库存相加。同 SKU 缺货与低库存属于不同类型，可分别出现。不同店铺相同标识、同订单不同包裹各自保留。既有 T4/T5 快照中的重复原始主键继续按原校验规则报错，避免擅自挑选冲突的原始业务记录。

空的显式集合（包括 `runInspection([], [], inspected_at)`）返回零异常。选中店铺传入完整但无业务记录的 T4/T5/T6 快照且 T3 无异常，也返回零异常。未授权店铺即便没有业务记录仍会单列授权异常。

不透传输入对象：买家引用/姓名/电话/地址、物流单号/轨迹描述、Token/Secret/cipher、游标、商品标题、金额、店铺名称和 code 均不进入巡检结果。只投影经过既有校验的标识、固定类型与标量证据。异常错误使用固定消息，不回显原始输入或异常文本。

## 验证与保留

执行 `npm test`、`npm run build`；运行记录和命令见 `T7-TEST-REPORT.md` 与 `.t7-evidence/`。新增 33 项 Node 内置运行器测试，全量 172 项通过、0 失败，含原有 139 项。测试覆盖三类触发/不触发、48/72 小时边界、库存边界、多店隔离、显式集合、去重、空数据、敏感字段与冻结输入不被修改。

这里没有数据库读取、业务写入、日志回调、网络请求、邮件/消息/webhook、Fastify 路由或后台任务。错误直接抛给显式调用方；本模块不自动重试、不静默返回健康结果。后续持久化、调度、失败重试与通知接入均待独立任务确定。真实数据验证、PG 持久化、生产可用性及七天稳定性均未验收；总控复核仍待进行。
