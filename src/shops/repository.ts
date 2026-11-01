import { validAuthorization, validShop, validSyncStates, type AuthorizationState, type Shop, type SyncState } from './models.js';

/** Replace with PostgreSQL once available. Every read requires a shop scope. */
export interface ShopRepository {
  getShop(shop_id: string): Promise<Shop | undefined>;
  getAuthorization(shop_id: string): Promise<AuthorizationState | undefined>;
  getSyncStates(shop_id: string): Promise<SyncState[]>;
}
export interface ShopSeed { shop: Shop; authorization?: AuthorizationState; sync?: readonly SyncState[] }

/** TEST/SKELETON ONLY: registration is explicit seed input, volatile and copied. */
export class MemoryShopRepository implements ShopRepository {
  private readonly rows = new Map<string, { shop: Shop; authorization: AuthorizationState; sync: SyncState[] }>();
  constructor(seeds: readonly ShopSeed[] = []) {
    for (const { shop, authorization: auth, sync = [] } of seeds) {
      if (!validShop(shop) || this.rows.has(shop.id)) {
        throw new Error('Invalid shop registration');
      }
      if (auth !== undefined && (!validAuthorization(auth) || auth.shop_id !== shop.id)) throw new Error('Invalid authorization state');
      if (!validSyncStates(sync) || sync.some(state => state.shop_id !== shop.id)) throw new Error('Invalid sync state');
      // Whitelist fields instead of spreading input: extra credential properties are discarded.
      this.rows.set(shop.id, {
        shop: { id: shop.id, market: shop.market, shopCode: shop.shopCode, shopName: shop.shopName, status: shop.status },
        authorization: auth ? { shop_id: shop.id, status: auth.status, expires_at: auth.expires_at, source: auth.source }
          : { shop_id: shop.id, status: 'unauthorized', expires_at: null, source: 'explicit_input' },
        sync: sync.map(s => ({ shop_id: shop.id, resource: s.resource, last_success_at: s.last_success_at,
          last_cursor: s.last_cursor, last_error: s.last_error })),
      });
    }
  }
  async getShop(shop_id: string) { const row = this.rows.get(shop_id); return row ? { ...row.shop } : undefined; }
  async getAuthorization(shop_id: string) { const row = this.rows.get(shop_id); return row ? { ...row.authorization } : undefined; }
  async getSyncStates(shop_id: string) { return this.rows.get(shop_id)?.sync.map(s => ({ ...s })) ?? []; }
}
