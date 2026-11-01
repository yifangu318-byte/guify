import assert from 'node:assert/strict';

// Run against `npx wrangler dev --local` (never a production URL).
const base = new URL(process.argv[2] ?? 'http://127.0.0.1:8787');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname));
const cases = [
  ['/health', 200, 'application/json', body => assert.equal(JSON.parse(body).status, 'ok')],
  ['/web/', 200, 'text/html', body => assert.match(body, /MUSE ERP/)],
  ['/web/orders', 200, 'text/html', body => assert.match(body, /订单列表/)],
  ['/api/shops/demo/orders', 401, 'application/json'],
  ['/missing', 404, 'application/json', body => assert.equal(JSON.parse(body).code, 'NOT_FOUND')],
  ['/api/tiktok/callback', 400, 'application/json'],
  ['/api/tiktok/callback?code=smoke&state=smoke', 501, 'application/json'],
];
for (const [path, status, contentType, check] of cases) {
  const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, status, path);
  assert.ok(response.headers.get('content-type')?.startsWith(contentType), path);
  check?.(await response.text());
  console.log(`PASS ${path}: ${status}`);
}
// Exercise reuse of the initialized server across concurrent requests.
await Promise.all(Array.from({ length: 8 }, async () => {
  const response = await fetch(new URL('/health', base), { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).service, 'muse-erp');
}));
console.log('PASS 8 concurrent health requests');
