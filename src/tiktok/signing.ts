import { createHmac, timingSafeEqual } from 'node:crypto';

/** DRAFT: pending Partner Center official documentation + real shop samples in T10.
 * GET-only draft: Unix seconds (integer), raw strings, case-sensitive ASCII key
 * ordering; exclude sign/access_token, concatenate path + key/value pairs,
 * wrap with secret, then HMAC-SHA256(secret). No URL encoding or body here.
 * This describes our candidate algorithm, NOT official verification.
 */
export function signDraft(path: string, params: Readonly<Record<string, string>>, secret: string, timestamp: number): string {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || !/^\/[A-Za-z0-9/_-]*$/.test(path) || !secret) {
    throw new Error('Invalid draft signing input');
  }
  const values = { ...params, timestamp: String(timestamp) };
  const canonical = Object.keys(values).filter(key => key !== 'sign' && key !== 'access_token').sort()
    .map(key => key + values[key as keyof typeof values]).join('');
  return createHmac('sha256', secret).update(secret + path + canonical + secret).digest('hex');
}

export function verifyDraft(path: string, params: Readonly<Record<string, string>>, secret: string, timestamp: number, signature: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(signature)) return false;
  return timingSafeEqual(Buffer.from(signDraft(path, params, secret, timestamp), 'hex'), Buffer.from(signature, 'hex'));
}
