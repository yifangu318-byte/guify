# MUSE ERP 技术缺口补齐记录（2026-10-30）

模型：由总控从进程记录核对。

本轮仅执行 T10 前的 MCP 传输、本机 PostgreSQL、Git 初始化。以下是开发执行证据，仍待总控复核，不代表 T10 或完整 MVP 验收通过。原有 25 份 Markdown 和 9 份测试文件均保持原文。

| 项目 | 本轮真实状态 | 验证范围 |
| --- | --- | --- |
| MCP | 已接通 stdio | 官方 SDK 客户端真实子进程握手、7 个模拟只读工具调用、REST 结果比对、权限与审计 |
| PostgreSQL | 已安装、启动，实库迁移与空库重建验证通过 | PostgreSQL 16.15；仅 `shops` 业务表及 Drizzle 迁移账本 |
| Git | 已初始化本地仓库 | `main`；无提交、无暂存、无远程 |
| 真实接入与 T10 | 未做 | 未接真实店铺、未做真实记录抽查、未生成真实日报 |

所有命令在 `/home/hatch/workspace/muse-erp` 下执行。npm/apt 仅用于本次要求的软件包查询和安装；没有向 TikTok 或其他真实业务域名发请求，没有使用真实凭证。系统变动限于明确要求的 PostgreSQL 安装、服务和本地数据库；没有修改 workspace 其他项目目录。

## 1. MCP 传输

实际包查询及安装命令（输出重定向至对应证据文件）：

```bash
npm view @modelcontextprotocol/sdk name version repository.url dist-tags --json --fetch-retries=0 --fetch-timeout=20000
npm view @modelcontextprotocol/sdk name version repository.url dist-tags --json --cache .technical-gap-evidence/npm-cache --fetch-retries=0 --fetch-timeout=20000
npm install --save-prod --save-exact @modelcontextprotocol/sdk@1.32.2 --cache .technical-gap-evidence/npm-cache --ignore-scripts --no-audit --no-fund
npm run build
npm run mcp:smoke
```

- 第一次查询在沙箱内因 `EPERM` 失败；宿主重试退出 0，返回包名 `@modelcontextprotocol/sdk`、版本及 latest 标签 `1.32.2`，仓库地址 `git+https://github.com/modelcontextprotocol/typescript-sdk.git`。安装退出 0，新增 89 个包，SDK 固定为生产依赖。
- 包内官方 README 说明该包是仍受维护的 v1 系列，覆盖 MCP 2025-11-25；v2 已拆为 server/client 包。本轮选用实测的官方 v1 包，没有把它称为 v2 或最新协议实现，没有请求 GitHub/文档网站。
- `src/gateway/mcp-transport.ts` 使用 SDK `Server`、`ListToolsRequestSchema`、`CallToolRequestSchema`，原样复用 T8 JSON Schema。采用低层 Server 是为保留原有封闭输入校验；工具调用均进入传入的同一 `gateway.invoke`。
- `src/gateway/mcp.ts` 增加显式 stdio 连接、关闭及状态管理。连接失败保持 `not_connected`；默认 REST/Web 进程不自动接 stdio，因此仍报 `not_connected`。仅显式启动的 stdio 进程报告已连接，不改变默认 Web 的历史状态说明。
- `src/mcp-stdio.ts` 从 `buildApp` 获取同一 Gateway 门面，REST 注册和 MCP 使用同一个 Gateway 对象；不启动 HTTP 监听。日志走 stderr，stdout 仅承载 SDK 协议。身份由可信本地启动端绑定，工具参数和客户端 metadata 均不能替换身份。
- 默认启动不授予任何调用权限。`--simulation` 显式启用隔离演示，只授权 `simulation-shop-a` 的 7 个只读工具；使用代码内明确标注的模拟占位值，不读取 `.env` 或真实授权配置。

实际客户端为 SDK `Client` + `StdioClientTransport`。`scripts/mcp-smoke.mjs` 启动 `node dist/mcp-stdio.js --simulation`，记录实际发送的 JSON-RPC 请求，完成 initialize、tools/list、全部 7 次只读调用，与 REST 结果逐个严格相等，并验证另一模拟店铺返回拒绝和审计 403。输出示例：

```text
phase=initialized server.name=muse-erp capabilities.tools={}
tool=get_products isError=false source=simulation shop_id=simulation-shop-a
product_id=simulation-product sku_id=simulation-sku price=12.50 currency=TST
PASS: actual SDK stdio initialize, tools/list, seven read calls, REST equality, shop denial and shared Gateway audit
```

以上为实际输出摘录的字段摘要，完整原始 JSON 在日志中。额外的同进程 SDK 测试将协议客户端和 REST 直接连到同一 `app.gateway`，覆盖全部 7 个工具及同一审计入口。

沙箱内实际子进程最初返回 `Connection closed`，该轮为 331 通过、2 失败；连最小子进程输出也受沙箱限制。使用获准宿主执行后，实际 stdio 调用及完整测试均通过，没有跳过或删除失败场景。

证据：[npm 查询成功](.technical-gap-evidence/npm-view-mcp-retry.log)、[首次查询失败](.technical-gap-evidence/npm-view-mcp.log)、[安装](.technical-gap-evidence/npm-install-mcp.log)、[stdio 完整调用与审计](.technical-gap-evidence/mcp-stdio-smoke.log)、[最初沙箱测试](.technical-gap-evidence/mcp-test.log)、[宿主复验](.technical-gap-evidence/mcp-test-host.log)。

## 2. PostgreSQL 实库

先执行 `id`、`cat /etc/os-release`、`command -v` 和 `dpkg-query`：本机为 root、Ubuntu 24.04.5；psql、postgres、pg_ctl、pg_ctlcluster、pg_lsclusters 均未安装。

实际安装及启动命令：

```bash
apt-get update
apt-get -o Acquire::Retries=0 -o Acquire::http::Timeout=8 -o Acquire::https::Timeout=8 update
DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l apt-get -o Acquire::Retries=0 -o Acquire::http::Timeout=8 -o Acquire::https::Timeout=8 install -y --no-install-recommends postgresql postgresql-client
service postgresql start
pg_lsclusters
runuser -u postgres -- psql -X -d postgres -c "SELECT type, database, user_name, auth_method FROM pg_hba_file_rules WHERE type='local';"
```

- 沙箱内 apt 更新因只读系统目录及 `setgroups` 权限限制退出 100。宿主第一次更新遭预设备用镜像长时间重试，本次启动的 apt 进程被 `kill -TERM 7250` 停止，退出 143；随后加短超时重试退出 0，但仍有备用镜像失败告警，Ubuntu 主源可用。未修改系统软件源。
- 安装退出 0：10 个新软件包，0 升级、0 删除；安装 PostgreSQL `16.15-0ubuntu0.24.04.1`。安装时环境 `policy-rc.d` 阻止自动启动，随后实际执行 `service postgresql start` 成功。
- `pg_lsclusters` 显示 `16 main 5432 online postgres`；local all/postgres、local all/all、local replication/all 三类认证均为 `peer`。未启用全网 trust，未设置数据库密码。

驱动查询与安装：

```bash
npm view pg name version --json --cache .technical-gap-evidence/npm-cache --fetch-retries=0 --fetch-timeout=20000
npm install --save-prod --save-exact pg@8.23.1 --cache .technical-gap-evidence/npm-cache --ignore-scripts --no-audit --no-fund
```

查询实返 `pg` / `8.23.1`，安装退出 0，新增 13 个包，作为生产迁移驱动。

首次尝试 `runuser -u postgres -g nogroup -- bash scripts/db-verify-local.sh` 因项目目录读取权限被拒绝而退出 126，迁移未运行。即使临时组匹配仍无法读取受保护目录。保持项目及父目录权限不变，改用本机 root OS 用户与同名 PostgreSQL peer 角色：

```bash
runuser -u postgres -- createuser --login --no-superuser --no-createdb --no-createrole --no-replication root
runuser -u postgres -- psql -X -d postgres -c "SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname='root';"
bash scripts/db-verify-local.sh
```

创建与验证退出 0；root 数据库角色可登录，但 `rolsuper/rolcreatedb/rolcreaterole` 均为 false，无密码。postgres 管理员只为本次验证创建专用库并授予该角色库所有权。

迁移使用已有 `drizzle-orm/node-postgres/migrator` 的 `migrate()`，读取原有 `drizzle/0000_great_skrulls.sql`，不使用手写替代 SQL。脚本固定 `/var/run/postgresql` 本地 socket、5432、当前 OS 用户 peer；不加载 DATABASE_URL、`.env` 或密码。数据库名只通过临时 `PGDATABASE` 传入，`.env.example` 仍为原有占位符，未生成真实连接串文件。

`scripts/db-verify-local.sh` 实际执行并断言：

1. 拒绝接管已有同名库；本次检查确认 `muse_erp_technical_gap` 不存在后才创建。
2. 空库 public 表数为 0，执行迁移；重复执行迁移仍成功，迁移账本仅 1 条。
3. public 只有 `shops`；插入 1 条 `SIM`/placeholder 哨兵记录，实查行数为 1。
4. 删除且重新创建本次专用模拟库，数据库 OID `16385 -> 16407`；重新确认 public 表数为 0。
5. 再次运行 Drizzle 迁移成功，`shops` 为 0 行，迁移账本为 1 条。

```text
table_schema | table_name
drizzle      | __drizzle_migrations
public       | shops
shops_after_rebuild = 0
PASS: empty database, idempotent migration, sentinel insert, drop/recreate, empty database migration; OID 16385 -> 16407
```

连接查询的 `inet_server_addr()` 为 NULL，与 Unix socket 连接一致。日志中的 `/dev/null is not a plain file` 是将 PGPASSFILE 指向 `/dev/null` 以禁用密码文件读取产生的告警，不影响 peer 认证或断言，脚本退出 0。

**仅 shops 已迁移。** products、skus、warehouses、inventory、orders、packages、alerts 等表尚无迁移；T3–T9 仓储仍为内存实现，未改成实库持久化。pg-boss 调度及 alerts 落库未补做。默认应用健康检查仍如实报告数据库未配置/未验证，不能据本次迁移推断整个应用已持久化。

证据：[安装前检查](.technical-gap-evidence/postgres-precheck.log)、[沙箱 apt 失败](.technical-gap-evidence/apt-update-sandbox.log)、[首轮宿主更新](.technical-gap-evidence/apt-update-host.log)、[限时更新告警](.technical-gap-evidence/apt-update-bounded.log)、[安装成功](.technical-gap-evidence/apt-install-postgres.log)、[服务和 peer](.technical-gap-evidence/postgres-start.log)、[首次迁移入口失败](.technical-gap-evidence/postgres-rebuild.log)、[本地角色](.technical-gap-evidence/postgres-local-role.log)、[完整迁移与重建](.technical-gap-evidence/postgres-rebuild-host.log)、[驱动查询](.technical-gap-evidence/npm-view-pg.log)、[驱动安装](.technical-gap-evidence/npm-install-pg.log)。

## 3. Git 本地初始化

```bash
git init --initial-branch=main
git status --short --branch --untracked-files=all
git rev-parse --show-toplevel
git diff --cached --name-only
git remote -v
git rev-parse --verify HEAD
git check-ignore .env .env.local .technical-gap-evidence/npm-cache/ node_modules/ dist/
```

- 沙箱初始化因 `.git/branches/: Read-only file system` 退出 1；获准宿主执行同一初始化命令退出 0，输出 `Initialized empty Git repository in /home/hatch/workspace/muse-erp/.git/`。
- 状态为 `No commits yet on main`，项目文件均为未跟踪；仓库根目录正确，暂存列表、远程列表均为空。HEAD 查询按空仓预期失败，表示没有提交。
- 未设置作者、未创建提交、未暂存文件、未添加 remote、未 push。`.env`、`.env.local`、依赖、编译输出和 npm 缓存均忽略；新增忽略规则只有本轮 npm 缓存目录。原有 `*.log` 规则保留，运行日志保存在本地供检查。

证据：[沙箱初始化失败](.technical-gap-evidence/git-init-sandbox.log)、[宿主初始化成功](.technical-gap-evidence/git-init-host.log)、[状态及忽略检查](.technical-gap-evidence/git-status.log)。

## 测试、文件保护与复核方法

| 实际运行 | 通过 | 失败 | 跳过 | 结果 |
| --- | ---: | ---: | ---: | --- |
| 修改前 `npm test` | 320 | 0 | 0 | 基线通过 |
| 首次沙箱 `npm test` | 331 | 2 | 0 | 两项 stdio 子进程连接关闭，已保留失败证据 |
| MCP 宿主复验 `npm test` | 333 | 0 | 0 | 同样场景全部通过 |
| 最终宿主 `npm test` | 333 | 0 | 0 | 退出 0，含原有 320 项和新增 13 项 |
| 最终 `npm run build` | — | — | — | 退出 0 |
| 新增测试严格 TypeScript 检查 | — | — | — | 退出 0 |
| 脚本 `bash -n` / `node --check` | — | — | — | 退出 0 |

新增 13 项覆盖：7 个工具的 SDK/REST 同 Gateway 比对，权限和封闭输入，客户端身份注入拒绝，stdio 状态与失败处理，以及两个实际子进程场景（模拟成功、默认拒绝）。无跳过、删改原测试或降低断言。

原有 155 个文件在修改前记录 SHA-256；最终原有 25 份 Markdown、9 份测试文件全部未变，无原文件删除。原文件修改仅为 `package.json`、`package-lock.json`、`.gitignore`、`src/app.ts`、`src/gateway/mcp.ts`。迁移 SQL、schema 及历史文档均未修改。

新文件：本报告、`src/gateway/mcp-transport.ts`、`src/mcp-stdio.ts`、`test/mcp-transport.test.ts`、`scripts/mcp-smoke.mjs`、`scripts/db-migrate-local.mjs`、`scripts/db-verify-local.sh`，以及 `.technical-gap-evidence/` 下的证据。

复核可运行：

```bash
npm test
npm run build
npm run mcp:smoke
PGDATABASE=muse_erp_technical_gap npm run db:migrate:local
PGHOST=/var/run/postgresql PGUSER=root PGDATABASE=muse_erp_technical_gap psql -X -c '\dt public.*'
git status --short --branch
```

实际客户端集成应直接启动 `node dist/mcp-stdio.js --simulation`，或使用 `npm run --silent mcp:stdio -- --simulation`，避免 npm 的脚本标题污染 stdio。缺省不带 `--simulation` 时工具调用全部拒绝。该入口只用于本轮本地技术验证，未提供真实凭证接入配置。

空库完整重建由 `bash scripts/db-verify-local.sh` 负责，只应在该专用库不存在时启动；本次已保留重建后的空 `shops` 库供复核，直接再跑会拒绝覆盖已有库，这是预期保护。服务重启可执行 `service postgresql start`。本机环境更换后须重新安装 PostgreSQL、创建本地 peer 角色并重跑迁移，不能把本机数据库当作唯一备份。

最终证据：[基线测试](.technical-gap-evidence/baseline-test.log)、[最终测试](.technical-gap-evidence/final-test.log)、[最终构建](.technical-gap-evidence/final-build.log)、[严格类型检查](.technical-gap-evidence/final-typecheck.log)、[生产依赖](.technical-gap-evidence/production-dependencies.log)、[原文件保护检查](.technical-gap-evidence/preservation-check.json)。

## 剩余问题与明确未做事项

- 业务表后续迁移、真实 PostgreSQL 仓储、pg-boss 定时调度、任务及审计持久化仍待后续工作；本轮没有扩大表结构或业务功能。
- 未接真实 TikTok、未接真实授权店铺、未使用真实凭证；Partner Center 登录与授权状态未检查。
- 未做 T10 的 20 条 Seller Center 真实抽查，未生成真实数据日报；七天稳定性未跑，不宣称通过。
- 未核验 TikTok 签名草案、真实 Scope、真实订单/商品/库存字段或真实 token 刷新。
- 未采购、未部署生产、未操作真实业务数据；未做手机浏览器视觉验证。
- Git 未提交，依用户指令仅初始化并检查状态；总控复核及 MVP 最终验收尚未做。
