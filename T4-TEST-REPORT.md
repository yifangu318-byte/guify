# T4 执行报告（2026-10-30）

本次运行模型与推理档：当前会话未提供可核验的运行头，无法确认是否为 **gpt-6.1-sol / high**，因此本报告**不作为模型配置合规证据**。CODEX-CONFIG.md 要求该配置；未把文档中的目标配置或历史 T3 记录冒充本次运行参数。本限制已在开始执行前说明，未声称配置合规。

## 交付范围与文件清单

仅交付 T4 商品、SKU、库存、仓库只读模拟同步与缺货检测骨架。工程实现与本地验证已完成，待总控独立验收；未将模拟验证声明为真实接入或持久化成功。

新增文件：

- `src/products/models.ts`
- `src/products/repository.ts`
- `src/products/alerts.ts`
- `src/products/sync.ts`
- `src/products/service.ts`
- `test/products.test.ts`
- `T4-README.md`
- `T4-TEST-REPORT.md`
- `.t4-evidence/baseline-sha256.json`：执行前 37 份已有文件哈希。
- `.t4-evidence/baseline-test.log`：原有 45 项测试原始输出。
- `.t4-evidence/final-test.log`：最终 71 项测试原始输出。
- `.t4-evidence/build.log`：构建原始输出。
- `.t4-evidence/scenario.log`：编译后 JS 的双店同步与告警演示原始输出。
- `.t4-evidence/static-check.log`：T4 源码与测试静态扫描输出。
- `.t4-evidence/verification.log`：原文件哈希核对与新增文件清单。

已有业务源码、测试、配置、依赖、数据库 schema、迁移和全部 13 份已有 Markdown 均未修改或删除。构建生成 `dist/products/*.{js,js.map}`，并按原构建流程生成 dist 其他文件；dist 不作为源码交付。未创建有效 Git 仓库或提交。

## 实际运行与结果

运行目录 `/home/hatch/workspace/muse-erp`；`node --version` 为 v24.22.1，`npm --version` 为 10.9.4。以下均为本次实际运行，无依赖安装、无网络下载。

| 命令或本地操作 | 结果与证据 |
| --- | --- |
| `pwd`、`rg --files`、`cat` 指定文档与源文件 | 已读取用户列出的文档、app/config/logging/server/schema、tiktok、shops、已有 test 文件以及 package/tsconfig |
| `git status --short` | 退出 128，fatal: not a git repository；沿用已有 Git 缺口，改用 SHA-256 核对 |
| Python hashlib 基线脚本 | 保存 37 个原文件，其中 Markdown 13 个，见 baseline-sha256.json |
| `npm test > .t4-evidence/baseline-test.log 2>&1` | 退出 0，45 通过，0 失败，0 跳过 |
| `npm test > .t4-evidence/final-test.log 2>&1` | 退出 0，71 通过，0 失败，0 跳过，0 取消 |
| `npm run build > .t4-evidence/build.log 2>&1` | 退出 0，实际执行 tsc -p tsconfig.json，严格 TypeScript 构建通过 |
| `node --input-type=module` 本地 heredoc 脚本，输出到 scenario.log | 退出 0，从 dist/products 导入编译产物，内存双店同步与两类告警断言通过 |
| Python 正则静态扫描 T4 的 5 个源码文件与 1 个测试文件 | 退出 0，无外部 URL、fetch、node:http(s)、TikTokReadOnlyAdapter 调用或 process.env 凭证读取，见 static-check.log |
| Python hashlib 最终核对脚本 | 见 verification.log，逐一复算执行前 37 文件的 SHA-256，检查新增清单和无删除 |

测试脚本使用项目原有 Node 内置测试运行器：`node --import tsx --test --test-isolation=none test/*.test.ts`。未修改 package.json 或任何原测试来获得通过。

原始最终测试摘要：

```text
ℹ tests 71
ℹ suites 0
ℹ pass 71
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

## 验证方法与复现证据

原有 T1 9 项 + T2 16 项 + T3 20 项 = 45 项全部保留通过；新增 T4 26 项，合计 71 项。校验覆盖：

1. 两店相同商品/SKU/仓库外部标识仍隔离，模拟同步后列表、详情、SKU、库存、仓库逐店可读。
2. 商品与 SKU 归属、库存 SKU/仓库引用在同店存在；重复标识和跨店混入拒绝。替换失败不部分覆盖原数据。
3. 库存拒绝负数、小数、NaN、Infinity、非安全整数、字符串、null；阈值亦须非负安全整数。
4. 阈值 2 时，数量 0 为 out_of_stock，1 为 low_stock，2 和 3 无告警；默认阈值 0 仅报零库存，缺少库存行不捏造缺货。
5. 显式跨店汇总去重并标注每层 shop_id；空集合返回空；查询期间修改调用方数组不能扩大范围，失败不暴露部分汇总。
6. 未同步元数据 null、未知 resource null、同步成功时间和游标、失败保留成功时间和游标、固定 SYNC_FAILED、失败后恢复；仓库或源异常不外泄。
7. 仓库类型独立于国家；同 SKU 按仓分别判定，不跨仓合并抵消缺货。
8. 模拟种子、仓库读写、源、查询和同步结果防御拷贝；替换仓库返回的数据也重新验证并白名单投影；额外 access_token、refresh_token、app_secret、shop_cipher 属性被丢弃。告警字段精确限定六项，不含标题、价格或凭证。
9. 同店同步串行，另一店独立完成；无效时钟和非 simulation 来源拒绝。

编译产物演示（scenario.log）的实际输出中，阈值为占位值 2：

| 店铺（均为占位 ID） | SKU | 仓库 | 数量（测试值） | 类型 |
| --- | --- | --- | --- | --- |
| placeholder-shop-a | placeholder-sku | placeholder-warehouse | 0 | out_of_stock |
| placeholder-shop-b | placeholder-sku | placeholder-warehouse | 1 | low_stock |

演示的 ProductSnapshot.source 明确为 simulation，时钟为注入的 1000；无真实商品、店铺、价格、库存或时间来源。构建产物也经过本地运行断言，不仅依赖 TypeScript 类型检查。

## 剩余问题与未做事项

- 模型与推理档未获得本次运行头的独立核验；不能宣称已满足 gpt-6.1-sol / high 配置验收。
- 仍是内存/模拟骨架，进程退出数据丢失，真实 PostgreSQL 持久化待 PG 就绪后接入；没有数据库迁移或实库验证。
- 实际 schema 只有 shops，Product 按 PROJECT.md 字段口径实现，没有声称复用不存在的已建 products 表。
- 同步只实现完整模拟快照；没有官方分页、增量协议、调度、分布式锁或实际授权校验。序列化限于同一 ProductSync 实例，替代仓库须提供原子事务语义。
- 未注册业务 REST/MCP 路由、UI 或 Agent 权限网关。未实现 T5–T10，未改变其状态；未改写 PROGRESS.md / TEST_REPORT.md 中待总控复核的记录。
- **未接真实同步、未连接真实 TikTok、未向真实域名发送请求、未使用真实凭证、真实店铺或真实商品数据。**
- 未读真实凭证文件、未安装依赖或 Docker、未采购、未部署生产、未改 workspace 其他目录、未覆盖或删除任何已有 Markdown。
- 项目无有效 Git 仓库，未提交；源码完整性以本次保存的原文件 SHA-256 结果作证。

本文件为开发工程师本地运行报告，不替代总控独立复核，也不表示 T10 或 MVP 真实接入验收通过。
