import { redact } from '../logging.js';
import { signDraft } from './signing.js';
import { validToken, type ShopToken, type TokenStore } from './tokens.js';

export interface ErrorEnvelope { error: true; message: string; code: string }
export type Result<T> = { error: false; data: T } | ErrorEnvelope;
const failure = (code: string, message: string): ErrorEnvelope => ({ error: true, message, code });
export interface AdapterOptions {
  appKey: string; appSecret: string; store: TokenStore;
  // Deliberately no default fetch/base URL: T2 performs no real network requests.
  transport: (request: { method: 'GET'; shop_id: string; path: string; params: Readonly<Record<string, string>>; access_token: string }) => Promise<{ status: number; data?: unknown }>;
  refresh: (shop_id: string, token: Readonly<ShopToken>) => Promise<ShopToken>;
  now?: () => number; sleep?: (ms: number) => Promise<void>; random?: () => number;
  log?: (record: unknown) => void;
  refreshAheadMs?: number; minIntervalMs?: number;
  maxRetries?: number; backoffBaseMs?: number; backoffCapMs?: number;
}

export class TikTokReadOnlyAdapter {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly settings: Required<Pick<AdapterOptions, 'refreshAheadMs' | 'minIntervalMs' | 'maxRetries' | 'backoffBaseMs' | 'backoffCapMs'>>;
  private readonly queues = new Map<string, Promise<void>>();
  private readonly lastAttempt = new Map<string, number>();
  constructor(private readonly options: AdapterOptions) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
    this.settings = { refreshAheadMs: options.refreshAheadMs ?? 60_000, minIntervalMs: options.minIntervalMs ?? 100,
      maxRetries: options.maxRetries ?? 2, backoffBaseMs: options.backoffBaseMs ?? 250, backoffCapMs: options.backoffCapMs ?? 10_000 };
    if (!options.appKey || !options.appSecret || Object.values(this.settings).some(value => !Number.isSafeInteger(value) || value < 0) || this.settings.maxRetries > 10) {
      throw new Error('Invalid adapter configuration');
    }
  }
  async read<T = unknown>(request: { shop_id: string; path: string; params?: Readonly<Record<string, string>> }): Promise<Result<T>> {
    if (!request || typeof request.shop_id !== 'string' || !request.shop_id.trim() || !/^\/[A-Za-z0-9/_-]*$/.test(request.path)) {
      return failure('INVALID_REQUEST', 'Invalid request');
    }
    // Snapshot caller input before awaiting: caller mutations cannot change shop scope.
    const shop = request.shop_id, path = request.path, params = { ...request.params };
    if (Object.keys(params).some(key => ['shop_id', 'app_key', 'timestamp', 'sign', 'access_token', 'refresh_token', 'shop_cipher'].includes(key))) {
      return failure('INVALID_REQUEST', 'Invalid request');
    }
    // Serial per-shop queue also prevents duplicate refreshes and burst races.
    const previous = this.queues.get(shop) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>(resolve => { release = resolve; });
    this.queues.set(shop, tail);
    await previous;
    try { return await this.execute<T>(shop, path, params); }
    catch { return failure('ADAPTER_ERROR', 'Adapter request failed'); }
    finally { release(); if (this.queues.get(shop) === tail) this.queues.delete(shop); }
  }
  private async execute<T>(shop: string, path: string, params: Record<string, string>): Promise<Result<T>> {
    let token = await this.options.store.get(shop);
    if (!token || !validToken(token, shop)) return failure('SHOP_TOKEN_INVALID', 'Shop authorization unavailable');
    const renew = async (): Promise<boolean> => {
      try {
        const fresh = await this.options.refresh(shop, { ...token! });
        if (!validToken(fresh, shop) || fresh.expires_at <= this.now() + this.settings.refreshAheadMs) return false;
        await this.options.store.set(shop, fresh);
        token = { ...fresh };
        return true;
      } catch { return false; }
    };
    if (token.expires_at <= this.now() + this.settings.refreshAheadMs && !await renew()) {
      return failure('TOKEN_REFRESH_FAILED', 'Token refresh failed');
    }
    let retried401 = false, retries429 = 0;
    for (;;) {
      const last = this.lastAttempt.get(shop);
      if (last !== undefined) await this.sleep(Math.max(0, last + this.settings.minIntervalMs - this.now()));
      this.lastAttempt.set(shop, this.now());
      const timestamp = Math.floor(this.now() / 1000);
      const signed = { ...params, shop_id: shop, app_key: this.options.appKey, timestamp: String(timestamp) };
      const response = await this.options.transport({ method: 'GET', shop_id: shop, path,
        params: { ...signed, sign: signDraft(path, signed, this.options.appSecret, timestamp) }, access_token: token.access_token });
      // Fixed fields only; never log tokens, request, response, or caught exceptions.
      try { this.options.log?.(redact({ event: 'tiktok_draft_response', status: response.status })); } catch { /* logging cannot affect retries */ }
      if (response.status === 401) {
        if (retried401) return failure('UNAUTHORIZED', 'Shop authorization rejected');
        retried401 = true;
        if (!await renew()) return failure('TOKEN_REFRESH_FAILED', 'Token refresh failed');
        continue;
      }
      if (response.status === 429) {
        if (retries429 >= this.settings.maxRetries) return failure('RATE_LIMITED', 'Shop rate limit exceeded');
        const ceiling = Math.min(this.settings.backoffCapMs, this.settings.backoffBaseMs * 2 ** retries429++);
        // Equal jitter in [ceiling/2, ceiling]; bounded exponential backoff.
        const random = this.random();
        if (!Number.isFinite(random) || random < 0 || random > 1) return failure('ADAPTER_ERROR', 'Adapter request failed');
        await this.sleep(Math.floor(ceiling / 2 + random * ceiling / 2));
        continue;
      }
      if (response.status < 200 || response.status >= 300 || !Number.isInteger(response.status)) return failure('UPSTREAM_ERROR', 'Upstream request failed');
      return { error: false, data: response.data as T };
    }
  }
}
