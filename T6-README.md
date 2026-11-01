# T6 — 经营数据分析（模拟计算）

本模块仅对 T4/T5 的内存快照进行纯函数计算。全部指标为模拟数据计算，未接真实数据、真实店铺或真实 TikTok；未新增持久化，未写入真实数据库。持久化待 PG 就绪，当前没有数据库读写、网络、定时任务、业务路由或 Gateway 接入。

模型：由总控从进程记录核对。

## 模块与调用

文件划分沿用商品/订单模块的模型与服务风格：`src/analytics/models.ts` 定义输入输出与元数据，`decimal.ts` 实现十进制合计，`service.ts` 导出同步纯函数。无需创建 repository、sync 或数据库迁移。

| 函数 | 输入 | 输出 |
| --- | --- | --- |
| `calculateShopOverview` | shop_id、OrderSnapshot、window、calculated_at | 订单数、已妥投数、待发货数、GMV |
| `calculateGmv` | 同上 | 窗口内十进制金额合计与逐币种金额 |
| `rankBestSellingSkus` | 同上 | 按明细数量合计排序的 SKU |
| `calculateInventoryRisk` | shop_id、ProductSnapshot、window、calculated_at、threshold（默认 0） | 零库存和低库存清单 |
| `summarizeAnalytics` | 显式 shop_ids、AnalyticsSnapshot[]、window、calculated_at、threshold（默认 0） | 指定店铺逐店标注的四类指标 |

```ts
import { summarizeAnalytics } from './src/analytics/service.js';
import { emptySnapshot as emptyProducts } from './src/products/models.js';
import { emptySnapshot as emptyOrders } from './src/orders/models.js';

const shop_id = 'placeholder-shop-a';
const result = summarizeAnalytics([shop_id], [{
  shop_id, products: emptyProducts(shop_id), orders: emptyOrders(shop_id),
}], { start_at: 1000, end_at: 2000 }, 3000, 2);
// 模拟空快照：订单数 0，GMV "0"，排行与风险清单为空。
```

调用方可在模块外取得 T4/T5 内存仓库的 `getSnapshot(shop_id)` 返回值作为输入；分析函数本身不会读取仓库。不能把单次查询的部分订单列表当成完整快照。计算时间由调用方显式传入，相同输入返回相同结果，不读取系统时钟，也不修改输入。

## 统计口径

- 每个指标（含概览内的 GMV）都有 `source: 'simulation'`、`shop_id`、`window: { start_at, end_at }`、`calculated_at`。时间单位均为 Unix 毫秒，窗口必须满足非负安全整数且 `start_at < end_at`。
- 订单数、GMV、已妥投数、待发货数与热销均按 **`order_time >= start_at && order_time < end_at`** 选订单。起点计入，终点不计入，相邻窗口不重复统计。`created_at`、`updated_at` 与包裹时间不参与窗口判断。
- 订单数统计窗口内所有状态。已妥投/待发货分别匹配订单当前状态 `delivered` / `pending_shipment`，不是按妥投日期统计，也不从包裹状态推断。
- GMV 为窗口内**所有状态订单原始 `total_amount` 的合计**，包含待付款与取消订单。这是本次模拟快照的可复算口径，不代表已支付 GMV、净收入或结算金额；未推定任何真实平台财务规则。明细金额不用于替代订单总额。
- 金额用 BigInt 整数系数对齐十进制位后相加，输出十进制文本，保留输入中最大的精度。不进行浮点金额累加，不把任意精度金额四舍五入成整数分。
- `by_currency` 分币种合计并按标识升序；每行带 `shop_id`。单币种时 `total_amount` 为该合计；空订单时为 `"0"`，`by_currency` 为空；多币种时 `total_amount: null`，有效合计在 `by_currency` 中，避免不同币种混加。无汇率转换。
- 热销按选中订单的明细 `quantity` 汇总，同 SKU 跨订单合并，数量降序；并列按 SKU 标识的 JavaScript 字符码顺序升序，独立于运行环境 locale 或输入顺序。保留历史订单中已不在当前商品目录的 SKU，不跨店合并同名 SKU。数量超过安全整数时显式报错。
- 库存风险直接复用 T4 `detectStockAlerts`：按店铺/SKU/仓库逐行判定，0 为缺货，`0 < quantity < threshold` 为低库存，等于阈值不告警，零库存优先。阈值为非负安全整数，默认 0；不跨仓抵消、不为缺失库存行补零。
- 库存结果显式标记 `inventory_basis: 'snapshot'`。窗口为本次分析报告上下文；库存是调用方提供的当前快照，**不是该窗口内的历史库存**，不按 `updated_at` 过滤或回推。

## 隔离、空数据与脱敏

跨店调用必须显式传 `shop_ids`，按调用方顺序去重；返回 `shop_ids` 与 `shops`，结果逐店标注，不自动发现全部店铺、不提供无店铺标注的跨店总额。显式 `[]` 返回空店铺集合。未选中的快照不会进入结果。

每个选中店铺必须恰有一个完整快照。缺失、重复或跨店/关系校验失败会抛固定错误，整个调用不返回部分结果。有效的空快照返回零值和空清单；缺失快照不伪装成零业务数据。空结果也不意味着真实店铺已同步完成。

复用 T4/T5 的快照校验，拒绝非 simulation 来源、跨店行、重复实体、无效关联和金额。输出只构造指标必要字段，不转发买家占位标识、包裹、物流、同步游标、标题或任意额外字段；凭证、姓名、电话、地址等额外字段不会进入结果。错误不回显输入，不产生业务日志。

## 验证与边界

`npm test` 使用 Node 内置测试运行器。新增 `test/analytics.test.ts` 覆盖多店隔离、半开窗口边界、任意精度金额、混合币种、确定性排序、T4 风险规则、空数据、敏感字段、不修改输入，以及 T4/T5 实际内存同步输出的集成复算。运行证据见 [T6-TEST-REPORT.md](T6-TEST-REPORT.md) 和 `.t6-evidence/`。

剩余：PG 未就绪，真实持久化待后续处理；当前项目无有效 Git 仓库，未提交。未做 T7–T10、真实接入、定时巡检、权限 Gateway 或 Web 页面。未用真实凭证、真实订单/商品/金额，未向真实域名请求，未安装 Docker、未采购、未部署生产。
