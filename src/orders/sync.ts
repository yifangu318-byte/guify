import type { Result } from '../tiktok/client.js';
import { copySnapshot, emptySnapshot, orderResources, validId, validTime, type OrderSnapshot } from './models.js';
import { MemoryOrderRepository, type OrderRepository } from './repository.js';

/** Simulation snapshots only; no adapter, credentials, network or official API. */
export interface OrderSyncSource {
  readonly source: 'simulation';
  readSnapshot(shop_id: string): Promise<OrderSnapshot>;
}
export class MemoryOrderSyncSource implements OrderSyncSource {
  readonly source = 'simulation';
  private readonly repository: MemoryOrderRepository;
  constructor(seeds: readonly OrderSnapshot[] = []) { this.repository = new MemoryOrderRepository(seeds); }
  async readSnapshot(shop_id: string) {
    const row = await this.repository.getSnapshot(shop_id);
    if (!row) throw new Error('Simulation snapshot unavailable');
    return row;
  }
}

export class OrderSync {
  private readonly queues = new Map<string, Promise<void>>();
  constructor(private readonly repository: OrderRepository, private readonly source: OrderSyncSource,
    private readonly options: { now?: () => number } = {}) {}

  async syncShop(shop_id: string): Promise<Result<OrderSnapshot>> {
    if (!validId(shop_id)) return { error: true, code: 'INVALID_REQUEST', message: 'Invalid request' };
    const previous = this.queues.get(shop_id) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>(resolve => { release = resolve; });
    this.queues.set(shop_id, tail);
    await previous;
    try { return await this.synchronize(shop_id); }
    finally { release(); if (this.queues.get(shop_id) === tail) this.queues.delete(shop_id); }
  }

  private async synchronize(shop_id: string): Promise<Result<OrderSnapshot>> {
    let prior: OrderSnapshot;
    const failure = { error: true as const, code: 'ORDER_SYNC_FAILED', message: 'Order simulation sync failed' };
    try {
      prior = copySnapshot(await this.repository.getSnapshot(shop_id) ?? emptySnapshot(shop_id), shop_id);
    } catch { return failure; }
    try {
      if (this.source.source !== 'simulation') throw new Error('Invalid simulation source');
      const snapshot = copySnapshot(await this.source.readSnapshot(shop_id), shop_id);
      const now = (this.options.now ?? Date.now)();
      if (!validTime(now)) throw new Error('Invalid sync clock');
      snapshot.sync = snapshot.sync.filter(s => s.resource !== null)
        .map(s => ({ ...s, last_success_at: now, last_error: null }));
      await this.repository.replaceSnapshot(shop_id, copySnapshot(snapshot, shop_id));
      return { error: false, data: snapshot };
    } catch {
      try {
        prior.sync = prior.sync.map(s => ({ ...s, last_error: 'SYNC_FAILED' }));
        await this.repository.replaceSnapshot(shop_id, prior);
      } catch { /* Failure remains visible even when storage is unavailable. */ }
      return failure;
    }
  }
}

export interface SimulationOrderEvent {
  source: 'simulation'; shop_id: string; event_id: string; resource: typeof orderResources[number];
}

/** Local webhook reception + polling skeleton. Events are hints, never trusted
 * business payloads. Both paths reconcile a full snapshot through the same queue.
 * No HTTP receiver, official webhook verification, scheduler or background job.
 */
export class OrderReconciliation {
  constructor(private readonly sync: OrderSync) {}
  async receiveWebhook(event: SimulationOrderEvent): Promise<Result<OrderSnapshot>> {
    if (!event || event.source !== 'simulation' || !validId(event.shop_id) || !validId(event.event_id)
      || !orderResources.some(resource => resource === event.resource)) {
      return { error: true, code: 'INVALID_REQUEST', message: 'Invalid request' };
    }
    return this.sync.syncShop(event.shop_id);
  }
  async pollShop(shop_id: string): Promise<Result<OrderSnapshot>> { return this.sync.syncShop(shop_id); }
}
