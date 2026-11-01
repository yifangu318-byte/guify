# MUSE ERP — T1

Node 24 + TypeScript 严格模式 + Fastify 的运行骨架。仅包含健康检查、配置、脱敏 JSON 日志和 shops 的 PostgreSQL 基线迁移。

## 安装与运行

需要 Node.js 24.x 和 npm。在项目目录执行：

```sh
npm install
npm run dev
```

默认监听 127.0.0.1:3000，GET /health 返回：

```json
{"status":"ok","service":"muse-erp","version":"0.1.0","database":{"status":"not_configured"}}
```

生产模式的本地验证（不代表生产部署）：

```sh
npm run build
npm start
```

测试使用 Node 内置测试运行器及 Fastify inject：

```sh
npm test
```

## 环境变量

| 名称 | 默认值 | 说明 |
| --- | --- | --- |
| PORT | 3000 | 监听端口，0–65535；0 由系统分配 |
| HOST | 按环境选择 | 显式 HOST 优先；HOST 未设置但 PORT 已设置时监听 0.0.0.0；两者均未设置时保持本地 127.0.0.1 |
| DATABASE_URL | 未设置 | 可选 PostgreSQL URL |
| PUBLIC_URL | 未设置 | 可选，首次部署后 Railway 生成的公网 HTTPS URL |
| TIKTOK_REDIRECT_URI | 按 PUBLIC_URL 推导 | 可选覆盖；未提供时由 PUBLIC_URL + /api/tiktok/callback 推导，无 PUBLIC_URL 则不设置 |
| TOKEN_ENCRYPTION_KEY | 未设置 | T10 预留；32 字节密钥只经 Railway 环境变量提供，绝不提交 |

.env.example 只包含占位符。服务不会自动读取 .env；请由启动环境注入变量。Node 24 也可显式加载已在本机配置的文件：

```sh
node --env-file=.env dist/server.js
```

PORT/HOST/DATABASE_URL 示例行保持注释，避免空值覆盖默认配置。不要提交真实凭证、.env 或真实业务数据。

数据库未配置时可以正常启动。配置 DATABASE_URL 后健康检查报告 configured_unverified；T1 不建立数据库连接、不执行自动迁移，因此不宣称数据库已连接。

## 数据库迁移

schema 位于 src/db/schema.ts，已生成的 SQL、快照及迁移日志位于 drizzle/。只创建 shops 表；updated_at 的后续更新需由未来的数据写入层显式维护。

```sh
npm run db:generate
```

在独立的空 PostgreSQL 开发库中，经配置 DATABASE_URL 后，可使用 psql 执行 SQL：

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f drizzle/0000_*.sql
```

此方式针对空库，一库只执行一次。重建时使用另一个空开发库；不要对现有数据库执行删除操作。

drizzle-kit 的在线迁移需要额外 PostgreSQL 驱动（pg 或 postgres）；T1 按最小依赖范围未安装驱动，当前请使用上述 psql 路径。后续经授权接入数据库时再选择驱动及自动迁移流程。本任务未安装 PostgreSQL 或 psql，未实测数据库迁移。

## 日志与错误

日志输出为 JSON；递归将键名包含 secret、token、password、key、cipher、authorization（不区分大小写）的值替换为 ***。额外屏蔽环境变量中已知敏感值、PostgreSQL URL 与常见认证文本。不会记录请求 URL、头、正文或原始异常；未知路由及异常响应使用固定错误信封，避免回显输入。业务代码仍应仅记录必要的结构化字段，不把凭证放进自由文本。

Railway 的本地部署准备与后续用户操作见 [DEPLOY.md](DEPLOY.md)。Dockerfile 使用 Node 24，railway.json 指定构建与健康检查；本次未部署、未创建云账号、未修改 Partner Center、未授权真实店铺。GET /api/tiktok/callback 仅检查 code/state 是否非空，缺失返回 400，否则返回 501 NOT_IMPLEMENTED；真实交换与加密持久化留待公网回调地址发布后的 T10。现有业务模块仍为隔离模拟与严格只读骨架。
