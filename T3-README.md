# T3 店铺连接只读骨架

本次仅交付 T3 模块函数，待总控独立复核。未接真实授权、未连接 TikTok、未使用真实凭证、未请求真实域名。状态为显式输入或模拟数据，`authorized` 不代表官方验证通过。

## 模块与使用

- `src/shops/models.ts`：店铺登记字段类型复用 T1 Drizzle shops 表；授权状态为 unauthorized（未授权）、pending_verification（已授权待验证）、authorized（已授权输入）、expired（过期）、revoked（撤销）。所有授权记录带 source，标注 explicit_input 或 simulation。
- `src/shops/repository.ts`：可替换的 ShopRepository 接口；MemoryShopRepository 通过构造时显式种子登记店铺，不提供运行时写接口。数据仅驻内存，不是数据库持久化。缺少授权输入时默认未授权。
- `src/shops/service.ts`：ShopQueries.getAuthorization(shop_id)、getSyncStates(shop_id)、summarize(shop_ids)。返回复用 T2 Result/ErrorEnvelope 结构，不调用适配器 transport、刷新或 TokenStore。

示例（全部为占位符）：

```ts
const repository = new MemoryShopRepository([{
  shop: { id: 'placeholder-shop-a', market: '<placeholder-market>',
    shopCode: '<placeholder-code>', shopName: '<placeholder-name>', status: 'inactive' },
}]);
const queries = new ShopQueries(repository);
await queries.getAuthorization('placeholder-shop-a'); // unauthorized
await queries.getSyncStates('placeholder-shop-a'); // []，尚无同步记录
await queries.summarize(['placeholder-shop-a']); // 每行明确标注 shop_id
```

跨店汇总必须显式传店铺集合；空集合返回空结果；去重并保留输入顺序，未知店铺整体报错。单店/汇总均检查仓库返回的 shop_id，拒绝混店结果。此接口的范围控制不是调用者身份权限系统；身份与白名单属于后续任务，本次未实现。

到期时间使用 Unix 毫秒，与 T2 一致；authorized/pending_verification 到期（含等于当前时间）时只在查询结果中计算为 expired，不改写仓库。revoked 不被过期推导覆盖；null 到期时间表示未知，不推断真实验证情况。

同步记录含资源、最后成功时间、游标、错误；可全部为 null，未建立记录则返回空数组。last_error 只允许安全类别 SYNC_FAILED 或 null，不接受上游原始错误正文。未实现任何资源同步。资源名、游标和店铺展示字段必须是非敏感业务元数据，禁止把凭证塞入这些字段；额外 Token/Secret 属性通过字段白名单丢弃，不进入模型。T2 TokenStore 与本模块分离。

未授权店铺可查询自身的状态元数据并返回 unauthorized，不读取业务数据。可注入 log 回调记录固定事件及授权状态，复用 T1 redact；接入应用时可传给 T1 应用 logger。默认不写日志或文件，审计不含凭证、游标、原始异常或店铺输入；本次没有业务 API 路由，也未改变 T1 配置、日志或错误处理。

## 验证与保留事项

见 T3-TEST-REPORT.md。T3 仍是骨架：真实 PostgreSQL 持久化待 PG 就绪后通过仓库接口接入；未新增实库迁移、未宣称持久化。未连接真实授权，授权状态由显式输入/模拟产生；真实授权及签名验证仍待后续授权。未实现 T4–T10、未安装 Docker、未采购、未部署生产。

## 2026-10-30 续跑补充（保留以上原文）

本轮模型：gpt-6.1-sol；推理档：高（high）。在上轮已有模块上继续完成 T3，未重复创建模块。TypeScript 的 `shopCode`、`shopName` 复用现有 Drizzle 字段类型，对应数据库的 `shop_code`、`shop_name`。

- `SyncState.resource` 现允许 `null`，表示资源未知或尚未同步；资源名、最后成功时间、最后游标、最后错误均可显式为 `null`。未建立记录仍返回 `[]`，不会捏造成功时间或游标。同一店铺不能重复登记同一资源（包括 `null`）。
- 种子登记与替换仓库读取使用共同的运行时校验。查询返回前拒绝未知授权状态、非显式/模拟来源、非法时间、非字符串游标、重复同步资源及原始错误正文，返回固定 `SHOP_QUERY_FAILED` 信封；合法结构中的跨店数据返回 `SHOP_SCOPE_INVALID`。额外凭证属性仍由字段白名单丢弃，异常内容不进入结果或日志。
- 本轮补充 8 项隔离测试，T3 共 20 项；包含原有 T1/T2 的全量测试共 45 项通过、0 失败，构建通过，运行证据见 T3-TEST-REPORT.md 的续跑记录。

自由文本展示字段和游标仅允许调用方提供非敏感元数据；系统无法识别被故意伪装成普通文本的任意凭证。不得将 Token、Secret 或 shop_cipher 放入任何这些字段。日志只含固定事件、枚举状态和固定结果，默认无持久审计存储。

交付仍为只读模块函数骨架，没有注册店铺业务路由、没有 OAuth 回调或授权请求，也没有任何资源同步。`authorized` 仅表示显式输入或模拟状态，不能作为真实授权的证据。仓库仍只有内存实现，真实 PostgreSQL 持久化待 PG 就绪后接入。本轮未接真实授权、未用真实凭证、未向真实域名发请求、未做 T4–T10、未装 Docker、未采购、未部署生产。
