import type { Result } from '../tiktok/client.js';

export class GatewayError extends Error {
  constructor(readonly statusCode: number) { super('Gateway request failed'); }
}
// Exactly T1's fixed envelopes; never forward a service error or raw exception.
export function errorBody(statusCode: number): Extract<Result<never>, { error: true }> {
  if (statusCode === 404) return { error: true, message: 'Route not found', code: 'NOT_FOUND' };
  if (statusCode >= 500) return { error: true, message: 'Internal server error', code: 'INTERNAL_ERROR' };
  return { error: true, message: 'Invalid request', code: 'INVALID_REQUEST' };
}
export function unwrap<T>(result: Result<T>): T {
  if (!result.error) return result.data;
  if (result.code === 'SHOP_NOT_FOUND' || result.code === 'ORDER_NOT_FOUND') throw new GatewayError(404);
  throw new GatewayError(500);
}
