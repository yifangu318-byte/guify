# T5 — 实现与测试证据（2026-10-30）

模型：**由总控从进程记录核对**。

本报告记录工程师实际运行证据，待总控复核验收。交付范围仅为 T5 内存模拟骨架；未接真实同步，真实 PostgreSQL 持久化待 PG 就绪。全部测试使用占位店铺、订单、买家、SKU、物流标识、金额和数量。

## 文件清单

新增业务与测试文件：

- `src/orders/models.ts`
- `src/orders/repository.ts`
- `src/orders/service.ts`
- `src/orders/sync.ts`
- `src/orders/alerts.ts`
- `test/orders.test.ts`
- `T5-README.md`
- `T5-TEST-REPORT.md`

新增证据文件：

- `.t5-evidence/baseline-tests.log`：实现前完整测试输出。
- `.t5-evidence/before-sha256.json`：实现前 52 份已有文件的 SHA-256。
- `.t5-evidence/final-tests.log`：实现后完整测试输出，逐项包含 39 项 T5 测试。
- `.t5-evidence/build.log`：TypeScript 构建输出。
- `.t5-evidence/test-types.log`：新增测试的额外严格类型检查输出，成功时为空文件。
- `.t5-evidence/integrity.log`：原文件与原 Markdown 完整性校验结果。
- `.t5-evidence/scope-scan.log`：新增模块/测试的外部 URL、网络调用及适配层运行时扫描结果。
- `.t5-evidence/compiled-smoke.mjs`：使用编译产物的模拟验证脚本。
- `.t5-evidence/compiled-smoke.log`：编译产物验证输出。

已有源文件、测试、配置及 Markdown 的修改/删除：**无**。SHA-256 核对 52 份已有文件全部不变，其中 15 份为 Markdown。未覆盖或删除 PROJECT.md、TASKS.md、DECISIONS.md、PROGRESS.md、TEST_REPORT.md、CODEX-CONFIG.md 等任何已有文档。构建另外生成 `dist/orders/{models,repository,service,sync,alerts}.js` 与对应 `.js.map`，这些是编译输出。

## 实际运行命令与结果

运行目录：`/home/hatch/workspace/muse-erp`。Node `v24.22.1`，npm `10.9.4`。没有安装依赖或执行联网命令。

| 实际执行命令（日志重定向除外） | 结果 | 证据 |
| --- | --- | --- |
| `npm test`（实现前） | exit 0；71 通过、0 失败 | [baseline-tests.log](.t5-evidence/baseline-tests.log) |
| `npm test`（实现后） | exit 0；110 通过、0 失败、0 跳过、0 取消 | [final-tests.log](.t5-evidence/final-tests.log) |
| `npm run build` | exit 0；严格模式 TypeScript 编译成功 | [build.log](.t5-evidence/build.log) |
| `./node_modules/.bin/tsc --noEmit --target ES2024 --module NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --skipLibCheck test/orders.test.ts` | exit 0；新增测试严格类型检查成功 | [test-types.log](.t5-evidence/test-types.log) |
| `node .t5-evidence/compiled-smoke.mjs` | exit 0；result PASS，双店告警及丢事件补齐断言通过，fetch 调用次数 0 | [compiled-smoke.log](.t5-evidence/compiled-smoke.log) |
| `python3` SHA-256 校验脚本 | exit 0；52 份原文件、15 份原 Markdown，changed_or_deleted = [] | [integrity.log](.t5-evidence/integrity.log) |
| `python3` 范围扫描脚本 | exit 0；新增 5 份模块源码及测试，3 类检查均无匹配 | [scope-scan.log](.t5-evidence/scope-scan.log) |
| `rg -c "^test\('T5" test/orders.test.ts` | exit 0；39 | [orders.test.ts](test/orders.test.ts) |
| `git status --short` | exit 128；当前不是有效 Git 仓库 | 沿用既有环境限制，未初始化或提交 |

`npm test` 实际脚本为 `node --import tsx --test --test-isolation=none test/*.test.ts`。未修改旧测试，110 = 原有 71 + 新增 T5 39；本轮无失败测试。编译产物脚本直接导入 `dist/orders/`，替换 fetch 为计数并抛错的本地桩；没有真实域名或传输实现。

## 验证方法与覆盖

| 场景 | 验证方式 |
| --- | --- |
| 多店隔离 | 两个占位店铺复用订单/包裹标识，分别同步并查询订单、明细、包裹及轨迹，状态与数据互不串店 |
| 归属一致 | 拒绝跨店业务行、悬空订单/包裹引用、重复身份；详情仅返回本订单的明细及包裹 |
| 金额与数量 | 保留高精度十进制文本；拒绝浮点输入、负数、指数、空白和畸形文本；数量要求正安全整数 |
| 待发货边界 | 2 小时阈值的前 1 毫秒、刚到、后 1 毫秒；验证使用 order_time，仅 pending_shipment 命中 |
| 默认阈值 | 48/72 小时精确边界和后 1 毫秒；告警标明阈值与检测时刻 |
| 物流停滞 | 无序轨迹取最新；不同包裹分别判断；无轨迹回退 shipped_at；未知时间不编造告警 |
| 状态与未来时间 | 已送达、取消、未发货包裹不报物流停滞；未来订单/轨迹时间不产生假阳性 |
| 配置校验及纯函数 | 非法时钟与小时阈值拒绝；纯函数不修改快照及配置；重复调用结果一致 |
| 跨店汇总 | 强制显式店铺集合；去重、空集合、逐行店铺标注；失败不返回部分结果；调用方等待期间篡改集合或阈值无效 |
| 同步空值 | 四个资源状态补空；未知资源 null 状态保留；非法错误、游标结构、时间和重复状态拒绝 |
| 同步成败 | 成功原子替换、记录成功时间、保留游标、清空错误；失败保留旧数据、成功时间与游标，只存 SYNC_FAILED；首次失败无虚构业务行 |
| 仓库替换边界 | 故意绕过内存校验的替代仓库仍在每个查询边界校验；拒绝错店、悬空关系和非法元数据 |
| 敏感信息 | 向每层注入占位姓名、电话、地址、物流单号及凭证额外字段，验证存储、模拟源、同步结果、查询与告警中均无字段及值；主字段只接受占位格式 |
| 告警最小字段 | 比较告警字段完整白名单，无买家、物流文本、金额和数量 |
| 数据复制及原子性 | 调用者修改种子、源、仓库、查询、同步结果不影响存储；非法替换不修改任何店铺 |
| 同步并发 | 同店同步串行、另一店可继续；前次失败释放队列，后次可恢复 |
| 模拟 Webhook 与轮询 | 故意丢发货事件，轮询修复订单、包裹与轨迹；重复/旧提示不信任业务 payload；非法提示不读源；轮询失败保留数据 |

静态扫描是补充证据，不代替行为测试。运行时未实例化 TikTok 适配层，没有网络源。额外的编译产物验证在 73 个占位小时生成店铺 A 的待发货超时和店铺 B 的物流停滞，默认阈值分别为 48 和 72；轨迹与订单发货变化通过丢事件后的轮询补齐。

## 剩余问题与未做事项

- 仍为内存模拟骨架；重启不保留数据，没有真实 PostgreSQL 表、仓库实现或实库迁移验证。
- 本地模拟 Webhook 提示与手动轮询已验证；实际 Webhook HTTP 接入、官方验签、分页/增量同步、多进程协调及官方时限规则尚未验证。
- 未开放业务 HTTP 路由、未接权限 Gateway、未做自动调度、经营分析、巡检、后台页面或真实验收；未开展 T6–T10。
- Git 目录是只读占位而非有效仓库，未提交；已有项目环境保留项不在本轮修复范围。
- 未连接真实 TikTok、未接真实同步、未使用真实凭证或业务数据、未向真实域名发请求；未安装 Docker、未采购、未部署生产，未修改 workspace 其他项目。
