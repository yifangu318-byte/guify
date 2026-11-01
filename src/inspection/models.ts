import type { InventoryRiskMetric } from '../analytics/models.js';
import type { OrderSnapshot } from '../orders/models.js';
import type { ProductSnapshot } from '../products/models.js';
import type { AuthorizationState } from '../shops/models.js';

/** T3 effective status (from ShopQueries), T4/T5 snapshots and T6 inventory
 * risk calculated from the same T4 snapshot. No repository/source callbacks.
 */
export interface InspectionSnapshot {
  shop_id: string;
  authorization: AuthorizationState;
  products: ProductSnapshot;
  orders: OrderSnapshot;
  inventory_risk: InventoryRiskMetric;
}
interface Evidence<Value, Threshold> {
  shop_id: string; entity_id: string; trigger_value: Value; threshold: Threshold;
}
export interface StockInspectionAlert extends Evidence<number, number> {
  type: 'out_of_stock' | 'low_stock'; entity_type: 'sku'; // Quantity units.
}
export interface TimeoutInspectionAlert extends Evidence<number, number> {
  type: 'pending_shipment_timeout' | 'logistics_stalled';
  entity_type: 'order' | 'package'; // Elapsed time and threshold in milliseconds.
}
export interface AuthorizationInspectionAlert extends Evidence<'expired' | 'revoked' | 'unauthorized', 'authorized'> {
  type: 'authorization_abnormal'; entity_type: 'shop';
}
export interface InspectionResult {
  source: 'simulation'; inspected_at: number; shop_ids: string[];
  stock: StockInspectionAlert[];
  order_timeouts: TimeoutInspectionAlert[];
  authorization: AuthorizationInspectionAlert[];
  total_anomalies: number;
}
