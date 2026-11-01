import { validSyncStates, type SyncState } from '../shops/models.js';

/** PROJECT.md products contract; T1's actual schema only contains shops.
 * No database table or PostgreSQL persistence is claimed here.
 */
export interface Product {
  shop_id: string; product_id: string; title: string; status: string;
  category: string | null; updated_at: number | null;
}
export interface Sku {
  shop_id: string; product_id: string; sku_id: string;
  price: string; // Decimal text, avoids floating point money arithmetic.
  currency: string; status: string;
}
export const warehouseTypes = ['regular', 'overseas', 'other'] as const;
export interface Warehouse {
  shop_id: string; warehouse_id: string; name: string;
  warehouse_type: typeof warehouseTypes[number];
}
export interface Inventory {
  shop_id: string; sku_id: string; warehouse_id: string;
  quantity: number; updated_at: number | null;
}
export const productResources = ['products', 'skus', 'warehouses', 'inventory'] as const;
export interface ProductSnapshot {
  shop_id: string;
  source: 'simulation';
  products: Product[]; skus: Sku[]; warehouses: Warehouse[]; inventory: Inventory[];
  sync: SyncState[];
}
export const validId = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
export const validQuantity = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const validTime = (value: unknown) => value === null || validQuantity(value);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function copyInventory(value: unknown, shop_id: string): Inventory[] {
  if (!validId(shop_id) || !Array.isArray(value)) throw new Error('Invalid inventory');
  const seen = new Set<string>();
  return value.map(row => {
    if (!record(row) || row.shop_id !== shop_id || !validId(row.sku_id) || !validId(row.warehouse_id)
      || !validQuantity(row.quantity) || !validTime(row.updated_at)) throw new Error('Invalid inventory');
    const key = JSON.stringify([row.sku_id, row.warehouse_id]);
    if (seen.has(key)) throw new Error('Invalid inventory');
    seen.add(key);
    return { shop_id, sku_id: row.sku_id, warehouse_id: row.warehouse_id,
      quantity: row.quantity, updated_at: row.updated_at as number | null };
  });
}

export function emptySnapshot(shop_id: string): ProductSnapshot {
  if (!validId(shop_id)) throw new Error('Invalid shop scope');
  return { shop_id, source: 'simulation', products: [], skus: [], warehouses: [], inventory: [],
    sync: productResources.map(resource => ({ shop_id, resource,
      last_success_at: null, last_cursor: null, last_error: null })) };
}

/** Validate scope, identities and relationships even for replacement repositories.
 * Project only known scalar fields so extra credential properties cannot escape.
 */
export function copySnapshot(value: unknown, shop_id: string): ProductSnapshot {
  const invalid = () => new Error('Invalid product snapshot');
  if (!validId(shop_id) || !record(value) || value.shop_id !== shop_id || value.source !== 'simulation'
    || !Array.isArray(value.products) || !Array.isArray(value.skus) || !Array.isArray(value.warehouses)
    || !validSyncStates(value.sync) || value.sync.some(s => s.shop_id !== shop_id
      || (s.resource !== null && !productResources.some(resource => resource === s.resource)))) throw invalid();
  const productIds = new Set<string>(), skuIds = new Set<string>(), warehouseIds = new Set<string>();
  const products: Product[] = value.products.map(row => {
    if (!record(row) || row.shop_id !== shop_id || !validId(row.product_id) || productIds.has(row.product_id)
      || !validId(row.title) || !validId(row.status) || (row.category !== null && !validId(row.category))
      || !validTime(row.updated_at)) throw invalid();
    productIds.add(row.product_id);
    return { shop_id, product_id: row.product_id, title: row.title, status: row.status,
      category: row.category as string | null, updated_at: row.updated_at as number | null };
  });
  const skus: Sku[] = value.skus.map(row => {
    if (!record(row) || row.shop_id !== shop_id || !validId(row.product_id) || !productIds.has(row.product_id)
      || !validId(row.sku_id) || skuIds.has(row.sku_id) || typeof row.price !== 'string'
      || !/^(0|[1-9]\d*)(\.\d+)?$/.test(row.price) || !validId(row.currency) || !validId(row.status)) throw invalid();
    skuIds.add(row.sku_id);
    return { shop_id, product_id: row.product_id, sku_id: row.sku_id,
      price: row.price, currency: row.currency, status: row.status };
  });
  const warehouses: Warehouse[] = value.warehouses.map(row => {
    if (!record(row) || row.shop_id !== shop_id || !validId(row.warehouse_id) || warehouseIds.has(row.warehouse_id)
      || !validId(row.name) || !warehouseTypes.some(type => type === row.warehouse_type)) throw invalid();
    warehouseIds.add(row.warehouse_id);
    return { shop_id, warehouse_id: row.warehouse_id, name: row.name,
      warehouse_type: row.warehouse_type as Warehouse['warehouse_type'] };
  });
  const inventory = copyInventory(value.inventory, shop_id);
  if (inventory.some(row => !skuIds.has(row.sku_id) || !warehouseIds.has(row.warehouse_id))) throw invalid();
  // Missing resources are explicitly unsynchronized; preserve T3 null semantics.
  const states = value.sync;
  const sync: SyncState[] = productResources.map(resource => {
    const state = states.find(s => s.resource === resource);
    return { shop_id, resource, last_success_at: state?.last_success_at ?? null,
      last_cursor: state?.last_cursor ?? null, last_error: state?.last_error ?? null };
  });
  const unknown = states.find(s => s.resource === null);
  if (unknown) sync.push({ shop_id, resource: null, last_success_at: unknown.last_success_at,
    last_cursor: unknown.last_cursor, last_error: unknown.last_error });
  return { shop_id, source: 'simulation', products, skus, warehouses, inventory, sync };
}
