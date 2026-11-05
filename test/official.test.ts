import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {fixture,SECRET,TARGET,NOW,json} from './oauth-fixture.js';
import {handleTikTokCallback} from '../src/tiktok/oauth.js';
import {invokeOfficial} from '../src/ai/official.js';
const request={shop_id:TARGET.shopId,path:'/product/202309/products/synthetic-product/inventory/update',method:'POST',body:{skus:[{id:'synthetic-sku',inventory:[{warehouse_id:'synthetic-warehouse',quantity:1}]}]},request_id:'11111111-1111-4111-8111-111111111111'};
async function ready(){const f=await fixture();assert.equal((await handleTikTokCallback(f.query,f.deps)).status,200);return {...f,options:{db:f.db,appKey:f.deps.appKey,appSecret:f.deps.appSecret,secret:SECRET,target:TARGET,writeEnabled:true,now:f.deps.now}};}
test('official executor binds shop credentials, signs exact JSON, sanitizes secret fields and records one successful attempt',async()=>{
 const f=await ready();let calls=0;
 const result=await invokeOfficial(request,{...f.options,fetchImpl:async(input,init)=>{calls++;const url=new URL(String(input));assert.equal(url.origin,'https://open-api.tiktokglobalshop.com');assert.equal(url.pathname,request.path);assert.equal(init!.redirect,'manual');assert.equal((init!.headers as any)['x-tts-access-token'],'synthetic-access');assert.equal(init!.body,JSON.stringify(request.body));const q=Object.fromEntries(url.searchParams);const canonical=Object.keys(q).filter(k=>k!=='sign').sort().map(k=>k+q[k]).join('');assert.equal(q.sign,createHmac('sha256',f.options.appSecret).update(f.options.appSecret+request.path+canonical+init!.body+f.options.appSecret).digest('hex'));return json({updated:true,access_token:'never-disclose',nested:{app_secret:'never-disclose',value:'synthetic-access'}});}});
 assert.equal(calls,1);assert.equal((result as any).data.updated,true);assert.ok(!JSON.stringify(result).includes('never-disclose'));assert.ok(!JSON.stringify(result).includes('synthetic-access'));assert.equal((await f.db.prepare('SELECT state FROM api_operations').first()).state,'succeeded');
});
test('official executor rejects other hosts, auth paths, reserved parameters, shop overrides and missing write permission before transport',async()=>{
 const f=await ready();let calls=0;const options={...f.options,fetchImpl:async()=>{calls++;return json({});}};
 for(const args of [{...request,path:'https://evil.test/x'},{...request,path:'/api/v2/token/get'},{...request,path:'/product/202309/../token'},{...request,query:{shop_cipher:'evil'}},{...request,query:{timestamp:'0'}},{...request,shop_id:'other-shop'},{...request,body:{nested:{shop_id:'other-shop'}}},{...request,body:{access_token:'evil'}},{...request,method:'GET'},{...request,request_id:undefined}])await assert.rejects(()=>invokeOfficial(args,options));
 await assert.rejects(()=>invokeOfficial(request,{...options,writeEnabled:false}),(e:any)=>e.code==='WRITES_DISABLED');assert.equal(calls,0);
});
test('durable generic mutations reject duplicate attempts across concurrent workers and after unknown outcomes',async()=>{
 const f=await ready();let calls=0;const options={...f.options,fetchImpl:async()=>{calls++;throw new TypeError('synthetic-private-failure');}};
 const results=await Promise.allSettled([invokeOfficial(request,options),invokeOfficial(request,options)]);assert.equal(calls,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);const done=results.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<any>;assert.equal(done.value.code,'OUTCOME_UNKNOWN');assert.equal(done.value.retry_safe,false);
 assert.equal((await f.db.prepare('SELECT state FROM api_operations').first()).state,'unknown');await assert.rejects(()=>invokeOfficial(request,options),(e:any)=>e.code==='REQUEST_ALREADY_ATTEMPTED');assert.equal(calls,1);
});
test('official GET works without enabling writes, business rejection is explicit and no transport automatically retries',async()=>{
 const f=await ready();let calls=0;const result=await invokeOfficial({shop_id:TARGET.shopId,path:'/order/202309/orders',method:'GET',query:{ids:'synthetic-order'}},{...f.options,writeEnabled:false,fetchImpl:async()=>{calls++;return json({status:'synthetic'},105005);}});
 assert.equal((result as any).error,true);assert.equal((result as any).upstream_code,105005);assert.equal(calls,1);assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM api_operations').first()).n,0);
});
