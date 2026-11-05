-- Tracks one attempted official mutation per idempotency key; never stores request bodies.
CREATE TABLE api_operations (
  app_hash TEXT NOT NULL, request_id TEXT NOT NULL, shop_id TEXT NOT NULL,
  request_hash TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('started','succeeded','rejected','unknown')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, upstream_code INTEGER,
  PRIMARY KEY(app_hash,request_id)
);
INSERT INTO muse_schema_versions(version) VALUES (6);
