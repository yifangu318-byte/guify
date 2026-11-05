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
test('documented analytics and seller affiliate business modules use the same fixed host and authorization boundary',async()=>{
 const f=await ready();let calls=0;
 for(const path of ['/analytics/202609/shop/performance','/affiliate_seller/202508/target_collaborations']){
  const result=await invokeOfficial({shop_id:TARGET.shopId,path,method:'GET'},{...f.options,writeEnabled:false,fetchImpl:async(input)=>{calls++;assert.equal(new URL(String(input)).origin,'https://open-api.tiktokglobalshop.com');return json({synthetic:true});}});
  assert.equal((result as any).data.synthetic,true);
 }assert.equal(calls,2);
});
test('official file upload uses multipart without signing file bytes and never accepts a remote URL',async()=>{
 const f=await ready();let calls=0;
 const args={shop_id:TARGET.shopId,method:'POST',path:'/product/202309/files/upload',request_id:request.request_id,
   upload:{filename:'certification.pdf',base64:Buffer.from('%PDF-1.7\nsynthetic').toString('base64')}};
 const options={...f.options,fetchImpl:async(input:RequestInfo|URL,init?:RequestInit)=>{
   calls++;const url=new URL(String(input));assert.equal(url.origin,'https://open-api.tiktokglobalshop.com');
   assert.equal(url.pathname,args.path);assert.equal(url.searchParams.has('shop_cipher'),false);
   assert.equal(new Headers(init!.headers).has('Content-Type'),false);
   const sent=new Request(url,init);assert.match(sent.headers.get('Content-Type')!,/^multipart\/form-data; boundary=/);
   const form=await sent.formData(),file=form.get('data') as File;
   assert.equal(file.name,'certification.pdf');assert.equal(file.type,'application/pdf');assert.equal(await file.text(),'%PDF-1.7\nsynthetic');
   assert.equal(form.get('name'),'certification.pdf');
   const q=Object.fromEntries(url.searchParams);const canonical=Object.keys(q).filter(k=>k!=='sign').sort().map(k=>k+q[k]).join('');
   assert.equal(q.sign,createHmac('sha256',f.options.appSecret).update(f.options.appSecret+args.path+canonical+f.options.appSecret).digest('hex'));
   return json({id:'synthetic-file'});
 }};
 for(const invalid of [
   {...args,upload:{...args.upload,url:'https://invalid.test/private'}},
   {...args,upload:{...args.upload,base64:'data:application/pdf;base64,JVBERg=='}},
   {...args,upload:{...args.upload,filename:'../certification.pdf'}},
   {...args,path:'/product/202309/products'},
   {...args,body:{}},
   {...args,query:{shop_id:'different-shop'}},
 ])await assert.rejects(()=>invokeOfficial(invalid,options));
 assert.equal(calls,0);const result=await invokeOfficial(args,options);
 assert.deepEqual(result.data,{id:'synthetic-file'});
 await assert.rejects(()=>invokeOfficial(args,options),(e:any)=>e.code==='REQUEST_ALREADY_ATTEMPTED');assert.equal(calls,1);
});
test('official code zero with no data is successful; malformed response is never reported as a confirmed rejection',async()=>{
 const f=await ready();
 const successful=await invokeOfficial(request,{...f.options,fetchImpl:async()=>Response.json({code:0})});
 assert.equal(successful.data,null);
 assert.equal((await f.db.prepare('SELECT state FROM api_operations WHERE request_id=?').bind(request.request_id).first()).state,'succeeded');
 const next={...request,request_id:'22222222-2222-4222-8222-222222222222'};
 const unknown=await invokeOfficial(next,{...f.options,fetchImpl:async()=>Response.json({data:{}})});
 assert.equal(unknown.code,'OUTCOME_UNKNOWN');
 assert.equal((await f.db.prepare('SELECT state FROM api_operations WHERE request_id=?').bind(next.request_id).first()).state,'unknown');
});
test('authorized shop discovery returns only the selected market and shop, without seller-wide IDs or ciphers',async()=>{
 const f=await ready();let calls=0;
 const args={shop_id:TARGET.shopId,method:'GET',path:'/authorization/202309/shops'};
 const options={...f.options,fetchImpl:async(input:RequestInfo|URL)=>{
  calls++;const url=new URL(String(input));assert.equal(url.searchParams.has('shop_cipher'),false);
  return json({shops:[{id:TARGET.shopId,region:TARGET.market,name:'Selected shop',cipher:'synthetic-private-cipher',code:'private-code'},
    {id:'other-shop',region:'PH',cipher:'other-cipher'}]});
 }};
 await assert.rejects(()=>invokeOfficial({...args,method:'POST',request_id:request.request_id},options));
 await assert.rejects(()=>invokeOfficial({...args,query:{shop_id:TARGET.shopId}},options));
 assert.deepEqual((await invokeOfficial(args,options)).data,{shops:[{id:TARGET.shopId,region:TARGET.market,name:'Selected shop'}]});
 assert.equal(calls,1);
});
test('official list cursors remain usable while credential-like fields are withheld',async()=>{
 const f=await ready();const args={shop_id:TARGET.shopId,method:'GET',path:'/order/202309/orders'};
 const result=await invokeOfficial(args,{...f.options,fetchImpl:async()=>json({
   next_page_token:'next-page-cursor',shop_cipher:'private-shop-cipher',refresh_token:'private-refresh',nested:{page_token:'synthetic-access'},
 })});
 assert.deepEqual(result.data,{next_page_token:'next-page-cursor',nested:{page_token:'[redacted]'}});
});
