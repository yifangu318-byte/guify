-- Additive AI identities. Tokens are SHA-256 digests; no plaintext credential is stored.
CREATE TABLE ai_api_clients (
  id TEXT PRIMARY KEY, app_hash TEXT NOT NULL, name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE, shop_ids_json TEXT NOT NULL, tools_json TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER,
  rate_limit INTEGER NOT NULL CHECK(rate_limit BETWEEN 1 AND 600),
  rate_window INTEGER NOT NULL DEFAULT 0, rate_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ai_api_clients_app ON ai_api_clients(app_hash, created_at);
CREATE TABLE ai_api_audit (
  id TEXT PRIMARY KEY, app_hash TEXT NOT NULL, client_id TEXT,
  action TEXT NOT NULL, tool TEXT, shop_id TEXT, status INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX ai_api_audit_time ON ai_api_audit(app_hash, created_at);
INSERT INTO muse_schema_versions(version) VALUES (5);
