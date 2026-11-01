import type { SyncState } from '../shops/models.js';
import type { Result } from '../tiktok/client.js';
import { detectStockAlerts, type StockAlert } from './alerts.js';
import { copySnapshot, validId, validQuantity, type Product, type Sku, type Warehouse,
  type Inventory, type ProductSnapshot } from './models.js';
import type { ProductRepository } from './repository.js';

const failure = (code: string, message: string): Result<never> => ({ error: true, code, message });

/** Local simulation reads only. No business routes or Agent Gateway permissions
 * are introduced in T4; deployment/access control belongs to later tasks.
 */
export class ProductQueries {
  constructor(private readonly repository: ProductRepository) {}
  private async inspect(shop_id: string): Promise<Result<ProductSnapshot>> {
    if (!validId(shop_id)) return failure('INVALID_REQUEST', 'Invalid request');
    try {
      const row = await this.repository.getSnapshot(shop_id);
      if (!row) return failure('SHOP_NOT_FOUND', 'Simulation shop not found');
      return { error: false, data: copySnapshot(row, shop_id) };
    } catch { return failure('PRODUCT_QUERY_FAILED', 'Product query failed'); }
  }
  async listProducts(shop_id: string): Promise<Result<Product[]>> {
    const r = await this.inspect(shop_id); return r.error ? r : { error: false, data: r.data.products };
  }
  async getProduct(shop_id: string, product_id: string): Promise<Result<Product>> {
    if (!validId(product_id)) return failure('INVALID_REQUEST', 'Invalid request');
    const r = await this.inspect(shop_id);
    if (r.error) return r;
    const product = r.data.products.find(p => p.product_id === product_id);
    return product ? { error: false, data: product } : failure('PRODUCT_NOT_FOUND', 'Product not found');
  }
  async listSkus(shop_id: string): Promise<Result<Sku[]>> {
    const r = await this.inspect(shop_id); return r.error ? r : { error: false, data: r.data.skus };
  }
  async listWarehouses(shop_id: string): Promise<Result<Warehouse[]>> {
    const r = await this.inspect(shop_id); return r.error ? r : { error: false, data: r.data.warehouses };
  }
  async listInventory(shop_id: string): Promise<Result<Inventory[]>> {
    const r = await this.inspect(shop_id); return r.error ? r : { error: false, data: r.data.inventory };
  }
  async getSyncStates(shop_id: string): Promise<Result<SyncState[]>> {
    const r = await this.inspect(shop_id); return r.error ? r : { error: false, data: r.data.sync };
  }
  async getStockAlerts(shop_id: string, threshold = 0): Promise<Result<StockAlert[]>> {
    if (!validQuantity(threshold)) return failure('INVALID_REQUEST', 'Invalid request');
    const r = await this.inspect(shop_id);
    return r.error ? r : { error: false, data: detectStockAlerts(shop_id, r.data.inventory, threshold) };
  }
  async summarize(shop_ids: readonly string[]): Promise<Result<ProductSnapshot[]>> {
    if (!Array.isArray(shop_ids) || !shop_ids.every(validId)) return failure('INVALID_REQUEST', 'Invalid request');
    const ids = [...new Set(shop_ids)]; // Snapshot caller scope before the first await.
    const rows: ProductSnapshot[] = [];
    for (const id of ids) {
      const result = await this.inspect(id);
      if (result.error) return result; // Never expose partial cross-shop data on failure.
      rows.push(result.data);
    }
    return { error: false, data: rows };
  }
  async summarizeStockAlerts(shop_ids: readonly string[], threshold = 0): Promise<Result<StockAlert[]>> {
    if (!validQuantity(threshold)) return failure('INVALID_REQUEST', 'Invalid request');
    const r = await this.summarize(shop_ids);
    return r.error ? r : { error: false,
      data: r.data.flatMap(s => detectStockAlerts(s.shop_id, s.inventory, threshold)) };
  }
}
