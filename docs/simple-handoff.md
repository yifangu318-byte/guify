# 简洁接入与官方 JSON API 执行器

此版本代码准备完成，公开访问和写入默认关闭。不得把本地测试当作已完成生产开通或全部官方接口实测。

## 页面

启用 MUSE_AI_API_ENABLED 后，首页进入 /developers。页面只保留密码登录、连接状态、下载 MUSE-AI.md、退出和店铺连接入口。

管理员可额外在 Cloudflare Secret 中设置 **MUSE_ADMIN_PASSWORD**，至少 8 位、无空格。该密码只用于 AI 接入管理页和对应 admin API；现有 MUSE_OAUTH_ADMIN_TOKEN 作为恢复入口保留，原 /connect 和 /live 使用原管理员凭据。新密码必须由用户本人填写提交。此版没有在网页保存/修改管理员密码的接口。

下载端点：GET /api/ai/admin/handoff，管理员身份验证后返回 text/markdown 附件。文件不包含管理员密码或 TikTok 凭据；包含基址、实际开关状态、全部配置目标店铺、当前可用工具及完整输入 Schema、调用示例和失败处理规则。默认公共模式无 AI 名称、到期日期、访问凭据或应用每分钟限额。

## 独立开关

| 变量 | 默认 | 效果 |
|---|---|---|
| MUSE_AI_PUBLIC_ENABLED | false | 允许匿名调用所有已注册可用工具，默认覆盖所有配置目标店铺，无应用侧到期或分钟计数 |
| MUSE_TIKTOK_API_ENABLED | false | 增加 tiktok_request 通用官方 JSON API 工具 |
| MUSE_TIKTOK_WRITE_ENABLED | false | 允许 tiktok_request 执行非 GET 请求；POST 搜索也保守视为需此开关 |

MUSE_AI_API_ENABLED、MUSE_LIVE_READ_ENABLED、环境、固定 PUBLIC_URL 与 DB 就绪检查继续生效。admin 接口始终要求密码/管理员凭据。公开模式无法区分具体 AI 或访客，任何知道地址的人都可能请求读取/写入，CORS/Origin 校验不能防止服务器客户端直接调用。

## 官方执行器

新增 schema 6 / api_operations（只记请求 ID、请求摘要、状态和时间，不存正文），在非 GET 请求前原子认领一次 request_id。相同 ID 永不再次发起；成功、平台拒绝或未知结果分别记录。没有自动重试。未知结果不得以新 UUID 重试同一业务动作，应先只读核对，不能确认则停止。

固定主机 https://open-api.tiktokglobalshop.com，版本化业务路径模块白名单 product/order/fulfillment/logistics/return_refund/finance/promotion/customer_service/seller/supply_chain/fbt，JSON 请求，不允许传外部 URL、Auth/Token 路径、自定义请求头、签名/凭据参数或其他店铺覆盖。App Key、签名、shop_cipher 和 Access Token 均由服务器添加。每次检查当前 App、已配置目标店铺、市场、有效授权映射；具体 scope、API 版本与业务权限最终由 TikTok 校验。

此工具并非逐项实现 Partner Center 所有功能：不支持未列出模块、二进制或 multipart 上传、OAuth/Token 接口、Webhook/SPI 配置；请求 JSON 最大 64KiB，响应 1MiB、超时 8 秒、无自动重试。平台和 Cloudflare 配额仍有效。“应用不限流”不能解除官方限额。

HTTP 200 / code=0 不等于最终业务完成；返回 business_outcome=verify_response_and_read_back，要求检查结果并回查。现有八个快照工具继续只读。tiktok_request 的 MCP annotations 标记为可能破坏性、非幂等、外部工具；工具发现和 OpenAPI 按开关动态生成。

## 核验

544 项隔离测试全部通过；TypeScript 编译、Worker 隔离构建和 HTTP 冒烟通过。实时执行器只用合成凭据和 Mock 网络，未修改真实商品、订单或库存，未逐项验证所有官方业务 API。源代码包含的通用执行器只能在官方实际授权及市场规则允许时成功。

生产操作需要审核发布、schema 6 和开关。公开匿名真实写入会显著扩大访问权限，应在动作前确认具体暴露范围；设置管理员新密码需用户本人输入和提交。不要将先前批准只读上线理解成这次公开写入已获批准。

2026-11-05 已只读核验 MY/Senalo 的授权记录：active，27 个 scope（scope 数量不是 API 数量），包括商品修改、履约、售后、联盟合作和经营分析。额外核实官方业务路径 analytics 与 affiliate_seller，执行器已增加这两个模块；生产启用仍待确认。官方下载 Markdown 会附当前已配置店铺的实际 scope 列表，不包括 Token 或卖家身份密文。

参考：[经营分析](https://partner.tiktokshop.com/docv2/page/get-shop-performance-202609)、[联盟合作](https://partner.tiktokshop.com/docv2/page/search-target-collaborations-202508)、[达人市场](https://partner.tiktokshop.com/docv2/page/search-creators-in-creator-marketplace-202608)。这些是路径和权限文档核验，不是真实业务执行验收。
