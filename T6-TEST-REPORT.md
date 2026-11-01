# T6 — 执行与验证报告（2026-10-30）

模型：由总控从进程记录核对。

状态：T6 开发与本地验证通过，待总控复核验收。本报告为开发执行证据，不冒充总控验收。仅执行 T6，未执行 T7–T10。

## 文件清单

新建：

- `src/analytics/models.ts`：输入输出、逐指标元数据与显式跨店结果类型。
- `src/analytics/decimal.ts`：BigInt 对齐十进制精度合计。
- `src/analytics/service.ts`：概览、时间窗口 GMV、热销 SKU、T4 库存风险复用、显式店铺集合汇总。
- `test/analytics.test.ts`：29 项 Node 内置测试。
- `T6-README.md`、`T6-TEST-REPORT.md`：统计口径、边界、调用方法与本报告。
- `.t6-evidence/`：`baseline-sha256.json`、`baseline-test.log`、`final-test.log`、`build.log`、`typecheck.log`、`smoke.mjs`、`smoke.log`、`verify-originals.py`、`verify-originals.log`、`verify-purity.py`、`verify-purity.log`、`command-results.json`。
- 构建生成 `dist/analytics/{models,decimal,service}.js` 及对应 `.js.map`，属于可重建编译产物；`npm run build` 同时正常重建已有模块产物。

已有源码、测试、配置、依赖与文档修改/删除：无。基线保存原有 69 个文件 SHA-256，包含 17 份 Markdown；完成后逐一对比确认原文未变。未覆盖、删除或追加修改既有 Markdown，T6 内容单独放在新文档中。

## 实际运行的命令与结果

工作目录均为 `/home/hatch/workspace/muse-erp`。日志通过 `tee` 保存，使用 `set -o pipefail` 保留真实退出码。独立验证并行运行，构建完成后再运行编译产物冒烟。

| 命令 | 实际结果 | 证据 |
| --- | --- | --- |
| 实现前 `npm test` | 退出 0；110 通过，0 失败，0 跳过 | `.t6-evidence/baseline-test.log` |
| 实现后 `npm test` | 退出 0；139 通过，0 失败，0 跳过；原有 110 + T6 29 | `.t6-evidence/final-test.log` |
| `npm run build` | 退出 0；TypeScript 构建通过 | `.t6-evidence/build.log` |
| 下方独立严格类型检查 | 退出 0；无类型错误 | `.t6-evidence/typecheck.log`（正常为空） |
| `node .t6-evidence/smoke.mjs` | 退出 0；编译产物双店指标断言 PASS，输出完整模拟结果 | `.t6-evidence/smoke.log` |
| `python3 .t6-evidence/verify-originals.py` | 退出 0；69 份原有文件、其中 17 份 Markdown 全部未变 | `.t6-evidence/verify-originals.log` |
| `python3 .t6-evidence/verify-purity.py` | 退出 0；递归检查 7 个编译后运行时模块，只引用本地纯计算/校验模块 | `.t6-evidence/verify-purity.log` |

独立类型检查实际命令：

```sh
./node_modules/.bin/tsc --noEmit --target ES2024 --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --esModuleInterop --skipLibCheck test/analytics.test.ts
```

另执行指定文档与源码的 `cat`/`sed` 阅读、`rg` 搜索、基线 SHA-256 生成及文件清单核对；`git status --short` 返回 128，确认当前目录无有效 Git 仓库，未产生提交。未运行联网安装或真实 API 请求。命令退出状态汇总在 `.t6-evidence/command-results.json`。

## 验证方法与可复算证据

1. 多店隔离：使用两个占位店铺、相同订单/SKU 标识，不同金额/数量/状态/库存；显式选店、重复店铺去重、逐行 shop_id、缺失/重复快照与跨店嵌套记录均有断言，不返回隐式全店或部分结果。
2. 窗口：`[1000, 2000)`，999 排除、1000 计入、1999 计入、2000 与 2001 排除；相邻窗口不重复计算共享边界。概览、GMV、热销共享订单窗口，以 `order_time` 判定。
3. 金额：占位金额 `0.10 + 0.20 = "0.30"`；`9007199254740993.123456789 + 0.000000011 + 2 = "9007199254740995.123456800"`；额外验证精度对齐、进位、输入倒序、无效金额拒绝与不同模拟币种分列。
4. 热销：明细单位数跨订单相加，数量降序；同数量的 `placeholder-sku-A`、`placeholder-sku-a`、`placeholder-sku-z` 按字符码升序，倒转输入仍一致；超安全整数合计显式拒绝。
5. 库存：数量 0/1/2/3、阈值 2，结果与 T4 `detectStockAlerts` 直接比较；确认零库存优先、等于阈值不告警、不同仓库不抵消、缺失库存不补零；复用默认阈值 0。
6. 空数据与元数据：有效空快照返回数值 0、金额文本 `"0"` 与空数组；每个指标和概览内 GMV 均带 simulation、窗口、shop_id、调用方计算时间。库存明确 `inventory_basis: 'snapshot'`，不伪造历史库存。
7. 安全与纯计算：各层附加占位 Token/Secret/cipher/姓名/电话/地址等字段，并断言输出无字段和值；买家标识、物流引用、游标与标题也不返回。无效标量只报固定错误；重复调用与输入、输出变异检查确认不修改输入、无共享引用污染。编译后依赖检查未引入 DB、传输或系统时钟。
8. 集成复算：在测试中实际调用 T4/T5 的 MemorySyncSource、Sync 与 MemoryRepository，取得同步快照后进行分析，两个店铺分别得订单数 2/1、GMV `"0.30"`/`"0.10"`、SKU 数量 4/2；再次读取仓库确认分析没有改写。额外编译产物冒烟给两个店铺各计算 2 单、`"0.30"`、3 件，完整元数据保存在日志。

## 剩余问题与未做事项

- 全部指标均为占位模拟数据计算；未接真实数据，未接真实 TikTok，未使用真实店铺、商品、订单、金额或真实凭证，未向真实域名发请求。
- 本模块不新增持久化、不读数据库、不宣称真实落库；持久化待 PG 就绪。内存快照完整性与同步新鲜度由调用方负责，空快照不证明真实同步成功。
- GMV 为全部订单状态的原始金额合计，包含取消/未付款，明确不是已支付 GMV 或结算；多币种无单一合计，需读取逐币种结果。当前库存快照不能回推历史窗口库存。
- 当前目录无有效 Git 仓库，未提交；已有 PG 实库迁移、真实接入等保留问题未在本轮解决。
- 未做 T7 到 T10；未新增定时巡检、持久化告警、Gateway、Web 页面或真实接入验证。未安装 Docker，未采购，未部署生产，未改动 workspace 其他目录。
