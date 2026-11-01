export interface ShopToken {
  shop_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: number; // Unix milliseconds; unlike signing's Unix seconds.
}
export interface TokenStore {
  get(shop_id: string): Promise<ShopToken | undefined>;
  set(shop_id: string, token: ShopToken): Promise<void>;
}
export function validToken(token: ShopToken, shop_id: string): boolean {
  return token.shop_id === shop_id && !!token.access_token && !!token.refresh_token && Number.isFinite(token.expires_at);
}
/** TEST ONLY: volatile copies, no logging/files. Encrypted persistence is deferred. */
export class MemoryTokenStore implements TokenStore {
  private readonly tokens = new Map<string, ShopToken>();
  async get(shop_id: string) { const token = this.tokens.get(shop_id); return token ? { ...token } : undefined; }
  async set(shop_id: string, token: ShopToken) {
    if (!shop_id.trim() || !validToken(token, shop_id)) throw new Error('Invalid shop token');
    this.tokens.set(shop_id, { ...token });
  }
}
