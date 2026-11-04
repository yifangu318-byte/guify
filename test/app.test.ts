import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createLogStream, redact } from '../src/logging.js';

function capture() {
  let text = '';
  const stream = new Writable({ write(chunk, _encoding, callback) { text += chunk.toString(); callback(); } });
  return { stream, read: () => text };
}

test('configuration defaults and overrides', () => {
  assert.deepEqual(loadConfig({}), { port: 3000, host: '127.0.0.1' });
  assert.deepEqual(loadConfig({ PORT: '4000', HOST: 'localhost', DATABASE_URL: 'placeholder' }), { port: 4000, host: 'localhost', databaseUrl: 'placeholder' });
  assert.equal(loadConfig({ DATABASE_URL: '' }).databaseUrl, undefined);
});

test('configuration listens on all interfaces when PORT is set without HOST', () => {
  for (const PORT of ['4000', '3000', '0']) {
    assert.equal(loadConfig({ PORT }).host, '0.0.0.0');
  }
});

test('configuration explicit HOST wins with and without platform PORT', () => {
  for (const HOST of ['localhost', '127.0.0.1', '0.0.0.0']) {
    assert.equal(loadConfig({ HOST }).host, HOST);
    assert.equal(loadConfig({ PORT: '4000', HOST }).host, HOST);
  }
  assert.throws(() => loadConfig({ PORT: '4000', HOST: '' }), { message: 'Invalid HOST configuration' });
});

test('configuration keeps local loopback when HOST and PORT are unset', () => {
  assert.equal(loadConfig({ HOST: undefined, PORT: undefined }).host, '127.0.0.1');
});

test('invalid configuration never echoes input', () => {
  for (const PORT of ['placeholder-secret', '-1', '65536', '', '3.5']) {
    assert.throws(() => loadConfig({ PORT }), { message: 'Invalid PORT configuration' });
  }
  assert.throws(() => loadConfig({ HOST: '' }), { message: 'Invalid HOST configuration' });
});

test('health reports an unconfigured database', async t => {
  const app = buildApp(loadConfig({}), capture().stream);
  t.after(() => app.close());
  const response = await app.inject('/health');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: 'ok', service: 'muse-erp', version: '0.1.0', database: { status: 'not_configured' } });
});

for (const parameter of ['code', 'state'] as const) {
  test(`TikTok callback rejects missing, empty or blank ${parameter} without disclosure`, async t => {
    const logs = capture();
    const app = buildApp(loadConfig({}), logs.stream);
    t.after(() => app.close());
    const other = parameter === 'code' ? 'state' : 'code';
    for (const value of [undefined, '', '   ']) {
      const query = new URLSearchParams({ [other]: 'synthetic-callback-other' });
      if (value !== undefined) query.set(parameter, value);
      const response = await app.inject(`/api/tiktok/callback?${query}`);
      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.json(), { error: true, message: 'Invalid callback request', code: 'INVALID_REQUEST' });
      assert.ok(!/token|secret/i.test(response.body));
      assert.ok(!`${response.body}${logs.read()}`.includes('synthetic-callback-other'));
      assert.equal(response.headers.location, undefined);
    }
  });
}

test('TikTok callback rejects absent and repeated parameters with a generic response', async t => {
  const logs = capture();
  const app = buildApp(loadConfig({}), logs.stream);
  t.after(() => app.close());
  for (const query of ['', '?code=synthetic-first&code=synthetic-second&state=synthetic-state',
    '?code=synthetic-first&state=synthetic-second&state=synthetic-state']) {
    const response = await app.inject(`/api/tiktok/callback${query}`);
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), { error: true, message: 'Invalid callback request', code: 'INVALID_REQUEST' });
    assert.ok(!/token|secret/i.test(response.body));
    assert.ok(!`${response.body}${logs.read()}`.includes('synthetic-'));
  }
});

test('TikTok callback with a non-issued state returns state_unverified without disclosure (T10 replaces the old 501 placeholder)', async t => {
  const logs = capture();
  // 测试专用合成密钥，非真实密钥；仅用于验签路径，绝不对应任何真实店铺。
  const app = buildApp(loadConfig({}), logs.stream, {}, {}, { tiktok: { getSecret: () => 'synthetic-test-secret-t10-only' } });
  t.after(() => app.close());
  const response = await app.inject('/api/tiktok/callback?code=synthetic-callback-code&state=synthetic-callback-state');
  assert.equal(response.statusCode, 400);
  const body = response.json();
  assert.deepEqual(Object.keys(body).sort(), ['code', 'error', 'message']);
  assert.equal(body.error, true);
  assert.equal(body.code, 'STATE_UNVERIFIED');
  assert.equal(body.message, 'State verification failed');
  assert.ok(!`${response.body}${logs.read()}`.includes('synthetic-callback-'));
  assert.ok(logs.read().includes('state_unverified'));
  assert.equal(response.headers.location, undefined);
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('configured database is not claimed connected or exposed', async t => {
  const app = buildApp(loadConfig({ DATABASE_URL: 'postgresql://placeholder:placeholder@invalid/placeholder' }), capture().stream);
  t.after(() => app.close());
  const response = await app.inject('/health');
  assert.equal(response.json().database.status, 'configured_unverified');
  assert.ok(!response.body.includes('postgresql'));
});

test('unknown route has a fixed error envelope without echoing secrets', async t => {
  const logs = capture();
  const app = buildApp(loadConfig({}), logs.stream);
  t.after(() => app.close());
  const response = await app.inject({ url: '/missing?token=synthetic-credential', headers: { authorization: 'Bearer synthetic-credential' } });
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), { error: true, message: 'Route not found', code: 'NOT_FOUND' });
  assert.ok(!`${response.body}${logs.read()}`.includes('synthetic-credential'));
});

test('redaction masks sensitive keys recursively including arrays and mixed case', () => {
  const input = { nested: [{ AppSecret: 'a', access_token: 'b', PASSWORD: 'c', apiKey: 'd', shop_cipher: 'e', Authorization: 'f' }], safe: 'ok' };
  assert.deepEqual(redact(input), { nested: [{ AppSecret: '***', access_token: '***', PASSWORD: '***', apiKey: '***', shop_cipher: '***', Authorization: '***' }], safe: 'ok' });
  assert.equal(input.nested[0]?.AppSecret, 'a');
});

test('actual Fastify JSON logs redact fields and known credential strings', async t => {
  const logs = capture();
  const databaseUrl = 'postgresql://synthetic:synthetic-password@invalid/placeholder';
  const app = buildApp({ port: 0, host: '127.0.0.1', databaseUrl }, logs.stream);
  t.after(() => app.close());
  app.log.info({ nested: { apiKey: 'synthetic-key' }, details: databaseUrl }, 'Synthetic log');
  const record = JSON.parse(logs.read().trim());
  assert.equal(record.nested.apiKey, '***');
  assert.equal(record.details, '***');
  assert.equal(record.msg, 'Synthetic log');
});

test('unhandled errors expose neither error messages nor credentials in logs', async t => {
  const logs = capture();
  const app = buildApp(loadConfig({}), logs.stream);
  t.after(() => app.close());
  app.get('/synthetic-failure', async () => { throw new Error('synthetic-raw-credential'); });
  const response = await app.inject('/synthetic-failure');
  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.json(), { error: true, message: 'Internal server error', code: 'INTERNAL_ERROR' });
  assert.ok(!`${response.body}${logs.read()}`.includes('synthetic-raw-credential'));
});

test('malformed logs fail closed', () => {
  const logs = capture();
  createLogStream(logs.stream, {}).write('synthetic-raw-credential\n');
  assert.equal(JSON.parse(logs.read()).msg, 'Log serialization failed');
  assert.ok(!logs.read().includes('synthetic-raw-credential'));
});

test('website root uses a fixed local redirect and health can identify a deployed release',async t=>{
 const app=buildApp(loadConfig({}),capture().stream,{},{},{getRelease:()=> 'synthetic-release'});t.after(()=>app.close());
 const root=await app.inject('/?next=https://evil.invalid');assert.equal(root.statusCode,302);assert.equal(root.headers.location,'/web/');
 assert.equal((await app.inject('/health')).json().release,'synthetic-release');
});
