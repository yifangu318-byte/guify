#!/usr/bin/env bash
set -euo pipefail
# Run as root from the project root. Drizzle uses root's local peer role;
# administrative create/drop commands use the postgres OS user. No real data.
export PGHOST=/var/run/postgresql PGPORT=5432 PGUSER=root
export PGDATABASE=muse_erp_technical_gap
unset PGPASSWORD PGPASSFILE PGSERVICE PGSERVICEFILE PGOPTIONS DATABASE_URL
export PGPASSFILE=/dev/null
if [ "$(id -un)" != root ]; then
  echo 'Run this script as root; migration uses the local root peer role.' >&2
  exit 1
fi
admin() { runuser -u postgres -- env PGUSER=postgres "$@"; }
if [ "$(admin psql -X -d postgres -Atc "SELECT count(*) FROM pg_database WHERE datname = 'muse_erp_technical_gap'")" != 0 ]; then
  echo 'Refusing to drop an existing database. This verification requires a fresh dedicated database name.' >&2
  exit 1
fi
set -x
psql --version
admin psql -X -d postgres -c 'SELECT version(), current_user, inet_server_addr();'
admin createdb --owner=root "$PGDATABASE"
psql -X -c 'SELECT current_user, inet_server_addr();'
first_oid=$(admin psql -X -d postgres -Atc "SELECT oid FROM pg_database WHERE datname = 'muse_erp_technical_gap'")
test "$(psql -X -Atc "SELECT count(*) FROM pg_tables WHERE schemaname='public'")" = 0
node scripts/db-migrate-local.mjs
node scripts/db-migrate-local.mjs
test "$(psql -X -Atc 'SELECT count(*) FROM drizzle.__drizzle_migrations')" = 1
test "$(psql -X -Atc "SELECT string_agg(tablename, ',') FROM pg_tables WHERE schemaname='public'")" = shops
psql -X -v ON_ERROR_STOP=1 -c "INSERT INTO shops (market, shop_code, shop_name) VALUES ('SIM', '<placeholder-rebuild>', 'simulation rebuild sentinel');"
test "$(psql -X -Atc 'SELECT count(*) FROM shops')" = 1
psql -X -c '\d public.shops'
psql -X -c 'TABLE drizzle.__drizzle_migrations;'
# Only this script's newly-created, dedicated simulation database is dropped.
admin dropdb "$PGDATABASE"
admin createdb --owner=root "$PGDATABASE"
second_oid=$(admin psql -X -d postgres -Atc "SELECT oid FROM pg_database WHERE datname = 'muse_erp_technical_gap'")
test "$first_oid" != "$second_oid"
test "$(psql -X -Atc "SELECT count(*) FROM pg_tables WHERE schemaname='public'")" = 0
node scripts/db-migrate-local.mjs
test "$(psql -X -Atc 'SELECT count(*) FROM shops')" = 0
test "$(psql -X -Atc 'SELECT count(*) FROM drizzle.__drizzle_migrations')" = 1
test "$(psql -X -Atc "SELECT string_agg(tablename, ',') FROM pg_tables WHERE schemaname='public'")" = shops
psql -X -c "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema IN ('public', 'drizzle') ORDER BY 1, 2;"
psql -X -c 'SELECT count(*) AS shops_after_rebuild FROM shops;'
psql -X -c 'TABLE drizzle.__drizzle_migrations;'
printf 'PASS: empty database, idempotent migration, sentinel insert, drop/recreate, empty database migration; OID %s -> %s\n' "$first_oid" "$second_oid"
