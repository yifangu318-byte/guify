import type { GatewayAudit } from '../gateway/gateway.js';
import { GatewayError, unwrap } from '../gateway/errors.js';
import { ShopQueries } from '../shops/service.js';
import type { ShopRepository } from '../shops/repository.js';
import { ProductQueries } from '../products/service.js';
import type { ProductRepository } from '../products/repository.js';
import { OrderQueries } from '../orders/service.js';
import type { OrderRepository } from '../orders/repository.js';
import { validTime } from '../orders/models.js';
import type { AnalyticsWindow } from '../analytics/models.js';
import { calculateInventoryRisk, calculateShopOverview, rankBestSellingSkus } from '../analytics/service.js';
import { runInspection } from '../inspection/service.js';
import { createWebSimulation, demoShopIds } from './simulation.js';

export interface WebOptions {
  // Test/local simulation injection only; never attach live repositories here.
  simulation?: { shops: ShopRepository; products: ProductRepository; orders: OrderRepository };
  shop_ids?: readonly string[];
  now?: () => number;
}
export interface WebScope extends AnalyticsWindow { shop_id: string }
export interface WebAuditRow {
  shop_id: string; recorded_at: number; agent_id: string | null; tool: string | null;
  result: GatewayAudit['result']; status_code: number; duration_ms: number;
}

/** Only the last 100 in-process Gateway audit summaries; no request/response
 * payload, headers, parameters, credentials, or persistent agent tasks. */
export class WebAuditLog {
  private rows: WebAuditRow[] = [];
  record(a: GatewayAudit, recorded_at: number): void {
    if (!a.shop_id || !validTime(recorded_at)) return;
    this.rows.push({ shop_id: a.shop_id, recorded_at, agent_id: a.agent_id, tool: a.tool,
      result: a.result, status_code: a.status_code, duration_ms: a.duration_ms });
    if (this.rows.length > 100) this.rows.shift();
  }
  read(scope: WebScope): WebAuditRow[] {
    return this.rows.filter(r => r.shop_id === scope.shop_id && r.recorded_at >= scope.start_at
      && r.recorded_at < scope.end_at).map(r => ({ ...r }));
  }
}

export class WebService {
  readonly shopIds: readonly string[];
  private readonly shops: ShopRepository;
  private readonly products: ProductQueries;
  private readonly orders: OrderQueries;
  constructor(options: WebOptions, readonly audit: WebAuditLog) {
    const repos = options.simulation ?? createWebSimulation();
    this.shopIds = Object.freeze([...new Set(options.shop_ids ?? (options.simulation ? [] : demoShopIds))]);
    if (!this.shopIds.every(id => /^[A-Za-z0-9_-]{1,128}$/.test(id))) throw new Error('Invalid Web configuration');
    this.shops = repos.shops;
    this.products = new ProductQueries(repos.products);
    this.orders = new OrderQueries(repos.orders);
    this.clock = options.now ?? Date.now;
  }
  private readonly clock: () => number;
  now(): number {
    const time = this.clock();
    if (!validTime(time)) throw new GatewayError(500);
    return time;
  }
  async shop(shop_id: string, queried_at: number) {
    if (!this.shopIds.includes(shop_id)) throw new GatewayError(404);
    // Resolve effective authorization using this request's one captured clock.
    const summary = unwrap(await new ShopQueries(this.shops, { now: () => queried_at }).summarize([shop_id]))[0]!;
    if (summary.authorization.source !== 'simulation') throw new GatewayError(500);
    return summary;
  }
  async orderList(scope: WebScope) {
    return unwrap(await this.orders.listOrders(scope.shop_id))
      .filter(o => o.order_time >= scope.start_at && o.order_time < scope.end_at);
  }
  async orderDetail(scope: WebScope, order_id: string) {
    const detail = unwrap(await this.orders.getOrder(scope.shop_id, order_id));
    if (detail.order.order_time < scope.start_at || detail.order.order_time >= scope.end_at) throw new GatewayError(404);
    return detail;
  }
  async catalog(scope: WebScope) { return unwrap(await this.products.summarize([scope.shop_id]))[0]!; }
  async analytics(scope: WebScope, time: number) {
    const orders = unwrap(await this.orders.summarize([scope.shop_id]))[0]!;
    const products = await this.catalog(scope);
    return { overview: calculateShopOverview(scope.shop_id, orders, scope, time),
      best_sellers: rankBestSellingSkus(scope.shop_id, orders, scope, time),
      inventory_risk: calculateInventoryRisk(scope.shop_id, products, scope, time, 5) };
  }
  async alerts(scope: WebScope, authorization: Awaited<ReturnType<WebService['shop']>>['authorization'], time: number) {
    const products = await this.catalog(scope), orders = unwrap(await this.orders.summarize([scope.shop_id]))[0]!;
    return runInspection([scope.shop_id], [{ shop_id: scope.shop_id, authorization, products, orders,
      inventory_risk: calculateInventoryRisk(scope.shop_id, products, scope, time, 5) }], time);
  }
  async sync(scope: WebScope) {
    return [...unwrap(await this.products.getSyncStates(scope.shop_id)), ...unwrap(await this.orders.getSyncStates(scope.shop_id))];
  }
}
