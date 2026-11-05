import {test} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {Script} from 'node:vm';
import {fixture,NOW,TARGET} from './oauth-fixture.js';
import {handleTikTokCallback} from '../src/tiktok/oauth.js';
import {hash} from '../src/tiktok/vault.js';
import {registerOAuth} from '../src/tiktok/routes.js';
import {ProductSnapshotBuilder} from '../src/live/snapshot.js';
import {createAiHttpClient} from '../src/ai/client.js';
import {aiPageScript} from '../src/ai/page.js';
import {aiTools} from '../src/ai/contracts.js';
import {createLiveMcpServer} from '../src/ai/mcp.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
const admin='synthetic-administrator-01234567890123456789';
const token='synthetic-ai-dedicated-01234567890123456789';
const host='erp.example.test';
const adminHeaders={authorization:'Bearer '+admin,host,origin:'https://'+host};
const aiHeaders={authorization:'Bearer '+token,host};
const grant={name:'Synthetic Grok / Muse',token,shop_ids:[TARGET.shopId],tools:aiTools.map(t=>t.name),expires_in_days:30,rate_limit:60};
async function setup(overrides:Record<string,any>={}){
  const f=await fixture();assert.equal((await handleTikTokCallback(f.query,f.deps)).status,200);
  await f.db.prepare('UPDATE authorizations SET scopes_json=?').bind(JSON.stringify(['seller.authorization.info','seller.product.basic','seller.order.info'])).run();
  let outbound=0;
  const app=Fastify();registerOAuth(app,{getDb:()=>f.db,getAppKey:()=> 'synthetic-app',getPublicUrl:()=> 'https://'+host,
    getAdminToken:()=>admin,getEnvironment:()=> 'test',getTargets:()=>JSON.stringify([TARGET]),getLiveEnabled:()=> 'true',getAiEnabled:()=> 'true',
    now:f.deps.now,fetchImpl:async()=>{outbound++;throw new Error('No upstream allowed');},...overrides});await app.ready();
  const create=(payload:unknown=grant)=>app.inject({method:'POST',url:'/api/ai/admin/clients',headers:adminHeaders,payload});
  const call=(tool:string,payload:unknown={shop_id:TARGET.shopId})=>app.inject({method:'POST',url:'/api/ai/tools/'+tool,headers:aiHeaders,payload});
  return {...f,app,create,call,outbound:()=>outbound};
}
test('AI grants are admin-only, hash credentials and never return them; duplicate and administrator tokens rejected',async t=>{
  const f=await setup();t.after(()=>f.app.close());
  for(const headers of [{host},aiHeaders])assert.equal((await f.app.inject({method:'POST',url:'/api/ai/admin/clients',headers,payload:grant})).statusCode,401);
  const saved=await f.create();assert.equal(saved.statusCode,201);assert.equal(saved.json().name,grant.name);assert.ok(!saved.body.includes(token));
  const row=await f.db.prepare('SELECT * FROM ai_api_clients').first();assert.equal(row.token_hash,hash(token));assert.ok(!JSON.stringify(row).includes(token));
  assert.equal((await f.create()).statusCode,409);assert.equal((await f.create({...grant,token:admin})).statusCode,400);
  const list=await f.app.inject({url:'/api/ai/admin/clients',headers:adminHeaders});assert.equal(list.json().clients.length,1);assert.ok(!list.body.includes('token_hash'));assert.ok(!list.body.includes(token));
  assert.equal((await f.app.inject({url:'/api/ai/shops',headers:adminHeaders})).statusCode,401);
  assert.equal((await f.app.inject({url:'/api/live/shops',headers:aiHeaders})).statusCode,401);
});
test('AI grant boundary rejects unknown shops, write tools, hidden authority and unsafe credential settings',async t=>{
  const f=await setup();t.after(()=>f.app.close());
  for(const change of [{shop_ids:[]},{shop_ids:['other-shop']},{shop_ids:[TARGET.shopId,TARGET.shopId]},{tools:['refund_order']},{tools:[]},{tools:['get_orders','get_orders']},
    {token:'short'},{token:' '.repeat(40)},{expires_in_days:0},{expires_in_days:366},{expires_in_days:1.5},{rate_limit:0},{rate_limit:601},{name:'\nInjected'},{is_admin:true},{url:'https://private.example'}]){
    assert.equal((await f.create({...grant,...change})).statusCode,400,JSON.stringify(change));
  }
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM ai_api_clients').first()).n,0);
});
test('AI APIs fail closed before enablement, without migration, on another host and for cross-site browser calls',async t=>{
  const f=await setup({getAiEnabled:()=> 'false'});t.after(()=>f.app.close());
  assert.equal((await f.app.inject({url:'/api/ai/shops',headers:{host}})).statusCode,401);
  assert.equal((await f.app.inject({url:'/api/ai/shops',headers:aiHeaders})).statusCode,503);
  for(const headers of [{...adminHeaders,host:'other.example'},{...adminHeaders,origin:'https://other.example'},{...adminHeaders,'sec-fetch-site':'cross-site'}])
    assert.equal((await f.app.inject({url:'/api/ai/admin/status',headers})).statusCode,403);
  const status=await f.app.inject({url:'/api/ai/admin/status',headers:adminHeaders});assert.equal(status.json().enabled,false);assert.equal(status.json().database,true);
  await f.db.prepare('DELETE FROM muse_schema_versions WHERE version=5').run();
  try{assert.equal((await f.create()).json().code,'AI_MIGRATION_REQUIRED');assert.equal((await f.app.inject({url:'/api/ai/admin/status',headers:adminHeaders})).json().database,false);}
  finally{await f.db.prepare('INSERT INTO muse_schema_versions(version) VALUES (5)').run();}
});
test('AI tool discovery and shop listing respect per-client grants and current upstream scopes',async t=>{
  const f=await setup();t.after(()=>f.app.close());await f.create({...grant,tools:['list_shops','get_inventory']});
  const discovery=await f.app.inject({url:'/api/ai/tools',headers:aiHeaders});assert.deepEqual(discovery.json().tools.map((v:any)=>v.name),['list_shops','get_inventory']);
  const shops=await f.call('list_shops',{});assert.deepEqual(shops.json().shops,[{shop_id:TARGET.shopId,market:'MY',permissions:{products:false,orders:false,inventory:true}}]);
  assert.equal((await f.call('get_products')).statusCode,403);assert.equal((await f.call('get_inventory',{shop_id:'other-shop'})).statusCode,403);
  await f.db.prepare("UPDATE authorizations SET scopes_json='[]'").run();assert.equal((await f.call('get_inventory')).statusCode,403);
  assert.equal((await f.call('list_shops',{})).json().shops[0].permissions.inventory,false);assert.equal(f.outbound(),0);
});
test('AI reads real gzip snapshots with full pagination, precision, timestamps, and per-warehouse inventory',async t=>{
  const f=await setup();t.after(()=>f.app.close());await f.create();
  const product={product_id:'9007199254740993123',title:'Untrusted business text <script>',status:'ACTIVATE',created_at:NOW-10000,updated_at:NOW-5000,
    skus:[{sku_id:'9007199254740993124',seller_sku:'SYNTHETIC',currency:'MYR',tax_exclusive_price:'0.10',sale_price:'1.20',inventory:[{warehouse_id:'W1',quantity:0},{warehouse_id:'W2',quantity:5}]}]};
  const builder=new ProductSnapshotBuilder();for(let page=0;page<3;page++)builder.add(Array.from({length:page===2?5:100},(_,i)=>({...product,product_id:String(1000+page*100+i)})));
  await f.db.prepare('INSERT INTO live_snapshots(app_hash,shop_id,resource,snapshot_json,last_success_at,last_attempt_at,last_error) VALUES (?,?,?,?,?,?,?)')
    .bind(hash('synthetic-app'),TARGET.shopId,'products',builder.finish(205),NOW,NOW,'UPSTREAM_UNAVAILABLE').run();
  const response=await f.call('get_products',{shop_id:TARGET.shopId,page:3});assert.equal(response.statusCode,200);const data=response.json();assert.equal(data.mode,'cached_snapshot');assert.equal(data.source,'tiktok_api');assert.equal(data.synced_at,NOW);assert.equal(data.last_error,'UPSTREAM_UNAVAILABLE');assert.equal(data.pagination.total_count,205);assert.equal(data.pagination.page_count,3);assert.equal(data.data.length,5);assert.equal(data.data[0].skus[0].sale_price,'1.20');
  const inventory=(await f.call('get_inventory')).json();assert.equal(inventory.pagination_unit,'products');assert.equal(inventory.resource,'inventory');assert.deepEqual(inventory.data[0].skus[0].inventory,product.skus[0]!.inventory);assert.ok(!JSON.stringify(inventory.data).includes('sale_price'));
  assert.equal((await f.app.inject({url:'/api/ai/shops/'+TARGET.shopId+'/products?page=3',headers:aiHeaders})).json().data.length,5);assert.equal(f.outbound(),0);
});
test('AI preserves missing snapshots as null and order window, currency and cancellation status',async t=>{
  const f=await setup();t.after(()=>f.app.close());await f.create();assert.equal((await f.call('get_products')).json().data,null);
  const order={order_id:'9007199254740993125',status:'CANCELLED',created_at:NOW-10000,updated_at:null,currency:'MYR',total_amount:'999999999999999.01'};
  await f.db.prepare('INSERT INTO live_snapshots(app_hash,shop_id,resource,snapshot_json,range_start,range_end,last_success_at,last_attempt_at) VALUES (?,?,?,?,?,?,?,?)')
    .bind(hash('synthetic-app'),TARGET.shopId,'orders',JSON.stringify([order]),NOW-86400000,NOW,NOW,NOW).run();
  const response=await f.call('get_orders');assert.equal(response.statusCode,200);assert.deepEqual(response.json().window,{start_at:NOW-86400000,end_at:NOW});assert.deepEqual(response.json().data,[order]);
  assert.equal((await f.call('get_orders',{shop_id:TARGET.shopId,page:1})).statusCode,400);assert.equal(f.outbound(),0);
});
test('AI tools reject arbitrary URLs, injected tokens, unknown tools, scope overrides and malformed pages',async t=>{
  const f=await setup();t.after(()=>f.app.close());await f.create();
  for(const args of [{shop_id:TARGET.shopId,page:'2'},{shop_id:TARGET.shopId,page:0},{shop_id:TARGET.shopId,page:21},{shop_id:TARGET.shopId,url:'http://169.254.169.254'},
    {shop_id:TARGET.shopId,authorization:'synthetic-hidden'},{shop_id:TARGET.shopId,tools:['refund_order']},{shop_id:TARGET.shopId,market:'PH'},[]])assert.equal((await f.call('get_products',args)).statusCode,400);
  assert.equal((await f.call('refund_order',{})).statusCode,404);assert.equal((await f.call('list_shops',{shop_id:TARGET.shopId})).statusCode,400);
  for(const query of ['page=01','page=21','page=1&page=2','page=1&shop_id=other','url=https://other'])assert.equal((await f.app.inject({url:'/api/ai/shops/'+TARGET.shopId+'/products?'+query,headers:aiHeaders})).statusCode,400);
  assert.equal(f.outbound(),0);
});
test('AI credentials expire, revoke independently and cannot cross application or target boundaries',async t=>{
  const f=await setup();t.after(()=>f.app.close());const a=(await f.create()).json();
  const second='synthetic-other-ai-01234567890123456789012345';await f.create({...grant,token:second,name:'Another AI'});
  assert.equal((await f.app.inject({method:'POST',url:'/api/ai/admin/clients/'+a.id+'/revoke',headers:adminHeaders,payload:{}})).statusCode,200);
  assert.equal((await f.call('list_shops',{})).statusCode,401);
  const headers={...aiHeaders,authorization:'Bearer '+second};assert.equal((await f.app.inject({url:'/api/ai/shops',headers})).statusCode,200);
  await f.db.prepare('UPDATE ai_api_clients SET app_hash=? WHERE token_hash=?').bind(hash('other-app'),hash(second)).run();assert.equal((await f.app.inject({url:'/api/ai/shops',headers})).statusCode,401);
  await f.db.prepare('UPDATE ai_api_clients SET app_hash=?,expires_at=? WHERE token_hash=?').bind(hash('synthetic-app'),NOW,hash(second)).run();assert.equal((await f.app.inject({url:'/api/ai/shops',headers})).statusCode,401);
});
test('durable AI rate limits are atomic under concurrent requests and reset next minute',async t=>{
  const f=await setup();t.after(()=>f.app.close());await f.create({...grant,rate_limit:3});
  const responses=await Promise.all(Array.from({length:8},()=>f.call('list_shops',{})));
  assert.equal(responses.filter(r=>r.statusCode===200).length,3);assert.equal(responses.filter(r=>r.statusCode===429).length,5);
  assert.ok(Number(responses.find(r=>r.statusCode===429)!.headers['retry-after'])>0);
  f.tick(60000);assert.equal((await f.call('list_shops',{})).statusCode,200);
});
test('AI audit records identity and outcome without plaintext credentials, parameters or snapshot contents',async t=>{
  const f=await setup();t.after(()=>f.app.close());const saved=(await f.create()).json();await f.call('get_products');await f.call('get_orders',{shop_id:'unauthorized-shop'});
  const audit=await f.db.prepare('SELECT * FROM ai_api_audit ORDER BY created_at,id').all();const text=JSON.stringify(audit);assert.ok(!text.includes(token));assert.ok(!text.includes(admin));assert.ok(!text.includes('snapshot_json'));assert.ok(audit.results.some((r:any)=>r.client_id===saved.id&&r.tool==='get_orders'&&r.status===403));
});
test('AI public docs and management page describe real cached data without granting anonymous access',async t=>{
  const f=await setup();t.after(()=>f.app.close());
  new Script(aiPageScript);
  const page=await f.app.inject('/developers');assert.equal(page.statusCode,200);assert.equal(page.headers['cache-control'],'no-store');assert.ok(page.headers['content-security-policy']?.includes("frame-ancestors 'none'"));
  const spec=(await f.app.inject('/api/ai/openapi.json')).json();assert.equal(spec.openapi,'3.1.0');assert.equal(Object.keys(spec.paths).length,8);assert.deepEqual(spec.security,[{aiBearer:[]}]);assert.ok(!JSON.stringify(spec).includes(TARGET.shopId));
  for(const path of ['/api/ai/shops','/api/ai/tools','/api/ai/admin/clients','/api/ai/admin/status']){const r=await f.app.inject({url:path,headers:{host}});assert.equal(r.statusCode,401);assert.equal(r.headers['cache-control'],'no-store');}
});
test('VPS HTTPS bridge calls the same scoped real-data gateway and never follows unknown tools or redirects',async t=>{
  const f=await setup();t.after(()=>f.app.close());await f.create({...grant,tools:['list_shops','get_orders']});let calls=0;
  const client=createAiHttpClient('https://'+host,token,async(input,init)=>{
    calls++;const url=new URL(String(input));assert.equal(url.origin,'https://'+host);assert.equal(init!.redirect,'error');assert.equal(init!.credentials,'omit');
    const response=await f.app.inject({method:init!.method as 'GET'|'POST',url:url.pathname,headers:{...(init!.headers as Record<string,string>),host},...(init!.body?{payload:String(init!.body)}:{})});
    return new Response(response.body,{status:response.statusCode,headers:{'Content-Type':'application/json'}});
  });
  assert.deepEqual((await client.listTools()).map(t=>t.name),['list_shops','get_orders']);assert.equal((await client.invoke('list_shops',{})).source,'tiktok_api');assert.equal((await client.invoke('refund_order',{})).code,'TOOL_NOT_FOUND');assert.equal(calls,2);
  assert.throws(()=>createAiHttpClient('http://'+host,token));assert.throws(()=>createAiHttpClient('https://'+host+'/api',token));assert.throws(()=>createAiHttpClient('https://user:pass@'+host,token));assert.throws(()=>createAiHttpClient('https://'+host,'short'));
  const denied=createAiHttpClient('https://'+host,token,async()=>new Response('synthetic-private-error',{status:403}));assert.deepEqual(await denied.invoke('get_orders',{}),{error:true,code:'ERP_REQUEST_FAILED',status:403});
});
test('real MCP protocol discovers scoped tools, reads the same cached result and rejects identity escalation',async t=>{
  const f=await setup();t.after(()=>f.app.close());await f.create({...grant,tools:['list_shops','get_products']});
  const http=createAiHttpClient('https://'+host,token,async(input,init)=>{
    const response=await f.app.inject({method:init!.method as 'GET'|'POST',url:new URL(String(input)).pathname,headers:{...(init!.headers as Record<string,string>),host},...(init!.body?{payload:String(init!.body)}:{})});
    return new Response(response.body,{status:response.statusCode});
  });
  const server=createLiveMcpServer(http),client=new Client({name:'synthetic-vps-ai',version:'1.0.0'}),[left,right]=InMemoryTransport.createLinkedPair();
  t.after(async()=>{await client.close();await server.close();});await server.connect(right);await client.connect(left);
  assert.deepEqual((await client.listTools()).tools.map(v=>v.name),['list_shops','get_products']);
  const result=await client.callTool({name:'get_products',arguments:{shop_id:TARGET.shopId}});assert.equal(result.isError,false);assert.deepEqual(result.structuredContent,(await f.call('get_products')).json());
  const denied=await client.callTool({name:'get_products',arguments:{shop_id:'other-shop'},_meta:{authorization:'Bearer '+admin}});assert.equal(denied.isError,true);
  assert.equal((await client.callTool({name:'get_orders',arguments:{shop_id:TARGET.shopId}})).isError,true);assert.equal(f.outbound(),0);
});
test('removing an assigned target or revoking TikTok authorization immediately blocks AI reads',async t=>{
  let targets=JSON.stringify([TARGET]);const f=await setup({getTargets:()=>targets});t.after(()=>f.app.close());await f.create();
  targets='[]';assert.equal((await f.call('get_products')).statusCode,403);assert.deepEqual((await f.call('list_shops',{})).json().shops,[]);
  targets=JSON.stringify([TARGET]);await f.db.prepare("UPDATE authorizations SET status='reauthorize_required'").run();assert.equal((await f.call('get_products')).statusCode,403);
});
test('exact product and SKU lookups find the final compressed page without rounding IDs',async t=>{
  const f=await setup();t.after(()=>f.app.close());await f.create();
  const product={product_id:'9007199254740993123',title:'Synthetic',status:'ACTIVATE',created_at:NOW,updated_at:NOW,skus:[{sku_id:'precise-sku',seller_sku:null,currency:'MYR',sale_price:'1.20',tax_exclusive_price:null,inventory:[{warehouse_id:'w1',quantity:0}]}]};
  const builder=new ProductSnapshotBuilder();for(let p=0;p<16;p++)builder.add(Array.from({length:p===15?70:100},(_,i)=>({...product,product_id:p===15&&i===69?product.product_id:String(p*100+i)})));
  await f.db.prepare('INSERT INTO live_snapshots(app_hash,shop_id,resource,snapshot_json,last_success_at,last_attempt_at) VALUES (?,?,?,?,?,?)').bind(hash('synthetic-app'),TARGET.shopId,'products',builder.finish(1570),NOW,NOW).run();
  const result=await f.call('get_product_detail',{shop_id:TARGET.shopId,product_id:product.product_id});assert.equal(result.statusCode,200);assert.deepEqual(result.json().data,product);assert.equal(result.json().lookup_status,'found');assert.equal(result.json().coverage.matched_page,16);assert.equal(result.json().coverage.total_count,1570);assert.equal(result.json().synced_at,NOW);
  const skus=await f.app.inject({url:'/api/ai/shops/'+TARGET.shopId+'/products/'+product.product_id+'/skus',headers:aiHeaders});assert.equal(skus.statusCode,200);assert.deepEqual(skus.json().data,{product_id:product.product_id,skus:product.skus});assert.equal(f.outbound(),0);
});
test('detail tools distinguish missing snapshot from object absent in a completed saved snapshot',async t=>{
  const f=await setup();t.after(()=>f.app.close());await f.create();const args={shop_id:TARGET.shopId,product_id:'absent'};
  assert.equal((await f.call('get_product_detail',args)).json().lookup_status,'snapshot_missing');
  await f.db.prepare('INSERT INTO live_snapshots(app_hash,shop_id,resource,snapshot_json,last_success_at,last_attempt_at) VALUES (?,?,?,?,?,?)').bind(hash('synthetic-app'),TARGET.shopId,'products','[]',NOW,NOW).run();
  const result=(await f.call('get_product_detail',args)).json();assert.equal(result.lookup_status,'not_in_snapshot');assert.equal(result.data,null);assert.equal(result.coverage.complete,true);assert.equal(result.coverage.total_count,0);
});
test('order detail and status preserve snapshot window and cancellation without exposing extra fields',async t=>{
  const f=await setup();t.after(()=>f.app.close());await f.create();const order={order_id:'9007199254740993999',status:'CANCELLED',created_at:NOW-1000,updated_at:null,currency:'MYR',total_amount:'1.20'};
  await f.db.prepare('INSERT INTO live_snapshots(app_hash,shop_id,resource,snapshot_json,range_start,range_end,last_success_at,last_attempt_at) VALUES (?,?,?,?,?,?,?,?)').bind(hash('synthetic-app'),TARGET.shopId,'orders',JSON.stringify([order]),NOW-86400000,NOW,NOW,NOW).run();
  const detail=(await f.call('get_order_detail',{shop_id:TARGET.shopId,order_id:order.order_id})).json();assert.deepEqual(detail.data,order);assert.deepEqual(detail.window,{start_at:NOW-86400000,end_at:NOW});
  const status=await f.app.inject({url:'/api/ai/shops/'+TARGET.shopId+'/orders/'+order.order_id+'/status',headers:aiHeaders});assert.equal(status.statusCode,200);assert.deepEqual(status.json().data,{order_id:order.order_id,status:order.status,created_at:order.created_at,updated_at:null});
  assert.equal((await f.call('get_order_detail',{shop_id:TARGET.shopId,order_id:'outside-window'})).json().lookup_status,'not_in_snapshot');assert.equal(f.outbound(),0);
});
test('new read tools require separate grants and strictly validate IDs, store scope and extra arguments',async t=>{
  const f=await setup();t.after(()=>f.app.close());await f.create({...grant,tools:['get_products','get_orders','get_inventory','list_shops']});
  assert.equal((await f.call('get_product_detail',{shop_id:TARGET.shopId,product_id:'p1'})).statusCode,403);
  await f.db.prepare('UPDATE ai_api_clients SET tools_json=?').bind(JSON.stringify(['get_product_detail','get_product_skus','get_order_detail','get_order_status'])).run();
  for(const args of [{shop_id:TARGET.shopId},{shop_id:TARGET.shopId,product_id:9007199254740992},{shop_id:TARGET.shopId,product_id:'p1',page:1},{shop_id:TARGET.shopId,product_id:'p1',order_id:'o1'},{shop_id:TARGET.shopId,product_id:'../p1'},{shop_id:TARGET.shopId,product_id:'p1',url:'http://127.0.0.1'}])assert.equal((await f.call('get_product_detail',args)).statusCode,400);
  assert.equal((await f.call('get_product_detail',{shop_id:'other-shop',product_id:'p1'})).statusCode,403);
  await f.db.prepare("UPDATE authorizations SET scopes_json='[]'").run();assert.equal((await f.call('get_order_detail',{shop_id:TARGET.shopId,order_id:'o1'})).statusCode,403);
});
