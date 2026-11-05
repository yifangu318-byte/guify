# 多国家店铺接入修复

此前只配置 MY/Senalo 一个精确目标；连接页只接受旧的32位管理员凭据，所以用户的新管理员密码不能用于新增国家授权。回调中的 MY 是该次会话实际绑定结果，不是其他国家已绑定的证明。

新连接页使用相同管理员密码（至少8位），支持 MY/PH/SG/TH/VN。管理员选择国家后，由 /api/tiktok/enroll 发起新的浏览器绑定 OAuth 会话；同一国家有多家店铺时可填写精确 Shop ID。非管理员、跨源、非法国家、额外参数、重复/过期会话仍拒绝。

回调使用官方 Get Authorized Shops 返回的 ID、region、cipher 选择该国家店铺，不能用国家标签改写 MY。零匹配返回 SHOP_MARKET_MISMATCH；多匹配返回 SHOP_SELECTION_REQUIRED。成功后以真实 Shop ID 保存；原加密 vault 和 schema 3 不变，不新增生产数据表。

同一卖家重新授权时，新的官方授权列表必须覆盖其已有店铺；否则返回 EXISTING_SHOPS_MISSING、保留原数据库记录。覆盖完整时在同一 D1 batch 更新共享 token 和现有店铺 cipher。不同卖家保持独立授权；不能保证 TikTok 的授权或 Token 轮换完全没有平台侧影响。

开启 MUSE_MULTI_SHOP_ENABLED 后，店铺列表、真实数据服务和 Markdown 合并显式配置与当前 App 的已核验 active 店铺记录。成功新增的店铺依现有公开 API 设置开放，不自动给旧的私有 AI 凭据增加店铺范围。移除静态配置不等于撤销动态 active 授权；停用该模式可设为false（本发布的wrangler vars默认true，后续部署需同步修改源配置）。

浏览器回调成功跳转 /developers，失败跳转 /connect 显示明确诊断，不继续展示含 code/state 的回调URL。成功后登录并重新下载 Markdown，内容读取最新已连接店铺，不需要逐店修改 Cloudflare 目标变量。

已验证555项测试，包括五市场合成接入、跨国错店拒绝、同国家多店精确选择、共享卖家 token 完整性、浏览器绑定、管理员和同源检查、动态店铺发现。实际新增国家仍需用户在 TikTok 完成授权，不能把测试中的合成店铺当作真实绑定成功。

官方依据：[Get Authorized Shops](https://partner.tiktokshop.com/docv2/page/6507ead7b99d5302be949ba9)，平台返回哪些店铺才代表该卖家对该应用已授权；应用市场与目标卖家资格仍由 Partner Center 管理。
