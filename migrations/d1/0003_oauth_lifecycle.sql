-- Additive migration. Legacy shop_tokens are deliberately NOT promoted to verified authorization.
CREATE TABLE oauth_sessions (
  state_hash TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, app_hash TEXT NOT NULL,
  shop_id TEXT NOT NULL, market TEXT NOT NULL, subject_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  owner TEXT, code_hash TEXT, result_json TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX idx_oauth_expiry ON oauth_sessions(expires_at);
CREATE INDEX idx_oauth_created ON oauth_sessions(created_at);
CREATE TABLE authorizations (
  id TEXT PRIMARY KEY, app_hash TEXT NOT NULL, subject_id TEXT NOT NULL,
  access_enc TEXT NOT NULL, refresh_enc TEXT NOT NULL, access_expires_at INTEGER NOT NULL,
  refresh_expires_at INTEGER NOT NULL, scopes_json TEXT NOT NULL, required_scopes_json TEXT NOT NULL,
  status TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  refresh_owner TEXT, refresh_until INTEGER, key_version TEXT NOT NULL DEFAULT 'v1',
  updated_at INTEGER NOT NULL, write_id TEXT NOT NULL, UNIQUE(app_hash, subject_id)
);
CREATE TABLE authorized_shops (
  id TEXT PRIMARY KEY, app_hash TEXT NOT NULL, tiktok_shop_id TEXT NOT NULL,
  authorization_id TEXT NOT NULL REFERENCES authorizations(id),
  market TEXT NOT NULL, cipher TEXT NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(app_hash, tiktok_shop_id)
);
CREATE TABLE oauth_audit (
  id TEXT PRIMARY KEY, event TEXT NOT NULL, result TEXT NOT NULL,
  shop_id TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE muse_schema_versions (version INTEGER PRIMARY KEY);
INSERT INTO muse_schema_versions(version) VALUES (3);
