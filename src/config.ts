export interface Config {
  port: number;
  host: string;
  databaseUrl?: string;
  publicUrl?: string;
  tiktokRedirectUri?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const portText = env.PORT ?? '3000';
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('Invalid PORT configuration');
  }
  // Explicit HOST always wins. A platform-supplied PORT (including Railway)
  // selects all interfaces; with neither variable, local dev stays on loopback.
  const host = env.HOST ?? (env.PORT !== undefined ? '0.0.0.0' : '127.0.0.1');
  if (!host.trim()) throw new Error('Invalid HOST configuration');
  const databaseUrl = env.DATABASE_URL?.trim();
  const publicUrl = env.PUBLIC_URL?.trim().replace(/\/+$/, '');
  const tiktokRedirectUri = env.TIKTOK_REDIRECT_URI?.trim()
    || (publicUrl ? `${publicUrl}/api/tiktok/callback` : undefined);
  return { port, host, ...(databaseUrl ? { databaseUrl } : {}),
    ...(publicUrl ? { publicUrl } : {}), ...(tiktokRedirectUri ? { tiktokRedirectUri } : {}) };
}
