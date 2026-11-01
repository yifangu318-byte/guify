import type { shops } from '../db/schema.js';

/** Field types follow the T1 shops schema; no tokens belong in this module. */
export type Shop = Pick<typeof shops.$inferSelect, 'id' | 'market' | 'shopCode' | 'shopName' | 'status'>;
export const authorizationStatuses = ['unauthorized', 'pending_verification', 'authorized', 'expired', 'revoked'] as const;
export type AuthorizationStatus = typeof authorizationStatuses[number];
export interface AuthorizationState {
  shop_id: string;
  status: AuthorizationStatus;
  expires_at: number | null; // Unix milliseconds, matching T2 token expiry units.
  source: 'explicit_input' | 'simulation';
}
export interface SyncState {
  shop_id: string;
  resource: string | null; // Unknown resource / not yet synchronized.
  last_success_at: number | null;
  last_cursor: string | null;
  // A safe category, never raw upstream messages or response bodies.
  last_error: 'SYNC_FAILED' | null;
}
export interface ShopSummary {
  shop_id: string;
  shop: Shop;
  authorization: AuthorizationState;
  sync: SyncState[];
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const time = (value: unknown) => value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);

/** Runtime checks apply to both explicit seeds and future repository implementations. */
export function validShop(value: unknown): value is Shop {
  return record(value) && [value.id, value.market, value.shopCode, value.shopName, value.status].every(text);
}
export function validAuthorization(value: unknown): value is AuthorizationState {
  return record(value) && text(value.shop_id) && authorizationStatuses.some(status => status === value.status)
    && time(value.expires_at) && (value.source === 'explicit_input' || value.source === 'simulation');
}
export function validSyncStates(value: unknown): value is SyncState[] {
  if (!Array.isArray(value)) return false;
  const resources = new Set<string | null>();
  for (const state of value) {
    if (!record(state) || !text(state.shop_id) || (state.resource !== null && !text(state.resource))
      || resources.has(state.resource) || !time(state.last_success_at)
      || (state.last_cursor !== null && typeof state.last_cursor !== 'string')
      || (state.last_error !== null && state.last_error !== 'SYNC_FAILED')) return false;
    resources.add(state.resource);
  }
  return true;
}
