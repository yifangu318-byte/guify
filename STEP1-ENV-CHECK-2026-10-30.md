# MUSE ERP 第一步检查证据（2026-10-30 06:24 CST）

> 结论先说：本机可指挥 Codex，但**不存在已有的 MUSE ERP 项目**，且**无 Docker、无 PostgreSQL 客户端**。这是第二步调研和第五步确认时必须先解决的两个环境缺口，不是直接开写的理由。

## 1. 电脑环境（实测命令输出）

- OS：Ubuntu 24.04.5 LTS，内核 Linux htch-runtime 7.0.0-39-generic，x86_64
- CPU：2 核
- 内存：总量 7.7 GiB，已用 7.3 GiB，空闲仅 165 MiB，可用约 488 MiB —— 偏紧，后续同时跑 Next.js + PostgreSQL + 任务队列时要先做内存评估，不能默认“够用”
- 磁盘：/home/hatch 150G，已用 6.6G，可用 143G（5%），空间不构成瓶颈
- Node：v24.22.1，npm 10.9.4，git 2.43.0，Python 3.12.3，curl 8.5.0
- 未找到：pnpm、docker、docker-compose、psql、pg_isready（`docker ps` / `docker compose version` 均报 command not found）

## 2. Codex 可用状态（实测）

- 二进制：~/workspace/tools/bin/codex -> ../lib/node_modules/@openai/codex/bin/codex.js
- 版本：codex-cli 0.163.0
- 登录：`codex login status` = Logged in using ChatGPT（2026-10-30 复核，与 2026-10-28 复核一致）
- 冒烟（2026-10-30，/tmp/codex-smoke-1030，只读沙箱）：
  - session id：01a189c3-585a-7b80-8f0c-11957f96570c
  - 模型：gpt-6.1-sol，provider：openai，approval：never，sandbox：read-only
  - 回复：“我是 Codex，你的 AI 编程助手，当前工作目录是 `/tmp/codex-smoke-1030`。”
  - tokens used：2,008，未改任何文件
- 注意：Codex 提示本机 PATH 无 bubblewrap，改用内置 bubblewrap；沙箱能力以实际任务验证为准

## 3. 已有 MUSE ERP 项目检查（实测）

- 工作区 4 层内按 `*muse*erp*` / `*erp*` 搜索（排除 .hatch-browser）：仅命中
  `~/workspace/goals/ai/hidden_files/malaysia-erp-pull-2026-10-28.json`
  —— 那是马来改价任务的 ERP 拉取数据文件，不是 MUSE ERP 项目代码
- goals 目录下无 muse-erp 相关目标目录；工作区 3 层内无属于 MUSE ERP 的 package.json / Dockerfile / docker-compose.yml / .git
- 已发现的 .git 仓库均为其他项目（tools 下的 min-skill-src、cf-sstp-src 等，muse-wechat-review 等），与 MUSE ERP 无关
- TikTok 相关文件名（仅文件名，不含任何凭证）多为运营资料与知识库：goals/tiktok-shop-ai-digital-employee-training、knowledge-base/docs/00-TikTok-Shop东南亚运营圣经.pdf、custom-skills/tiktok-omni-product-storyboard-flow 等，均非 ERP 代码
- 结论：**从零新建**。本检查新建的空目录 ~/workspace/muse-erp/ 仅用于存放项目文档，后续 Codex 不得在不读现有项目的情况下另起一个新项目

## 4. 第一步未解决、留给第二步/第五步的问题

1. Docker 缺失：文档推荐 Docker Compose 部署，但本机无 Docker。选项（待第五步确认）：装 Docker、改用本机直接跑 PostgreSQL + Node、或 MVP 先用轻量方案再迁 PostgreSQL——不得在未确认前默认已解决。
2. PostgreSQL 缺失：无客户端也未验证服务端；MVP 的数据库选型与安装方式待调研后确认。
3. 内存偏紧：7.7G 总量、可用约 488M，开发期多服务并行需实测，不得凭感觉承诺“云端部署无压力”。
4. TikTok Shop Open API 应用授权状态：第一步未触碰任何凭证、不做猜测；第二步核验“现有应用授权”时只核对应用/权限的存在性与官方文档口径，App Secret / Token 一律不进聊天、不进文档、不进代码仓库。
5. 正式店铺写入禁令：MVP 验收前，任何真实店铺价格/库存修改、取消订单、发货、发消息、达人邀约均须用户审批；模拟数据必须与真实数据明确区分。

## 5. 下一步（已启动，不等于已确认开发）

- 第二步开源调研已并行启动：TikTok Shop 官方 SDK、OpenAPI 开源项目、MCP 项目、开源 ERP、AI Agent 工具框架，对比维护情况、许可证与商用条件、依赖安全、部署难度、可复用代码。
- 第三/四步（架构、模块、数据库结构、MVP 任务清单与验收标准）在调研结果回来后做，第五步一次性提交用户确认，确认后才进入 Codex 开发循环。
