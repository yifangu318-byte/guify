import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { buildApp, type TiktokRuntime } from '../src/app.js';
import { loadConfig } from '../src/config.js';

// Synthetic fetches only; no upstream or database access.
const NOW = 1_790_000_000_123;
const RELAY_URL = 'https://synthetic-diag-relay.invalid';
const AUTH_URL = 'https://auth.tiktok-shops.com/api/v2/token/get?app_key=diag-fake&app_secret=diag-fake&auth_code=diag-fake&grant_type=authorized_code';
const QUERY = `app_key=diag-fake&timestamp=${Math.floor(NOW / 1000)}&sign=diag-fake`;
const SHOPS_URL = `https://open-api.tiktokglobalshop.com/authorization/202309/shops?${QUERY}`;
const HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};
const IDS = ['auth-no-headers', 'shops-no-headers', 'shops-headers', 'relay-health-no-headers', 'relay-forward-fake-secret', 'auth-headers'];

function fixture(fetchImpl: typeof fetch, overrides: Partial<TiktokRuntime> = {}) {
  let logs = '';
  const stream = new Writable({ write(chunk, _encoding, done) { logs += chunk.toString(); done(); } });
  const forbidden = () => { assert.fail('diagnostics must not read credentials or the database'); };
  const app = buildApp(loadConfig({}), stream, {}, {}, { tiktok: {
    fetchImpl, now: () => NOW, getRelayUrl: () => RELAY_URL,
    getSecret: forbidden, getAppKey: forbidden, getAppSecret: forbidden,
    getRelaySecret: forbidden, getServiceId: forbidden, getDb: forbidden,
    ...overrides,
  } });
  return { app, readLogs: () => logs };
}

function responded(id: string, http: number) {
  return { id, responded: true, http, threw: null, skipped: false };
}

function skipped(id: string) {
  return { id, responded: false, http: null, threw: null, skipped: true };
}

test('T11 diag-fetch: six fixed probes run sequentially, report HTTP only, and never read response bodies', async t => {
  const statuses = [400, 403, 429, 200, 401, 302];
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const bodies = statuses.map(() => ({
    json: mock.fn(() => { assert.fail('must not call upstream json'); }),
    text: mock.fn(() => { assert.fail('must not call upstream text'); }),
  }));
  let active = 0;
  let maxActive = 0;
  const { app, readLogs } = fixture(async (url, init) => {
    const index = requests.length;
    requests.push({ url: String(url), init });
    maxActive = Math.max(maxActive, ++active);
    await Promise.resolve();
    active--;
    return {
      status: statuses[index], ...bodies[index],
      get body() { assert.fail('must not access upstream body'); },
      get ok() { assert.fail('only status is needed'); },
      get headers() { assert.fail('must not inspect upstream headers'); },
    } as unknown as Response;
  }, { getRelayUrl: () => ` \t${RELAY_URL}/// \n` });
  t.after(() => app.close());
  const response = await app.inject('/api/tiktok/diag-fetch');
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(response.json(), { probes: IDS.map((id, i) => responded(id, statuses[i]!)) });
  assert.equal(maxActive, 1);
  assert.deepEqual(requests.map(request => request.url), [AUTH_URL, SHOPS_URL, SHOPS_URL, `${RELAY_URL}/health`, `${RELAY_URL}/forward?${QUERY}`, AUTH_URL]);
  for (const [index, request] of requests.entries()) {
    assert.equal(request.init?.method, index === 4 ? 'POST' : 'GET');
    assert.equal(request.init?.redirect, 'manual');
    if ([0, 1, 3].includes(index)) assert.equal(request.init?.headers, undefined);
    if ([2, 5].includes(index)) assert.deepEqual(request.init?.headers, HEADERS);
    if (index !== 4) assert.equal(request.init?.body, undefined);
  }
  assert.deepEqual(requests[4]?.init?.headers, {
    ...HEADERS, 'x-tts-access-token': 'diag-fake', 'x-relay-secret': 'diag-fake', 'Content-Type': 'application/json',
  });
  assert.equal(requests[4]?.init?.body, '{"host":"open-api.tiktokglobalshop.com","path":"/authorization/202309/shops"}');
  for (const body of bodies) {
    assert.equal(body.json.mock.callCount(), 0);
    assert.equal(body.text.mock.callCount(), 0);
  }
  assert.doesNotMatch(response.body + readLogs(), /synthetic|diag-fake|Mozilla|application\/json|x-relay-secret|x-tts-access-token|https?:/i);
});

test('T11 diag-fetch: thrown fetches retain only safe constructor names and all six probes still run', async t => {
  const CustomError = class extends Error {};
  Object.defineProperty(CustomError, 'name', { value: 'synthetic-private-constructor' });
  const errors = [new TypeError(), new RangeError(), new DOMException(), new Error(), new CustomError(), new SyntaxError()];
  for (const error of errors) {
    Object.defineProperties(error, {
      name: { get() { assert.fail('must not read error name'); } },
      message: { get() { assert.fail('must not read error message'); } },
      stack: { get() { assert.fail('must not read error stack'); } },
    });
  }
  let calls = 0;
  const { app, readLogs } = fixture(async () => { throw errors[calls++]; });
  t.after(() => app.close());
  const response = await app.inject('/api/tiktok/diag-fetch');
  assert.equal(response.statusCode, 200);
  assert.equal(calls, 6);
  const names = ['TypeError', 'RangeError', 'DOMException', 'Error', 'Error', 'SyntaxError'];
  assert.deepEqual(response.json(), { probes: IDS.map((id, i) => ({ id, responded: false, http: null, threw: names[i], skipped: false })) });
  assert.doesNotMatch(response.body + readLogs(), /synthetic|message|stack|https?:/i);
});

test('T11 diag-fetch: a thrown probe does not prevent later HTTP responses', async t => {
  let calls = 0;
  const { app } = fixture(async () => {
    if (++calls === 3) throw new TypeError('synthetic-private-fetch-error');
    return new Response(null, { status: 401 });
  });
  t.after(() => app.close());
  const response = await app.inject('/api/tiktok/diag-fetch');
  assert.equal(calls, 6);
  assert.deepEqual(response.json(), { probes: IDS.map((id, i) => i === 2
    ? { id, responded: false, http: null, threw: 'TypeError', skipped: false }
    : responded(id, 401)) });
});

for (const value of ['synthetic-private-thrown-value', null]) {
  test(`T11 diag-fetch: non-Error ${value === null ? 'null' : 'string'} uses a fixed safe label`, async t => {
    const { app } = fixture(async () => { throw value; });
    t.after(() => app.close());
    const response = await app.inject('/api/tiktok/diag-fetch');
    assert.deepEqual(response.json(), { probes: IDS.map(id => ({ id, responded: false, http: null, threw: 'UnknownError', skipped: false })) });
  });
}

for (const relayUrl of [undefined, '', ' \t\n ']) {
  test(`T11 diag-fetch: relay URL ${JSON.stringify(relayUrl)} skips both relay probes and runs the other four`, async t => {
    const urls: string[] = [];
    const { app } = fixture(async url => {
      urls.push(String(url));
      return new Response(null, { status: 400 });
    }, { getRelayUrl: () => relayUrl });
    t.after(() => app.close());
    const response = await app.inject('/api/tiktok/diag-fetch');
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { probes: IDS.map(id => id.startsWith('relay-') ? skipped(id) : responded(id, 400)) });
    assert.deepEqual(urls, [AUTH_URL, SHOPS_URL, SHOPS_URL, AUTH_URL]);
  });
}

for (const relayUrl of [undefined, ` \t${RELAY_URL}/ `]) {
  test(`T11 diag-fetch: environment relay URL ${relayUrl === undefined ? 'absent' : 'configured'} is used without reading the real relay secret`, async t => {
    const previous = { url: process.env.RELAY_URL, secret: process.env.RELAY_SECRET };
    if (relayUrl === undefined) delete process.env.RELAY_URL;
    else process.env.RELAY_URL = relayUrl;
    process.env.RELAY_SECRET = 'synthetic-private-env-relay-secret';
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const { app, readLogs } = fixture(async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(null, { status: 401 });
    }, { getRelayUrl: undefined });
    try {
      const response = await app.inject('/api/tiktok/diag-fetch');
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { probes: IDS.map(id => !relayUrl && id.startsWith('relay-') ? skipped(id) : responded(id, 401)) });
      if (relayUrl) {
        assert.equal(requests[3]?.url, `${RELAY_URL}/health`);
        assert.equal(requests[4]?.url, `${RELAY_URL}/forward?${QUERY}`);
        assert.equal(new Headers(requests[4]?.init?.headers).get('x-relay-secret'), 'diag-fake');
      }
      assert.doesNotMatch(JSON.stringify(requests) + response.body + readLogs(), /synthetic-private-env-relay-secret/);
    } finally {
      await app.close();
      if (previous.url === undefined) delete process.env.RELAY_URL; else process.env.RELAY_URL = previous.url;
      if (previous.secret === undefined) delete process.env.RELAY_SECRET; else process.env.RELAY_SECRET = previous.secret;
    }
  });
}

test('T11 diag-fetch: query strings and incoming headers cannot change probe inputs', async t => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const { app, readLogs } = fixture(async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(null, { status: 200 });
  });
  t.after(() => app.close());
  await app.inject('/api/tiktok/diag-fetch');
  const baseline = requests.splice(0);
  const response = await app.inject({
    url: '/api/tiktok/diag-fetch?url=https://synthetic-input.invalid&RELAY_URL=https://synthetic-input.invalid&app_key=synthetic-input&sign=synthetic-input&timestamp=0&id=synthetic-input&id=other',
    headers: { 'x-relay-secret': 'synthetic-input', 'x-tts-access-token': 'synthetic-input', 'user-agent': 'synthetic-input' },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(requests, baseline);
  assert.doesNotMatch(response.body + readLogs(), /synthetic-input/);
});
