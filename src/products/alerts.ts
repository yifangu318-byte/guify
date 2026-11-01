import { copyInventory, validQuantity, type Inventory } from './models.js';

export interface StockAlert {
  shop_id: string; sku_id: string; warehouse_id: string;
  quantity: number; threshold: number; type: 'out_of_stock' | 'low_stock';
}

/** Pure, per-shop/SKU/warehouse rule. No pooling across warehouses and no
 * invented zero for a missing inventory row. Zero takes precedence over low.
 */
export function detectStockAlerts(shop_id: string, inventory: readonly Inventory[], threshold = 0): StockAlert[] {
  if (!validQuantity(threshold)) throw new Error('Invalid stock threshold');
  return copyInventory(inventory, shop_id).flatMap(row => {
    const type = row.quantity === 0 ? 'out_of_stock' : row.quantity < threshold ? 'low_stock' : undefined;
    return type ? [{ shop_id, sku_id: row.sku_id, warehouse_id: row.warehouse_id,
      quantity: row.quantity, threshold, type }] : [];
  });
}
