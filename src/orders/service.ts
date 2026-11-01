import type { SyncState } from '../shops/models.js';
import type { Result } from '../tiktok/client.js';
import { detectTimeoutAlerts, resolveTimeoutThresholds, type TimeoutAlert, type TimeoutThresholds } from './alerts.js';
import { copySnapshot, validId, validTime, type Order, type OrderDetail, type OrderSnapshot,
  type Package, type TrackingEvent } from './models.js';
import type { OrderRepository } from './repository.js';

const failure = (code: string, message: string): Result<never> => ({ error: true, code, message });

/** Local simulation queries only. No HTTP routes or Gateway introduced in T5. */
export class OrderQueries {
  constructor(private readonly repository: OrderRepository) {}
  private async inspect(shop_id: string): Promise<Result<OrderSnapshot>> {
    if (!validId(shop_id)) return failure('INVALID_REQUEST', 'Invalid request');
    try {
      const row = await this.repository.getSnapshot(shop_id);
      if (!row) return failure('SHOP_NOT_FOUND', 'Simulation shop not found');
      return { error: false, data: copySnapshot(row, shop_id) };
    } catch { return failure('ORDER_QUERY_FAILED', 'Order query failed'); }
  }
  async listOrders(shop_id: string): Promise<Result<Order[]>> {
    const r = await this.inspect(shop_id); return r.error ? r : { error: false, data: r.data.orders };
  }
  async getOrder(shop_id: string, order_id: string): Promise<Result<OrderDetail>> {
    if (!validId(order_id)) return failure('INVALID_REQUEST', 'Invalid request');
    const r = await this.inspect(shop_id);
    if (r.error) return r;
    const order = r.data.orders.find(o => o.order_id === order_id);
    return order ? { error: false, data: { shop_id, source: 'simulation', order,
      items: r.data.items.filter(i => i.order_id === order_id),
      packages: r.data.packages.filter(p => p.order_id === order_id) } }
      : failure('ORDER_NOT_FOUND', 'Order not found');
  }
  async listPackages(shop_id: string): Promise<Result<Package[]>> {
    const r = await this.inspect(shop_id); return r.error ? r : { error: false, data: r.data.packages };
  }
  async listTracking(shop_id: string, package_id: string): Promise<Result<TrackingEvent[]>> {
    if (!validId(package_id)) return failure('INVALID_REQUEST', 'Invalid request');
    const r = await this.inspect(shop_id);
    if (r.error) return r;
    if (!r.data.packages.some(p => p.package_id === package_id)) return failure('PACKAGE_NOT_FOUND', 'Package not found');
    return { error: false, data: r.data.tracking.filter(t => t.package_id === package_id)
      .sort((a, b) => a.occurred_at - b.occurred_at) };
  }
  async getSyncStates(shop_id: string): Promise<Result<SyncState[]>> {
    const r = await this.inspect(shop_id); return r.error ? r : { error: false, data: r.data.sync };
  }
  async getTimeoutAlerts(shop_id: string, now: number, thresholds: Partial<TimeoutThresholds> = {}): Promise<Result<TimeoutAlert[]>> {
    return this.summarizeTimeoutAlerts([shop_id], now, thresholds);
  }
  async summarize(shop_ids: readonly string[]): Promise<Result<OrderSnapshot[]>> {
    if (!Array.isArray(shop_ids) || !shop_ids.every(validId)) return failure('INVALID_REQUEST', 'Invalid request');
    const ids = [...new Set(shop_ids)]; // Capture explicit scope before the first await.
    const rows: OrderSnapshot[] = [];
    for (const id of ids) {
      const r = await this.inspect(id);
      if (r.error) return r; // No partial cross-shop output on failure.
      rows.push(r.data);
    }
    return { error: false, data: rows };
  }
  async summarizeTimeoutAlerts(shop_ids: readonly string[], now: number,
    thresholds: Partial<TimeoutThresholds> = {}): Promise<Result<TimeoutAlert[]>> {
    let settings: TimeoutThresholds;
    try {
      if (!validTime(now)) throw new Error('Invalid clock');
      settings = resolveTimeoutThresholds(thresholds); // Capture before awaiting repository.
    } catch { return failure('INVALID_REQUEST', 'Invalid request'); }
    const r = await this.summarize(shop_ids);
    return r.error ? r : { error: false, data: r.data.flatMap(s => detectTimeoutAlerts(s.shop_id, s, now, settings)) };
  }
}
