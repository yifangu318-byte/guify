import { copySnapshot, validTime, type OrderSnapshot } from './models.js';

export interface TimeoutThresholds { pendingShipmentHours: number; logisticsStalledHours: number }
export const defaultTimeoutThresholds: Readonly<TimeoutThresholds> = Object.freeze({
  pendingShipmentHours: 48, logisticsStalledHours: 72,
});
export type TimeoutAlert = {
  shop_id: string; order_id: string; triggered_at: number; threshold_hours: number;
} & ({ type: 'pending_shipment_timeout' } | { type: 'logistics_stalled'; package_id: string });

export function resolveTimeoutThresholds(input: Partial<TimeoutThresholds> = {}): TimeoutThresholds {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid timeout thresholds');
  const result = { pendingShipmentHours: input.pendingShipmentHours ?? defaultTimeoutThresholds.pendingShipmentHours,
    logisticsStalledHours: input.logisticsStalledHours ?? defaultTimeoutThresholds.logisticsStalledHours };
  // Positive integer hours; ensure millisecond conversion cannot overflow.
  for (const key of ['pendingShipmentHours', 'logisticsStalledHours'] as const) {
    if ((key in input && input[key] === undefined) || (key in input && input[key] === null)
      || !Number.isSafeInteger(result[key]) || result[key] <= 0 || !Number.isSafeInteger(result[key] * 3_600_000)) {
      throw new Error('Invalid timeout thresholds');
    }
  }
  return result;
}

/** Pure rule, Unix milliseconds. Strictly MORE than threshold; equality is safe.
 * Pending shipments use order_time. In-transit packages use the latest event,
 * falling back to shipped_at only when no events exist. Unknown times never
 * invent an alert. triggered_at is the supplied detection time, not a deadline.
 */
export function detectTimeoutAlerts(shop_id: string, value: OrderSnapshot, now: number,
  thresholds: Partial<TimeoutThresholds> = {}): TimeoutAlert[] {
  if (!validTime(now)) throw new Error('Invalid timeout clock');
  const settings = resolveTimeoutThresholds(thresholds), snapshot = copySnapshot(value, shop_id);
  const alerts: TimeoutAlert[] = [];
  const orders = new Map(snapshot.orders.map(o => [o.order_id, o]));
  for (const order of snapshot.orders) {
    if (order.status === 'pending_shipment' && now - order.order_time > settings.pendingShipmentHours * 3_600_000) {
      alerts.push({ shop_id, order_id: order.order_id, type: 'pending_shipment_timeout',
        triggered_at: now, threshold_hours: settings.pendingShipmentHours });
    }
  }
  const latest = new Map<string, number>();
  for (const event of snapshot.tracking) {
    latest.set(event.package_id, Math.max(latest.get(event.package_id) ?? 0, event.occurred_at));
  }
  for (const parcel of snapshot.packages) {
    const status = orders.get(parcel.order_id)!.status;
    if (parcel.status !== 'in_transit' || status === 'delivered' || status === 'cancelled') continue;
    const last = latest.get(parcel.package_id) ?? parcel.shipped_at;
    if (last !== null && now - last > settings.logisticsStalledHours * 3_600_000) {
      alerts.push({ shop_id, order_id: parcel.order_id, package_id: parcel.package_id,
        type: 'logistics_stalled', triggered_at: now, threshold_hours: settings.logisticsStalledHours });
    }
  }
  return alerts;
}
