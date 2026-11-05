import {hash,type LifecycleDb,type Target,type SessionRow} from './vault.js';
export const markets=['MY','PH','SG','TH','VN'] as const;
export const enrollmentPrefix='@enroll:';
export function enrollmentSession(row:SessionRow,enabled:boolean){
  return enabled&&/^enroll_[a-f0-9-]{36}$/.test(row.shop_id)&&/^@enroll:(?:[A-Za-z0-9_-]{1,128})?$/.test(row.subject_id)
    &&(markets as readonly string[]).includes(row.market);
}
/** Only verified vault mappings can extend the configured target list. Never infer shop identity from a country label. */
export async function resolveTargets(configured:Target[],db:LifecycleDb|undefined,appKey:string|undefined,multi:boolean):Promise<Target[]>{
  if(!multi||!db||!appKey)return configured;
  const result=await db.prepare(`SELECT s.tiktok_shop_id,s.market,a.subject_id FROM authorized_shops s JOIN authorizations a ON a.id=s.authorization_id
    WHERE s.app_hash=? AND a.app_hash=? AND a.status='active' ORDER BY s.updated_at,s.tiktok_shop_id LIMIT 101`).bind(hash(appKey),hash(appKey))
    .all<{tiktok_shop_id:string;market:string;subject_id:string}>();
  const targets=new Map(configured.map(t=>[t.shopId,t]));
  for(const row of result.results){
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(row.tiktok_shop_id)||!(markets as readonly string[]).includes(row.market)||!row.subject_id)throw new Error('Invalid verified shop mapping');
    const existing=targets.get(row.tiktok_shop_id);
    if(existing&&(existing.market!==row.market||existing.subjectId&&existing.subjectId!==row.subject_id))throw new Error('Shop configuration conflict');
    if(!existing)targets.set(row.tiktok_shop_id,{shopId:row.tiktok_shop_id,market:row.market,subjectId:row.subject_id});
  }
  if(targets.size>100||result.results.length>100)throw new Error('Too many configured shops');
  return [...targets.values()];
}
