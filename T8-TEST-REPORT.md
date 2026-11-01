# T8 — Codex 开发交付与测试证据

- 日期：2026-10-30。
- 模型：由总控从进程记录核对。
- 执行范围：仅 T8；供总控复核，不替代总控验收。原 `PROGRESS.md`、`TEST_REPORT.md` 等已有 Markdown 均未修改。

## 文件清单

修改的已有源文件只有 `src/app.ts`：注册 Gateway GET 路由、将同一 Gateway 提供给模块入口、接入既有脱敏日志；原 `buildApp(config, destination?)` 调用方式兼容。

新增文件：

- `src/gateway/contracts.ts`：七种工具输入/输出、元数据、Agent 授权和证据结构。
- `src/gateway/registry.ts`：七个不可修改的只读定义、输入 JSON Schema 与共用验证器。
- `src/gateway/errors.ts`：T1 固定错误信封与服务错误映射。
- `src/gateway/service.ts`：组合 T3–T7 只读服务和履约证据归因。
- `src/gateway/gateway.ts`：同源调用入口、Agent 摘要认证、白名单/工具权限、脱敏审计。
- `src/gateway/rest.ts`：七个 GET 路由映射，无写方法业务路由。
- `src/gateway/mcp.ts`：工具注册表及模块调用函数，明确无 MCP 传输层。
- `src/gateway/index.ts`：注入现有仓库的组合入口，默认空数据、空授权。
- `test/gateway.test.ts`：新增 74 项 Node 内置测试与 Fastify inject 验证。
- `T8-README.md`、`T8-TEST-REPORT.md`：新增说明和本报告。
- `.t8-evidence/baseline-sha256.json`、`baseline-test.log`、`gateway-test.log`、`npm-test.log`、`build.log`、`typecheck.log`、`mcp-sdk-check.log`、`smoke.mjs`、`smoke-output.json`、`check-integrity.py`、`integrity-check.log`、`routes.log`：可复跑脚本、基线摘要与运行证据。

`npm run build` 另生成 `dist/gateway/` 对应 8 个 `.js` 和 8 个 `.js.map`，更新 `dist/app.js` / `dist/app.js.map`；这些是构建产物，不是额外业务实现。没有修改其他既有源码、既有测试、数据库 schema、配置或依赖清单。

## 实际运行的验证命令与结果

所有命令均在 `/home/hatch/workspace/muse-erp` 执行。网络请求为零；接口验证全部走 Fastify inject，不启动监听。

| 实际命令 | 结果 | 证据 |
| --- | --- | --- |
| `npm test`（修改前） | 退出码 0；172 通过、0 失败、0 跳过 | `.t8-evidence/baseline-test.log` |
| `node --import tsx --test --test-isolation=none test/gateway.test.ts` | 退出码 0；74 通过、0 失败、0 跳过 | `.t8-evidence/gateway-test.log` |
| `npm test`（最终完整回归） | 退出码 0；246 通过、0 失败、0 跳过（原有 172 + T8 74）；最终记录耗时约 5.57 秒 | `.t8-evidence/npm-test.log` |
| `npm run build` | 退出码 0；TypeScript 构建通过 | `.t8-evidence/build.log` |
| `./node_modules/.bin/tsc --noEmit --target ES2024 --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --esModuleInterop --skipLibCheck test/gateway.test.ts` | 最终退出码 0；新增测试严格类型检查通过，无诊断 | `.t8-evidence/typecheck.log`（成功为空） |
| `node .t8-evidence/smoke.mjs` | 退出码 0；编译产物冒烟 PASS | `.t8-evidence/smoke-output.json` |
| `python3 .t8-evidence/check-integrity.py` | 退出码 0；55 份原有文件对照，唯一变化 `src/app.ts`；21 份原有 Markdown 与 7 份原有测试摘要全部相同，无删除 | `.t8-evidence/integrity-check.log` |
| `node --input-type=module` 本地 SDK 检查脚本 | 两个 SDK 导入路径均 `ERR_MODULE_NOT_FOUND`，4 个常见全局位置 `ABSENT`；未安装任何包 | `.t8-evidence/mcp-sdk-check.log` |
| `node --input-type=module` 加载编译后 app 并 `app.printRoutes({commonPrefix:false})` | 仅健康路由与七个 Gateway GET 业务路由，没有业务写方法 | `.t8-evidence/routes.log` |

开发中曾在新增测试的故意非法工具权限样本上遇到严格类型检查 TS2352；将该负向测试的显式断言改为经 `unknown` 转换后，上表最终类型检查退出码为 0。没有修改既有测试来规避检查。

最终完整测试摘要原文：

```text
tests 246
suites 0
pass 246
fail 0
cancelled 0
skipped 0
todo 0
```

编译产物冒烟关键输出：`result: PASS`、`rest_status: 200`、`module_result_identical: true`、`alerts_status: 200`、`write_status: 404`、`mcp_transport: not_connected`。响应示例为带 `source: simulation`、占位店铺集合和固定查询时间的空订单列表。

## 验证方法与覆盖

七个工具各自覆盖正常返回、REST/模块逐字段一致、未知店铺、必填参数缺失、两店共用外部实体 ID 的隔离、Agent 店铺白名单拒绝、T3 未授权拒绝、工具权限/Agent 认证，以及 POST/PUT/PATCH/DELETE 无业务执行/无状态变化，共 56 项。

另 18 项覆盖：与 T3–T6 查询/计算结果复核；与实际 T7 运行结果复核；待发货超时/物流停滞/相关 SKU 库存证据；无相关证据不编造原因；T7 授权异常归因和对外权限门；授权有效期边界；输出与日志的敏感字段投影；额外参数、范围覆盖、数值校验与拒绝隐式多店；未知订单；异常/混店/非模拟快照固定错误；缺失快照与明确空快照区别；共享仓库更新即时可见；调用中参数/授权集合修改不能扩大范围；默认拒绝与 `/mcp` 不存在；未知工具/非法时钟的脱敏审计；非法本地授权配置；注册表闭合且不可修改。

敏感字段测试直接注入未经内存仓库预过滤的替换仓库：覆盖 Token、Secret、shop_cipher、姓名/电话/地址/物流单号等额外属性，及已有买家/物流引用、游标；检查七个工具的 REST 响应、模块结果和 14 条审计日志均不含这些字段或占位敏感值。失败测试检查固定信封，不回显输入或原始异常。写方法测试比较业务快照与授权状态，并断言未执行 Gateway 工具。

所有测试数据为字面占位符和 `TST` 模拟币种。原有 172 项用例和相关文件未改动；完整回归包含它们。

## 状态、剩余问题与明确未做项

- REST：已注册、以 inject 和编译产物冒烟验证；没有验证网络监听或远程调用。
- MCP：只有模块注册表/同源函数，**传输层未接通**。缺少本机可用官方 SDK；未安装依赖，没有 MCP 客户端握手/发现/调用证据。T10 前须准备官方 SDK、接入选定传输、统一可信身份与权限/审计，并用至少一个实际 AI 客户端完成协议验证，详见 `T8-README.md`。MCP 客户端验收项仍待验证。
- 仍是内存模拟骨架，无新持久化；持久化及持久审计待 PG 就绪。T7 调度/通知仍未接入；跨仓库读事务一致性未实现；默认服务器无 Agent/店铺种子，需要本地组合时显式注入授权和现有快照仓库。
- 未授权店铺一律先拒绝读取；授权异常归因仅在内部证据映射测试中验证，不能借诊断工具读取未授权店铺。未建立历史巡检结果存储。
- 当前没有有效 Git 仓库，未创建提交。原有 PG/签名草案等保留问题仍在，本轮不宣称解决。
- 未接真实数据、未连接真实 TikTok、未使用真实凭证、未向真实域名发请求；未执行 Gateway 业务写操作；未做 T9–T10、未开发 Web 页面/真实接入、未安装 Docker、未采购、未部署生产；没有改动 workspace 其他目录。

## 总控复核

待总控独立检查代码、复跑上述命令及核对进程记录后填写。本报告不宣称总控已验收或实际 MCP 客户端已接通。
