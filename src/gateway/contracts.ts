import type { ShopOverview } from '../analytics/models.js';
import type { InspectionResult, StockInspectionAlert, TimeoutInspectionAlert, AuthorizationInspectionAlert } from '../inspection/models.js';
import type { Order, OrderItem, Package } from '../orders/models.js';
import type { Product, Sku, Inventory, Warehouse } from '../products/models.js';

export interface ShopInput { shop_id: string }
export interface OverviewInput extends ShopInput { start_at: number; end_at: number }
export interface OrderInput extends ShopInput { order_id: string }
export interface AlertsInput extends ShopInput { stock_threshold?: number }
export interface DiagnosisInput extends OrderInput { stock_threshold?: number }
export interface ToolInputs {
  get_shop_overview: OverviewInput;
  get_orders: ShopInput;
  get_order_detail: OrderInput;
  get_products: ShopInput;
  get_inventory: ShopInput;
  get_shop_alerts: AlertsInput;
  diagnose_fulfillment_issue: DiagnosisInput;
}
export type ToolName = keyof ToolInputs;
export type PublicOrder = Omit<Order, 'buyer_ref'>;
export type PublicPackage = Omit<Package, 'tracking_ref'>;
export interface PublicOrderDetail {
  order: PublicOrder; items: OrderItem[]; packages: PublicPackage[];
}
export type DiagnosisReason =
  | { category: 'pending_shipment_timeout' | 'logistics_stalled'; scope: 'order'; evidence: TimeoutInspectionAlert }
  | { category: 'inventory_abnormal'; scope: 'order_sku'; evidence: StockInspectionAlert }
  | { category: 'authorization_abnormal'; scope: 'shop'; evidence: AuthorizationInspectionAlert };
export interface FulfillmentDiagnosis {
  order_id: string;
  status: 'evidence_found' | 'insufficient_evidence';
  // Signals associated with the order, not proof of a causal chain. No advice.
  causal_claim: 'not_established';
  reasons: DiagnosisReason[];
}
export interface ToolPayloads {
  get_shop_overview: { overview: ShopOverview; gmv_basis: 'all_order_statuses_raw_total' };
  get_orders: { orders: PublicOrder[] };
  get_order_detail: PublicOrderDetail;
  get_products: { products: Product[]; skus: Sku[] };
  get_inventory: { inventory: Inventory[]; warehouses: Warehouse[] };
  get_shop_alerts: { inspection: InspectionResult };
  diagnose_fulfillment_issue: FulfillmentDiagnosis;
}
export interface ReadMetadata {
  source: 'simulation'; shop_id: string; shop_ids: string[]; queried_at: number;
}
export type ToolOutputs = { [N in ToolName]: ReadMetadata & ToolPayloads[N] };
export type ToolInput = ToolInputs[ToolName];
export type ToolOutput = ToolOutputs[ToolName];
export interface AgentGrant {
  agent_id: string;
  bearer_token: string;
  shop_ids: readonly string[];
  tools: readonly ToolName[];
}
