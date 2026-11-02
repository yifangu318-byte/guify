/**
 * T10 D1 店铺 Token 注册表（SQLite 方言）。
 *
 * 绑定变量名已定为 DB，数据库名 muse-erp，Cloudflare 后台已建好并绑定。
 * 本层只存加密后的 Token（密文），绝不存明文 Token；加密/解密在 crypto.ts，
 * 密钥只来自 Workers env 的 TOKEN_ENCRYPTION_KEY。
 *
 * 表 shop_tokens 即 Token + 店铺注册表（等价于任务里的 tokens / shop_tokens）：
 * 一条记录对应一个店铺的授权，shop_code 为主键，market 为店铺市场，
 * market 为 'unknown' 时表示授权回调里未提供市场、不得凭空猜测，
 * 须以 Partner Center / Seller Center 的授权记录为准再补填。
 * expires_at / created_at / updated_at 均为 Unix 毫秒。
 */

export interface D1Prepared {
  bind(...args: unknown[]): D1Prepared;
  run(): Promise<unknown>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}

export interface D1Binding {
  prepare(sql: string): D1Prepared;
}

export const SHOP_TOKENS_SCHEMA_SQL = [
  'CREATE TABLE IF NOT EXISTS shop_tokens (',
  '  shop_code TEXT PRIMARY KEY,',
  '  market TEXT NOT NULL,',
  '  access_token_enc TEXT NOT NULL,',
  '  refresh_token_enc TEXT NOT NULL,',
  '  expires_at INTEGER NOT NULL,',
  '  scope TEXT NOT NULL DEFAULT \'\',',
  '  created_at INTEGER NOT NULL,',
  '  updated_at INTEGER NOT NULL',
  ');',
  'CREATE INDEX IF NOT EXISTS idx_shop_tokens_market ON shop_tokens (market);',
].join('\n');

export interface EncryptedShopToken {
  shopCode: string;
  market: string;
  accessTokenEnc: string;
  refreshTokenEnc: string;
  expiresAt: number;
  scope: string;
  createdAt: number;
  updatedAt: number;
}

export async function ensureShopTokenSchema(db: D1Binding): Promise<void> {
  // D1 的 prepare().run() 可执行 DDL；本地模拟实现同样遵循该约定。
  await db.prepare(SHOP_TOKENS_SCHEMA_SQL).run();
}

export async function saveEncryptedShopToken(
  db: D1Binding,
  record: Omit<EncryptedShopToken, 'createdAt' | 'updatedAt'>,
  nowMs: number,
): Promise<void> {
  if (!record.shopCode.trim() || !record.market.trim() || !record.accessTokenEnc || !record.refreshTokenEnc || !Number.isSafeInteger(record.expiresAt)) {
    throw new Error('Invalid encrypted shop token record');
  }
  await db.prepare(
    'INSERT INTO shop_tokens (shop_code, market, access_token_enc, refresh_token_enc, expires_at, scope, created_at, updated_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
    'ON CONFLICT(shop_code) DO UPDATE SET market = excluded.market, access_token_enc = excluded.access_token_enc, ' +
    'refresh_token_enc = excluded.refresh_token_enc, expires_at = excluded.expires_at, scope = excluded.scope, updated_at = excluded.updated_at',
  ).bind(record.shopCode, record.market, record.accessTokenEnc, record.refreshTokenEnc, record.expiresAt, record.scope, nowMs, nowMs).run();
}

export async function getEncryptedShopToken(db: D1Binding, shopCode: string): Promise<EncryptedShopToken | undefined> {
  const row = await db.prepare(
    'SELECT shop_code, market, access_token_enc, refresh_token_enc, expires_at, scope, created_at, updated_at FROM shop_tokens WHERE shop_code = ?',
  ).bind(shopCode).first<Record<string, unknown>>();
  if (!row) return undefined;
  return {
    shopCode: String(row.shop_code),
    market: String(row.market),
    accessTokenEnc: String(row.access_token_enc),
    refreshTokenEnc: String(row.refresh_token_enc),
    expiresAt: Number(row.expires_at),
    scope: String(row.scope ?? ''),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/** D1 可读探针：只返回可读与否，绝不抛错、绝不回显数据。 */
export async function probeD1(db: D1Binding): Promise<boolean> {
  try {
    const row = await db.prepare('SELECT 1 AS ok').first<Record<string, unknown>>();
    return row !== null && (row.ok === 1 || row.ok === '1' || row.ok === true);
  } catch {
    return false;
  }
}
