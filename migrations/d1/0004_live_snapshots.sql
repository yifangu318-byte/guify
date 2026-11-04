-- Additive: sanitized business snapshots only; existing authorization tables stay intact.
CREATE TABLE live_snapshots (
  app_hash TEXT NOT NULL, shop_id TEXT NOT NULL, resource TEXT NOT NULL CHECK(resource IN ('products','orders')),
  snapshot_json TEXT, range_start INTEGER, range_end INTEGER,
  last_success_at INTEGER, last_attempt_at INTEGER NOT NULL,
  last_error TEXT, upstream_code INTEGER,
  lease_owner TEXT, lease_until INTEGER,
  PRIMARY KEY(app_hash,shop_id,resource)
);
INSERT INTO muse_schema_versions(version) VALUES (4);
