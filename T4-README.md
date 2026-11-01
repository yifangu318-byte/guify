# T4 商品、SKU、库存、仓库只读模拟骨架

本模块仍是骨架，**未接真实同步，未连接 TikTok，未持久化到真实数据库；PostgreSQL 持久化待 PG 就绪后接入**。仅交付模块接口与内存实现，不注册 Fastify 业务路由，不执行 T5–T10。

## 文件与模型

- `src/products/models.ts`：Product、Sku、Warehouse、Inventory、ProductSnapshot 及运行时校验、字段白名单投影。
- `src/products/repository.ts`：可替换 ProductRepository 与 MemoryProductRepository。
- `src/products/sync.ts`：模拟源 ProductSyncSource、MemoryProductSyncSource 与 ProductSync。
- `src/products/service.ts`：只读 ProductQueries，复用 T2 Result 信封（仅类型导入，不调用适配器）。
- `src/products/alerts.ts`：纯函数 detectStockAlerts 与最小告警字段。
- `test/products.test.ts`：26 个 T4 隔离场景。

Product 使用 PROJECT.md 的 products 字段口径：shop_id、product_id、title、status、category、updated_at。实际 T1 `src/db/schema.ts` 目前只有 shops 表，未发现可直接复用的 products 表；本次未虚构或修改已落地数据库 schema，也未增加迁移。

SKU 含 shop_id、product_id、sku_id、price、currency、status。price 为非负十进制字符串，不作浮点金额计算；测试只用占位价格 `1.00` 等与测试币种 `TST`。仓库含 shop_id、warehouse_id、name、warehouse_type，类型为 regular（普通仓）、overseas（海外仓）、other，不含国家到仓库的映射。Inventory 含 shop_id、sku_id、warehouse_id、quantity、updated_at，数量必须是非负安全整数，更新时间为 Unix 毫秒或 null。

商品、SKU、仓库按各自标识在店内唯一，库存以 SKU + 仓库在店内唯一。SKU 必须引用同店商品，库存必须引用同店 SKU 与仓库；其他店恰好有同名标识也不能满足归属校验。不同店可使用相同外部标识。

## 查询与同步接口

ProductQueries 提供以下按店接口，shop_id 必须显式传入：

- listProducts(shop_id)、getProduct(shop_id, product_id)。
- listSkus(shop_id)、listWarehouses(shop_id)、listInventory(shop_id)。
- getSyncStates(shop_id)、getStockAlerts(shop_id, threshold = 0)。
- summarize(shop_ids)、summarizeStockAlerts(shop_ids, threshold = 0)。跨店查询必须传数组，空数组返回空结果，去重保留输入顺序；不会隐式查询全部店铺。所有结果及嵌套业务记录标注 shop_id。

ProductRepository.getSnapshot(shop_id) 查询单店快照；replaceSnapshot(shop_id, snapshot) 是供模拟同步使用的本地仓库替换接口，要求先校验再原子替换，不是远端改商品、改价或改库存接口。替换一个店铺不会修改其他店铺，输入与输出均拷贝，禁止通过可变引用绕过校验。替换为 PostgreSQL 时必须保留按店原子事务、校验和隔离语义。

ProductSyncSource 只接受 source 为 simulation 的完整快照，readSnapshot(shop_id) 不含 URL、凭证或默认网络传输。MemoryProductSyncSource 仅从显式模拟种子读取；无种子的店铺报错。测试全部使用占位标识、标题、价格、库存，不读环境凭证，不访问真实域名。

ProductSync.syncShop(shop_id) 一次校验、替换四类完整资源，不是分页增量协议。空数组表示该完整快照确实为空，可以移除旧条目；不省略资源、不伪造不存在 SKU 的零库存。同一 ProductSync 实例内同店请求串行，不同店独立；尚无多进程锁。

同步状态直接复用 T3 SyncState 类型和校验：shop_id、resource、last_success_at、last_cursor、last_error。四类资源为 products、skus、warehouses、inventory。缺少的资源状态补为三个元数据字段均 null；输入可保留 resource 为 null 的未知资源状态。成功同步后资源已知，仅返回四类具体资源状态，成功时间取注入时钟或 Date.now()，保留模拟源游标，清空错误。失败保留原业务数据、上次成功时间和游标，仅写固定类别 SYNC_FAILED，不存原始异常。首次失败可留下明确标记 simulation 的空快照，其成功时间仍为 null。仓库不可写时返回固定失败信封，不能保证失败状态已保存。

模块不产生日志；额外的 Token、Secret、shop_cipher 等属性在内存仓库、模拟源和服务边界均丢弃；异常只返回固定错误信封。业务字段允许调用方提供模拟标题等正常字符串，白名单过滤不等于任意字符串内容的凭证识别；不得向这些接口输入真实凭证或真实商品数据。

## 缺货规则

detectStockAlerts(shop_id, inventory, threshold = 0) 是纯函数，不改输入。按“店铺 + SKU + 仓库”独立判断，不把其他仓库存量相加掩盖当前仓库缺货。阈值必须是非负安全整数。

| 条件 | 类型 |
| --- | --- |
| quantity = 0 | out_of_stock（缺货，优先级高于低库存） |
| 0 < quantity < threshold | low_stock（低库存） |
| quantity = threshold 且 quantity > 0 | 无告警 |
| quantity > threshold | 无告警 |
| 缺少库存行 | 不推断零库存，无告警 |

每条告警严格只有 shop_id、sku_id、warehouse_id、quantity、threshold、type；不带商品标题、价格、SKU 状态、同步游标、凭证或其他商品详情。跨店告警通过显式 shop_ids 的服务接口汇总，逐条标注店铺。

## 使用示例（仅内存模拟）

```ts
import { emptySnapshot } from './src/products/models.js';
import { MemoryProductRepository } from './src/products/repository.js';
import { MemoryProductSyncSource, ProductSync } from './src/products/sync.js';
import { ProductQueries } from './src/products/service.js';

const snapshot = emptySnapshot('placeholder-shop-a');
// 如需数据，仅填入明确的占位商品/SKU/仓库/库存；完整示例见测试。
const repository = new MemoryProductRepository();
const source = new MemoryProductSyncSource([snapshot]);
const sync = new ProductSync(repository, source, { now: () => 1000 });
await sync.syncShop(snapshot.shop_id);
const queries = new ProductQueries(repository);
await queries.listProducts(snapshot.shop_id);
await queries.summarizeStockAlerts([snapshot.shop_id], 2);
```

## 验证与保留

运行 `npm test` 与 `npm run build`。本次运行证据见 T4-TEST-REPORT.md 和 `.t4-evidence/`。仍待 PG 就绪后实现真实数据库仓库；真实同步、权限网关、分页、调度、UI、官方字段映射和生产接入均未交付。本次没有实现 T5–T10，也未修改任何已有 Markdown。
