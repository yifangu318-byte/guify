import {createHmac} from 'node:crypto';
import {requestJson,UpstreamError} from '../tiktok/http.js';
import {LiveError,product,order,type Resource,type Window,type LiveProduct,type LiveOrder,type LimitDiagnostic} from './models.js';
const paths={products:'/product/202309/products/search',orders:'/order/202309/orders/search'} as const;
/** Sign the exact UTF-8 JSON body sent on the wire, excluding sign/access_token query fields. */
export function signJson(path:string,query:Readonly<Record<string,string>>,body:string,secret:string):string {
  if(!Object.values(paths).some(p=>p===path)||!secret)throw new LiveError(503,'LIVE_UNAVAILABLE');
  const canonical=Object.keys(query).filter(k=>k!=='sign'&&k!=='access_token').sort().map(k=>k+query[k]).join('');
  return createHmac('sha256',secret).update(secret+path+canonical+body+secret).digest('hex');
}
export async function readSnapshot(options:{resource:Resource;window?:Window;appKey:string;appSecret:string;accessToken:string;cipher:string;fetchImpl?:typeof fetch;now?:()=>number;sleep?:(ms:number)=>Promise<void>}):Promise<LiveProduct[]|LiveOrder[]> {
  const now=options.now??Date.now,started=now(),sleep=options.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  const limited=(kind:LimitDiagnostic['kind'],limit:number,actual:number)=>new LiveError(502,'SYNC_LIMIT_EXCEEDED',null,{kind,limit,actual});
  const path=paths[options.resource];if(!path||options.resource==='orders'&&!options.window)throw new LiveError(400,'INVALID_REQUEST');
  const body=JSON.stringify(options.resource==='products'?{status:'ALL'}:{create_time_ge:options.window!.start_at/1000,create_time_lt:options.window!.end_at/1000});
  const rows:Array<LiveProduct|LiveOrder>=[],seenIds=new Set<string>(),seenCursors=new Set<string>();let cursor='',total:number|undefined,attempts=0;
  for(let page=0;page<20;page++){
    if(now()-started>55_000)throw limited('duration',55_000,now()-started);
    let data:Record<string,unknown>|undefined;
    for(let attempt=0;attempt<3;attempt++){
      if(++attempts>32)throw limited('requests',32,attempts);
      const remaining=55_000-(now()-started);if(remaining<=0)throw limited('duration',55_000,now()-started);
      const query:Record<string,string>={app_key:options.appKey,timestamp:String(Math.floor(now()/1000)),shop_cipher:options.cipher,page_size:'50',...(cursor?{page_token:cursor}:{})};
      if(options.resource==='orders')Object.assign(query,{sort_field:'create_time',sort_order:'ASC'});
      const url='https://open-api.tiktokglobalshop.com'+path+'?'+new URLSearchParams({...query,sign:signJson(path,query,body,options.appSecret)});
      try{data=await requestJson(options.fetchImpl??globalThis.fetch,url,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json','x-tts-access-token':options.accessToken},body},Math.min(8000,remaining));break;}
      catch(e){
        if(e instanceof UpstreamError&&[429,502,503,504].includes(e.http??0)&&attempt<2){await sleep(200*2**attempt);continue;}
        throw new LiveError(502,e instanceof UpstreamError&&e.category==='business_error'?'UPSTREAM_REJECTED':'UPSTREAM_UNAVAILABLE',e instanceof UpstreamError?e.upstreamCode:null);
      }
    }
    if(!data||!Array.isArray(data[options.resource])||typeof data.total_count!=='number'||!Number.isSafeInteger(data.total_count)||data.total_count<0)throw new LiveError(502,'INVALID_UPSTREAM_DATA');
    if(total!==undefined&&total!==data.total_count)throw new LiveError(502,'INCOMPLETE_SNAPSHOT');total=data.total_count;
    if(total>1000)throw limited('records',1000,total);
    const list=data[options.resource] as unknown[];if(list.length>50)throw new LiveError(502,'INVALID_UPSTREAM_DATA');
    for(const raw of list){const item=options.resource==='products'?product(raw):order(raw,options.window!);const key='product_id'in item?item.product_id:item.order_id;
      if(seenIds.has(key))throw new LiveError(502,'INCOMPLETE_SNAPSHOT');seenIds.add(key);rows.push(item);
    }
    const next=data.next_page_token;
    const bytes=Buffer.byteLength(JSON.stringify(rows),'utf8');if(bytes>512*1024)throw limited('bytes',512*1024,bytes);
    if(next===undefined||next===null||next===''){
      if(rows.length!==total)throw new LiveError(502,'INCOMPLETE_SNAPSHOT');
      return rows as LiveProduct[]|LiveOrder[];
    }
    if(typeof next!=='string'||next.length>4096||!list.length||seenCursors.has(next))throw new LiveError(502,'INCOMPLETE_SNAPSHOT');
    seenCursors.add(next);cursor=next;await sleep(100);
  }
  throw limited('pages',20,21);
}
