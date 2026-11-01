import { redact } from '../logging.js';
import type { Result } from '../tiktok/client.js';
import { validAuthorization, validShop, validSyncStates, type AuthorizationState, type ShopSummary, type SyncState } from './models.js';
import type { ShopRepository } from './repository.js';

const failure = (code: string, message: string): Result<never> => ({ error: true, message, code });
const validId = (id: unknown): id is string => typeof id === 'string' && !!id.trim();

/** Status inspection only: never calls the adapter, token store, or network. */
export class ShopQueries {
  constructor(private readonly repository: ShopRepository, private readonly options: {
    now?: () => number; log?: (record: unknown) => void;
  } = {}) {}

  private async inspect(shop_id: string): Promise<Result<ShopSummary>> {
    if (!validId(shop_id)) return failure('INVALID_REQUEST', 'Invalid request');
    try {
      const shop = await this.repository.getShop(shop_id);
      if (!shop) return failure('SHOP_NOT_FOUND', 'Shop not found');
      const auth = await this.repository.getAuthorization(shop_id)
        ?? { shop_id, status: 'unauthorized' as const, expires_at: null, source: 'explicit_input' as const };
      const sync = await this.repository.getSyncStates(shop_id);
      // A replaceable repository must obey the same metadata contract as memory seeds.
      // Validate before logging or projecting fields, especially status and last_error.
      if (!validShop(shop) || !validAuthorization(auth) || !validSyncStates(sync)) {
        return failure('SHOP_QUERY_FAILED', 'Shop query failed');
      }
      if (shop.id !== shop_id || auth.shop_id !== shop_id || sync.some(s => s.shop_id !== shop_id)) {
        return failure('SHOP_SCOPE_INVALID', 'Shop scope mismatch');
      }
      const now = (this.options.now ?? Date.now)();
      if (!Number.isSafeInteger(now) || now < 0) return failure('SHOP_QUERY_FAILED', 'Shop query failed');
      const status = (auth.status === 'authorized' || auth.status === 'pending_verification')
        && auth.expires_at !== null && auth.expires_at <= now ? 'expired' : auth.status;
      // Fixed fields only: no shop identifiers, cursor, errors or exception text in logs.
      try { this.options.log?.(redact({ event: 'shop_status_read', status, result: 'status_returned' })); } catch { /* read remains available */ }
      return { error: false, data: {
        shop_id, shop: { id: shop.id, market: shop.market, shopCode: shop.shopCode, shopName: shop.shopName, status: shop.status },
        authorization: { shop_id, status, expires_at: auth.expires_at, source: auth.source },
        sync: sync.map(s => ({ shop_id, resource: s.resource, last_success_at: s.last_success_at,
          last_cursor: s.last_cursor, last_error: s.last_error })),
      } };
    } catch { return failure('SHOP_QUERY_FAILED', 'Shop query failed'); }
  }
  async getAuthorization(shop_id: string): Promise<Result<AuthorizationState>> {
    const result = await this.inspect(shop_id);
    return result.error ? result : { error: false, data: result.data.authorization };
  }
  async getSyncStates(shop_id: string): Promise<Result<SyncState[]>> {
    const result = await this.inspect(shop_id);
    return result.error ? result : { error: false, data: result.data.sync };
  }
  async summarize(shop_ids: readonly string[]): Promise<Result<ShopSummary[]>> {
    if (!Array.isArray(shop_ids) || !shop_ids.every(validId)) return failure('INVALID_REQUEST', 'Invalid request');
    // Snapshot scope before any await; no implicit all-shops operation.
    const ids = [...new Set(shop_ids)];
    const summaries: ShopSummary[] = [];
    for (const id of ids) {
      const result = await this.inspect(id);
      if (result.error) return result;
      summaries.push(result.data);
    }
    return { error: false, data: summaries };
  }
}
