import { calculateInventoryRisk, calculateShopOverview } from '../analytics/service.js';
import { runInspection } from '../inspection/service.js';
import type { InspectionResult } from '../inspection/models.js';
import { detectTimeoutAlerts, type TimeoutAlert } from '../orders/alerts.js';
import type { OrderDetail, Order } from '../orders/models.js';
import type { ShopQueries } from '../shops/service.js';
import type { ProductQueries } from '../products/service.js';
import { OrderQueries } from '../orders/service.js';
import { GatewayError, unwrap } from './errors.js';
import type { ToolName, ToolInput, ToolOutput, OverviewInput, OrderInput, AlertsInput, DiagnosisInput,
  PublicOrder, FulfillmentDiagnosis, DiagnosisReason } from './contracts.js';

const publicOrder = (o: Order): PublicOrder => ({ shop_id: o.shop_id, order_id: o.order_id,
  total_amount: o.total_amount, currency: o.currency, status: o.status,
  created_at: o.created_at, order_time: o.order_time, updated_at: o.updated_at });

/** Internal evidence projection; the gateway permission gate runs before this.
 * T5 decides timeouts; T7 supplies evidence. SKU relevance is an association,
 * never a claim that stock caused a particular missed shipment.
 */
export function attributeFulfillmentIssue(detail: OrderDetail, timeouts: readonly TimeoutAlert[],
  inspection: InspectionResult): FulfillmentDiagnosis {
  const shop_id = detail.shop_id, order_id = detail.order.order_id;
  const packageIds = new Set(detail.packages.map(p => p.package_id));
  const skuIds = new Set(detail.items.map(i => i.sku_id));
  const reasons: DiagnosisReason[] = [];
  for (const alert of inspection.order_timeouts) {
    if (alert.shop_id !== shop_id || !timeouts.some(t => t.shop_id === shop_id && t.order_id === order_id
      && t.type === alert.type && (t.type === 'logistics_stalled' ? t.package_id === alert.entity_id
        && packageIds.has(t.package_id) : alert.entity_id === order_id))) continue;
    reasons.push({ category: alert.type, scope: 'order', evidence: { shop_id, type: alert.type,
      entity_type: alert.entity_type, entity_id: alert.entity_id, trigger_value: alert.trigger_value, threshold: alert.threshold } });
  }
  for (const alert of inspection.stock) {
    if (alert.shop_id === shop_id && skuIds.has(alert.entity_id)) reasons.push({ category: 'inventory_abnormal', scope: 'order_sku',
      evidence: { shop_id, type: alert.type, entity_type: 'sku', entity_id: alert.entity_id,
        trigger_value: alert.trigger_value, threshold: alert.threshold } });
  }
  for (const alert of inspection.authorization) {
    if (alert.shop_id === shop_id) reasons.push({ category: 'authorization_abnormal', scope: 'shop',
      evidence: { shop_id, type: 'authorization_abnormal', entity_type: 'shop', entity_id: shop_id,
        trigger_value: alert.trigger_value, threshold: 'authorized' } });
  }
  return { order_id, status: reasons.length ? 'evidence_found' : 'insufficient_evidence',
    causal_claim: 'not_established', reasons };
}

/** Composition only: business rules remain in T3–T7. No persistence or sync. */
export class GatewayService {
  constructor(private readonly shops: ShopQueries, private readonly products: ProductQueries,
    private readonly orders: OrderQueries) {}

  async run(name: ToolName, input: ToolInput, queried_at: number): Promise<ToolOutput> {
    const shop_id = input.shop_id;
    const authorization = unwrap(await this.shops.getAuthorization(shop_id));
    // Agent grants do not override T3's effective shop authorization.
    if (authorization.status !== 'authorized') throw new GatewayError(403);
    const meta = { source: 'simulation' as const, shop_id, shop_ids: [shop_id], queried_at };
    switch (name) {
      case 'get_shop_overview': {
        const { start_at, end_at } = input as OverviewInput;
        const snapshot = unwrap(await this.orders.summarize([shop_id]))[0]!;
        return { ...meta, overview: calculateShopOverview(shop_id, snapshot, { start_at, end_at }, queried_at),
          gmv_basis: 'all_order_statuses_raw_total' };
      }
      case 'get_orders':
        return { ...meta, orders: unwrap(await this.orders.listOrders(shop_id)).map(publicOrder) };
      case 'get_order_detail': {
        const detail = unwrap(await this.orders.getOrder(shop_id, (input as OrderInput).order_id));
        return { ...meta, order: publicOrder(detail.order), items: detail.items,
          packages: detail.packages.map(p => ({ shop_id: p.shop_id, order_id: p.order_id,
            package_id: p.package_id, status: p.status, shipped_at: p.shipped_at })) };
      }
      case 'get_products': {
        const snapshot = unwrap(await this.products.summarize([shop_id]))[0]!;
        return { ...meta, products: snapshot.products, skus: snapshot.skus };
      }
      case 'get_inventory': {
        const snapshot = unwrap(await this.products.summarize([shop_id]))[0]!;
        return { ...meta, inventory: snapshot.inventory, warehouses: snapshot.warehouses };
      }
      case 'get_shop_alerts':
      case 'diagnose_fulfillment_issue': {
        const products = unwrap(await this.products.summarize([shop_id]))[0]!;
        const orders = unwrap(await this.orders.summarize([shop_id]))[0]!;
        // T6 requires a nonempty window even though inventory uses the current
        // snapshot. This fixed window has no effect on T4/T5/T7 rule decisions.
        const inventory_risk = calculateInventoryRisk(shop_id, products, { start_at: 0, end_at: 1 }, queried_at,
          (input as AlertsInput).stock_threshold ?? 0);
        const inspection = runInspection([shop_id], [{ shop_id, authorization, products, orders, inventory_risk }], queried_at);
        if (name === 'get_shop_alerts') return { ...meta, inspection };
        // Reuse T5's detail query against this exact captured snapshot. The
        // replacement method is unreachable: OrderQueries only performs reads.
        const captured = new OrderQueries({ getSnapshot: async () => orders,
          replaceSnapshot: async () => { throw new GatewayError(500); } });
        const detail = unwrap(await captured.getOrder(shop_id, (input as DiagnosisInput).order_id));
        return { ...meta, ...attributeFulfillmentIssue(detail, detectTimeoutAlerts(shop_id, orders, queried_at), inspection) };
      }
    }
  }
}
