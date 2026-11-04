import {test} from 'node:test';
import assert from 'node:assert/strict';
import {handleTikTokCallback} from '../src/tiktok/callback.js';
import {getValidAccessToken} from '../src/tiktok/refresh.js';
import {fixture,TOKEN,SHOP,json,SECRET} from './oauth-fixture.js';
async function authorized(){const f=await fixture();assert.equal((await handleTikTokCallback(f.query,f.deps)).status,200);return {...f,options:{appKey:f.deps.appKey,appSecret:f.deps.appSecret,secret:SECRET,shopId:SHOP.id,fetchImpl:f.deps.fetchImpl,now:f.deps.now}};}
const fresh=(now:number,extra={})=>({...TOKEN,access_token:'synthetic-access-new',refresh_token:'synthetic-refresh-new',access_token_expire_in:Math.floor(now/1000)+3600,refresh_token_expire_in:Math.floor(now/1000)+86400,...extra});
test('fresh encrypted authorization serves internal access without refresh network',async()=>{
 const f=await authorized();assert.equal(await getValidAccessToken(f.store,f.options),TOKEN.access_token);assert.equal(f.calls.length,2);
});
test('near-expiry refresh rotates and persists both tokens with version CAS',async()=>{
 const f=await authorized();f.tick(3590000);let count=0;
 f.options.fetchImpl=async(url,init)=>{count++;const u=new URL(String(url));assert.equal(u.pathname,'/api/v2/token/refresh');assert.equal(u.searchParams.get('refresh_token'),TOKEN.refresh_token);assert.equal(u.searchParams.get('grant_type'),'refresh_token');assert.equal(init?.redirect,'manual');return json(fresh(f.deps.now()));};
 assert.equal(await getValidAccessToken(f.store,f.options),'synthetic-access-new');const row=await f.store.authorization(f.options.appKey,SHOP.id);assert.equal(row!.version,2);assert.equal(row!.refresh_owner,null);assert.equal(row!.status,'active');
 assert.equal(await getValidAccessToken(f.store,f.options),'synthetic-access-new');assert.equal(count,1);
});
test('parallel refresh claim permits one request and never sends old refresh twice',async()=>{
 const f=await authorized();f.tick(3590000);let release!:()=>void;const gate=new Promise<void>(r=>release=r);let calls=0;
 f.options.fetchImpl=async()=>{calls++;await gate;return json(fresh(f.deps.now()));};const first=getValidAccessToken(f.store,f.options);
 while(!(await f.store.authorization(f.options.appKey,SHOP.id))!.refresh_owner) await new Promise(r=>setTimeout(r,1));
 await assert.rejects(()=>getValidAccessToken(f.store,f.options));assert.equal(calls,1);release();assert.equal(await first,'synthetic-access-new');
});
for(const scenario of ['network','wrong-subject','lost-scope','expired','malformed']) test(`refresh ${scenario} requires reauthorization and never retries`,async()=>{
 const f=await authorized();f.tick(3590000);let calls=0;f.options.fetchImpl=async()=>{calls++;if(scenario==='network')throw new Error('synthetic-private-token');
 const changes=scenario==='wrong-subject'?{open_id:'other'}:scenario==='lost-scope'?{granted_scopes:['seller.product.basic']}:scenario==='expired'?{refresh_token_expire_in:1}:{};
 return scenario==='malformed'?new Response('{}'):json(fresh(f.deps.now(),changes));};
 await assert.rejects(()=>getValidAccessToken(f.store,f.options));await assert.rejects(()=>getValidAccessToken(f.store,f.options));assert.equal(calls,1);
 const row=await f.store.authorization(f.options.appKey,SHOP.id);assert.equal(row!.status,'reauthorize_required');assert.equal(row!.refresh_owner,null);
});
test('crashed refresh lease is never stolen or replayed after expiry',async()=>{
 const f=await authorized();await f.db.prepare('UPDATE authorizations SET refresh_owner=?,refresh_until=?').bind('synthetic-crashed-owner',f.deps.now()-1).run();
 await assert.rejects(()=>getValidAccessToken(f.store,f.options));assert.equal(f.calls.length,2);assert.equal((await f.store.authorization(f.options.appKey,SHOP.id))!.status,'reauthorize_required');
});
test('expired refresh token and unrelated shop never reach network',async()=>{
 const f=await authorized();f.tick(86400001);await assert.rejects(()=>getValidAccessToken(f.store,f.options));await assert.rejects(()=>getValidAccessToken(f.store,{...f.options,shopId:'other'}));assert.equal(f.calls.length,2);
});
test('lost CAS cannot overwrite a newer authorization or return uncommitted access',async()=>{
 const f=await authorized();f.tick(3590000);f.options.fetchImpl=async()=>{await f.db.prepare('UPDATE authorizations SET version=version+1,refresh_owner=NULL').run();return json(fresh(f.deps.now()));};
 await assert.rejects(()=>getValidAccessToken(f.store,f.options));const row=await f.store.authorization(f.options.appKey,SHOP.id);assert.equal(row!.version,2);assert.equal(row!.status,'active');
});

test('refresh failure permits explicit new authorization without replaying the old refresh',async()=>{
 const f=await authorized();f.tick(3590000);f.options.fetchImpl=async()=>{throw new Error('synthetic-failure');};await assert.rejects(()=>getValidAccessToken(f.store,f.options));
 const {issueState}=await import('../src/tiktok/crypto.js');const {BROWSER,TARGET}=await import('./oauth-fixture.js');const state=issueState(SECRET,{now:f.deps.now,market:'MY'}).state;
 await f.store.issue(state,BROWSER,f.deps.appKey,TARGET,f.deps.now()+600000,f.deps.now());
 f.deps.fetchImpl=async(url)=>String(url).includes('/token/')?json(fresh(f.deps.now())):json({shops:[SHOP]});
 assert.equal((await handleTikTokCallback({...f.query,state},f.deps)).status,200);assert.equal((await f.store.authorization(f.options.appKey,SHOP.id))!.status,'active');
});
