# T3 验证记录（2026-10-30，Codex 实际运行）

本文件为开发者运行记录，尚未经总控独立复核，不替代 TEST_REPORT.md 中的总控验收。

## 命令与结果

1. 实现前 `npm test`：退出码 0，tests 25 / pass 25 / fail 0。
2. 实现后 `npm test`：退出码 0，tests 37 / pass 37 / fail 0 / cancelled 0 / skipped 0 / todo 0，duration_ms 1063.09193。命令实际调用 `node --import tsx --test --test-isolation=none test/*.test.ts`。
3. `npm run build`：退出码 0，实际调用 `tsc -p tsconfig.json`，无编译错误。
4. `sha256sum -c /tmp/muse-t3-md-before.sha256`：核对实现前已有的根目录 Markdown 文档；结果见本次终端运行输出。

## 新增 12 项隔离测试

1. 单店授权与同步查询互不串店。
2. 无授权记录返回 unauthorized，审计通过 T1 createLogStream 输出固定字段。
3. 过期边界包含等于当前时间；撤销/未授权状态保留；查询不回写状态。
4. 空到期时间保留，待验证状态不自动提升。
5. 同步 null 字段与空记录列表保持原样。
6. 显式跨店集合、去重、每层标注 shop_id；缺失集合拒绝。
7. 未知店铺、空 shop_id 使用固定错误信封；汇总不返回部分结果。
8. 注入额外占位 Token/cipher 字段，验证仓库、返回值与日志均无这些字段和值。
9. 拒绝授权/同步跨店种子、重复店铺和原始错误正文。
10. 修改种子或仓库返回对象不会污染内存存储。
11. 替换仓库串店时拒绝；仓库异常使用安全错误信封。
12. await 期间修改调用者数组不会扩大汇总店铺范围。

测试只用 placeholder 店铺、标识及凭证；不注入真实 transport，不使用网络或 PostgreSQL。已有 T1 9 项、T2 16 项均保留且通过。

## 文件与剩余事项

新增 src/shops/models.ts、src/shops/repository.ts、src/shops/service.ts、test/shops.test.ts、T3-README.md、本文件。未修改已有源代码、测试、配置、依赖或 Markdown 文档。构建生成 dist/shops 下对应 JavaScript 与 source map。

真实授权、真实 PG 持久化、实库迁移和真实数据验证均未执行。T3 是内存骨架，待总控验收；T1/T2 既有保留项未解决。未做 T4–T10、未使用真实凭证、未向真实域名请求、未安装 Docker、未采购、未部署生产。

## 2026-10-30 本轮续跑报告

本次运行模型：**gpt-6.1-sol**；推理档：**高（high）**。以下为本轮实测记录；上文为被中断前已有记录，原文完整保留。T3 开发交付待总控独立复核，不替代总控验收。

已读取 PROJECT.md、TASKS.md、DECISIONS.md、PROGRESS.md、TEST_REPORT.md、CODEX-CONFIG.md，以及指定的 T1/T2 源码、已有 T3 模块、三份测试和两份 T3 文档。复用已有实现，只补齐资源名空值及替换仓库返回值校验。

### 实际命令与结果

运行环境：`node --version` 为 `v24.22.1`，`npm --version` 为 `10.9.4`。

| 命令 | 本轮结果 |
| --- | --- |
| 修改前 `npm test` | 退出 0；37 通过、0 失败（T1 9 + T2 16 + 已有 T3 12），duration_ms 1358.687351 |
| 修改后 `npm test` | 退出 0；45 通过、0 失败、0 取消、0 跳过、0 todo，duration_ms 984.212571 |
| `npm run build` | 退出 0；执行 `tsc -p tsconfig.json`，无编译错误 |
| `rg -n 'https?://|\bfetch\s*\(|node:(http|https|net)|TikTokReadOnlyAdapter|TokenStore' src/shops test/shops.test.ts` | 无匹配（rg 退出 1）；T3 无外部地址、网络调用或适配器/TokenStore 依赖 |
| `python3 /tmp/muse-t3-resume-verify.py` | 核对本轮修改范围、原有 Markdown 字节前缀、T1/T2 测试 SHA-256；具体结果见下方核对记录 |
| `git status --short` | 退出 128：当前目录不是有效 Git 仓库；未创建或修改 .git，未提交 |

测试实际使用 Node 内置运行器：`node --import tsx --test --test-isolation=none test/*.test.ts`。修改后完整终端输出保存于 `/tmp/muse-t3-resume-npm-test.log`；构建输出保存于 `/tmp/muse-t3-resume-build.log`。这些临时日志不是数据库持久化，也不替代总控的独立复核。

### 验证方法与覆盖

本轮保留已有 37 项测试，新增以下 8 项（合计 T3 20 项，全项目 45 项）：

1. 资源名及全部同步字段为 `null`；未授权店铺仍可返回自身状态元数据。
2. 显式传入两店集合，顺序、每层店铺标识、不同授权来源与同步状态完整对应。
3. 到期时间在当前时钟之前、相等、之后及未知时的判断；保留显式输入来源。
4. 直接替换仓库，绕过内存种子校验，注入非法授权状态/来源/时间、原始错误、含占位 Token 的对象及重复资源；三个查询均返回固定错误，日志为空。
5. 替换仓库授权行或同步行混入另一店铺，汇总拒绝返回跨店内容。
6. 替换仓库包含额外占位 Token、Secret、cipher 属性，三个查询结果及日志不泄漏字段或值。
7. 种子拒绝未知授权状态、非允许来源及非法到期时间。
8. 非法时钟返回安全错误；日志回调抛出占位敏感异常时，状态查询仍正常且不返回异常。

原有测试继续验证多店隔离、未授权审计、状态不回写、空同步列表、显式集合与防止 await 期间扩权、未知店铺、种子跨店拒绝及防御性复制。所有新增店铺/凭证仅为 `placeholder` 占位数据；不连接 PostgreSQL，不注入真实 transport，不触发网络请求。T1 的 HTTP 测试使用 Fastify inject，不监听外部服务。

### 文件清单与剩余问题

本轮无新增项目文件。修改：`src/shops/models.ts`、`src/shops/repository.ts`、`src/shops/service.ts`、`test/shops.test.ts`。仅追加：`T3-README.md`、`T3-TEST-REPORT.md`。构建更新 `dist/shops/{models,repository,service}.js` 及对应 `.js.map`，不重复创建同名源码模块。临时备份、校验脚本及运行日志均在 `/tmp/muse-t3-resume-*`。

仍为内存只读骨架，未接真实授权；真实 PostgreSQL 持久化与实库迁移待 PG 就绪，未宣称实库持久化。没有业务路由、持久审计或调用者身份权限系统；查询范围要求显式店铺集合，后续权限系统未在本轮实现。自由文本字段必须由调用方确保不含凭证。Git 仓库保留问题仍存在，未扩大到 T1/T2 修复。

明确未做：真实 TikTok 连接、真实授权、真实凭证使用、真实域名请求、T4–T10、Docker 安装、采购、生产部署。未修改总控 PROGRESS.md 或 TEST_REPORT.md 的验收结论；本轮结果待总控独立复核。

### 本轮范围核对记录

`python3 /tmp/muse-t3-resume-verify.py` 实际退出 0：所记录的源码、测试与 Markdown 共 28 个路径中，22 个未变，6 个为上述 T3 允许修改；无新增或删除路径。全部 13 份原有 Markdown 的原始字节前缀 SHA-256 一致，原文完整保留；T1/T2 两份测试文件 SHA-256 未变。输出保存在 `/tmp/muse-t3-resume-verification.log`。

测试夹具改为通过替换只读数组来构造重复资源后，最终再次执行 `npm test`：退出 0，45 通过、0 失败、0 取消、0 跳过、0 todo，duration_ms 1132.831979。`/tmp/muse-t3-resume-npm-test.log` 保存该最终运行；上表 984.212571 为此前同轮运行。源码未再变动，构建结果仍适用。范围校验再次通过。
