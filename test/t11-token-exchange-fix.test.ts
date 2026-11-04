import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDefaultExchange,parseSellerToken,fetchAuthorizedShops} from '../src/tiktok/callback.js';
import {signDraft} from '../src/tiktok/signing.js';
import {TOKEN,NOW,SHOP,json} from './oauth-fixture.js';
test('token exchange exact auth query, redirect policy, no business signature',async()=>{
 const exchange=createDefaultExchange(async(url,init)=>{const u=new URL(String(url));assert.equal(u.origin,'https://auth.tiktok-shops.com');assert.equal(u.pathname,'/api/v2/token/get');
 assert.deepEqual([...u.searchParams.keys()].sort(),['app_key','app_secret','auth_code','grant_type']);assert.equal(u.searchParams.get('grant_type'),'authorized_code');assert.equal(init?.redirect,'manual');assert.ok(init?.signal);return json(TOKEN);});
 assert.equal((await exchange({code:'synthetic-code',appKey:'synthetic-app',appSecret:'synthetic-secret',nowMs:NOW})).subjectId,TOKEN.open_id);
});
for(const [field,values] of Object.entries({access_token:[null,undefined,'',123],refresh_token:[null,undefined,'',123],open_id:[null,undefined,'',123],user_type:[null,undefined,1,'0'],
 access_token_expire_in:[null,undefined,0,NOW/1000,1.5],refresh_token_expire_in:[null,undefined,0,NOW/1000,1.5],granted_scopes:[null,undefined,[],[123],['a\nsecret']]})) {
 for(const [index,value] of values.entries()) test(`token rejects ${field} case ${index}`,()=>{assert.throws(()=>parseSellerToken({...TOKEN,[field]:value},NOW));});
}
test('timestamp parser supports absolute seconds/milliseconds, scope alias, never interprets missing timestamp as default lifetime',()=>{
 assert.equal(parseSellerToken({...TOKEN,access_token_expire_in:NOW+3600000},NOW).expiresAtMs,NOW+3600000);
 const {granted_scopes,...base}=TOKEN;assert.equal(parseSellerToken({...base,scope:'seller.authorization.info seller.product.basic'},NOW).scope,'seller.authorization.info,seller.product.basic');
 assert.throws(()=>parseSellerToken({...TOKEN,access_token_expire_in:undefined,expires_in:3600},NOW));
});
test('shops request matches official path/header and deterministic GET signature',async()=>{
 await fetchAuthorizedShops({appKey:'synthetic-app',appSecret:'synthetic-secret',accessToken:'synthetic-access',nowMs:NOW,fetchImpl:async(url,init)=>{
 const u=new URL(String(url));assert.equal(u.pathname,'/authorization/202309/shops');assert.deepEqual([...u.searchParams.keys()].sort(),['app_key','sign','timestamp']);
 assert.equal(u.searchParams.get('sign'),signDraft(u.pathname,{app_key:'synthetic-app'},'synthetic-secret',Math.floor(NOW/1000)));
 assert.equal(new Headers(init?.headers).get('x-tts-access-token'),'synthetic-access');assert.equal(new Headers(init?.headers).get('content-type'),'application/json');assert.equal(init?.redirect,'manual');return json({shops:[SHOP]});}});
});
