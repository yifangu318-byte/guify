-- T10 D1 迁移：店铺 Token 注册表 shop_tokens（SQLite 方言）。
-- 与 src/tiktok/d1.ts 里的 SHOP_TOKENS_SCHEMA_SQL 保持一致，改一处须同步另一处。
-- 本表只存加密后的 Token（密文），绝不存明文；market 为 'unknown' 时表示
-- 授权回调里未提供市场、不得凭空猜测，须以 Partner Center / Seller Center
-- 的授权记录为准再补填。时间字段均为 Unix 毫秒。
CREATE TABLE IF NOT EXISTS shop_tokens (
  shop_code TEXT PRIMARY KEY,
  market TEXT NOT NULL,
  access_token_enc TEXT NOT NULL,
  refresh_token_enc TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shop_tokens_market ON shop_tokens (market);
