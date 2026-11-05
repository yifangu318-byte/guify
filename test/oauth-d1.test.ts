import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,NOW,SECRET,BROWSER,TARGET} from './oauth-fixture.js';
import {handleTikTokCallback} from '../src/tiktok/callback.js';
import {issueState} from '../src/tiktok/crypto.js';
test('actual D1 additive migration retains legacy row but never trusts it',async()=>{
 const f=await fixture();await f.db.prepare('INSERT INTO shop_tokens(shop_code,market,access_token_enc,refresh_token_enc,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').bind('legacy','MY','synthetic-old-ciphertext','synthetic-old-refresh',NOW+3600000,NOW,NOW).run();
 assert.equal(await f.store.authorization('synthetic-app','legacy'),null);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM shop_tokens').first()).n,1);
});
test('actual D1 batch failure rolls back token and shop writes, records failed session',async t=>{
 const f=await fixture();await f.db.prepare("CREATE TRIGGER synthetic_fail BEFORE INSERT ON authorized_shops BEGIN SELECT RAISE(ABORT,'synthetic-db-failure'); END").run();t.after(()=>f.db.prepare('DROP TRIGGER synthetic_fail').run());
 const result=await handleTikTokCallback(f.query,f.deps);assert.equal(result.status,503);
 assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM authorizations').first()).n,0);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM authorized_shops').first()).n,0);
 assert.equal((await f.db.prepare('SELECT status FROM oauth_sessions').first()).status,'failed');
});
test('actual schema-version absence prevents consuming code',async t=>{
 const f=await fixture();await f.db.prepare('DELETE FROM muse_schema_versions WHERE version=3').run();t.after(()=>f.db.prepare('INSERT INTO muse_schema_versions(version) VALUES (3)').run());
 assert.equal((await handleTikTokCallback(f.query,f.deps)).status,503);assert.equal(f.calls.length,0);
});
test('authorization issue limiter uses atomic SQL across concurrent requests',async()=>{
 const f=await fixture();const results=await Promise.allSettled(Array.from({length:15},async()=>{
 const state=issueState(SECRET,{now:()=>NOW,market:'MY'}).state;await f.store.issue(state,BROWSER,'synthetic-app',TARGET,NOW+600000,NOW);
 }));assert.equal(results.filter(x=>x.status==='fulfilled').length,9);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM oauth_sessions').first()).n,10);
});
test('live refresh claim cannot be overwritten by a simultaneous reauthorization',async()=>{
 const f=await fixture();assert.equal((await handleTikTokCallback(f.query,f.deps)).status,200);
 await f.db.prepare("UPDATE authorizations SET refresh_owner='synthetic-owner',refresh_until=?").bind(NOW+30000).run();
 const state=issueState(SECRET,{now:()=>NOW,market:'MY'}).state;await f.store.issue(state,BROWSER,'synthetic-app',TARGET,NOW+600000,NOW);
 const result=await handleTikTokCallback({...f.query,state},f.deps);assert.equal(result.status,503);assert.equal((await f.store.authorization('synthetic-app',TARGET.shopId))!.version,1);
});

test('first enrollment can learn app-specific subject only after verifying exact registered shop',async()=>{
 const f=await fixture();const target={...TARGET,subjectId:''};const state=issueState(SECRET,{now:()=>NOW,market:'MY'}).state;
 await f.store.issue(state,BROWSER,'synthetic-app',target,NOW+600000,NOW);
 const deps={...f.deps,targets:[target]};assert.equal((await handleTikTokCallback({...f.query,state},deps)).status,200);
 assert.equal((await f.store.authorization('synthetic-app',TARGET.shopId))!.subject_id,TARGET.subjectId);
 assert.equal((await handleTikTokCallback({...f.query,state},deps)).status,200);
});

test('multiple shops share only a verified subject; different subjects remain separate',async()=>{
 const f=await fixture();assert.equal((await handleTikTokCallback(f.query,f.deps)).status,200);
 for(const target of [{...TARGET,shopId:'synthetic-shop-2'},{...TARGET,shopId:'synthetic-shop-3',subjectId:'synthetic-subject-3'}]){
 const state=issueState(SECRET,{now:()=>NOW,market:target.market}).state;await f.store.issue(state,BROWSER,'synthetic-app',target,NOW+600000,NOW);
 const {TOKEN,SHOP,json}=await import('./oauth-fixture.js');const deps={...f.deps,targets:[target],fetchImpl:async(url:any)=>String(url).includes('/token/')?json({...TOKEN,open_id:target.subjectId}):json({shops:[...(target.subjectId===TARGET.subjectId?[SHOP]:[]),{...SHOP,id:target.shopId}]})};
 assert.equal((await handleTikTokCallback({...f.query,state},deps)).status,200);
 }
 const a=await f.store.authorization('synthetic-app',TARGET.shopId),b=await f.store.authorization('synthetic-app','synthetic-shop-2'),c=await f.store.authorization('synthetic-app','synthetic-shop-3');
 assert.equal(a!.id,b!.id);assert.notEqual(a!.id,c!.id);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM authorizations').first()).n,2);
});
