/** Bounded credential-bearing HTTP. No response body, URL or exception escapes. */
export class UpstreamError extends Error {
  constructor(readonly http: number | null, readonly category: string, readonly upstreamCode: number | null = null) {
    super('Upstream request failed');
  }
}
export async function requestJson(fetchImpl: typeof fetch, url: string, init: RequestInit = {}, timeoutMs = 8000): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = async () => {
    const response = await fetchImpl(url, { ...init, redirect: 'manual', signal: controller.signal });
    if (response.status >= 300 && response.status < 400) { void response.body?.cancel().catch(() => {}); throw new UpstreamError(response.status, 'redirect_rejected'); }
    if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new UpstreamError(response.status, 'http_error'); }
    const reader = response.body?.getReader();
    if (!reader) throw new UpstreamError(response.status, 'invalid_response');
    const cancel = () => { void reader.cancel().catch(() => {}); };
    controller.signal.addEventListener('abort',cancel,{once:true});
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 1024 * 1024) { await reader.cancel(); throw new UpstreamError(response.status, 'response_too_large'); }
        chunks.push(chunk.value);
      }
    } finally { controller.signal.removeEventListener('abort',cancel); reader.releaseLock(); }
    let payload: unknown;
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new UpstreamError(response.status, 'invalid_response'); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new UpstreamError(response.status, 'invalid_response');
    const row = payload as Record<string, unknown>;
    if (row.code !== 0 && row.code !== '0') throw new UpstreamError(response.status, 'business_error', typeof row.code === 'number' && Number.isSafeInteger(row.code) ? row.code : null);
    if (!row.data || typeof row.data !== 'object' || Array.isArray(row.data)) throw new UpstreamError(response.status, 'invalid_response');
    return row.data as Record<string, unknown>;
  };
  try {
    return await Promise.race([work(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new UpstreamError(null, 'timeout')); }, timeoutMs);
    })]);
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    throw new UpstreamError(null, 'network');
  } finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
}
