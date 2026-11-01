import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import { userInfo } from 'node:os';

// Technical-gap verification only: fixed local Unix socket and peer identity.
// Do not consume DATABASE_URL, .env, remote hosts or database passwords.
const database = process.env.PGDATABASE;
if (!database || !/^muse_erp_[a-z0-9_]+$/.test(database)) {
  throw new Error('Set PGDATABASE to a local muse_erp_ database name');
}
const pool = new pg.Pool({ host: '/var/run/postgresql', port: 5432,
  user: userInfo().username, database, ssl: false, max: 1, connectionTimeoutMillis: 5000,
  password: async () => { throw new Error('Password authentication is disabled for this local verification'); },
});
try {
  await migrate(drizzle(pool), { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
  console.log('PASS: Drizzle local peer migration applied (existing shops migration only)');
} finally { await pool.end(); }
