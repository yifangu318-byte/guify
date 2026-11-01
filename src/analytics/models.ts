import { validId, validTime, type OrderSnapshot } from '../orders/models.js';
import type { ProductSnapshot } from '../products/models.js';
import type { StockAlert } from '../products/alerts.js';

/** Unix milliseconds, start inclusive and end exclusive: [start_at, end_at). */
export interface AnalyticsWindow { start_at: number; end_at: number }
export interface MetricMetadata {
  source: 'simulation'; shop_id: string; window: AnalyticsWindow; calculated_at: number;
}
export interface CurrencyGmv { shop_id: string; currency: string; total_amount: string }
export interface GmvMetric extends MetricMetadata {
  // No conversion or addition across currencies. Empty input has total "0";
  // mixed currencies have no meaningful scalar total, hence null.
  total_amount: string | null; by_currency: CurrencyGmv[];
}
export interface ShopOverview extends MetricMetadata {
  order_count: number; delivered_order_count: number; pending_shipment_order_count: number;
  gmv: GmvMetric;
}
export interface BestSellersMetric extends MetricMetadata {
  items: Array<{ shop_id: string; sku_id: string; quantity: number }>;
}
export interface InventoryRiskMetric extends MetricMetadata {
  inventory_basis: 'snapshot'; threshold: number;
  out_of_stock: StockAlert[]; low_stock: StockAlert[];
}
export interface AnalyticsSnapshot {
  shop_id: string; products: ProductSnapshot; orders: OrderSnapshot;
}
export interface ShopAnalytics {
  shop_id: string; overview: ShopOverview; gmv: GmvMetric;
  best_sellers: BestSellersMetric; inventory_risk: InventoryRiskMetric;
}
export interface AnalyticsSummary {
  source: 'simulation'; shop_ids: string[]; window: AnalyticsWindow; calculated_at: number;
  shops: ShopAnalytics[];
}

/** Project metadata explicitly: caller extras are never included in a result. */
export function metricMetadata(shop_id: string, window: AnalyticsWindow, calculated_at: number): MetricMetadata {
  if (!validId(shop_id) || !window || !validTime(window.start_at) || !validTime(window.end_at)
    || window.start_at >= window.end_at || !validTime(calculated_at)) throw new Error('Invalid analytics request');
  return { source: 'simulation', shop_id,
    window: { start_at: window.start_at, end_at: window.end_at }, calculated_at };
}
