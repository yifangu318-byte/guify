import { copySnapshot as copyOrders, validId, type OrderSnapshot } from '../orders/models.js';
import { copySnapshot as copyProducts, validQuantity, type ProductSnapshot } from '../products/models.js';
import { detectStockAlerts } from '../products/alerts.js';
import { sumDecimalAmounts } from './decimal.js';
import { metricMetadata, type AnalyticsWindow, type MetricMetadata, type GmvMetric,
  type ShopOverview, type BestSellersMetric, type InventoryRiskMetric,
  type AnalyticsSnapshot, type AnalyticsSummary } from './models.js';

// Pure calculations over T4/T5 simulation snapshots. No repositories, clocks,
// logs, database access, transport or persistence are introduced here.
function scopedOrders(shop_id: string, snapshot: OrderSnapshot): OrderSnapshot {
  try { return copyOrders(snapshot, shop_id); }
  catch { throw new Error('Invalid analytics snapshot'); }
}
const compareIds = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function windowOrders(snapshot: OrderSnapshot, window: AnalyticsWindow) {
  return snapshot.orders.filter(o => o.order_time >= window.start_at && o.order_time < window.end_at);
}
function gmvFor(snapshot: OrderSnapshot, meta: MetricMetadata): GmvMetric {
  const amounts = new Map<string, string[]>();
  for (const order of windowOrders(snapshot, meta.window)) {
    const bucket = amounts.get(order.currency) ?? [];
    bucket.push(order.total_amount); amounts.set(order.currency, bucket);
  }
  const by_currency = [...amounts].sort(([a], [b]) => compareIds(a, b))
    .map(([currency, values]) => ({ shop_id: meta.shop_id, currency, total_amount: sumDecimalAmounts(values) }));
  return { ...meta, total_amount: by_currency.length > 1 ? null : by_currency[0]?.total_amount ?? '0', by_currency };
}

/** Raw order totals for ALL snapshot statuses, including unpaid/cancelled.
 * This is a reproducible simulation metric, not paid GMV or settlement income. */
export function calculateGmv(shop_id: string, snapshot: OrderSnapshot,
  window: AnalyticsWindow, calculated_at: number): GmvMetric {
  const meta = metricMetadata(shop_id, window, calculated_at);
  return gmvFor(scopedOrders(shop_id, snapshot), meta);
}

export function calculateShopOverview(shop_id: string, snapshot: OrderSnapshot,
  window: AnalyticsWindow, calculated_at: number): ShopOverview {
  const meta = metricMetadata(shop_id, window, calculated_at), orders = scopedOrders(shop_id, snapshot);
  const selected = windowOrders(orders, meta.window);
  return { ...meta, order_count: selected.length,
    delivered_order_count: selected.filter(o => o.status === 'delivered').length,
    pending_shipment_order_count: selected.filter(o => o.status === 'pending_shipment').length,
    gmv: gmvFor(orders, metricMetadata(shop_id, window, calculated_at)) };
}

/** Units from items of orders in the same window; SKU ties use code-unit order,
 * independent of locale and source row order. Historical SKUs need not exist
 * in the current product catalog. Safe integer overflow is rejected. */
export function rankBestSellingSkus(shop_id: string, snapshot: OrderSnapshot,
  window: AnalyticsWindow, calculated_at: number): BestSellersMetric {
  const meta = metricMetadata(shop_id, window, calculated_at), orders = scopedOrders(shop_id, snapshot);
  const selected = new Set(windowOrders(orders, meta.window).map(o => o.order_id));
  const quantities = new Map<string, number>();
  for (const item of orders.items) {
    if (!selected.has(item.order_id)) continue;
    const quantity = (quantities.get(item.sku_id) ?? 0) + item.quantity;
    if (!Number.isSafeInteger(quantity)) throw new Error('Analytics quantity overflow');
    quantities.set(item.sku_id, quantity);
  }
  return { ...meta, items: [...quantities].map(([sku_id, quantity]) => ({ shop_id, sku_id, quantity }))
    .sort((a, b) => b.quantity - a.quantity || compareIds(a.sku_id, b.sku_id)) };
}

/** Current inventory snapshot, NOT historical inventory in the order window.
 * Reuse T4's zero / strictly-below-threshold rule per warehouse without pooling. */
export function calculateInventoryRisk(shop_id: string, snapshot: ProductSnapshot,
  window: AnalyticsWindow, calculated_at: number, threshold = 0): InventoryRiskMetric {
  const meta = metricMetadata(shop_id, window, calculated_at);
  if (!validQuantity(threshold)) throw new Error('Invalid stock threshold');
  let products: ProductSnapshot;
  try { products = copyProducts(snapshot, shop_id); }
  catch { throw new Error('Invalid analytics snapshot'); }
  const alerts = detectStockAlerts(shop_id, products.inventory, threshold);
  return { ...meta, inventory_basis: 'snapshot', threshold,
    out_of_stock: alerts.filter(a => a.type === 'out_of_stock'),
    low_stock: alerts.filter(a => a.type === 'low_stock') };
}

/** Explicit scope only. Duplicate IDs are deduplicated in caller order. Each
 * selected shop must have exactly one complete snapshot; never return partial
 * results or implicitly include other shops. An explicit [] returns no shops. */
export function summarizeAnalytics(shop_ids: readonly string[], snapshots: readonly AnalyticsSnapshot[],
  window: AnalyticsWindow, calculated_at: number, threshold = 0): AnalyticsSummary {
  if (!Array.isArray(shop_ids) || !shop_ids.every(validId) || !Array.isArray(snapshots)) {
    throw new Error('Invalid analytics request');
  }
  const ids = [...new Set(shop_ids)];
  // Validate the window and threshold even when the caller explicitly selects no shops.
  const meta = metricMetadata(ids[0] ?? 'placeholder-empty-scope', window, calculated_at);
  if (!validQuantity(threshold)) throw new Error('Invalid stock threshold');
  const shops = ids.map(shop_id => {
    const matches = snapshots.filter(s => s && s.shop_id === shop_id);
    if (matches.length !== 1) throw new Error('Analytics snapshot unavailable or ambiguous');
    const s = matches[0]!;
    return { shop_id, overview: calculateShopOverview(shop_id, s.orders, window, calculated_at),
      gmv: calculateGmv(shop_id, s.orders, window, calculated_at),
      best_sellers: rankBestSellingSkus(shop_id, s.orders, window, calculated_at),
      inventory_risk: calculateInventoryRisk(shop_id, s.products, window, calculated_at, threshold) };
  });
  return { source: 'simulation', shop_ids: ids, window: meta.window, calculated_at, shops };
}
