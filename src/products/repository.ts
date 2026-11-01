import { copySnapshot, type ProductSnapshot } from './models.js';

/** Replace with PostgreSQL after PG is ready. replaceSnapshot must atomically
 * replace ONE shop's complete snapshot; reject invalid input without mutation.
 */
export interface ProductRepository {
  getSnapshot(shop_id: string): Promise<ProductSnapshot | undefined>;
  replaceSnapshot(shop_id: string, snapshot: ProductSnapshot): Promise<void>;
}

/** Volatile simulation storage, with defensive copies on every boundary. */
export class MemoryProductRepository implements ProductRepository {
  private readonly rows = new Map<string, ProductSnapshot>();
  constructor(seeds: readonly ProductSnapshot[] = []) {
    for (const seed of seeds) {
      const copy = copySnapshot(seed, seed.shop_id);
      if (this.rows.has(copy.shop_id)) throw new Error('Duplicate product shop');
      this.rows.set(copy.shop_id, copy);
    }
  }
  async getSnapshot(shop_id: string) {
    const row = this.rows.get(shop_id);
    return row ? copySnapshot(row, shop_id) : undefined;
  }
  async replaceSnapshot(shop_id: string, snapshot: ProductSnapshot) {
    const copy = copySnapshot(snapshot, shop_id);
    this.rows.set(shop_id, copy);
  }
}
