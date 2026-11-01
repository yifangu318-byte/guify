import { metricMetadata, type InventoryRiskMetric } from '../analytics/models.js';
import { detectTimeoutAlerts } from '../orders/alerts.js';
import { copySnapshot as copyOrders, validId, validTime, type OrderSnapshot } from '../orders/models.js';
import { detectStockAlerts, type StockAlert } from '../products/alerts.js';
import { copySnapshot as copyProducts, validQuantity, type ProductSnapshot } from '../products/models.js';
import { validAuthorization } from '../shops/models.js';
import type { InspectionSnapshot, InspectionResult, StockInspectionAlert, TimeoutInspectionAlert } from './models.js';

/** Validate the T6 risk against T4 evidence; stale/mixed inputs fail visibly.
 * Compare whitelisted fields only. Caller extras never become output or errors.
 */
function stockAlerts(shop_id: string, products: ProductSnapshot, metric: InventoryRiskMetric): StockAlert[] {
  if (!metric || metric.source !== 'simulation' || metric.shop_id !== shop_id || metric.inventory_basis !== 'snapshot'
    || !validQuantity(metric.threshold)) {
    throw new Error('Invalid inspection snapshot');
  }
  metricMetadata(shop_id, metric.window, metric.calculated_at);
  const alerts = detectStockAlerts(shop_id, products.inventory, metric.threshold);
  const signature = (rows: readonly StockAlert[]) => {
    if (!Array.isArray(rows)) throw new Error('Invalid inspection snapshot');
    return rows.map(a => JSON.stringify([a.shop_id, a.type, a.sku_id, a.warehouse_id, a.quantity, a.threshold])).sort();
  };
  for (const type of ['out_of_stock', 'low_stock'] as const) {
    if (JSON.stringify(signature(metric[type])) !== JSON.stringify(signature(alerts.filter(a => a.type === type)))) {
      throw new Error('Invalid inspection snapshot');
    }
  }
  return alerts;
}

/** Evidence projection AFTER T5 decides which rows trigger. No timeout decision
 * is made here. Use the same order time / latest event / shipped_at reference.
 */
function timeoutAlerts(shop_id: string, orders: OrderSnapshot, inspected_at: number): TimeoutInspectionAlert[] {
  return detectTimeoutAlerts(shop_id, orders, inspected_at).map(alert => {
    if (alert.type === 'pending_shipment_timeout') {
      const order = orders.orders.find(o => o.order_id === alert.order_id)!;
      return { shop_id, type: alert.type, entity_type: 'order', entity_id: alert.order_id,
        trigger_value: inspected_at - order.order_time, threshold: alert.threshold_hours * 3_600_000 };
    }
    const parcel = orders.packages.find(p => p.package_id === alert.package_id)!;
    const times = orders.tracking.filter(e => e.package_id === alert.package_id).map(e => e.occurred_at);
    const last = times.reduce((latest, time) => Math.max(latest, time), times.length ? 0 : parcel.shipped_at!);
    return { shop_id, type: alert.type, entity_type: 'package', entity_id: alert.package_id,
      trigger_value: inspected_at - last, threshold: alert.threshold_hours * 3_600_000 };
  });
}

/** Explicitly triggered, synchronous pure simulation run. The caller supplies
 * time and scope; no clock, database, network, logging, timer or persistence.
 * Exactly one input per selected shop; missing/ambiguous data is an error,
 * not a successful zero. Explicit [] or complete empty snapshots return zero.
 */
export function runInspection(shop_ids: readonly string[], snapshots: readonly InspectionSnapshot[],
  inspected_at: number): InspectionResult {
  if (!Array.isArray(shop_ids) || !shop_ids.every(validId) || !Array.isArray(snapshots) || !validTime(inspected_at)) {
    throw new Error('Invalid inspection request');
  }
  const ids = [...new Set(shop_ids)];
  const result: InspectionResult = { source: 'simulation', inspected_at, shop_ids: ids,
    stock: [], order_timeouts: [], authorization: [], total_anomalies: 0 };
  // Identity: shop + associated identifier + type. Stock is per SKU in the
  // report; retain the lowest per-warehouse quantity, never pool warehouses.
  const stock = new Map<string, StockInspectionAlert>();
  const timeouts = new Map<string, TimeoutInspectionAlert>();
  for (const shop_id of ids) {
    const matches = snapshots.filter(s => s && s.shop_id === shop_id);
    if (matches.length !== 1) throw new Error('Inspection snapshot unavailable or ambiguous');
    const s = matches[0]!;
    try {
      if (!validAuthorization(s.authorization) || s.authorization.shop_id !== shop_id) {
        throw new Error('Invalid inspection snapshot');
      }
      const products = copyProducts(s.products, shop_id), orders = copyOrders(s.orders, shop_id);
      for (const alert of stockAlerts(shop_id, products, s.inventory_risk)) {
        const key = JSON.stringify([shop_id, alert.sku_id, alert.type]);
        const prior = stock.get(key);
        if (!prior || alert.quantity < prior.trigger_value) stock.set(key, {
          shop_id, type: alert.type, entity_type: 'sku', entity_id: alert.sku_id,
          trigger_value: alert.quantity, threshold: alert.threshold,
        });
      }
      for (const alert of timeoutAlerts(shop_id, orders, inspected_at)) {
        timeouts.set(JSON.stringify([shop_id, alert.entity_id, alert.type]), alert);
      }
      // T3 has already resolved expiration. Do not reinterpret pending/unknown
      // status, infer missing authorizations, or copy T3's expiry rule here.
      const status = s.authorization.status;
      if (status === 'expired' || status === 'revoked' || status === 'unauthorized') {
        result.authorization.push({ shop_id, type: 'authorization_abnormal', entity_type: 'shop',
          entity_id: shop_id, trigger_value: status, threshold: 'authorized' });
      }
    } catch { throw new Error('Invalid inspection snapshot'); }
  }
  result.stock = [...stock.values()];
  result.order_timeouts = [...timeouts.values()];
  result.total_anomalies = result.stock.length + result.order_timeouts.length + result.authorization.length;
  return result;
}
