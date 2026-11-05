import {createHmac} from 'node:crypto';
import {D1OAuthStore,hash,type LifecycleDb,type Target} from '../tiktok/vault.js';
import {getValidAccessToken} from '../tiktok/refresh.js';
import {requestJson,UpstreamError} from '../tiktok/http.js';
import {record} from '../live/models.js';
import {AiError} from './contracts.js';

export interface OfficialOptions {db:LifecycleDb;appKey:string;appSecret:string;secret:string;target:Target;writeEnabled:boolean;fetchImpl?:typeof fetch;now?:()=>number}
const forbidden=/^(app_key|app_secret|access_token|refresh_token|sign|timestamp|shop_cipher|shop_id|authorization)$/i;
// Fixed official host, versioned shop business modules only. No auth/token/relay URLs.
const pathPattern=/^\/(product|order|fulfillment|logistics|return_refund|finance|promotion|customer_service|seller|supply_chain|fbt)\/20\d{4}(?:\/[A-Za-z0-9_-]+){1,12}$/;
function clean(value:unknown,secrets:string[],depth=0):unknown {
  if(depth>30)throw new AiError(502,'UPSTREAM_RESPONSE_INVALID');
  if(typeof value==='string'){let result=value;for(const secret of secrets)if(secret)result=result.split(secret).join('[redacted]');return result;}
  if(Array.isArray(value))return value.map(v=>clean(v,secrets,depth+1));
  if(record(value))return Object.fromEntries(Object.entries(value).filter(([key])=>!/token|secret|authorization|cookie|^sign$|^app_key$/i.test(key)).map(([key,v])=>[key,clean(v,secrets,depth+1)]));
  return value;
}
export async function invokeOfficial(args:unknown,options:OfficialOptions){
  if(!record(args)||Object.keys(args).some(k=>!['shop_id','path','method','query','body','request_id'].includes(k))||args.shop_id!==options.target.shopId
    ||typeof args.path!=='string'||!pathPattern.test(args.path)||typeof args.method!=='string'||!['GET','POST','PUT','PATCH','DELETE'].includes(args.method))throw new AiError(400,'INVALID_REQUEST');
  const method=args.method,path=args.path,query=args.query??{},body=args.body;
  if(!record(query)||Object.keys(query).length>32||Object.entries(query).some(([k,v])=>!(/^[a-zA-Z0-9_]{1,64}$/.test(k))||forbidden.test(k)||typeof v!=='string'||v.length>4096)
    ||method==='GET'&&body!==undefined||body!==undefined&&!record(body))throw new AiError(400,'INVALID_REQUEST');
  const bodyText=body===undefined?'':JSON.stringify(body);
  if(Buffer.byteLength(bodyText)>65536)throw new AiError(413,'REQUEST_TOO_LARGE');
  // POST includes read searches, but the generic executor conservatively treats every non-GET as a mutation.
  const mutation=method!=='GET';
  if(mutation&&!options.writeEnabled)throw new AiError(403,'WRITES_DISABLED');
  if((mutation||args.request_id!==undefined)&&(typeof args.request_id!=='string'||!/^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/.test(args.request_id)))throw new AiError(400,'REQUEST_ID_REQUIRED');
  const now=options.now??Date.now,appHash=hash(options.appKey),store=new D1OAuthStore(options.db);
  const authorization=await store.authorization(options.appKey,options.target.shopId);
  const mapping=await options.db.prepare('SELECT market,cipher FROM authorized_shops WHERE app_hash=? AND tiktok_shop_id=? AND authorization_id=?')
    .bind(appHash,options.target.shopId,authorization?.id??'').first<{market:string;cipher:string}>();
  if(!authorization||authorization.status!=='active'||!mapping?.cipher||mapping.market!==options.target.market)throw new AiError(403,'SHOP_AUTHORIZATION_REQUIRED');
  // Prevent caller-supplied shop or credential overrides at any depth of a business body.
  const checkBody=(value:unknown,depth=0)=>{if(depth>30)throw new AiError(400,'INVALID_REQUEST');if(Array.isArray(value)){for(const v of value)checkBody(v,depth+1);}else if(record(value))for(const [key,v] of Object.entries(value)){
    if(forbidden.test(key)&&!(key==='shop_id'&&v===options.target.shopId))throw new AiError(400,'INVALID_REQUEST');checkBody(v,depth+1);
  }};checkBody(body);
  const accessToken=await getValidAccessToken(store,{appKey:options.appKey,appSecret:options.appSecret,secret:options.secret,shopId:options.target.shopId,...(options.fetchImpl?{fetchImpl:options.fetchImpl}:{}),now});
  const fresh=await store.authorization(options.appKey,options.target.shopId);
  const current=await options.db.prepare('SELECT cipher FROM authorized_shops WHERE app_hash=? AND tiktok_shop_id=? AND authorization_id=? AND market=?')
    .bind(appHash,options.target.shopId,fresh?.id??'',options.target.market).first<{cipher:string}>();
  if(!fresh||fresh.status!=='active'||current?.cipher!==mapping.cipher)throw new AiError(403,'SHOP_AUTHORIZATION_REQUIRED');
  if(mutation){
    if(!await options.db.prepare('SELECT version FROM muse_schema_versions WHERE version=6').first())throw new AiError(503,'OPERATIONS_MIGRATION_REQUIRED');
    const digest=hash(JSON.stringify({shop_id:args.shop_id,path,method,query,body:body??null}));
    const claimed=await options.db.prepare(`INSERT INTO api_operations(app_hash,request_id,shop_id,request_hash,state,created_at,updated_at)
      VALUES (?,?,?,?,'started',?,?) ON CONFLICT(app_hash,request_id) DO NOTHING RETURNING request_id`)
      .bind(appHash,args.request_id,args.shop_id,digest,now(),now()).first();
    if(!claimed)throw new AiError(409,'REQUEST_ALREADY_ATTEMPTED');
  }
  const finish=async(state:string,code:number|null)=>{if(mutation)await options.db.prepare('UPDATE api_operations SET state=?,upstream_code=?,updated_at=? WHERE app_hash=? AND request_id=? AND state=?')
    .bind(state,code,now(),appHash,args.request_id,'started').run();};
  const signed:Record<string,string>={...(query as Record<string,string>),app_key:options.appKey,timestamp:String(Math.floor(now()/1000)),shop_cipher:mapping.cipher};
  const canonical=Object.keys(signed).sort().map(k=>k+signed[k]).join('');
  signed.sign=createHmac('sha256',options.appSecret).update(options.appSecret+path+canonical+bodyText+options.appSecret).digest('hex');
  let data:Record<string,unknown>;
  try{data=await requestJson(options.fetchImpl??fetch,'https://open-api.tiktokglobalshop.com'+path+'?'+new URLSearchParams(signed),
    {method,headers:{'Content-Type':'application/json',Accept:'application/json','x-tts-access-token':accessToken},...(body===undefined?{}:{body:bodyText})});}
  catch(error){const code=error instanceof UpstreamError?error.upstreamCode:null;
    const rejected=error instanceof UpstreamError&&(error.category==='business_error'||error.http!==null&&error.http>=400&&error.http<500);
    await finish(rejected?'rejected':'unknown',code);
    // No automatic retry: even a failed HTTP response cannot establish every mutation's outcome.
    return {error:true,code:rejected?'TIKTOK_REQUEST_REJECTED':'OUTCOME_UNKNOWN',upstream_code:code,request_id:args.request_id??null,source:'tiktok_api',mode:'live',shop_id:args.shop_id,retry_safe:false};
  }
  await finish('succeeded',0);
  return {source:'tiktok_api',mode:'live',shop_id:args.shop_id,market:options.target.market,fetched_at:now(),request_id:args.request_id??null,
    data:clean(data,[options.appSecret,options.secret,options.appKey,accessToken,mapping.cipher]),business_outcome:'verify_response_and_read_back'};
}
