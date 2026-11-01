# T7 开发与验证报告（2026-10-30）

模型：由总控从进程记录核对。

本报告为 Codex 的实际执行记录，T7 只读模拟骨架已实现并通过本地检查，仍待总控验收。未修改、覆盖或删除任何已有 Markdown 文档；不改写 PROGRESS.md、TEST_REPORT.md 的既有结论。

## 文件清单

新增交付：

- `src/inspection/models.ts`：T3/T4/T5/T6 输入、三类白名单证据与结果类型。
- `src/inspection/service.ts`：纯函数 `runInspection`、既有规则调用、范围/一致性校验、证据投影及去重。
- `test/inspection.test.ts`：33 项新增隔离测试。
- `T7-README.md`、`T7-TEST-REPORT.md`：说明与本报告。
- `.t7-evidence/baseline-sha256.json`：实现前 59 份已有文件的摘要清单（含 19 份 Markdown）。
- `.t7-evidence/baseline-test.log`、`final-test.log`、`build.log`、`typecheck.log`：基线、最终全量测试、构建与严格类型检查输出。类型检查无诊断，因此 `typecheck.log` 为空；退出码实际为 0。
- `.t7-evidence/smoke.mjs`、`smoke.log`：编译产物冒烟脚本和实际输出。
- `.t7-evidence/verify.py`、`integrity-audit.log`：既有文件完整性与新增模块静态边界检查脚本和输出。

已有源码、测试、配置、迁移和 Markdown 修改/删除：0；上述 59 份既有文件 SHA-256 全部一致。`npm run build` 按既有脚本生成 `dist/inspection/models.js`、`models.js.map`、`service.js`、`service.js.map`，并重新生成既有构建产物。无依赖安装或 package 文件修改。

## 已运行命令及结果

开始先使用 `pwd`、`rg --files`、`cat`、`sed` 阅读 PROJECT.md、TASKS.md、DECISIONS.md、PROGRESS.md、TEST_REPORT.md、CODEX-CONFIG.md，以及用户指定的全部源码目录和 `test/*.test.ts`；同时读取适用的 AGENTS.md。没有访问外部站点。

| 实际命令 | 结果/证据 |
| --- | --- |
| `git status --short` | 退出 128：当前目录无有效 Git 仓库；未初始化、未提交 |
| `mkdir -p .t7-evidence`，随后用本地 `python3` + `hashlib.sha256` 记录清单 | 59 份已有文件，含 19 份 Markdown；`baseline-sha256.json` |
| `npm test > .t7-evidence/baseline-test.log 2>&1` | 退出 0；139 通过、0 失败、0 跳过 |
| `npm test > .t7-evidence/final-test.log 2>&1` | 退出 0；172 通过、0 失败、0 取消、0 跳过、0 todo |
| `npm run build > .t7-evidence/build.log 2>&1` | 退出 0；`tsc -p tsconfig.json` 通过 |
| `./node_modules/.bin/tsc --noEmit --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --target ES2024 --module NodeNext --moduleResolution NodeNext --esModuleInterop --skipLibCheck test/inspection.test.ts > .t7-evidence/typecheck.log 2>&1` | 退出 0；新增测试及其导入的源码严格类型检查通过 |
| `node .t7-evidence/smoke.mjs > .t7-evidence/smoke.log 2>&1` | 退出 0；编译产物三类异常、显式单店隔离、空集合与输入未变断言通过 |
| `python3 .t7-evidence/verify.py > .t7-evidence/integrity-audit.log 2>&1` | 退出 0；59 份既有文件摘要全同；新增源码及编译产物无检查模式中的网络/定时器/数据库/仓库/路由导入或调用 |

这些检查均已实际执行，没有仅列计划，也没有把 Git 状态命令失败算作测试通过。未执行 `npm install`、服务监听、PG 迁移或外部请求。

## 测试证据

`npm test` 使用已有 Node 内置测试运行器命令：`node --import tsx --test --test-isolation=none test/*.test.ts`。最终日志末尾：

```text
ℹ tests 172
ℹ suites 0
ℹ pass 172
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

原有 139 项 + 新增 T7 33 项 = 172 项；没有修改或跳过旧测试。

新增用例的验证方法与边界：

- 库存：调用 T4 alerts 并对照结果；覆盖零库存、严格低库存、等于/高于阈值、阈值为零的缺货例外、缺失库存行不补零。
- 超时：调用 T5 alerts，48/72 小时前 1 毫秒、恰好阈值、超过 1 毫秒均实测；核对输出的持续毫秒数与阈值，覆盖最新无序轨迹、发货时间回退、未知时间、未来时间与非适用状态。
- 授权：`expired`、`revoked`、`unauthorized` 各自触发并单列；`authorized`、`pending_verification` 不凭空触发；实际用 T3 `ShopQueries` 在到期边界解析状态后输入 T7，确认原授权存储未变。
- 显式范围：缺省/非法集合拒绝；显式空集合与空业务快照返回零；多店复用相同实体标识不混店；所选店铺缺失/有歧义时整次失败。
- 去重：重复店铺集合、多仓同 SKU 同类型合并，保留最低数量证据；不同类型、不同店铺、同订单不同包裹独立保留；原始重复主键继续按既有模型拒绝。
- 一致性：T6 库存风险必须匹配同店 T4 快照；过时/伪造风险与非 simulation 来源拒绝；T4/T5 父子引用和归属沿用现有校验。
- 隐私与纯函数：在输入各层注入合成敏感字段，结果六字段白名单断言及敏感字段/值缺席断言通过；冻结输入、重复调用和修改返回值均不影响原始快照。

编译产物冒烟实际返回 `simulation`、所选 `placeholder-shop-b`、缺货 1 条、待发货超时 1 条、授权撤销 1 条、总数 3；未包含另一店铺，前后输入深比较相同。完整 JSON 在 `smoke.log`。静态模式检查只作为源码审阅的补充，不夸大为所有潜在副作用的形式化证明。

## 剩余问题与未做事项

- 仍是骨架，输入仅模拟快照。T3 的有效状态解析与快照准备由调用方显式完成；T7 不读库、不读系统时钟、不自动刷新数据。
- 持久化待 PG 就绪；未写 alerts 表、未运行数据库迁移。原有 PG 与 Git 保留问题继续存在。
- 未启动定时器、未引入 pg-boss、未实现自动重试；错误明确抛给调用方，调度失败重试与通知机制待后续独立任务。
- 未接真实数据、未连接真实 TikTok、未用真实凭证、未向真实域名发请求、未发邮件/消息/webhook 或任何外部通知、未改任何业务数据。
- 未注册 Fastify 业务路由、未做 T8–T10、未安装 Docker、未采购、未部署生产、未改 workspace 其他目录。
- 本地验证通过不代表真实接入、生产验收、七天稳定性或总控验收已经通过。
