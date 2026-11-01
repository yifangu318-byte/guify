import type { Result } from '../tiktok/client.js';
import { copySnapshot, emptySnapshot, validId, validQuantity, type ProductSnapshot } from './models.js';
import { MemoryProductRepository, type ProductRepository } from './repository.js';

/** Simulation-only full snapshots; no official adapter, fetch, URL or tokens. */
export interface ProductSyncSource {
  readonly source: 'simulation';
  readSnapshot(shop_id: string): Promise<ProductSnapshot>;
}
export class MemoryProductSyncSource implements ProductSyncSource {
  readonly source = 'simulation';
  private readonly repository: MemoryProductRepository;
  constructor(seeds: readonly ProductSnapshot[] = []) { this.repository = new MemoryProductRepository(seeds); }
  async readSnapshot(shop_id: string) {
    const row = await this.repository.getSnapshot(shop_id);
    if (!row) throw new Error('Simulation snapshot unavailable');
    return row;
  }
}

/** A sync replaces all four resources atomically. Serialize same-shop runs to
 * prevent stale success/failure overwrites; different shops remain independent.
 */
export class ProductSync {
  private readonly queues = new Map<string, Promise<void>>();
  constructor(private readonly repository: ProductRepository, private readonly source: ProductSyncSource,
    private readonly options: { now?: () => number } = {}) {}

  async syncShop(shop_id: string): Promise<Result<ProductSnapshot>> {
    if (!validId(shop_id)) return { error: true, code: 'INVALID_REQUEST', message: 'Invalid request' };
    const previous = this.queues.get(shop_id) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>(resolve => { release = resolve; });
    this.queues.set(shop_id, tail);
    await previous;
    try { return await this.synchronize(shop_id); }
    finally { release(); if (this.queues.get(shop_id) === tail) this.queues.delete(shop_id); }
  }

  private async synchronize(shop_id: string): Promise<Result<ProductSnapshot>> {
    let prior: ProductSnapshot;
    try {
      prior = copySnapshot(await this.repository.getSnapshot(shop_id) ?? emptySnapshot(shop_id), shop_id);
    } catch { return { error: true, code: 'PRODUCT_SYNC_FAILED', message: 'Product simulation sync failed' }; }
    try {
      if (this.source.source !== 'simulation') throw new Error('Invalid simulation source');
      const snapshot = copySnapshot(await this.source.readSnapshot(shop_id), shop_id);
      const now = (this.options.now ?? Date.now)();
      if (!validQuantity(now)) throw new Error('Invalid sync clock');
      snapshot.sync = snapshot.sync.filter(s => s.resource !== null)
        .map(s => ({ ...s, last_success_at: now, last_error: null }));
      // Repository receives its own copy; returned data cannot mutate storage.
      await this.repository.replaceSnapshot(shop_id, copySnapshot(snapshot, shop_id));
      return { error: false, data: snapshot };
    } catch {
      try {
        prior.sync = prior.sync.map(s => ({ ...s, last_error: 'SYNC_FAILED' }));
        await this.repository.replaceSnapshot(shop_id, prior);
      } catch { /* Failure remains explicit even if storage is unavailable. */ }
      return { error: true, code: 'PRODUCT_SYNC_FAILED', message: 'Product simulation sync failed' };
    }
  }
}
