import {test} from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {randomBytes} from 'node:crypto';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import Fastify from 'fastify';
import {ProductSnapshotBuilder,snapshotPage} from '../src/live/snapshot.js';
import {product,LiveError} from '../src/live/models.js';
import {fixture,NOW,SECRET,TARGET,json} from './oauth-fixture.js';
import {handleTikTokCallback} from '../src/tiktok/oauth.js';
import {registerOAuth} from '../src/tiktok/routes.js';
const upstream=(n:number)=>({id:'product-'+n,title:'Synthetic title '.repeat(60),status:'ACTIVATE',create_time:NOW/1000-100,update_time:NOW/1000,
 skus:Array.from({length:6},(_,i)=>({id:'sku-'+n+'-'+i,seller_sku:'synthetic-'+n+'-'+i,price:{currency:'MYR',tax_exclusive_price:'1.20',sale_price:'1.40'},inventory:[{warehouse_id:'warehouse',quantity:i}]})),buyer_email:'synthetic-private-must-not-persist'});
test('page-compressed catalog exceeds 2 MB raw but fits one D1 row and reads each page independently',()=>{
 const products=Array.from({length:1570},(_,i)=>product(upstream(i)));assert.ok(Buffer.byteLength(JSON.stringify(products))>2_500_845);
 const builder=new ProductSnapshotBuilder();for(let start=0;start<products.length;start+=100)builder.add(products.slice(start,start+100));const stored=builder.finish(1570);
 assert.ok(Buffer.byteLength(stored)<1_900_000);const first=snapshotPage(stored,'products'),last=snapshotPage(stored,'products',16);
 assert.equal(first.data!.length,100);assert.equal(first.pagination!.total_count,1570);assert.equal(first.pagination!.next_page,2);assert.equal(last.data!.length,70);assert.equal(last.pagination!.next_page,null);assert.deepEqual(last.data![69],products[1569]);
 assert.ok(!JSON.stringify(first.data).includes('synthetic-private'));
});
test('snapshot codec distinguishes never synchronized, empty data, and legacy arrays',()=>{
 assert.deepEqual(snapshotPage(null,'products'),{data:null,pagination:null});const builder=new ProductSnapshotBuilder();const empty=snapshotPage(builder.finish(0),'products');assert.deepEqual(empty.data,[]);assert.equal(empty.pagination!.total_count,0);
 const legacy=JSON.stringify(Array.from({length:101},(_,i)=>({product_id:String(i)})));assert.equal(snapshotPage(legacy,'products',2).data!.length,1);
 assert.deepEqual(snapshotPage('[{"order_id":"old-order"}]','orders').data,[{order_id:'old-order'}]);
});
test('corrupt compressed snapshots and incomplete manifests fail with fixed safe errors',()=>{
 const builder=new ProductSnapshotBuilder();builder.add([product(upstream(0))]);assert.throws(()=>builder.finish(2),LiveError);
 const valid=JSON.parse(builder.finish(1));
 for(const raw of ['synthetic-private-invalid-json',JSON.stringify({...valid,count:2}),JSON.stringify({...valid,chunks:[{count:1,data:Buffer.from('synthetic-private-not-gzip').toString('base64')}]})])
  assert.throws(()=>snapshotPage(raw,'products'),(error:any)=>error.code==='SNAPSHOT_UNAVAILABLE'&&!error.message.includes('synthetic-private'));
 assert.throws(()=>snapshotPage(builder.finish(1),'products',2),(error:any)=>error.code==='INVALID_PAGE');
});
test('decompression and stored-size limits cannot be bypassed by highly compressed or incompressible input',()=>{
 const bomb=JSON.stringify({format:'muse-products-gzip-v1',count:1,chunks:[{count:1,data:gzipSync(Buffer.from(JSON.stringify(['x'.repeat(8_000_001)]))).toString('base64')}]});
 assert.throws(()=>snapshotPage(bomb,'products'),(error:any)=>error.code==='SNAPSHOT_UNAVAILABLE');
 const builder=new ProductSnapshotBuilder();assert.throws(()=>builder.add([{...product(upstream(0)),title:randomBytes(1_600_000).toString('base64')}]),(error:any)=>error.code==='SYNC_LIMIT_EXCEEDED'&&error.limit.kind==='bytes');
});
test('actual D1 atomically stores a 1570-product compressed manifest and serves bounded authenticated pages',async t=>{
 const f=await fixture();assert.equal((await handleTikTokCallback(f.query,f.deps)).status,200);
 const admin='synthetic-compressed-admin-1234567890',headers={authorization:'Bearer '+admin,host:'erp.example.test',origin:'https://erp.example.test'};
 const app=Fastify();t.after(()=>app.close());registerOAuth(app,{getDb:()=>f.db,getAdminToken:()=>admin,getPublicUrl:()=> 'https://erp.example.test',getAppKey:()=> 'synthetic-app',getAppSecret:()=> 'synthetic-secret',getSecret:()=>SECRET,getEnvironment:()=> 'test',getLiveEnabled:()=> 'true',getProductLimit:()=> '2000',getTargets:()=>JSON.stringify([TARGET]),now:()=>NOW,
  fetchImpl:async(url)=>{const page=Number(new URL(String(url)).searchParams.get('page_token')??0),start=page*100;return json({total_count:1570,products:Array.from({length:Math.min(100,1570-start)},(_,i)=>upstream(start+i)),...(start+100<1570?{next_page_token:String(page+1)}:{})});}});
 const sync=await app.inject({method:'POST',url:'/api/live/shops/'+TARGET.shopId+'/products/sync',headers,payload:{}});assert.equal(sync.statusCode,200);assert.equal(sync.json().count,1570);
 const stored=await f.db.prepare('SELECT snapshot_json,last_success_at FROM live_snapshots').first();assert.ok(Buffer.byteLength(stored.snapshot_json)<1_900_000);assert.equal(stored.last_success_at,NOW);
 for(const [page,count] of [[1,100],[16,70]]){const response=await app.inject({url:'/api/live/shops/'+TARGET.shopId+'/products?page='+page,headers});assert.equal(response.statusCode,200);assert.equal(response.json().data.length,count);assert.equal(response.json().pagination.total_count,1570);assert.ok(!response.body.includes('synthetic-private'));}
 for(const page of ['0','17','21','1&page=2'])assert.equal((await app.inject({url:'/api/live/shops/'+TARGET.shopId+'/products?page='+page,headers})).statusCode,400);
 assert.equal((await app.inject({url:'/api/live/shops/'+TARGET.shopId+'/products?page=1'})).statusCode,401);
});
test('gzip round-trip and decompression guards run in the actual isolated Worker runtime',async t=>{
 const mf=new Miniflare(convertV4MiniflareOptions({name:'isolated-live-codec',modules:true,compatibilityDate:'2026-10-30',compatibilityFlags:['nodejs_compat'],script:`import {gzipSync,gunzipSync} from 'node:zlib'; import {Buffer} from 'node:buffer';export default {fetch(){const input='synthetic-中文-'.repeat(20000),packed=gzipSync(Buffer.from(input),{level:1});let guarded=false;try{gunzipSync(packed,{maxOutputLength:100});}catch{guarded=true;}return Response.json({equal:gunzipSync(packed,{maxOutputLength:1000000}).toString()===input,guarded,packed:packed.length,raw:Buffer.byteLength(input)});}};`}));t.after(()=>mf.dispose());
 const result=await(await mf.dispatchFetch('https://codec.test/')).json() as any;assert.equal(result.equal,true);assert.equal(result.guarded,true);assert.ok(result.packed<result.raw);
});
