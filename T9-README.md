# T9 — 只读 Web 后台模拟骨架

日期：2026-10-30。模型：由总控从进程记录核对。

本轮仅实现 T9，提交总控复核，不代替总控验收。仍是模拟骨架，未接真实数据；持久化待 PG 就绪。使用现有 Fastify 和服务端 HTML，无前端构建、JavaScript、Next.js、CDN 或新增依赖。

## 页面清单

8 个导航模块、1 个订单详情页；另有 `/web/` 概览别名，共 10 个 GET 路由。与 `/api/` Gateway 路由分离。

| 模块 | 路径 | 展示内容与时间口径 |
| --- | --- | --- |
| 店铺概览 | `/web/overview`，别名 `/web/` | 店铺、市场、模拟授权；窗口订单量、原始 GMV、热销 SKU；当前库存风险 |
| 订单列表 | `/web/orders` | 所选店铺与窗口内的订单、状态、原始金额、币种、下单时间；详情链接保留范围 |
| 订单详情 | `/web/orders/:order_id` | 同店且在窗口内的订单、明细、包裹状态；无买家标识或物流单号 |
| 商品 | `/web/products` | 当前商品和 SKU 快照、价格、币种与状态 |
| 库存与仓库 | `/web/inventory` | 当前 SKU / 仓库库存，不跨仓合计；T4 regular / overseas / other 类型，不推断国家归属 |
| 经营数据 | `/web/analytics` | T6 窗口概览、按币种 GMV、热销 SKU 和当前库存风险 |
| 异常中心 | `/web/alerts` | 查询时计算 T7 巡检证据、触发值与阈值，不保存告警、不启动任务 |
| API 连接状态 | `/web/connections` | T3 模拟授权与 T4/T5 同步状态，未知时间显示未知 / 未同步；真实 API 明确显示未连接、未验证 |
| Agent 任务与执行日志 | `/web/agents` | 任务存储未接通；本进程最多 100 条 Gateway 审计摘要，按店铺与记录时间窗口筛选；MCP 传输未接通 |

每个成功页面均在显著位置显示 `source: simulation`、适用店铺、查询时间和显式窗口。默认不选择店铺，不读取业务数据，不汇总全部店铺。未选窗口显示提示，不计算默认指标。未知店铺或订单返回 T1 固定 404 JSON 信封，不回显参数。

## 使用

沿用现有命令：

```sh
npm run build
npm start
```

在本机访问 `/web/`，明确选择模拟店铺和起止时间后通过 GET 查询。唯一表单仅有店铺、起止时间和“查询（只读）”；没有业务写操作按钮或表单。

默认可选模拟店铺：`simulation-shop-a`、`simulation-shop-b`，与真实店铺无关。默认界面不自动选择其中任何一家。可用下列明确的示例查询查看模拟窗口：

```text
/web/overview?shop_id=simulation-shop-a&start_at=1790812800000&end_at=1793491200000
/web/orders?shop_id=simulation-shop-a&start_at=1790812800000&end_at=1793491200000
/web/orders/simulation-order-1?shop_id=simulation-shop-a&start_at=1790812800000&end_at=1793491200000
```

输入为 Unix 毫秒，示例窗口是 UTC 2026-10-01 至 2026-11-01。参数起止均须非负安全整数且 `start_at < end_at`。不接受重复、额外、多店参数或不完整窗口。无店铺时只显示选择提示；选店但未给起止时间时只显示窗口提示。导航和订单详情链接保留完整范围。

## 数据流向与只读边界

本实现选择**直接调用 T3–T7 内存 / 模拟服务函数**，不通过 REST 自调用、不调用 TikTok 适配层：

```text
buildApp
  ├─ 原有 T8 Gateway（原有身份、店铺白名单与工具授权保持原样）
  │    └─ 现有审计回调 → 有限内存摘要 → /web/agents 只读展示
  └─ 独立的 T9 simulation seeds
       → T3 MemoryShopRepository / ShopQueries
       → T4 MemoryProductRepository / ProductQueries
       → T5 MemoryOrderRepository / OrderQueries
       → T6 calculateShopOverview / rankBestSellingSkus / calculateInventoryRisk
       → T7 runInspection
       → 固定列投影、HTML 转义 → /web/* 服务端 HTML
```

模拟数据只在创建应用时初始化，Web 请求不调用同步器、`replaceSnapshot`、队列、调度器或外部传输。T9 的默认仓库与 T8 Gateway 配置隔离，不向 Gateway 发放凭证或授予访问权限。测试可通过 `buildApp` 第四参数 `WebOptions` 注入明确的模拟仓库、可选店铺白名单和时钟；注入仓库时不默认发现或汇总店铺，须提供 `shop_ids`。T4/T5 边界拒绝非 simulation 快照，Web 额外要求 T3 授权来源为 simulation，避免将显式或真实授权改标为模拟。

先通过 T3 读取有效授权，仅 `authorized` 放行业务页面；连接状态页可展示无效授权，但不读取其商品、订单同步快照。Web 没有真实用户登录系统，限本地模拟使用，不是生产访问控制交付。

日志页只保存 T8 已产生的安全摘要：店铺、记录时间、Agent、工具、结果、状态码与耗时。不保存原始参数、请求头、响应体或任务明细；内存最多 100 条，重启清空。默认 Gateway 未授权任何 Agent，因此默认日志为空，不伪造执行记录。Web 审计失败不影响原有 T8 审计回调。未接 Agent 任务表、pg-boss、通知或 MCP 传输。

## 统计口径

- 订单列表、详情与经营指标均按 `order_time >= start_at && order_time < end_at` 筛选，沿用 T6 的含起点、不含终点规则；窗口外的订单详情返回 404。
- GMV 页面明确注明：**全部状态原始合计，含未付款、已取消，非实收，非结算收入**。复用 T6 十进制计算与币种分列，不混币累加。默认模拟示例为 3 笔订单 × 12.50 TST = 37.50 TST。
- 库存、商品、包裹、授权和同步状态为当前快照，页面写明非窗口历史数据，不伪造历史库存或同步时间。库存风险阈值为 5，缺货优先，低库存严格小于阈值，不跨仓合计。
- 告警为查询时的 T7 当前快照巡检，不按订单统计窗口截断，查询时间即巡检时间；待发货超过 48 小时、物流停滞超过 72 小时，沿用 T5/T7 边界。
- Agent 日志窗口筛选字段为 `recorded_at`，同样含起点、不含终点。

## 输出与布局

渲染只列出明确的字段，不序列化整份业务对象。Token、Secret、shop_cipher、shopCode、游标、买家引用、物流引用、姓名、电话、地址等不输出。所有数据文本和链接属性进行 HTML 转义；响应设置 no-store、no-referrer、nosniff，以及禁止脚本、外部资源和嵌入的 CSP。

响应式骨架含 viewport、可换行导航、600px 以下单列表单、可键盘聚焦的局部横向滚动表格、长文本换行。自动验证覆盖这些 HTML / CSS 约束；当前环境无浏览器可执行文件，手机浏览器实机 / 截图验收仍待总控复核，没有声称已完成浏览器视觉实测。

## 验证与剩余问题

实际命令、测试数、失败修正记录与可复跑脚本见 [T9-TEST-REPORT.md](T9-TEST-REPORT.md)。最终全量测试为 320 通过、0 失败（原有 246 + T9 新增 74）；构建与新增测试严格类型检查通过。

仍是内存模拟骨架，持久化待 PG 就绪；真实 API、生产登录、Agent 任务存储、调度、通知、MCP 传输和手机浏览器视觉实测均未补齐。本轮未连接真实 TikTok、未使用真实凭证、未向真实域名发请求、未注册 POST / PUT / PATCH / DELETE 业务路由、未进行业务写操作、未安装 Docker、未采购、未部署生产，**未做 T10**。原有文档不修改，总控可在复核后自行更新总进度。
