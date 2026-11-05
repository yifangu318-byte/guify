import { after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { issueState } from '../src/tiktok/crypto.js';
import { D1OAuthStore } from '../src/tiktok/vault.js';
export const NOW = 1790000000000, SECRET='11'.repeat(32), BROWSER='22'.repeat(32);
export const TARGET = {shopId:'synthetic-shop',market:'MY',subjectId:'synthetic-subject'};
export const TOKEN = {access_token:'synthetic-access',refresh_token:'synthetic-refresh',open_id:TARGET.subjectId,user_type:0,
  access_token_expire_in:(NOW+3600000)/1000,refresh_token_expire_in:(NOW+86400000)/1000,granted_scopes:['seller.authorization.info','seller.product.basic']};
export const SHOP = {id:TARGET.shopId,region:'MY',cipher:'synthetic-cipher'};
export const json = (data: unknown, code: unknown = 0) => new Response(JSON.stringify({code,data}),{headers:{'Content-Type':'application/json'}});
let mf: Miniflare | undefined, database: any;
after(async()=>{await mf?.dispose();});
export async function fixture() {
  if (!mf) {
    mf=new Miniflare(convertV4MiniflareOptions({name:'oauth-tests',modules:true,script:'export default {fetch(){return new Response("test");}}',compatibilityDate:'2026-10-30',d1Databases:{DB:'isolated-oauth-tests'}}));
    database=await mf.getD1Database('DB');
    for (const file of ['0001_shop_tokens.sql','0002_shop_cipher.sql','0003_oauth_lifecycle.sql','0004_live_snapshots.sql','0005_ai_api.sql','0006_api_operations.sql']) {
      const sql=await readFile(new URL(`../migrations/d1/${file}`,import.meta.url),'utf8');
      for(const statement of sql.replace(/--[^\n]*/g,'').split(';').map(s=>s.trim()).filter(Boolean)) await database.prepare(statement).run();
    }
  }
  for (const table of ['api_operations','ai_api_audit','ai_api_clients','live_snapshots','oauth_audit','authorized_shops','authorizations','oauth_sessions','shop_tokens']) await database.prepare(`DELETE FROM ${table}`).run();
  const store=new D1OAuthStore(database);
  let time=NOW;
  const state=issueState(SECRET,{now:()=>time,market:TARGET.market,shopCode:TARGET.shopId}).state;
  await store.issue(state,BROWSER,'synthetic-app',TARGET,NOW+600000,NOW);
  const calls: Array<{url:string;init:RequestInit|undefined}>=[];
  const fetchImpl: typeof fetch=async(url,init)=>{
    calls.push({url:String(url),init});
    const path=new URL(String(url)).pathname;
    if(path==='/api/v2/token/get' || path==='/api/v2/token/refresh') return json(TOKEN);
    if(path==='/authorization/202309/shops') return json({shops:[SHOP]});
    throw new Error('Unexpected mocked endpoint');
  };
  return {db:database,store,state,calls,query:{code:'synthetic-code',state},tick:(ms:number)=>{time+=ms;},deps:{secret:SECRET,appKey:'synthetic-app',appSecret:'synthetic-app-secret',
    db:database,browser:BROWSER,enabled:true,environment:'test',targets:[TARGET],fetchImpl,now:()=>time}};
}
