import {test} from 'node:test';
import assert from 'node:assert/strict';
import {handleTikTokCallback} from '../src/tiktok/callback.js';
import {hash,unseal} from '../src/tiktok/vault.js';
import {fixture,SECRET,BROWSER,NOW,TOKEN,SHOP,json} from './oauth-fixture.js';
test('callback saves verified subject/cipher/scopes/expiries using AAD encryption',async()=>{
 const f=await fixture();const r=await handleTikTokCallback(f.query,f.deps);assert.equal(r.status,200);
 const row=await f.store.authorization('synthetic-app',SHOP.id);assert.equal(row?.status,'active');assert.equal(row?.refresh_expires_at,TOKEN.refresh_token_expire_in*1000);
 assert.equal(unseal(SECRET,row!.access_enc,`${row!.id}:access`),TOKEN.access_token);
 assert.throws(()=>unseal(SECRET,row!.access_enc,`${row!.id}:refresh`));
 assert.throws(()=>unseal('33'.repeat(32),row!.access_enc,`${row!.id}:access`));
 assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM shop_tokens').first()).n,0);
 assert.ok(!JSON.stringify(row).includes(TOKEN.access_token));assert.equal(f.calls.length,2);
});
test('callback always fetches shops even when token payload asserts a shop identity',async()=>{
 const f=await fixture();f.deps.fetchImpl=async(url,init)=>{f.calls.push({url:String(url),init});return String(url).includes('/token/')?json({...TOKEN,shop_id:SHOP.id,shops:[{shop_id:SHOP.id}]}):json({shops:[SHOP]});};
 assert.equal((await handleTikTokCallback(f.query,f.deps)).status,200);assert.equal(f.calls.length,2);
});
for(const change of [{browser:undefined},{browser:'33'.repeat(32)},{appKey:'other-app'},{targets:[]},{enabled:false},{environment:'simulation'}]) test(`callback context guard ${Object.keys(change)[0]}`,async()=>{
 const f=await fixture();assert.notEqual((await handleTikTokCallback(f.query,{...f.deps,...change})).status,200);assert.equal(f.calls.length,0);
});
test('expired state never consumes code',async()=>{const f=await fixture();f.tick(600000);assert.equal((await handleTikTokCallback(f.query,f.deps)).status,400);assert.equal(f.calls.length,0);});
test('duplicate success replays safe result only for same code and browser',async()=>{
 const f=await fixture();const one=await handleTikTokCallback(f.query,f.deps),two=await handleTikTokCallback(f.query,f.deps);
 assert.deepEqual(two.body,one.body);assert.equal(two.status,200);assert.equal(f.calls.length,2);
 assert.equal((await handleTikTokCallback({...f.query,code:'other-code'},f.deps)).status,409);
});
test('simultaneous callbacks atomically claim only one token exchange',async()=>{
 const f=await fixture();let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});const fetch=f.deps.fetchImpl;
 f.deps.fetchImpl=async(url,init)=>{await gate;return fetch(url,init);};
 const first=handleTikTokCallback(f.query,f.deps);while(!(await f.db.prepare("SELECT owner FROM oauth_sessions WHERE status='processing'").first())) await new Promise(r=>setTimeout(r,1));
 const second=await handleTikTokCallback(f.query,f.deps);assert.equal(second.status,409);release();assert.equal((await first).status,200);assert.equal(f.calls.length,2);
});
test('upstream failure consumes claim permanently and cannot replay one-time code',async()=>{
 const f=await fixture();let calls=0;f.deps.fetchImpl=async()=>{calls++;throw new Error('synthetic-private-code-token');};
 assert.equal((await handleTikTokCallback(f.query,f.deps)).status,502);assert.equal((await handleTikTokCallback(f.query,f.deps)).status,409);assert.equal(calls,1);
 assert.equal(await f.store.authorization('synthetic-app',SHOP.id),null);
});
test('request-time global fetch is used when no injected transport exists',async t=>{
 const f=await fixture();const {fetchImpl,...deps}=f.deps;t.mock.method(globalThis,'fetch',fetchImpl);
 assert.equal((await handleTikTokCallback(f.query,deps)).status,200);assert.equal(f.calls.length,2);
});
test('missing schema fails before token exchange',async()=>{
 const f=await fixture();const db={...f.db,batch:f.db.batch.bind(f.db),prepare(){throw new Error('schema unavailable');}};
 assert.equal((await handleTikTokCallback(f.query,{...f.deps,db})).status,503);assert.equal(f.calls.length,0);
});
