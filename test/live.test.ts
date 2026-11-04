import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {Script} from 'node:vm';
import Fastify from 'fastify';
import {fixture,NOW,SECRET,TARGET,TOKEN,json} from './oauth-fixture.js';
import {handleTikTokCallback} from '../src/tiktok/oauth.js';
import {LiveService} from '../src/live/service.js';
import {readSnapshot,signJson} from '../src/live/client.js';
import {LiveError,parseWindow,product,order} from '../src/live/models.js';
import {registerOAuth} from '../src/tiktok/routes.js';
import {buildApp} from '../src/app.js';
const admin='synthetic-live-administrator-123456789';
const headers={authorization:`Bearer ${admin}`,host:'erp.example.test',origin:'https://erp.example.test'};
const window={start_at:NOW-86400000,end_at:NOW};
const upstreamProduct={id:'9007199254740993123',title:'Synthetic product <script>',status:'ACTIVATE',create_time:NOW/1000-100,update_time:NOW/1000-10,
 skus:[{id:'9007199254740993124',seller_sku:'SYNTHETIC',price:{currency:'MYR',tax_exclusive_price:'0.10',sale_price:'1.20'},inventory:[{warehouse_id:'warehouse-1',quantity:0}],access_token:'synthetic-never-store'}],access_token:'synthetic-never-store'};
const upstreamOrder={id:'9007199254740993125',status:'AWAITING_SHIPMENT',create_time:NOW/1000-100,update_time:NOW/1000-10,payment:{currency:'MYR',total_amount:'999999999999999.01'},buyer_email:'synthetic-private@example.test',recipient_address:{full_address:'synthetic-private-address'},buyer_message:'synthetic-private-message'};
const opts={resource:'products' as const,appKey:'synthetic-app',appSecret:'synthetic-app-secret',accessToken:'synthetic-access',cipher:'synthetic-cipher',now:()=>NOW,sleep:async()=>{}};
async function ready(){const f=await fixture();assert.equal((await handleTikTokCallback(f.query,f.deps)).status,200);await f.db.prepare('UPDATE authorizations SET scopes_json=?').bind(JSON.stringify(['seller.authorization.info','seller.product.basic','seller.order.info'])).run();return f;}
const service=(f:Awaited<ReturnType<typeof ready>>,fetchImpl:typeof fetch)=>new LiveService({db:f.db,appKey:'synthetic-app',appSecret:'synthetic-app-secret',secret:SECRET,now:f.deps.now,fetchImpl,sleep:async()=>{}});
async function routes(f:Awaited<ReturnType<typeof ready>>,fetchImpl:typeof fetch,overrides:Record<string,any>={}){
 const app=Fastify();registerOAuth(app,{getDb:()=>f.db,getAdminToken:()=>admin,getPublicUrl:()=> 'https://erp.example.test',getAppKey:()=> 'synthetic-app',getAppSecret:()=> 'synthetic-app-secret',getSecret:()=>SECRET,getEnvironment:()=> 'test',getLiveEnabled:()=> 'true',getTargets:()=>JSON.stringify([TARGET]),fetchImpl,now:f.deps.now,...overrides});await app.ready();return app;
}
test('live JSON signatures include exact body bytes and raw sorted parameters; write endpoints rejected',()=>{
 const path='/product/202309/products/search',query={timestamp:'1790000000',shop_cipher:'synthetic-cipher',page_size:'50',app_key:'synthetic-app',sign:'ignored',access_token:'ignored'};
 const body='{"status":"ALL"}';const canonical='synthetic-app-secret'+path+'app_keysynthetic-apppage_size50shop_ciphersynthetic-ciphertimestamp1790000000'+body+'synthetic-app-secret';
 assert.equal(signJson(path,query,body,'synthetic-app-secret'),createHmac('sha256','synthetic-app-secret').update(canonical).digest('hex'));
 assert.notEqual(signJson(path,query,body,'synthetic-app-secret'),signJson(path,query,'{ "status": "ALL" }','synthetic-app-secret'));
 assert.throws(()=>signJson('/product/202309/products/deactivate',query,body,'synthetic-app-secret'),LiveError);
});
test('live client uses only official read endpoints with verified cipher, fixed JSON and bounded pagination',async()=>{
 const calls:Array<{url:URL;init:RequestInit}>=[];const fetchImpl:typeof fetch=async(url,init)=>{const parsed=new URL(String(url));calls.push({url:parsed,init:init!});return json(calls.length===1?{total_count:2,products:[upstreamProduct],next_page_token:'synthetic-next'}:{total_count:2,products:[{...upstreamProduct,id:'second-product'}]});};
 const result=await readSnapshot({...opts,fetchImpl});assert.equal(result.length,2);assert.equal(calls.length,2);
 for(const call of calls){assert.equal(call.url.origin,'https://open-api.tiktokglobalshop.com');assert.equal(call.url.pathname,'/product/202309/products/search');assert.equal(call.init.method,'POST');assert.equal(call.init.body,'{"status":"ALL"}');assert.equal(call.init.redirect,'manual');assert.equal((call.init.headers as any)['x-tts-access-token'],'synthetic-access');assert.equal(call.url.searchParams.get('shop_cipher'),'synthetic-cipher');assert.equal(call.url.searchParams.get('shop_id'),null);}
 assert.equal(calls[1]!.url.searchParams.get('page_token'),'synthetic-next');assert.ok(!JSON.stringify(result).includes('synthetic-never-store'));
});
test('only transient read HTTP failures retry; business errors and invalid credentials never retry',async()=>{
 let n=0;const result=await readSnapshot({...opts,fetchImpl:async()=>++n<3?new Response('',{status:429}):json({total_count:0,products:[]})});assert.deepEqual(result,[]);assert.equal(n,3);
 for(const reply of [()=>new Response('synthetic-secret-upstream-error',{status:401}),()=>json({private:'synthetic-private'},105005)]){n=0;await assert.rejects(()=>readSnapshot({...opts,fetchImpl:async()=>{n++;return reply();}}),e=>e instanceof LiveError&&!e.message.includes('synthetic'));assert.equal(n,1);}
});
test('missing arrays, changing counts, duplicate IDs, repeated cursors and incomplete pagination fail closed',async()=>{
 for(const mode of ['missing','duplicate','count','cursor','incomplete','limit'] as const){let n=0;await assert.rejects(()=>readSnapshot({...opts,fetchImpl:async()=>{n++;if(mode==='missing')return json({total_count:0});if(mode==='limit')return json({total_count:1001,products:[]});if(mode==='incomplete')return json({total_count:2,products:[upstreamProduct]});return json({total_count:mode==='count'&&n>1?3:2,products:[{...upstreamProduct,id:mode==='duplicate'?upstreamProduct.id:String(n)}],next_page_token:mode==='cursor'?'same':n===1?'next':''});}}),LiveError);}
});
test('retry-heavy pagination cannot exceed the per-run upstream request budget',async()=>{
 let calls=0,page=0;
 await assert.rejects(()=>readSnapshot({...opts,fetchImpl:async()=>{calls++;if(calls%3!==0)return new Response('',{status:503});page++;return json({total_count:1000,products:Array.from({length:50},(_,i)=>({...upstreamProduct,id:'product-'+(page*50+i)})),next_page_token:'page-'+page});}}),(e:any)=>e.code==='SYNC_LIMIT_EXCEEDED');
 assert.equal(calls,32);
});
test('record limits expose only safe numeric diagnostics and preserve them without a schema change',async t=>{
 const f=await ready();const app=await routes(f,async()=>json({total_count:1001,products:[],private:'synthetic-private-raw-response'}));t.after(()=>app.close());
 const response=await app.inject({method:'POST',url:'/api/live/shops/'+TARGET.shopId+'/products/sync',headers,payload:{}});
 assert.equal(response.statusCode,502);assert.equal(response.json().code,'SYNC_LIMIT_EXCEEDED');assert.deepEqual(response.json().limit,{kind:'records',limit:1000,actual:1001});assert.ok(!response.body.includes('synthetic-private'));
 const saved=await app.inject({url:'/api/live/shops/'+TARGET.shopId+'/products',headers});assert.equal(saved.json().data,null);assert.equal(saved.json().synced_at,null);assert.equal(saved.json().last_error,'SYNC_LIMIT_EXCEEDED');assert.deepEqual(saved.json().limit,{kind:'records',limit:1000,actual:1001});
});
test('expanded product capacity is explicit, covers 1570 complete records, and never raises order capacity',async()=>{
 let calls=0;const fetchImpl:typeof fetch=async(url)=>{
  const query=new URL(String(url)).searchParams;assert.equal(query.get('page_size'),'100');const page=Number(query.get('page_token')??0),start=page*100;calls++;
  return json({total_count:1570,products:Array.from({length:Math.min(100,1570-start)},(_,i)=>({...upstreamProduct,id:'product-'+(start+i)})),...(start+100<1570?{next_page_token:String(page+1)}:{})});
 };
 await assert.rejects(()=>readSnapshot({...opts,fetchImpl}),(e:any)=>e.limit?.actual===1570&&e.limit?.limit===1000);assert.equal(calls,1);calls=0;
 const rows=await readSnapshot({...opts,productLimit:2000,fetchImpl});assert.equal(rows.length,1570);assert.equal(calls,16);
 await assert.rejects(()=>readSnapshot({...opts,productLimit:2000,resource:'orders',window,fetchImpl:async()=>json({total_count:1001,orders:[]})}),(e:any)=>e.limit?.limit===1000);
});
test('product capacity configuration accepts only explicit approved capacity levels',async t=>{
 const f=await ready();const app=await routes(f,async()=>{throw new Error();},{getProductLimit:()=> '2000'});t.after(()=>app.close());
 assert.deepEqual((await app.inject({url:'/api/live/shops',headers})).json().limits,{products:2000,orders:1000});
 const invalid=await routes(f,async()=>{throw new Error();},{getProductLimit:()=> '100000'});t.after(()=>invalid.close());assert.equal((await invalid.inject({url:'/api/live/shops',headers})).statusCode,503);
});
test('projection keeps precise prices and platform statuses, omits all buyer and credential fields',()=>{
 const p=product(upstreamProduct);assert.equal(p.product_id,upstreamProduct.id);assert.equal(p.skus![0]!.tax_exclusive_price,'0.10');assert.equal(p.skus![0]!.inventory![0]!.quantity,0);
 const o=order(upstreamOrder,window);assert.equal(o.total_amount,'999999999999999.01');assert.equal(o.status,'AWAITING_SHIPMENT');assert.ok(!JSON.stringify(o).includes('synthetic-private'));
 assert.deepEqual(product({id:'draft',title:'Draft',status:'DRAFT'}).skus,null);assert.equal(order({...upstreamOrder,payment:undefined},window).total_amount,null);
 assert.throws(()=>product({...upstreamProduct,id:9007199254740992}),LiveError);assert.throws(()=>order({...upstreamOrder,payment:{currency:'MYR',total_amount:1.2}},window),LiveError);
 assert.throws(()=>order({...upstreamOrder,create_time:window.end_at/1000},window),LiveError);
});
test('order windows require explicit second-aligned bounds, maximum 31 days and no future end',()=>{
 assert.deepEqual(parseWindow(window,NOW),window);
 for(const bad of [{},{...window,start_at:String(window.start_at)},{...window,end_at:NOW+1000},{...window,start_at:window.start_at+1},{...window,start_at:NOW},{...window,start_at:NOW-32*86400000},{...window,shop_cipher:'synthetic'}])assert.throws(()=>parseWindow(bad,NOW),LiveError);
});
test('order queries preserve the selected creation-time window and project only necessary fields',async()=>{
 let body:any;const rows=await readSnapshot({...opts,resource:'orders',window,fetchImpl:async(url,init)=>{assert.equal(new URL(String(url)).pathname,'/order/202309/orders/search');body=JSON.parse(String(init?.body));return json({total_count:1,orders:[upstreamOrder]});}});
 assert.deepEqual(body,{create_time_ge:window.start_at/1000,create_time_lt:window.end_at/1000});assert.equal(rows.length,1);assert.ok(!JSON.stringify(rows).includes('synthetic-private'));
});
test('actual D1 persists sanitized snapshots, reports unsynchronized as null, and isolates resources',async()=>{
 const f=await ready();const s=service(f,async()=>json({total_count:1,products:[upstreamProduct]}));
 assert.equal((await s.snapshot(TARGET.shopId,'MY','products')).data,null);await s.sync(TARGET.shopId,'MY','products');
 const saved=await s.snapshot(TARGET.shopId,'MY','products');assert.equal(saved.source,'tiktok_api');assert.equal(saved.synced_at,NOW);assert.equal(saved.data!.length,1);assert.equal((await s.snapshot(TARGET.shopId,'MY','orders')).data,null);
 assert.ok(!JSON.stringify(await f.db.prepare('SELECT snapshot_json FROM live_snapshots').all()).includes('synthetic-never-store'));
});
test('failed pagination preserves prior successful snapshot and reports failure separately',async()=>{
 const f=await ready();let failing=false;const s=service(f,async()=>json(failing?{total_count:2,products:[{...upstreamProduct,title:'must-not-replace'}]}:{total_count:1,products:[upstreamProduct]}));
 await s.sync(TARGET.shopId,'MY','products');f.tick(31000);failing=true;
 await assert.rejects(()=>s.sync(TARGET.shopId,'MY','products'),(e:any)=>e.code==='INCOMPLETE_SNAPSHOT');
 const result=await s.snapshot(TARGET.shopId,'MY','products');assert.equal(result.synced_at,NOW);assert.equal(result.last_error,'INCOMPLETE_SNAPSHOT');assert.equal((result.data![0] as any).title,upstreamProduct.title);
});
test('durable D1 sync claims block concurrent Workers and enforce retry cooldown',async()=>{
 const f=await ready();let release!:(r:Response)=>void,entered!:()=>void;const seen=new Promise<void>(r=>entered=r);
 const one=service(f,async()=>{entered();return new Promise<Response>(r=>release=r);});const two=service(f,async()=>{throw new Error('must not call');});
 const running=one.sync(TARGET.shopId,'MY','products');await seen;await assert.rejects(()=>two.sync(TARGET.shopId,'MY','products'),(e:any)=>e.code==='SYNC_BUSY');
 release(json({total_count:1,products:[upstreamProduct]}));await running;await assert.rejects(()=>two.sync(TARGET.shopId,'MY','products'),(e:any)=>e.code==='SYNC_BUSY');
});
test('a stale sync owner cannot overwrite data or clear a newer owner lease',async()=>{
 const f=await ready();const s=service(f,async()=>{await f.db.prepare("UPDATE live_snapshots SET lease_owner='synthetic-new-owner'").run();return json({total_count:1,products:[upstreamProduct]});});
 await assert.rejects(()=>s.sync(TARGET.shopId,'MY','products'),(e:any)=>e.code==='SYNC_CONFLICT');
 const row=await f.db.prepare('SELECT snapshot_json,lease_owner FROM live_snapshots').first();assert.equal(row.snapshot_json,null);assert.equal(row.lease_owner,'synthetic-new-owner');
});
test('authorization changes during a sync prevent committing the old credential response',async()=>{
 const f=await ready();const s=service(f,async()=>{await f.db.prepare('UPDATE authorizations SET version=version+1').run();return json({total_count:1,products:[upstreamProduct]});});
 await assert.rejects(()=>s.sync(TARGET.shopId,'MY','products'),(e:any)=>e.code==='SYNC_CONFLICT');assert.equal((await s.snapshot(TARGET.shopId,'MY','products')).data,null);
});
test('missing scopes, wrong market, other apps and expired authorizations never reach transport',async()=>{
 const f=await ready();let calls=0;const s=service(f,async()=>{calls++;throw new Error();});
 await assert.rejects(()=>s.sync(TARGET.shopId,'PH','products'),(e:any)=>e.code==='SHOP_AUTHORIZATION_REQUIRED');
 await assert.rejects(()=>new LiveService({...s.config,appKey:'other-app'}).sync(TARGET.shopId,'MY','products'),(e:any)=>e.code==='SHOP_AUTHORIZATION_REQUIRED');
 await f.db.prepare('UPDATE authorizations SET scopes_json=?').bind('["seller.authorization.info"]').run();await assert.rejects(()=>s.sync(TARGET.shopId,'MY','products'),(e:any)=>e.code==='SCOPE_REQUIRED');
 await f.db.prepare("UPDATE authorizations SET status='reauthorize_required'").run();await assert.rejects(()=>s.snapshot(TARGET.shopId,'MY','products'),(e:any)=>e.code==='SHOP_AUTHORIZATION_REQUIRED');assert.equal(calls,0);
});
test('resource permissions are checked again after token refresh before issuing a business query',async()=>{
 const f=await ready();await f.db.prepare('UPDATE authorizations SET access_expires_at=?').bind(NOW-1).run();const paths:string[]=[];
 const s=service(f,async(url)=>{const path=new URL(String(url)).pathname;paths.push(path);if(path==='/api/v2/token/refresh')return json({...TOKEN,granted_scopes:['seller.authorization.info']});throw new Error('business query must not be sent');});
 await assert.rejects(()=>s.sync(TARGET.shopId,'MY','products'),(e:any)=>e.code==='SCOPE_REQUIRED');assert.deepEqual(paths,['/api/v2/token/refresh']);
});
test('stored snapshots are keyed by app and shop, never selected by first matching resource',async()=>{
 const f=await ready();const s=service(f,async()=>json({total_count:0,products:[]}));await s.sync(TARGET.shopId,'MY','products');
 await f.db.prepare("UPDATE live_snapshots SET shop_id='other-shop'").run();assert.equal((await s.snapshot(TARGET.shopId,'MY','products')).data,null);
 await f.db.prepare("UPDATE live_snapshots SET shop_id=?,app_hash='other-app'").bind(TARGET.shopId).run();assert.equal((await s.snapshot(TARGET.shopId,'MY','products')).data,null);
});
test('API authentication, same-origin binding, allowlist and read-only route surface fail closed',async t=>{
 const f=await ready();let calls=0;const app=await routes(f,async()=>{calls++;throw new Error();});t.after(()=>app.close());
 assert.equal((await app.inject('/api/live/shops')).statusCode,401);
 for(const change of [{host:'foreign.test'},{origin:'https://foreign.test'},{'sec-fetch-site':'cross-site'}])assert.equal((await app.inject({url:'/api/live/shops',headers:{...headers,...change}})).statusCode,403);
 assert.equal((await app.inject({url:'/api/live/shops/other-shop/products',headers})).statusCode,404);
 for(const resource of ['write','inventory','products/deactivate'])assert.ok((await app.inject({method:'POST',url:'/api/live/shops/'+TARGET.shopId+'/'+resource+'/sync',headers,payload:{}})).statusCode>=400);
 assert.equal(calls,0);
});
test('live feature flag is separate, defaults disabled, and old simulation pages remain public',async t=>{
 const f=await ready();let calls=0;const app=await routes(f,async()=>{calls++;throw new Error();},{getLiveEnabled:()=>undefined});t.after(()=>app.close());
 const info=await app.inject({url:'/api/live/shops',headers});assert.equal(info.json().enabled,false);assert.equal(info.json().database,true);
 assert.equal((await app.inject({method:'POST',url:'/api/live/shops/'+TARGET.shopId+'/products/sync',headers,payload:{}})).json().code,'LIVE_DISABLED');assert.equal(calls,0);
});
test('site root follows the live enable flag while keeping unauthenticated business requests protected',async t=>{
 for(const enabled of ['false','true']){const app=buildApp({port:0,host:'127.0.0.1'},undefined,{}, {},{tiktok:{getLiveEnabled:()=>enabled}});t.after(()=>app.close());
  const root=await app.inject('/');assert.equal(root.statusCode,302);assert.equal(root.headers.location,enabled==='true'?'/live':'/web/');assert.equal((await app.inject('/api/live/shops')).statusCode,401);
 }
});
test('API rejects unknown filters, client-supplied cipher and malformed order windows before network',async t=>{
 const f=await ready();let calls=0;const app=await routes(f,async()=>{calls++;throw new Error();});t.after(()=>app.close());
 for(const [resource,payload] of [['products',{shop_cipher:'evil'}],['orders',{}],['orders',{...window,access_token:'evil'}],['orders',{...window,end_at:NOW+1000}]] as const){const result=await app.inject({method:'POST',url:'/api/live/shops/'+TARGET.shopId+'/'+resource+'/sync',headers,payload});assert.equal(result.statusCode,400);assert.ok(!result.body.includes('evil'));}
 assert.equal((await app.inject({url:'/api/live/shops/'+TARGET.shopId+'/products?shop_id=other',headers})).statusCode,400);assert.equal(calls,0);
});
test('API reads do not fetch upstream; successful sync produces safe source and time metadata',async t=>{
 const f=await ready();let calls=0;const app=await routes(f,async()=>{calls++;return json({total_count:1,orders:[upstreamOrder]});});t.after(()=>app.close());
 let result=await app.inject({url:'/api/live/shops/'+TARGET.shopId+'/orders',headers});assert.equal(result.json().data,null);assert.equal(calls,0);
 result=await app.inject({method:'POST',url:'/api/live/shops/'+TARGET.shopId+'/orders/sync',headers,payload:window});assert.equal(result.statusCode,200);assert.equal(result.json().count,1);assert.equal(calls,1);
 result=await app.inject({url:'/api/live/shops/'+TARGET.shopId+'/orders',headers});assert.equal(result.statusCode,200);assert.deepEqual(result.json().window,window);assert.equal(result.json().source,'tiktok_api');assert.ok(!result.body.includes('synthetic-private'));assert.equal(calls,1);
});
test('missing live migration blocks sync before any upstream request',async t=>{
 const f=await ready();await f.db.prepare('DELETE FROM muse_schema_versions WHERE version=4').run();t.after(()=>f.db.prepare('INSERT INTO muse_schema_versions(version) VALUES(4)').run());
 let calls=0;const s=service(f,async()=>{calls++;throw new Error();});await assert.rejects(()=>s.sync(TARGET.shopId,'MY','products'),(e:any)=>e.code==='LIVE_MIGRATION_REQUIRED');assert.equal(calls,0);
});
test('live page scripts parse, use no credential storage, and render dynamic business data as text',async t=>{
 const f=await ready();const app=await routes(f,async()=>{throw new Error();});t.after(()=>app.close());const page=await app.inject('/live'),script=await app.inject('/live.js');
 assert.equal(page.statusCode,200);assert.match(String(page.headers['content-security-policy']),/connect-src 'self'/);assert.equal(page.headers['cache-control'],'no-store');assert.match(page.body,/type="password"/);new Script(script.body);
 assert.doesNotMatch(script.body,/innerHTML|localStorage|sessionStorage|document.cookie/);assert.match(script.body,/textContent/);assert.match(script.body,/pagehide/);
});
function pageHarness(script:string,fetchImpl:typeof fetch){
 const elements=new Map<string,any>();
 const make=(tag:string)=>({tag,value:'',textContent:'',hidden:false,disabled:false,children:[] as any[],listeners:new Map<string,Function>(),addEventListener(type:string,fn:Function){this.listeners.set(type,fn);},append(...nodes:any[]){this.children.push(...nodes);if(this.tag==='select'&&!this.value&&nodes[0]?.value)this.value=nodes[0].value;},replaceChildren(...nodes:any[]){this.children=[...nodes];if(this.tag==='select')this.value='';}});
 const get=(id:string)=>{if(!elements.has(id))elements.set(id,make(id==='shop'?'select':'div'));return elements.get(id);};
 new Script(script).runInNewContext({document:{getElementById:get,createElement:make},window:{addEventListener(){}},fetch:fetchImpl,Intl,Date,JSON,Number,encodeURIComponent});
 return {get,dispatch:(id:string,type:string)=>get(id).listeners.get(type)?.({preventDefault(){}})};
}
const settle=()=>new Promise<void>(r=>setImmediate(r));
test('live page displays invalid credential errors and discards in-flight results after credentials change',async t=>{
 const f=await ready();const app=await routes(f,async()=>{throw new Error();});t.after(()=>app.close());const script=(await app.inject('/live.js')).body;
 const denied=pageHarness(script,async()=>new Response(JSON.stringify({code:'UNAUTHORIZED'}),{status:401}));denied.get('credential').value=admin;denied.dispatch('access','submit');await settle();assert.equal(denied.get('message').textContent,'管理员凭据无效。');
 let release!:(r:Response)=>void;const pending=pageHarness(script,async()=>new Promise<Response>(r=>release=r));pending.get('credential').value=admin;pending.dispatch('access','submit');pending.get('credential').value='';pending.dispatch('credential','input');
 release(new Response(JSON.stringify({enabled:true,database:true,shops:[{shop_id:TARGET.shopId,market:'MY',permissions:{products:true,orders:true}}]})));await settle();assert.equal(pending.get('controls').hidden,true);assert.equal(pending.get('shop').children.length,0);
 denied.dispatch('logout','click');assert.equal(denied.get('credential').value,'');assert.equal(denied.get('controls').hidden,true);
});
test('live page navigates cached product pages and displays total snapshot coverage',async t=>{
 const f=await ready();const app=await routes(f,async()=>{throw new Error();});t.after(()=>app.close());const script=(await app.inject('/live.js')).body;
 const requests:string[]=[];const page=pageHarness(script,async(url)=>{const path=String(url);requests.push(path);
  if(path==='/api/live/shops')return new Response(JSON.stringify({enabled:true,database:true,shops:[{shop_id:TARGET.shopId,market:'MY',permissions:{products:true,orders:false}}]}));
  const current=Number(new URL(path,'https://erp.example.test').searchParams.get('page'));
  return new Response(JSON.stringify({resource:'products',shop_id:TARGET.shopId,synced_at:NOW,window:null,last_error:null,data:[product({...upstreamProduct,id:'product-'+current})],pagination:{page:current,page_count:2,total_count:2}}));
 });
 page.get('credential').value=admin;page.dispatch('access','submit');await settle();await settle();assert.match(page.get('products-pagination').textContent,/全量快照 2 条；第 1 \/ 2 页/);assert.equal(page.get('products-next').disabled,false);
 page.dispatch('products-next','click');await settle();await settle();assert.match(page.get('products-pagination').textContent,/第 2 \/ 2 页/);assert.equal(page.get('products-next').disabled,true);assert.equal(page.get('products-prev').disabled,false);assert.ok(requests.some(path=>path.endsWith('products?page=2')));
 page.dispatch('logout','click');assert.equal(page.get('products-pagination').textContent,'');assert.equal(page.get('credential').value,'');
});
test('draft products and unassigned seller SKUs remain explicitly unknown rather than failing or becoming zero',()=>{
 const result=product({id:'draft',status:'DRAFT',title:'',skus:[{id:'sku',seller_sku:'',price:{currency:'',sale_price:''}}]});
 assert.equal(result.title,null);assert.equal(result.skus![0]!.seller_sku,null);assert.equal(result.skus![0]!.currency,null);assert.equal(result.skus![0]!.sale_price,null);assert.equal(result.skus![0]!.inventory,null);
});
