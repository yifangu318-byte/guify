# T9 — 开发与验证报告

日期：2026-10-30。模型：由总控从进程记录核对。

范围：仅 T9 只读模拟 Web 后台。开发验证通过，待总控独立复核；不宣称真实接入或完整 MVP 验收通过。

## 文件清单

修改的原文件仅 `src/app.ts`：注册 Web 路由；新增可选第四参数用于隔离模拟测试；在原有 Gateway 审计旁增加有界内存摘要。T8 的 REST、MCP 模块入口、默认拒绝授权和原有审计继续保留。

新增源码与测试：

- `src/web/simulation.ts`：两家明确模拟店铺的独立种子，复用现有内存仓库。
- `src/web/service.ts`：T3–T7 查询组合、模拟来源和店铺范围校验、日志摘要缓存。
- `src/web/html.ts`：轻量服务端 HTML、固定列表、转义与响应式 CSS。
- `src/web/routes.ts`：8 个模块、订单详情与概览别名的 GET 路由、查询校验与固定错误信封。
- `test/web.test.ts`：74 项 Node 内置测试，使用 Fastify inject，无网络监听。
- `T9-README.md`、`T9-TEST-REPORT.md`：本轮新增说明与报告，无已有 Markdown 覆盖或删除。
- `.t9-evidence/`：基线摘要、测试 / 构建日志、严格类型检查日志、编译产物冒烟脚本及日志、文件核对脚本及日志、10 份页面 HTML、路由清单、过程失败记录。

`npm run build` 自动生成 `dist/web/{simulation,service,html,routes}.{js,js.map}`，并更新 `dist/app.{js,js.map}`。没有新增包或更改依赖清单、锁文件、数据库 schema。未修改其他 workspace 目录。

## 实际命令与结果

以下命令均从项目根目录运行。测试 / 构建最终日志由 Bash 内置 `time` 记录耗时；未安装额外工具。

| 命令 | 结果 | 证据 |
| --- | --- | --- |
| 修改前 `npm test` | 退出 0；246 通过，0 失败，0 跳过 | `.t9-evidence/baseline-test.log` |
| `node --import tsx --test --test-isolation=none test/web.test.ts` | 首次 63 通过、10 失败；修正测试正则后 73 通过、0 失败；随后新增第 74 项兼容性测试，纳入最终全量测试 | `.t9-evidence/web-test-first.log`、`web-test.log` |
| 最终 `npm test` | 退出 0；320 通过，0 失败，0 取消，0 跳过；Node 测试耗时约 2492ms，命令约 2.919s | `.t9-evidence/test.log` |
| 最终 `npm run build` | 退出 0；TypeScript 编译通过，约 4.490s | `.t9-evidence/build.log` |
| 新增测试严格类型检查，完整命令见下文 | 退出 0；无诊断 | `.t9-evidence/test-typecheck.log` |
| `node .t9-evidence/smoke.mjs` | 退出 0；编译后的 10 个页面全部 200 / simulation，40 个写方法请求全部 404；GMV 37.50 TST、未选店提示、Gateway 401、health 200 断言通过 | `.t9-evidence/smoke.log`、`routes.txt`、各页面 HTML |
| `node .t9-evidence/verify-files.mjs` | 退出 0；124 份原文件仅 app.ts 改动，0 删除；23 份原 Markdown、8 份原测试摘要全部一致 | `.t9-evidence/integrity.log`、`baseline-sha256.json` |

```sh
./node_modules/.bin/tsc --noEmit --target ES2024 --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --esModuleInterop --skipLibCheck test/web.test.ts
```

最终测试数：原有 **246** 项 + 新增 T9 **74** 项 = **320 通过 / 0 失败**。基线的原有测试文件全部未改动。

## 验证方法

1. 每条页面路由都验证 HTML 200、simulation 来源、显式店铺、查询时间、窗口与含起点不含终点说明；未选店时使用会失败的仓库桩，证实没有无范围读取。
2. 每条页面路由验证未选窗口提示、未知店铺固定 404 信封；POST / PUT / PATCH / DELETE 全部 404，并对读取前后模拟业务快照进行比较。
3. 重用订单、SKU 标识的双店测试验证隔离；窗口边界验证 999 被排除、1000 被包含、1999 被包含、2000 被排除；窗口外订单详情 404。未付款 0.10 + 已取消 0.20 = 0.30，GMV 保留“全部状态原始合计、非实收”说明；混币分列。
4. 在替换仓库中注入敏感额外字段，检查页面与日志不含字段名、原值或 HTML 转义值；买家、物流引用、游标和 shopCode 同时排除。另测试动态文本 HTML 转义、CSP、no-store、no-referrer。
5. 重复、额外、多店、缺一端窗口、非法时间输入均固定 400。无效授权业务页 403，连接页可查看有效过期状态而不读业务快照；异常、错店、live 来源和非法时钟均固定 500，不回显异常。
6. 完整空快照显示空态，缺失快照返回错误；更新测试仓库后页面即时展示新库存及 T7 低库存证据，证明未另建静态业务结果缓存。
7. 真实调用本进程的模拟 Gateway 后，日志页只展示本店和所选记录时间窗口内的摘要；验证 100 条上限、输出副本、无原始参数，以及 Web 时钟错误不抑制 T8 原有审计回调。默认任务与日志空态如实显示未接通。
8. 无业务写操作 UI，唯一表单为 GET 查询；所有链接为本地相对地址并保留范围。自动检查 viewport、600px 媒体查询、导航换行、局部表格滚动。环境没有 Chromium / Chrome，**手机浏览器视觉与触摸操作尚未实测**，未将 CSS 静态断言写成浏览器验收通过。
9. 冒烟脚本直接导入 `dist/app.js`，使用 Fastify inject，不监听端口、不发真实域名请求；禁用 fetch，输出页面 HTML 供总控审阅。

## 过程失败与处理

- T9 首轮 10 个断言失败来自过宽的事件属性检测正则 `on\w+=`，误匹配合法 `content=`。改为带空白属性边界的 `\son[a-z]+\s*=` 后通过，保留首次日志；没有削弱字段转义或 CSP 检查。
- 首次原文件摘要脚本以空字符串为目录，产生 ENOENT；在任何源码修改前改为 `.`，成功记录 124 份原文件。最终摘要校验通过。
- 尝试 `/usr/bin/time -v` 返回 127，环境无该工具；改用 Bash 内置 time 实际重跑最终测试和构建。未安装工具，也未声称测得进程峰值内存。失败记录在 `.t9-evidence/time-unavailable.log`。
- `git status --short` 证实当前不是有效 Git 仓库；未创建仓库或提交，沿用既有保留项。文件差异以修改前 SHA-256 清单核对。

上述过程失败均与最终业务测试失败数区分；最终测试失败数为 0。

## 剩余问题与未做事项

仍是模拟骨架，未接真实数据；持久化待 PG 就绪。Agent 任务存储、调度 / 通知、MCP 传输未接通，T8 的既有验收保留项未改写为通过。手机浏览器实测待总控；没有生产 Web 登录 / 权限体系，不用于真实店铺数据展示。

未连接真实 TikTok、未使用任何真实凭证、未向真实域名发请求；未做业务写操作或注册业务写路由；未装 Docker、未采购、未部署生产；**未做 T10**。未覆盖或删除任何原有 Markdown，未修改其他 workspace 目录。当前结果仅为 T9 开发交付与本地自动验证证据。
