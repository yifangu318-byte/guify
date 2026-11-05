import {randomUUID} from 'node:crypto';
import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import type {TiktokRuntime} from '../tiktok/routes.js';
import {authenticated,parseTargets} from '../tiktok/oauth.js';
import {LiveService} from '../live/service.js';
import {LiveError,record} from '../live/models.js';
import {AiService,type AiClientRow} from './service.js';
import {AiError,aiTools,instructions,isTool,type AiTool} from './contracts.js';
import {aiOpenApi} from './openapi.js';
import {registerAiPage} from './page.js';
import {invokeOfficial} from './official.js';
import {officialBodyLimit,officialUploadPaths} from './official-upload.js';
import {catalogPath,officialCatalog,reference} from './official-catalog.js';
import {handoffMarkdown} from './handoff.js';
import {resolveTargets} from '../tiktok/targets.js';

export function registerAi(app:FastifyInstance,runtime:TiktokRuntime){
  registerAiPage(app);
  const read=(getter:(()=>string|undefined)|undefined,name:string)=>getter?getter():process.env[name];
  const enabled=()=>read(runtime.getAiEnabled,'MUSE_AI_API_ENABLED')==='true';
  const publicEnabled=()=>read(runtime.getAiPublicEnabled,'MUSE_AI_PUBLIC_ENABLED')==='true';
  const officialEnabled=()=>read(runtime.getOfficialEnabled,'MUSE_TIKTOK_API_ENABLED')==='true';
  const writeEnabled=()=>read(runtime.getWriteEnabled,'MUSE_TIKTOK_WRITE_ENABLED')==='true';
  const availableTools=()=>aiTools.filter(t=>t.name!=='tiktok_request'||officialEnabled());
  const isAdmin=(request:FastifyRequest)=>authenticated(request.headers.authorization,read(runtime.getAdminToken,'MUSE_OAUTH_ADMIN_TOKEN'))
    ||authenticated(request.headers.authorization,read(runtime.getAdminPassword,'MUSE_ADMIN_PASSWORD'),8);
  const config=async(request:FastifyRequest)=>{
    let origin:URL;
    try{origin=new URL(read(runtime.getPublicUrl,'PUBLIC_URL')??'');if(origin.protocol!=='https:'||origin.pathname!=='/'||origin.search||origin.hash||origin.username||origin.password)throw new Error();}
    catch{throw new AiError(503,'AI_UNAVAILABLE');}
    if(request.headers.host!==origin.host||request.headers.origin&&request.headers.origin!==origin.origin||request.headers['sec-fetch-site']==='cross-site')throw new AiError(403,'FORBIDDEN');
    if(!['test','staging','production'].includes(read(runtime.getEnvironment,'MUSE_ENV')??''))throw new AiError(503,'AI_UNAVAILABLE');
    const db=runtime.getDb?.(),appKey=read(runtime.getAppKey,'TIKTOK_APP_KEY');
    if(!db||!appKey)throw new AiError(503,'AI_UNAVAILABLE');
    const targets=await resolveTargets(parseTargets(read(runtime.getTargets,'TIKTOK_SHOP_TARGETS')),db,appKey,read(runtime.getMultiShopEnabled,'MUSE_MULTI_SHOP_ENABLED')==='true'),now=runtime.now??Date.now;
    // Reading cached snapshots needs neither app secret nor encryption key and never refreshes tokens.
    const live=new LiveService({db,appKey,appSecret:'',secret:'',now,fetchImpl:async()=>{throw new Error('AI reads cannot contact upstream');}});
    return new AiService({db,appKey,targets,live,now,...(officialEnabled()?{official:async(target,args)=>{
      const appSecret=read(runtime.getAppSecret,'TIKTOK_APP_SECRET'),secret=read(runtime.getSecret,'TOKEN_ENCRYPTION_KEY');
      if(!appSecret||!secret)throw new AiError(503,'OFFICIAL_API_UNAVAILABLE');
      return invokeOfficial(args,{db,appKey,appSecret,secret,target,writeEnabled:writeEnabled(),now,...(runtime.fetchImpl?{fetchImpl:runtime.fetchImpl}:{})});
    }}:{})});
  };
  const safe=(handler:(request:FastifyRequest,reply:FastifyReply)=>Promise<unknown>)=>async(request:FastifyRequest,reply:FastifyReply)=>{
    const requestId=randomUUID();reply.header('Cache-Control','no-store').header('Referrer-Policy','no-referrer').header('X-Content-Type-Options','nosniff').header('X-Request-ID',requestId);
    try{return await handler(request,reply);}catch(error){
      const e=error instanceof AiError||error instanceof LiveError?error:new AiError(503,'AI_UNAVAILABLE');
      if(e instanceof AiError&&e.retryAfter)reply.header('Retry-After',e.retryAfter);
      app.log.info({event:'ai_api_failed',request_id:requestId,status:e.status,code:e.code},'AI API request rejected');
      return reply.code(e.status).send({error:true,code:e.code,message:'AI API request could not be completed.',request_id:requestId});
    }
  };
  const admin=async(request:FastifyRequest)=>{
    if(!isAdmin(request))throw new AiError(401,'UNAUTHORIZED');
    const service=await config(request);await service.ready();return service;
  };
  const noQuery=(request:FastifyRequest)=>{if(Object.keys(request.query as object).length)throw new AiError(400,'INVALID_REQUEST');};
  app.get('/api/ai/openapi.json',async(_request,reply)=>reply.header('Cache-Control','no-store').send({...aiOpenApi,
    security:publicEnabled()?[]:aiOpenApi.security,
    paths:Object.fromEntries(Object.entries(aiOpenApi.paths).filter(([path])=>availableTools().some(t=>path==='/api/ai/tools/'+t.name)))}));
  app.get('/api/ai/admin/status',safe(async request=>{
    noQuery(request);
    if(!isAdmin(request))throw new AiError(401,'UNAUTHORIZED');
    const service=await config(request);let database=false;try{await service.ready();database=true;}catch{}
    return {enabled:enabled(),public_enabled:publicEnabled(),official_enabled:officialEnabled(),write_enabled:writeEnabled(),live_enabled:read(runtime.getLiveEnabled,'MUSE_LIVE_READ_ENABLED')==='true',database,
      shops:service.options.targets.map(t=>({shop_id:t.shopId,market:t.market})),tools:availableTools(),instructions};
  }));
  app.get('/api/ai/admin/handoff',safe(async(request,reply)=>{
    noQuery(request);const service=await admin(request);
    const grants=[];
    for(const target of service.options.targets){
      const row=await service.options.db.prepare('SELECT a.status,a.scopes_json FROM authorizations a JOIN authorized_shops s ON s.authorization_id=a.id WHERE s.app_hash=? AND a.app_hash=? AND s.tiktok_shop_id=? AND s.market=?')
        .bind(service.appHash,service.appHash,target.shopId,target.market).first<{status:string;scopes_json:string}>();
      const scopes:unknown=row?JSON.parse(row.scopes_json):[];
      grants.push({shop_id:target.shopId,status:row?.status??'not_connected',scopes:Array.isArray(scopes)?scopes.filter((s):s is string=>typeof s==='string'&&/^[A-Za-z0-9_.]{1,128}$/.test(s)):[]});
    }
    const markdown=handoffMarkdown(new URL(read(runtime.getPublicUrl,'PUBLIC_URL')!).origin,service.options.targets,publicEnabled()&&enabled(),officialEnabled(),writeEnabled(),grants);
    return reply.type('text/markdown; charset=utf-8').header('Content-Disposition','attachment; filename="MUSE-AI.md"').send(markdown);
  }));
  app.get('/api/ai/admin/clients',safe(async request=>{noQuery(request);return (await admin(request)).list();}));
  app.post('/api/ai/admin/clients',{bodyLimit:8192},safe(async(request,reply)=>{
    noQuery(request);const service=await admin(request);
    const client=await service.create(request.body,[read(runtime.getAdminToken,'MUSE_OAUTH_ADMIN_TOKEN'),read(runtime.getAppSecret,'TIKTOK_APP_SECRET'),read(runtime.getSecret,'TOKEN_ENCRYPTION_KEY')]);
    reply.code(201);return client;
  }));
  app.post('/api/ai/admin/clients/:id/revoke',{bodyLimit:1024},safe(async request=>{
    noQuery(request);const service=await admin(request);
    if(!record(request.body)||Object.keys(request.body).length)throw new AiError(400,'INVALID_REQUEST');
    return service.revoke((request.params as {id:unknown}).id);
  }));
  const agent=async(request:FastifyRequest)=>{
    if(publicEnabled()&&request.headers.authorization===undefined){
      const service=await config(request);
      if(!enabled()||read(runtime.getLiveEnabled,'MUSE_LIVE_READ_ENABLED')!=='true')throw new AiError(503,'AI_DISABLED');
      await service.ready();const now=(runtime.now??Date.now)();
      const client:AiClientRow={id:'anonymous-public',app_hash:service.appHash,name:'Public',token_hash:'',shop_ids_json:JSON.stringify(service.options.targets.map(t=>t.shopId)),
        tools_json:JSON.stringify(availableTools().map(t=>t.name)),created_at:now,expires_at:Number.MAX_SAFE_INTEGER,revoked_at:null,rate_limit:0,rate_window:0,rate_count:0};
      if(!service.options.targets.length)throw new AiError(503,'SHOP_AUTHORIZATION_REQUIRED');return {service,client};
    }
    if(typeof request.headers.authorization!=='string'||!/^Bearer [A-Za-z0-9_-]{32,256}$/.test(request.headers.authorization))throw new AiError(401,'UNAUTHORIZED');
    const service=await config(request);
    if(!enabled()||read(runtime.getLiveEnabled,'MUSE_LIVE_READ_ENABLED')!=='true')throw new AiError(503,'AI_DISABLED');
    await service.ready();const client=await service.authenticate(request.headers.authorization);return {service,client};
  };
  const invoke=async(service:AiService,client:AiClientRow,tool:unknown,args:unknown)=>{
    let status=200,result:unknown;
    try{result=await service.invoke(client,tool,args);}catch(error){status=error instanceof AiError||error instanceof LiveError?error.status:503;
      await service.audit(client.id,'tool_call',status,isTool(tool)?tool:null,record(args)&&typeof args.shop_id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(args.shop_id)?args.shop_id:null);throw error;}
    if(record(result)&&result.error===true)status=502;
    await service.audit(client.id,'tool_call',status,isTool(tool)?tool:null,record(args)&&typeof args.shop_id==='string'?args.shop_id:null);
    app.log.info({event:'ai_tool_read',client_id:client.id,tool,request_status:status},'AI read completed');return result;
  };
  app.get('/api/ai/tools',safe(async request=>{
    const {service,client}=await agent(request);noQuery(request);
    await service.audit(client.id,'tools_listed',200);const tools=availableTools().filter(t=>service.allowedTools(client).includes(t.name));
    return {tools,instructions,...(tools.some(t=>t.name==='tiktok_request')?{official_api:{catalog:catalogPath,reference,multipart_paths:writeEnabled()?officialUploadPaths:[]}}:{})};
  }));
  app.get(catalogPath,safe(async request=>{
    noQuery(request);const {service,client}=await agent(request);
    if(!officialEnabled()||!service.allowedTools(client).includes('tiktok_request'))throw new AiError(403,'TOOL_FORBIDDEN');
    return officialCatalog(writeEnabled());
  }));
  app.post('/api/ai/tools/tiktok_request',{bodyLimit:officialBodyLimit},safe(async request=>{
    const {service,client}=await agent(request);noQuery(request);return invoke(service,client,'tiktok_request',request.body);
  }));
  app.post('/api/ai/tools/:tool',{bodyLimit:73728},safe(async request=>{
    const {service,client}=await agent(request);noQuery(request);return invoke(service,client,(request.params as {tool:unknown}).tool,request.body);
  }));
  app.get('/api/ai/shops',safe(async request=>{const {service,client}=await agent(request);noQuery(request);return invoke(service,client,'list_shops',{});}));
  for(const [path,tool] of [
    ['/api/ai/shops/:shop_id/products/:product_id','get_product_detail'],
    ['/api/ai/shops/:shop_id/products/:product_id/skus','get_product_skus'],
    ['/api/ai/shops/:shop_id/orders/:order_id','get_order_detail'],
    ['/api/ai/shops/:shop_id/orders/:order_id/status','get_order_status'],
  ] as const)app.get(path,safe(async request=>{
    const {service,client}=await agent(request);noQuery(request);return invoke(service,client,tool,request.params);
  }));
  app.get('/api/ai/shops/:shop_id/:resource',safe(async request=>{
    const {service,client}=await agent(request),{shop_id,resource}=request.params as {shop_id:string;resource:string},query=request.query as Record<string,unknown>;
    const tool=({products:'get_products',orders:'get_orders',inventory:'get_inventory'} as Record<string,AiTool>)[resource];
    if(!tool)throw new AiError(404,'TOOL_NOT_FOUND');
    if(Object.keys(query).some(k=>k!=='page'||resource==='orders')||query.page!==undefined&&(typeof query.page!=='string'||!/^([1-9]|1\d|20)$/.test(query.page)))throw new AiError(400,'INVALID_REQUEST');
    return invoke(service,client,tool,{shop_id,...(query.page!==undefined?{page:Number(query.page)}:{})});
  }));
}
