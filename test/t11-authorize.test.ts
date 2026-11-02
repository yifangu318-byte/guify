import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { verifyState, STATE_TTL_MS } from '../src/tiktok/crypto.js';

// T11 authorize endpoint tests. All values below are synthetic test-only
// placeholders; they never correspond to a real app, shop, secret, or token.
const TEST_SECRET = 'synthetic-test-secret-t11-authorize-only';
const TEST_SERVICE_ID = 'synthetic-service-id-t11-authorize-only';

function capture() {
  let text = '';
  const stream = new Writable({ write(chunk, _encoding, callback) { text += chunk.toString(); callback(); } });
  return { stream, read: () => text };
}

function appWith(tiktok: Record<string, unknown>, logs: ReturnType<typeof capture>) {
  // @ts-expect-error test-only runtime shape, matching buildApp's TiktokRuntime
  return buildApp(loadConfig({}), logs.stream, {}, {}, { tiktok });
}

test('T11 authorize rejects missing, blank, or non-allowlisted market with 400 and no redirect', async t => {
  const logs = capture();
  const app = appWith({ getSecret: () => TEST_SECRET, getServiceId: () => TEST_SERVICE_ID }, logs);
  t.after(() => app.close());
  for (const query of [
    '',
    '?market=',
    '?market=%20%20%20',
    '?market=US',
    '?market=CN',
    '?market=my',
    '?market=MY&market=PH',
  ]) {
    const response = await app.inject(`/api/tiktok/authorize${query}`);
    assert.equal(response.statusCode, 400, query);
    assert.deepEqual(response.json(), { error: true, message: 'Invalid authorize request', code: 'INVALID_REQUEST' });
    assert.equal(response.headers.location, undefined);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
});

test('T11 authorize without encryption key returns 503 TOKEN_ENCRYPTION_KEY_MISSING and no redirect', async t => {
  const logs = capture();
  const app = appWith({ getSecret: () => undefined, getServiceId: () => TEST_SERVICE_ID }, logs);
  t.after(() => app.close());
  const response = await app.inject('/api/tiktok/authorize?market=MY');
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().code, 'TOKEN_ENCRYPTION_KEY_MISSING');
  assert.equal(response.headers.location, undefined);
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('T11 authorize without Service ID returns 503 SERVICE_ID_MISSING and no redirect', async t => {
  for (const serviceId of [undefined, '   ']) {
    const logs = capture();
    const app = appWith({ getSecret: () => TEST_SECRET, getServiceId: () => serviceId }, logs);
    t.after(() => app.close());
    const response = await app.inject('/api/tiktok/authorize?market=MY');
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().code, 'SERVICE_ID_MISSING');
    assert.equal(response.headers.location, undefined);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
});

test('T11 authorize with valid MY returns 302 to ROW host with service_id and state only', async t => {
  const logs = capture();
  // No getAppKey / getAppSecret getters: the endpoint must not need them.
  const app = appWith({ getSecret: () => TEST_SECRET, getServiceId: () => TEST_SERVICE_ID }, logs);
  t.after(() => app.close());
  const response = await app.inject('/api/tiktok/authorize?market=MY');
  assert.equal(response.statusCode, 302);
  assert.equal(response.headers['cache-control'], 'no-store');
  const location = response.headers.location as string;
  const url = new URL(location);
  assert.equal(`${url.protocol}//${url.host}${url.pathname}`, 'https://services.tiktokshop.com/open/authorize');
  assert.deepEqual([...url.searchParams.keys()].sort(), ['service_id', 'state']);
  assert.equal(url.searchParams.get('service_id'), TEST_SERVICE_ID);
  assert.ok(url.searchParams.get('state'));
  assert.ok(!location.includes('app_key'));
  assert.ok(!location.includes('redirect_uri'));
  assert.ok(!location.includes('scope'));
  assert.ok(!location.includes('services.us.tiktokshop.com'));
});

test('T11 authorize state verifies with verifyState, carries market, and expires in 10 minutes', async t => {
  const logs = capture();
  const app = appWith({ getSecret: () => TEST_SECRET, getServiceId: () => TEST_SERVICE_ID }, logs);
  t.after(() => app.close());
  for (const market of ['MY', 'PH', 'SG', 'TH', 'VN']) {
    const response = await app.inject(`/api/tiktok/authorize?market=${market}`);
    assert.equal(response.statusCode, 302, market);
    const state = new URL(response.headers.location as string).searchParams.get('state') as string;
    const now = Date.now();
    const verified = verifyState(TEST_SECRET, state, now);
    assert.deepEqual(verified, { valid: true, market, expiresAt: verified.valid ? verified.expiresAt : 0 });
    if (verified.valid) {
      assert.ok(verified.expiresAt > now);
      assert.ok(verified.expiresAt - now <= STATE_TTL_MS);
      assert.ok(verified.expiresAt - now > STATE_TTL_MS - 60_000);
      assert.equal(verified.shopCode, undefined);
    }
    assert.deepEqual(verifyState('synthetic-wrong-secret-t11-only', state, now).valid, false);
  }
});

test('T11 authorize log contains event and market only, never state or Service ID', async t => {
  const logs = capture();
  const app = appWith({ getSecret: () => TEST_SECRET, getServiceId: () => TEST_SERVICE_ID }, logs);
  t.after(() => app.close());
  const response = await app.inject('/api/tiktok/authorize?market=MY');
  assert.equal(response.statusCode, 302);
  const state = new URL(response.headers.location as string).searchParams.get('state') as string;
  const text = logs.read();
  assert.ok(text.includes('tiktok_authorize_issued'));
  assert.ok(text.includes('MY'));
  assert.ok(!text.includes(state));
  assert.ok(!text.includes(TEST_SERVICE_ID));
  assert.ok(!text.includes(TEST_SECRET));
});

test('T11 authorize ignores unknown params and never forwards shop_code or redirect_uri', async t => {
  const logs = capture();
  const app = appWith({ getSecret: () => TEST_SECRET, getServiceId: () => TEST_SERVICE_ID }, logs);
  t.after(() => app.close());
  const response = await app.inject('/api/tiktok/authorize?market=MY&shop_code=synthetic-shop&redirect_uri=https%3A%2F%2Fexample.invalid%2Fcb&scope=synthetic-scope');
  assert.equal(response.statusCode, 302);
  const url = new URL(response.headers.location as string);
  assert.deepEqual([...url.searchParams.keys()].sort(), ['service_id', 'state']);
  assert.ok(!url.toString().includes('synthetic-shop'));
  assert.ok(!url.toString().includes('example.invalid'));
});
