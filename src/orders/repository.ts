import { copySnapshot, type OrderSnapshot } from './models.js';

/** PG implementation deferred until PostgreSQL is ready. Replacements MUST
 * atomically replace one complete shop snapshot; invalid input changes nothing.
 */
export interface OrderRepository {
  getSnapshot(shop_id: string): Promise<OrderSnapshot | undefined>;
  replaceSnapshot(shop_id: string, snapshot: OrderSnapshot): Promise<void>;
}
export class MemoryOrderRepository implements OrderRepository {
  private readonly rows = new Map<string, OrderSnapshot>();
  constructor(seeds: readonly OrderSnapshot[] = []) {
    for (const seed of seeds) {
      const copy = copySnapshot(seed, seed.shop_id);
      if (this.rows.has(copy.shop_id)) throw new Error('Duplicate order shop');
      this.rows.set(copy.shop_id, copy);
    }
  }
  async getSnapshot(shop_id: string) {
    const row = this.rows.get(shop_id);
    return row ? copySnapshot(row, shop_id) : undefined;
  }
  async replaceSnapshot(shop_id: string, snapshot: OrderSnapshot) {
    const copy = copySnapshot(snapshot, shop_id);
    this.rows.set(shop_id, copy);
  }
}
