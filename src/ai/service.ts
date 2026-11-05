import {randomUUID} from 'node:crypto';
import {hash,type LifecycleDb,type Target} from '../tiktok/vault.js';
import {LiveService} from '../live/service.js';
import {record,type LiveProduct} from '../live/models.js';
import {AiError,isTool,validToken,toolFields,type AiTool} from './contracts.js';

export interface AiClientRow {
  id:string; app_hash:string; name:string; token_hash:string; shop_ids_json:string; tools_json:string;
  created_at:number; expires_at:number; revoked_at:number|null; rate_limit:number; rate_window:number; rate_count:number;
}
export interface AiOptions {db:LifecycleDb;appKey:string;targets:Target[];live:LiveService;now:()=>number}
const validId = (v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
function strings(raw:string):string[]{
  const value:unknown=JSON.parse(raw);
  if(!Array.isArray(value)||!value.length||value.length>100||value.some(v=>typeof v!=='string')||new Set(value).size!==value.length)throw new AiError(503,'AI_UNAVAILABLE');
  return value;
}
export function publicClient(row:AiClientRow){
  return {id:row.id,name:row.name,shop_ids:strings(row.shop_ids_json),tools:strings(row.tools_json),created_at:row.created_at,
    expires_at:row.expires_at,revoked_at:row.revoked_at,rate_limit:row.rate_limit};
}
export class AiService {
  readonly appHash:string;
  constructor(readonly options:AiOptions){this.appHash=hash(options.appKey);}
  async ready(){
    if(!await this.options.db.prepare('SELECT version FROM muse_schema_versions WHERE version=5').first())throw new AiError(503,'AI_MIGRATION_REQUIRED');
    await this.options.db.prepare('SELECT c.token_hash,c.rate_window,a.action FROM ai_api_clients c LEFT JOIN ai_api_audit a ON 0 LIMIT 0').all();
  }
  auditStatement(clientId:string|null,action:string,status:number,tool:AiTool|null=null,shopId:string|null=null){
    return this.options.db.prepare('INSERT INTO ai_api_audit(id,app_hash,client_id,action,tool,shop_id,status,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .bind(randomUUID(),this.appHash,clientId,action,tool,shopId,status,this.options.now());
  }
  async audit(clientId:string|null,action:string,status:number,tool:AiTool|null=null,shopId:string|null=null){
    await this.auditStatement(clientId,action,status,tool,shopId).run();
  }
  async list(){
    const result=await this.options.db.prepare('SELECT * FROM ai_api_clients WHERE app_hash=? ORDER BY created_at DESC,id LIMIT 1001').bind(this.appHash).all<AiClientRow>();
    return {clients:result.results.slice(0,1000).map(publicClient),truncated:result.results.length>1000};
  }
  async create(body:unknown,forbiddenTokens:(string|undefined)[]){
    if(!record(body)||Object.keys(body).some(k=>!['name','token','shop_ids','tools','expires_in_days','rate_limit'].includes(k)))throw new AiError(400,'INVALID_REQUEST');
    const {name,token,shop_ids,tools,expires_in_days,rate_limit}=body;
    if(typeof name!=='string'||name!==name.trim()||name.length<1||name.length>80||/[\u0000-\u001f\u007f]/.test(name)
      ||!validToken(token)||forbiddenTokens.some(t=>t&&hash(t)===hash(token))
      ||!Array.isArray(shop_ids)||!shop_ids.length||shop_ids.length>100||shop_ids.some(id=>!validId(id)||!this.options.targets.some(t=>t.shopId===id))||new Set(shop_ids).size!==shop_ids.length
      ||!Array.isArray(tools)||!tools.length||tools.some(t=>!isTool(t))||new Set(tools).size!==tools.length
      ||typeof expires_in_days!=='number'||!Number.isInteger(expires_in_days)||expires_in_days<1||expires_in_days>365
      ||typeof rate_limit!=='number'||!Number.isInteger(rate_limit)||rate_limit<1||rate_limit>600)throw new AiError(400,'INVALID_REQUEST');
    const row:AiClientRow={id:randomUUID(),app_hash:this.appHash,name,token_hash:hash(token),shop_ids_json:JSON.stringify(shop_ids),tools_json:JSON.stringify(tools),
      created_at:this.options.now(),expires_at:this.options.now()+expires_in_days*86400000,revoked_at:null,rate_limit,rate_window:0,rate_count:0};
    // One SQLite statement enforces the total limit across concurrent Workers.
    const insert=this.options.db.prepare(`INSERT INTO ai_api_clients(id,app_hash,name,token_hash,shop_ids_json,tools_json,created_at,expires_at,rate_limit)
      SELECT ?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM ai_api_clients WHERE app_hash=?)<1000`)
      .bind(row.id,this.appHash,name,row.token_hash,row.shop_ids_json,row.tools_json,row.created_at,row.expires_at,rate_limit,this.appHash);
    const audit=this.options.db.prepare(`INSERT INTO ai_api_audit(id,app_hash,client_id,action,status,created_at)
      SELECT ?,?,?,'client_created',201,? WHERE EXISTS(SELECT 1 FROM ai_api_clients WHERE id=? AND app_hash=?)`)
      .bind(randomUUID(),this.appHash,row.id,this.options.now(),row.id,this.appHash);
    try{await this.options.db.batch([insert,audit]);}catch{throw new AiError(409,'CLIENT_NOT_CREATED');}
    if(!await this.options.db.prepare('SELECT id FROM ai_api_clients WHERE id=? AND app_hash=?').bind(row.id,this.appHash).first())throw new AiError(409,'CLIENT_LIMIT_REACHED');
    return publicClient(row);
  }
  async revoke(clientId:unknown){
    if(!validId(clientId))throw new AiError(400,'INVALID_REQUEST');
    if(!await this.options.db.prepare('SELECT id FROM ai_api_clients WHERE app_hash=? AND id=?').bind(this.appHash,clientId).first())throw new AiError(404,'CLIENT_NOT_FOUND');
    await this.options.db.batch([
      this.options.db.prepare('UPDATE ai_api_clients SET revoked_at=COALESCE(revoked_at,?) WHERE app_hash=? AND id=?').bind(this.options.now(),this.appHash,clientId),
      this.auditStatement(clientId,'client_revoked',200),
    ]);
    return {id:clientId,revoked:true};
  }
  async authenticate(header:unknown):Promise<AiClientRow>{
    if(typeof header!=='string'||!header.startsWith('Bearer ')||!validToken(header.slice(7)))throw new AiError(401,'UNAUTHORIZED');
    const row=await this.options.db.prepare('SELECT * FROM ai_api_clients WHERE app_hash=? AND token_hash=? AND revoked_at IS NULL AND expires_at>?')
      .bind(this.appHash,hash(header.slice(7)),this.options.now()).first<AiClientRow>();
    if(!row)throw new AiError(401,'UNAUTHORIZED');
    strings(row.shop_ids_json);if(strings(row.tools_json).some(t=>!isTool(t)))throw new AiError(503,'AI_UNAVAILABLE');
    const window=Math.floor(this.options.now()/60000)*60000;
    const claimed=await this.options.db.prepare(`UPDATE ai_api_clients SET rate_window=?,rate_count=CASE WHEN rate_window=? THEN rate_count+1 ELSE 1 END
      WHERE id=? AND app_hash=? AND revoked_at IS NULL AND expires_at>? AND (rate_window!=? OR rate_count<rate_limit) RETURNING id`)
      .bind(window,window,row.id,this.appHash,this.options.now(),window).first();
    if(!claimed)throw new AiError(429,'RATE_LIMITED',Math.max(1,Math.ceil((window+60000-this.options.now())/1000)));
    return row;
  }
  allowedTools(client:AiClientRow){return strings(client.tools_json) as AiTool[];}
  async invoke(client:AiClientRow,tool:unknown,args:unknown){
    if(!isTool(tool))throw new AiError(404,'TOOL_NOT_FOUND');
    if(!this.allowedTools(client).includes(tool))throw new AiError(403,'TOOL_FORBIDDEN');
    if(!record(args))throw new AiError(400,'INVALID_REQUEST');
    if(tool==='list_shops'){
      if(Object.keys(args).length)throw new AiError(400,'INVALID_REQUEST');
      const shops=[];
      for(const target of this.options.targets.filter(t=>strings(client.shop_ids_json).includes(t.shopId))){
        const permissions={products:false,orders:false,inventory:false};
        for(const resource of ['products','orders'] as const){
          try{await this.options.live.scope(target.shopId,target.market,resource);
            permissions[resource]=this.allowedTools(client).some(t=>(resource==='products'?['get_products','get_product_detail','get_product_skus']:['get_orders','get_order_detail','get_order_status']).includes(t));
            if(resource==='products')permissions.inventory=this.allowedTools(client).includes('get_inventory');
          }catch{/* A revoked or insufficient TikTok scope never grants read access. */}
        }
        shops.push({shop_id:target.shopId,market:target.market,permissions});
      }
      return {source:'tiktok_api',mode:'cached_snapshot',shops};
    }
    const {shop_id,page}=args;
    if(Object.keys(args).some(k=>!toolFields[tool].includes(k))||toolFields[tool].some(k=>k!=='page'&&!validId(args[k]))||!validId(shop_id)
      ||page!==undefined&&(typeof page!=='number'||!Number.isInteger(page)||page<1||page>20))throw new AiError(400,'INVALID_REQUEST');
    const target=this.options.targets.find(t=>t.shopId===shop_id&&strings(client.shop_ids_json).includes(t.shopId));
    if(!target)throw new AiError(403,'SHOP_FORBIDDEN');
    const objectId=args.product_id??args.order_id;
    if(typeof objectId==='string'){
      const result=await this.options.live.lookup(target.shopId,target.market,args.order_id===undefined?'products':'orders',objectId);
      let data=result.data;
      if(data&&tool==='get_product_skus')data={product_id:data.product_id,skus:data.skus};
      if(data&&tool==='get_order_status')data={order_id:data.order_id,status:data.status,created_at:data.created_at,updated_at:data.updated_at};
      return {...result,data,mode:'cached_snapshot',resource:tool.slice(4)};
    }
    const snapshot=await this.options.live.snapshot(target.shopId,target.market,tool==='get_orders'?'orders':'products',page===undefined?1:page as number);
    if(tool!=='get_inventory')return {...snapshot,mode:'cached_snapshot'};
    return {...snapshot,mode:'cached_snapshot',resource:'inventory',pagination_unit:'products',
      data:snapshot.data===null?null:(snapshot.data as LiveProduct[]).map(p=>({product_id:p.product_id,skus:p.skus===null?null:p.skus.map(s=>({sku_id:s.sku_id,seller_sku:s.seller_sku,inventory:s.inventory}))}))};
  }
}
