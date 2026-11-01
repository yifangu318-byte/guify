import { validSyncStates, type SyncState } from '../shops/models.js';

/** T5 simulation models only. No database tables or real buyer/logistics data. */
export const orderStatuses = ['awaiting_payment', 'pending_shipment', 'shipped', 'delivered', 'cancelled'] as const;
export const packageStatuses = ['pending_shipment', 'in_transit', 'delivered', 'cancelled'] as const;
export interface Order {
  shop_id: string; order_id: string; buyer_ref: string;
  total_amount: string; currency: string; status: typeof orderStatuses[number];
  created_at: number; order_time: number; updated_at: number | null;
}
export interface OrderItem {
  shop_id: string; order_id: string; item_id: string; sku_id: string;
  quantity: number; unit_price: string;
}
export interface Package {
  shop_id: string; order_id: string; package_id: string;
  tracking_ref: string | null; status: typeof packageStatuses[number]; shipped_at: number | null;
}
export interface TrackingEvent {
  shop_id: string; package_id: string; event_id: string;
  occurred_at: number; status_description: string;
}
export const orderResources = ['orders', 'order_items', 'packages', 'tracking_events'] as const;
export interface OrderSnapshot {
  shop_id: string; source: 'simulation';
  orders: Order[]; items: OrderItem[]; packages: Package[]; tracking: TrackingEvent[];
  sync: SyncState[];
}
export interface OrderDetail {
  shop_id: string; source: 'simulation'; order: Order; items: OrderItem[]; packages: Package[];
}

export const validId = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
export const validTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export const validDecimal = (value: unknown): value is string =>
  typeof value === 'string' && /^(0|[1-9]\d*)(\.\d+)?$/.test(value);
const nullableTime = (value: unknown) => value === null || validTime(value);
const placeholder = (value: unknown): value is string =>
  typeof value === 'string' && /^<placeholder-[a-z0-9-]+>$/.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function emptySnapshot(shop_id: string): OrderSnapshot {
  if (!validId(shop_id)) throw new Error('Invalid shop scope');
  return { shop_id, source: 'simulation', orders: [], items: [], packages: [], tracking: [],
    sync: orderResources.map(resource => ({ shop_id, resource,
      last_success_at: null, last_cursor: null, last_error: null })) };
}

/** Validate all relationships within one shop and project only known fields.
 * Apply this at storage, source and service boundaries, including replacements.
 */
export function copySnapshot(value: unknown, shop_id: string): OrderSnapshot {
  const invalid = () => new Error('Invalid order snapshot');
  if (!validId(shop_id) || !record(value) || value.shop_id !== shop_id || value.source !== 'simulation'
    || !Array.isArray(value.orders) || !Array.isArray(value.items) || !Array.isArray(value.packages)
    || !Array.isArray(value.tracking) || !validSyncStates(value.sync)
    || value.sync.some(s => s.shop_id !== shop_id
      || (s.resource !== null && !orderResources.some(resource => resource === s.resource)))) throw invalid();
  const orderIds = new Set<string>(), itemIds = new Set<string>(), packageIds = new Set<string>(), eventIds = new Set<string>();
  const orders: Order[] = value.orders.map(row => {
    if (!record(row) || row.shop_id !== shop_id || !validId(row.order_id) || orderIds.has(row.order_id)
      || !placeholder(row.buyer_ref) || !validDecimal(row.total_amount) || !validId(row.currency)
      || !orderStatuses.some(s => s === row.status) || !validTime(row.created_at)
      || !validTime(row.order_time) || !nullableTime(row.updated_at)) throw invalid();
    orderIds.add(row.order_id);
    return { shop_id, order_id: row.order_id, buyer_ref: row.buyer_ref, total_amount: row.total_amount,
      currency: row.currency, status: row.status as Order['status'], created_at: row.created_at,
      order_time: row.order_time, updated_at: row.updated_at as number | null };
  });
  const items: OrderItem[] = value.items.map(row => {
    if (!record(row) || row.shop_id !== shop_id || !validId(row.order_id) || !orderIds.has(row.order_id)
      || !validId(row.item_id) || !validId(row.sku_id) || !validTime(row.quantity) || row.quantity === 0
      || !validDecimal(row.unit_price)) throw invalid();
    const key = JSON.stringify([row.order_id, row.item_id]);
    if (itemIds.has(key)) throw invalid();
    itemIds.add(key);
    return { shop_id, order_id: row.order_id, item_id: row.item_id, sku_id: row.sku_id,
      quantity: row.quantity, unit_price: row.unit_price };
  });
  const packages: Package[] = value.packages.map(row => {
    if (!record(row) || row.shop_id !== shop_id || !validId(row.order_id) || !orderIds.has(row.order_id)
      || !validId(row.package_id) || packageIds.has(row.package_id)
      || (row.tracking_ref !== null && !placeholder(row.tracking_ref))
      || !packageStatuses.some(s => s === row.status) || !nullableTime(row.shipped_at)) throw invalid();
    packageIds.add(row.package_id);
    return { shop_id, order_id: row.order_id, package_id: row.package_id,
      tracking_ref: row.tracking_ref as string | null, status: row.status as Package['status'],
      shipped_at: row.shipped_at as number | null };
  });
  const tracking: TrackingEvent[] = value.tracking.map(row => {
    if (!record(row) || row.shop_id !== shop_id || !validId(row.package_id) || !packageIds.has(row.package_id)
      || !validId(row.event_id) || !validTime(row.occurred_at) || !placeholder(row.status_description)) throw invalid();
    const key = JSON.stringify([row.package_id, row.event_id]);
    if (eventIds.has(key)) throw invalid();
    eventIds.add(key);
    return { shop_id, package_id: row.package_id, event_id: row.event_id,
      occurred_at: row.occurred_at, status_description: row.status_description };
  });
  const states = value.sync;
  const sync: SyncState[] = orderResources.map(resource => {
    const s = states.find(s => s.resource === resource);
    return { shop_id, resource, last_success_at: s?.last_success_at ?? null,
      last_cursor: s?.last_cursor ?? null, last_error: s?.last_error ?? null };
  });
  const unknown = states.find(s => s.resource === null);
  if (unknown) sync.push({ shop_id, resource: null, last_success_at: unknown.last_success_at,
    last_cursor: unknown.last_cursor, last_error: unknown.last_error });
  return { shop_id, source: 'simulation', orders, items, packages, tracking, sync };
}
