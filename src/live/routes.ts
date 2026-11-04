import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {TiktokRuntime} from '../tiktok/routes.js';
import {authenticated,parseTargets} from '../tiktok/oauth.js';
import {LiveService,type LiveConfig} from './service.js';
import {LiveError,parseWindow,record,type Resource} from './models.js';
import {registerLivePage} from './page.js';
export function registerLive(app:FastifyInstance,runtime:TiktokRuntime){
  registerLivePage(app);
  const read=(getter:(()=>string|undefined)|undefined,name:string)=>getter?getter():process.env[name];
  const config=(request:FastifyRequest)=>{
    if(!authenticated(request.headers.authorization,read(runtime.getAdminToken,'MUSE_OAUTH_ADMIN_TOKEN')))throw new LiveError(401,'UNAUTHORIZED');
    let origin:URL;
    try{origin=new URL(read(runtime.getPublicUrl,'PUBLIC_URL')??'');if(origin.protocol!=='https:'||origin.pathname!=='/'||origin.username||origin.password||origin.search||origin.hash)throw new Error();}
    catch{throw new LiveError(503,'LIVE_UNAVAILABLE');}
    if(request.headers.host!==origin.host||request.headers.origin&&request.headers.origin!==origin.origin||request.headers['sec-fetch-site']==='cross-site')throw new LiveError(403,'FORBIDDEN');
    const environment=read(runtime.getEnvironment,'MUSE_ENV');
    const enabled=read(runtime.getLiveEnabled,'MUSE_LIVE_READ_ENABLED')==='true'&&['test','staging','production'].includes(environment??'');
    const appKey=read(runtime.getAppKey,'TIKTOK_APP_KEY'),appSecret=read(runtime.getAppSecret,'TIKTOK_APP_SECRET'),secret=read(runtime.getSecret,'TOKEN_ENCRYPTION_KEY'),db=runtime.getDb?.();
    if(!appKey||!appSecret||!secret||!/^[a-fA-F0-9]{64}$/.test(secret)||!db)throw new LiveError(503,'LIVE_UNAVAILABLE');
    const targets=parseTargets(read(runtime.getTargets,'TIKTOK_SHOP_TARGETS'));
    const options:LiveConfig={db,appKey,appSecret,secret,...(runtime.fetchImpl?{fetchImpl:runtime.fetchImpl}:{}),...(runtime.now?{now:runtime.now}:{})};
    return {enabled,targets,service:new LiveService(options)};
  };
  const protect=(handler:(request:FastifyRequest)=>Promise<unknown>)=>async(request:FastifyRequest,reply:any)=>{
    reply.header('Cache-Control','no-store').header('Referrer-Policy','no-referrer').header('X-Content-Type-Options','nosniff');
    try{return await handler(request);}catch(error){
      const safe=error instanceof LiveError?error:new LiveError(503,'LIVE_UNAVAILABLE');
      app.log.info({event:'live_data_request_failed',outcome:safe.code},'Live data request failed');
      return reply.code(safe.status).send({error:true,code:safe.code,message:'真实数据请求未完成，请检查接入条件或稍后重试。',...(safe.upstreamCode!==null?{upstream_code:safe.upstreamCode}:{})});
    }
  };
  app.get('/api/live/shops',protect(async request=>{
    if(Object.keys(request.query as object).length)throw new LiveError(400,'INVALID_REQUEST');
    const {enabled,targets,service}=config(request);let database=false;try{await service.ready();database=true;}catch{}
    const shops=[];
    for(const target of targets){const permissions={products:false,orders:false};for(const resource of ['products','orders'] as const){try{await service.scope(target.shopId,target.market,resource);permissions[resource]=true;}catch{}}
      shops.push({shop_id:target.shopId,market:target.market,permissions});}
    return {source:'tiktok_api',enabled,database,shops};
  }));
  const scoped=(request:FastifyRequest)=>{
    const {service,targets,enabled}=config(request);if(!enabled)throw new LiveError(503,'LIVE_DISABLED');
    const {shop_id,resource}=request.params as {shop_id:string;resource:Resource};
    if(!['products','orders'].includes(resource)||Object.keys(request.query as object).length)throw new LiveError(400,'INVALID_REQUEST');
    const target=targets.find(t=>t.shopId===shop_id);if(!target)throw new LiveError(404,'SHOP_NOT_FOUND');
    return {service,target,resource};
  };
  app.get('/api/live/shops/:shop_id/:resource',protect(async request=>{
    const {service,target,resource}=scoped(request);return service.snapshot(target.shopId,target.market,resource);
  }));
  app.post('/api/live/shops/:shop_id/:resource/sync',{bodyLimit:1024},protect(async request=>{
    const {service,target,resource}=scoped(request);
    if(!record(request.body))throw new LiveError(400,'INVALID_REQUEST');
    if(resource==='products'&&Object.keys(request.body).length)throw new LiveError(400,'INVALID_REQUEST');
    const window=resource==='orders'?parseWindow(request.body,service.now()):undefined;
    const result=await service.sync(target.shopId,target.market,resource,window);
    app.log.info({event:'live_sync_completed',resource,count:result.count},'Live sync completed');return result;
  }));
}
