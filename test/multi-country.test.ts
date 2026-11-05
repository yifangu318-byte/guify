import {test} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {fixture,SECRET,TARGET,TOKEN,SHOP,json} from './oauth-fixture.js';
import {handleTikTokCallback} from '../src/tiktok/oauth.js';
import {registerOAuth} from '../src/tiktok/routes.js';
import {Script} from 'node:vm';
import {connectionScript} from '../src/tiktok/connection-page.js';
const password='Admin123',host='erp.multi.test',headers={host,authorization:'Bearer '+password,accept:'application/json'};
async function setup(t:any,withMy=true,overrides:Record<string,any>={}){
 const f=await fixture();if(withMy)assert.equal((await handleTikTokCallback(f.query,f.deps)).status,200);
 let country='PH',subject='subject-PH',shops=[{id:'shop-PH',region:'PH',cipher:'cipher-PH'}],calls=0,sequence=0;
 const fetchImpl:typeof fetch=async(input)=>{calls++;const path=new URL(String(input)).pathname;
  if(path==='/api/v2/token/get')return json({...TOKEN,open_id:subject});
  if(path==='/authorization/202309/shops')return json({shops});throw new Error('Unexpected mocked request');};
 const app=Fastify();registerOAuth(app,{getSecret:()=>SECRET,getAppKey:()=>f.deps.appKey,getAppSecret:()=>f.deps.appSecret,getDb:()=>f.db,getServiceId:()=> 'synthetic-service',
  getAdminPassword:()=>password,getTargets:()=>JSON.stringify([{shopId:TARGET.shopId,market:TARGET.market}]),getEnvironment:()=> 'test',getEnabled:()=> 'true',getPublicUrl:()=> 'https://'+host,
  getMultiShopEnabled:()=> 'true',getAiEnabled:()=> 'true',getAiPublicEnabled:()=> 'true',getLiveEnabled:()=> 'true',now:f.deps.now,fetchImpl,...overrides});
 t.after(()=>app.close());await app.ready();
 const start=async(market=country,shopId?:string)=>{const r=await app.inject({url:'/api/tiktok/enroll?'+new URLSearchParams({market,...(shopId?{shop_id:shopId}:{})}),headers});assert.equal(r.statusCode,200);return {state:new URL(r.json().authorization_url).searchParams.get('state')!,cookie:String(r.headers['set-cookie']).split(';')[0]!};};
 const finish=(issued:{state:string;cookie:string},extraHeaders:Record<string,string>={})=>app.inject({url:'/api/tiktok/callback?'+new URLSearchParams({code:'synthetic-code-'+(++sequence),state:issued.state}),headers:{host,cookie:issued.cookie,...extraHeaders}});
 return {...f,app,start,finish,calls:()=>calls,set:(market:string,rows?:typeof shops,newSubject?:string)=>{country=market;shops=rows??[{id:'shop-'+market,region:market,cipher:'cipher-'+market}];subject=newSubject??'subject-'+market;}};
}
for(const country of ['MY','PH','SG','TH','VN'])test(`country enrollment binds verified ${country} shop and discovers it without changing static configuration`,async t=>{
 const f=await setup(t,false);f.set(country);const issued=await f.start(country);const result=await f.finish(issued);assert.equal(result.statusCode,200);assert.equal(result.json().market,country);assert.equal(result.json().shop_code,'shop-'+country);
 const mapped=await f.store.authorization(f.deps.appKey,'shop-'+country);assert.equal(mapped?.subject_id,'subject-'+country);
 const listing=await f.app.inject({url:'/api/ai/shops',headers:{host}});assert.equal(listing.statusCode,200);assert.ok(listing.json().shops.some((s:any)=>s.shop_id==='shop-'+country&&s.market===country&&s.permissions.products));
 const packet=await f.app.inject({url:'/api/ai/admin/handoff',headers});assert.equal(packet.statusCode,200);assert.ok(packet.body.includes('shop-'+country));assert.ok(!packet.body.includes('cipher-'+country));assert.ok(!packet.body.includes('synthetic-access'));
});
test('PH enrollment rejects MY-only authorization without relabelling or overwriting the connected MY shop',async t=>{
 const f=await setup(t);f.set('PH',[{...SHOP,region:'MY',cipher:'wrong-country-cipher'}]);const before=await f.store.authorization(f.deps.appKey,TARGET.shopId);
 const result=await f.finish(await f.start('PH'));assert.equal(result.statusCode,409);assert.equal(result.json().code,'SHOP_MARKET_MISMATCH');
 assert.equal((await f.store.authorization(f.deps.appKey,TARGET.shopId))?.access_enc,before?.access_enc);assert.equal(await f.store.authorization(f.deps.appKey,'shop-PH'),null);
});
test('same-market ambiguity requires exact shop selection; explicit ID selects the intended store',async t=>{
 const f=await setup(t);f.set('PH',[{id:'ph-A',region:'PH',cipher:'cipher-A'},{id:'ph-B',region:'PH',cipher:'cipher-B'}]);
 const ambiguous=await f.finish(await f.start('PH'));assert.equal(ambiguous.json().code,'SHOP_SELECTION_REQUIRED');
 const selected=await f.finish(await f.start('PH','ph-B'));assert.equal(selected.statusCode,200);assert.equal(selected.json().shop_code,'ph-B');assert.equal(await f.store.authorization(f.deps.appKey,'ph-A'),null);
});
test('a shared seller token must cover existing shops and updates their ciphers atomically',async t=>{
 const f=await setup(t);f.set('PH',[{id:'shop-PH',region:'PH',cipher:'new-ph'}],TARGET.subjectId);const old=await f.store.authorization(f.deps.appKey,TARGET.shopId);
 const missing=await f.finish(await f.start('PH'));assert.equal(missing.json().code,'EXISTING_SHOPS_MISSING');assert.equal((await f.store.authorization(f.deps.appKey,TARGET.shopId))?.access_enc,old?.access_enc);
 f.set('PH',[{...SHOP,region:'MY',cipher:'new-my'},{id:'shop-PH',region:'PH',cipher:'new-ph'}],TARGET.subjectId);
 const bound=await f.finish(await f.start('PH'));assert.equal(bound.statusCode,200);
 assert.equal((await f.store.authorization(f.deps.appKey,'shop-PH'))?.id,(await f.store.authorization(f.deps.appKey,TARGET.shopId))?.id);
 assert.equal((await f.db.prepare('SELECT cipher FROM authorized_shops WHERE tiktok_shop_id=?').bind(TARGET.shopId).first()).cipher,'new-my');
});
test('country enrollment requires administrator, origin, valid country, one-time state and browser binding',async t=>{
 const f=await setup(t);
 for(const query of ['market=US','market=PH&market=MY','market=PH&shop_id=../wrong','market=PH&redirect_uri=https://evil.test'])assert.equal((await f.app.inject({url:'/api/tiktok/enroll?'+query,headers})).statusCode,400);
 assert.equal((await f.app.inject({url:'/api/tiktok/enroll?market=PH',headers:{host}})).statusCode,401);
 assert.equal((await f.app.inject({url:'/api/tiktok/enroll?market=PH',headers:{...headers,origin:'https://evil.test'}})).statusCode,403);
 const issued=await f.start('PH');assert.equal((await f.finish({...issued,cookie:'__Host-muse_oauth='+'ff'.repeat(32)})).statusCode,400);assert.equal(f.calls(),0);
 const success=await f.finish(issued);assert.equal(success.statusCode,200);const after=f.calls();assert.equal((await f.finish(issued)).statusCode,409);assert.equal(f.calls(),after);
});
test('country enrollment is opt-in and browser callback redirects away from authorization-code URLs',async t=>{
 const disabled=await setup(t,false,{getMultiShopEnabled:()=> 'false'});assert.equal((await disabled.app.inject({url:'/api/tiktok/enroll?market=PH',headers})).statusCode,503);await disabled.app.close();
 const f=await setup(t);const response=await f.finish(await f.start('PH'),{accept:'text/html'});assert.equal(response.statusCode,303);assert.equal(response.headers.location,'/developers?connected=PH');assert.ok(!String(response.headers.location).includes('code='));
 const checks=await f.app.inject({url:'/api/tiktok/connection',headers});assert.deepEqual(checks.json().markets,['MY','PH','SG','TH','VN']);assert.equal(checks.json().targets.filter((s:any)=>s.status==='active').length,2);
 new Script(connectionScript);
});
