import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * T10 Token 加密与回调 state 签发（简体中文注释）。
 *
 * 密钥来源：只读 Workers env / 本地进程 env 里的 TOKEN_ENCRYPTION_KEY，
 * 绝不在代码、测试、文档、提交信息里放真实密钥、Token、App Secret。
 *
 * 密钥解析（兼容两档）：
 * - 64 位十六进制字符串：视为 32 字节原始密钥，直接使用；
 * - 其他字符串：先 SHA-256 派生 32 字节。
 * 注意：换密钥后，旧密钥加密的 Token 与旧密钥签发的 state 一律不可解、
 * 一律校验失败，这是预期行为，不是数据损坏；换密钥前必须先完成
 * 旧 Token 的重新授权或迁移，绝不能静默丢弃旧 Token 就宣称成功。
 *
 * 加密格式：AES-256-GCM，随机 12 字节 IV，输出为 base64(IV || 认证标签 16 字节 || 密文)。
 * 解密失败只返回通用错误，绝不回显密文、明文或密钥。
 */

export function deriveKey(secret: string): Buffer {
  if (!secret) throw new Error('Token encryption key is missing');
  if (/^[0-9a-fA-F]{64}$/.test(secret)) return Buffer.from(secret, 'hex');
  return createHash('sha256').update(secret, 'utf8').digest();
}

export function encryptToken(secret: string, plaintext: string): string {
  if (!plaintext) throw new Error('Token value is empty');
  const key = deriveKey(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

export function decryptToken(secret: string, blob: string): string {
  try {
    const key = deriveKey(secret);
    const raw = Buffer.from(blob, 'base64');
    if (raw.length < 12 + 16 + 1) throw new Error('Invalid encrypted token');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ciphertext = raw.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // 绝不回显密文或密钥；调用方只看到通用失败。
    throw new Error('Token decryption failed');
  }
}

/** state 签发用途区分字符串：防止该 HMAC 被挪用到其他用途。 */
export const STATE_PURPOSE = 'tiktok-oauth-state-v1';
/** state 有效期：10 分钟，过期即失效，防重放。 */
export const STATE_TTL_MS = 10 * 60 * 1000;

export interface IssuedState {
  state: string;
  shopCode?: string;
  market?: string;
  expiresAt: number;
}

function base64urlEncode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function base64urlDecode(text: string): string {
  return Buffer.from(text, 'base64url').toString('utf8');
}

export function issueState(secret: string, options: { now?: () => number; nonce?: string; shopCode?: string; market?: string } = {}): IssuedState {
  const now = options.now ?? Date.now;
  const issuedAt = now();
  const expiresAt = issuedAt + STATE_TTL_MS;
  const nonce = options.nonce ?? randomBytes(16).toString('hex');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(nonce)) throw new Error('Invalid state nonce');
  const payload: Record<string, unknown> = { exp: expiresAt, nonce };
  if (options.shopCode) payload.shop_code = options.shopCode;
  if (options.market) payload.market = options.market;
  const payloadText = base64urlEncode(JSON.stringify(payload));
  const key = deriveKey(secret);
  const signature = createHmac('sha256', key).update(`${STATE_PURPOSE}.${payloadText}`).digest('hex');
  return { state: `${payloadText}.${signature}`, ...(options.shopCode ? { shopCode: options.shopCode } : {}), ...(options.market ? { market: options.market } : {}), expiresAt };
}

export type StateVerification =
  | { valid: true; shopCode?: string; market?: string; expiresAt: number }
  | { valid: false; reason: 'malformed' | 'expired' | 'signature_mismatch' | 'too_far_future' };

export function verifyState(secret: string, state: string, nowMs: number): StateVerification {
  try {
    if (!secret || typeof state !== 'string') return { valid: false, reason: 'malformed' };
    const parts = state.split('.');
    if (parts.length !== 2) return { valid: false, reason: 'malformed' };
    const [payloadText, signature] = parts as [string, string];
    if (!/^[a-f0-9]{64}$/.test(signature)) return { valid: false, reason: 'signature_mismatch' };
    const key = deriveKey(secret);
    const expected = createHmac('sha256', key).update(`${STATE_PURPOSE}.${payloadText}`).digest('hex');
    if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'))) {
      return { valid: false, reason: 'signature_mismatch' };
    }
    const payload = JSON.parse(base64urlDecode(payloadText)) as Record<string, unknown>;
    const exp = payload.exp;
    const nonce = payload.nonce;
    if (!Number.isSafeInteger(exp) || typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(nonce)) {
      return { valid: false, reason: 'malformed' };
    }
    if ((exp as number) <= nowMs) return { valid: false, reason: 'expired' };
    if ((exp as number) - nowMs > STATE_TTL_MS) return { valid: false, reason: 'too_far_future' };
    const shopCode = typeof payload.shop_code === 'string' && payload.shop_code.trim() ? payload.shop_code : undefined;
    const market = typeof payload.market === 'string' && payload.market.trim() ? payload.market : undefined;
    return { valid: true, ...(shopCode ? { shopCode } : {}), ...(market ? { market } : {}), expiresAt: exp as number };
  } catch {
    return { valid: false, reason: 'malformed' };
  }
}
