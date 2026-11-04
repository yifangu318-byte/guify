import {test} from 'node:test';
import assert from 'node:assert/strict';
import {selectAuthorizedShop,handleTikTokCallback} from '../src/tiktok/callback.js';
import {fixture,TOKEN,SHOP,json} from './oauth-fixture.js';
for(const [label,shops] of Object.entries({wrongRegion:[{...SHOP,region:'SG'}],wrongId:[{...SHOP,id:'other'}],missingCipher:[{...SHOP,cipher:''}],duplicateId:[SHOP,SHOP],missingRegion:[{...SHOP,region:undefined}],numericId:[{...SHOP,id:123}]})) test(`shop identity rejects ${label}`,async()=>{
 const f=await fixture();f.deps.fetchImpl=async(url)=>String(url).includes('/token/')?json(TOKEN):json({shops});assert.equal((await handleTikTokCallback(f.query,f.deps)).status,502);assert.equal(await f.store.authorization('synthetic-app',SHOP.id),null);
});
test('same-market ambiguity cannot choose first; explicit id chooses correct shop',()=>{
 const shops=[{...SHOP,id:'other'},SHOP];assert.equal(selectAuthorizedShop(shops,'MY'),undefined);assert.deepEqual(selectAuthorizedShop(shops,'MY',SHOP.id),SHOP);
 assert.equal(selectAuthorizedShop([{...SHOP,region:'SG'}],'MY'),undefined);
});
test('callback selects explicit target when same market contains multiple shops',async()=>{
 const f=await fixture();f.deps.fetchImpl=async(url)=>String(url).includes('/token/')?json(TOKEN):json({shops:[{...SHOP,id:'other'},SHOP]});assert.equal((await handleTikTokCallback(f.query,f.deps)).status,200);
});
for(const change of [{open_id:'other-subject'},{user_type:1},{granted_scopes:['seller.product.basic']}]) test(`subject/scope check ${JSON.stringify(change)}`,async()=>{
 const f=await fixture();let calls=0;f.deps.fetchImpl=async()=>{calls++;return json({...TOKEN,...change});};assert.equal((await handleTikTokCallback(f.query,f.deps)).status,502);assert.equal(calls,1);
});
