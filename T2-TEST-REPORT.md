# T2 Codex 运行报告 — 2026-10-30

仅开发者运行证据，待总控独立复核。原有 TEST_REPORT.md、PROGRESS.md 等 Markdown 未改写。

## 代码文件清单

新增 src/tiktok/signing.ts、tokens.ts、client.ts、coverage.ts；新增 test/tiktok.test.ts；新增 T2-README.md、本报告。
未修改任何既有源码、测试、配置、依赖清单或 Markdown。构建更新 dist，并生成 dist/tiktok/{client,coverage,signing,tokens}.js 及对应 .js.map。

## 实际执行与结果

| 命令/检查 | 结果 |
| --- | --- |
| 实现前 npm test | 退出 0；9 通过，0 失败 |
| 首次 npm run build | 退出 0 |
| 实现后 npm test | 退出 0；25 通过，0 失败，0 跳过，0 待办；含 T1 原有 9 项及 T2 新增 16 项 |
| 实现后 npm run build | 退出 0；TypeScript 严格构建成功 |
| node --import tsx --test --test-isolation=none test/tiktok.test.ts | 退出 0；16 通过，0 失败 |
| 首次临时 Node 子进程启动冒烟脚本 | 退出 13；子进程退出等待处理存在问题，未形成启动证据 |
| 修正退出等待的 Node 冒烟脚本（PORT=0） | 退出 1；服务提前退出，未取得 HTTP 结果 |
| PORT=0 npm start | 退出 1；固定日志 Service startup failed; check configuration and port availability |
| Node net.createServer().listen(0, '127.0.0.1') 诊断 | 捕获 code=EPERM、syscall=listen，确认当前沙箱禁止监听；脚本捕获错误后退出 0 |

另一次未加 --test-isolation=none 的单文件运行仅报告文件级 1 通过，因此细粒度场景数以上表带该参数的运行与 npm test 为准。
测试失败数为 0；真实监听启动验证失败，不能记成已通过。没有为启动限制修改 T1。T1 的 health 和 404 已通过 Fastify inject 验证，未证明当前沙箱允许端口监听。

## 隔离场景

签名确定性/排序/本地 HMAC 向量、篡改检测、到期前刷新、401 刷新与重试、重复 401 停止、两层刷新失败、429 指数上限及 jitter、429 重试预算、必需 shop_id/禁止覆盖、跨店 Token 隔离与复制、恶意存储与跨店刷新拒绝、并发按店限流、复用 T1 脱敏日志、异常错误信封、覆盖登记完整性、配置边界与无效刷新结果。

所有测试传输、Token 刷新、时钟、等待、随机数均为注入模拟，所有凭证字符串均为占位符。无真实 TikTok 请求。

## 验证方法与保留项

安装运行步骤见 T2-README.md。可在允许本地监听的环境运行 npm start 并 curl /health；当前沙箱只能将完整测试与构建记为通过。

T2 仍为只读草案骨架，签名未获官方验证，须在 T10 以 Partner Center 官方文档和真实店铺样本复核。真实加密 Token 存储、官方传输实现、超时取消和分布式限流均未实现。覆盖表仅 draft / not_implemented。T1 的实库迁移、Git 提交保留问题未解决。

未接真实 TikTok，未用真实凭证，未做 T3–T10，未装 Docker，未采购，未部署生产，未修改其他 workspace 目录。
