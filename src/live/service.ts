import {randomUUID} from 'node:crypto';
import {D1OAuthStore,hash,type LifecycleDb} from '../tiktok/vault.js';
import {getValidAccessToken} from '../tiktok/refresh.js';
import {readSnapshot} from './client.js';
import {LiveError,limitDiagnostic,type Resource,type Window} from './models.js';
export interface LiveConfig {db:LifecycleDb;appKey:string;appSecret:string;secret:string;productLimit?:1000|2000;fetchImpl?:typeof fetch;now?:()=>number;sleep?:(ms:number)=>Promise<void>}
interface ScopeRow {id:string;version:number;market:string;cipher:string;scopes_json:string;status:string;access_expires_at:number;refresh_expires_at:number;key_version:string}
interface SnapshotRow {snapshot_json:string|null;range_start:number|null;range_end:number|null;last_success_at:number|null;last_attempt_at:number;last_error:string|null;upstream_code:number|null;lease_until:number|null}
export const scopes={products:'seller.product.basic',orders:'seller.order.info'} as const;
export class LiveService {
  readonly appHash:string;readonly now:()=>number;
  constructor(readonly config:LiveConfig){this.appHash=hash(config.appKey);this.now=config.now??Date.now;}
  async ready(){
    if(!await this.config.db.prepare('SELECT version FROM muse_schema_versions WHERE version=4').first())throw new LiveError(503,'LIVE_MIGRATION_REQUIRED');
    await this.config.db.prepare('SELECT snapshot_json,lease_owner,lease_until,upstream_code FROM live_snapshots LIMIT 0').all();
  }
  async scope(shopId:string,market:string,resource:Resource):Promise<ScopeRow>{
    const row=await this.config.db.prepare(`SELECT a.id,a.version,a.scopes_json,a.status,a.access_expires_at,a.refresh_expires_at,a.key_version,s.market,s.cipher
      FROM authorizations a JOIN authorized_shops s ON s.authorization_id=a.id WHERE s.app_hash=? AND a.app_hash=? AND s.tiktok_shop_id=?`)
      .bind(this.appHash,this.appHash,shopId).first<ScopeRow>();
    if(!row||row.market!==market||row.status!=='active'||row.key_version!=='v1'||!row.cipher||row.access_expires_at<=this.now()&&row.refresh_expires_at<=this.now())throw new LiveError(403,'SHOP_AUTHORIZATION_REQUIRED');
    let granted:unknown;try{granted=JSON.parse(row.scopes_json);}catch{throw new LiveError(403,'SCOPE_REQUIRED');}
    if(!Array.isArray(granted)||!granted.includes(scopes[resource]))throw new LiveError(403,'SCOPE_REQUIRED');
    return row;
  }
  async snapshot(shopId:string,market:string,resource:Resource){
    await this.scope(shopId,market,resource);await this.ready();
    const row=await this.config.db.prepare('SELECT snapshot_json,range_start,range_end,last_success_at,last_attempt_at,last_error,upstream_code,lease_until FROM live_snapshots WHERE app_hash=? AND shop_id=? AND resource=?')
      .bind(this.appHash,shopId,resource).first<SnapshotRow>();
    const data=row?.snapshot_json?JSON.parse(row.snapshot_json) as unknown[]:null;
    const parts=row?.last_error?.split('|')??[];
    const limit=parts.length===4?limitDiagnostic({kind:parts[1],limit:Number(parts[2]),actual:Number(parts[3])}):null;
    return {source:'tiktok_api' as const,shop_id:shopId,market,resource,synced_at:row?.last_success_at??null,last_attempt_at:row?.last_attempt_at??null,
      last_error:parts[0]??null,limit,upstream_code:row?.upstream_code??null,syncing:!!row?.lease_until&&row.lease_until>this.now(),
      window:resource==='orders'&&row?.range_start!==null&&row?.range_start!==undefined?{start_at:row.range_start,end_at:row.range_end}:null,data};
  }
  async sync(shopId:string,market:string,resource:Resource,window?:Window){
    await this.scope(shopId,market,resource);await this.ready();const owner=randomUUID(),started=this.now();
    const claimed=await this.config.db.prepare(`INSERT INTO live_snapshots(app_hash,shop_id,resource,last_attempt_at,lease_owner,lease_until)
      VALUES (?,?,?,?,?,?) ON CONFLICT(app_hash,shop_id,resource) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,
      lease_owner=excluded.lease_owner,lease_until=excluded.lease_until
      WHERE (live_snapshots.lease_until IS NULL OR live_snapshots.lease_until<=?) AND live_snapshots.last_attempt_at<=? RETURNING resource`)
      .bind(this.appHash,shopId,resource,started,owner,started+90_000,started,started-30_000).first();
    if(!claimed)throw new LiveError(409,'SYNC_BUSY');
    try{
      const accessToken=await getValidAccessToken(new D1OAuthStore(this.config.db),{...this.config,shopId});
      const authorized=await this.scope(shopId,market,resource);
      const data=await readSnapshot({...this.config,resource,...(window?{window}:{}),accessToken,cipher:authorized.cipher});
      const finished=this.now();
      const saved=await this.config.db.prepare(`UPDATE live_snapshots SET snapshot_json=?,range_start=?,range_end=?,last_success_at=?,last_error=NULL,
        upstream_code=NULL,lease_owner=NULL,lease_until=NULL WHERE app_hash=? AND shop_id=? AND resource=? AND lease_owner=? AND lease_until>?
        AND EXISTS(SELECT 1 FROM authorizations a JOIN authorized_shops s ON s.authorization_id=a.id WHERE a.id=? AND a.version=? AND a.status='active'
        AND s.app_hash=? AND s.tiktok_shop_id=? AND s.market=? AND s.cipher=?) RETURNING resource`)
        .bind(JSON.stringify(data),window?.start_at??null,window?.end_at??null,finished,this.appHash,shopId,resource,owner,finished,
          authorized.id,authorized.version,this.appHash,shopId,market,authorized.cipher).first();
      if(!saved)throw new LiveError(409,'SYNC_CONFLICT');
      return {source:'tiktok_api' as const,shop_id:shopId,resource,synced_at:finished,count:data.length,window:window??null};
    }catch(error){
      const safe=error instanceof LiveError?error:new LiveError(503,'LIVE_SYNC_FAILED');
      await this.config.db.prepare('UPDATE live_snapshots SET last_error=?,upstream_code=?,lease_owner=NULL,lease_until=NULL WHERE app_hash=? AND shop_id=? AND resource=? AND lease_owner=?')
        .bind(safe.limit?[safe.code,safe.limit.kind,safe.limit.limit,safe.limit.actual].join('|'):safe.code,safe.upstreamCode,this.appHash,shopId,resource,owner).run();
      throw safe;
    }
  }
}
