import {gzipSync,gunzipSync} from 'node:zlib';
import {LiveError,record,type LiveProduct,type Resource} from './models.js';
const storedLimit=1_900_000,pageLimit=8_000_000;
interface Chunk {count:number;data:string}
interface Manifest {format:'muse-products-gzip-v1';count:number;chunks:Chunk[]}
/** Compress one projected upstream page at a time. Never retain the entire uncompressed catalog. */
export class ProductSnapshotBuilder {
  private chunks:Chunk[]=[];private count=0;private bytes=100;
  add(items:LiveProduct[]){
    if(!items.length)return;
    const json=JSON.stringify(items),rawBytes=Buffer.byteLength(json,'utf8');
    if(items.length>100||rawBytes>pageLimit)throw new LiveError(502,'SYNC_LIMIT_EXCEEDED',null,{kind:'bytes',limit:pageLimit,actual:rawBytes});
    const chunk={count:items.length,data:gzipSync(Buffer.from(json),{level:1}).toString('base64')};
    this.bytes+=Buffer.byteLength(JSON.stringify(chunk),'utf8')+1;
    if(this.bytes>storedLimit)throw new LiveError(502,'SYNC_LIMIT_EXCEEDED',null,{kind:'bytes',limit:storedLimit,actual:this.bytes});
    this.chunks.push(chunk);this.count+=items.length;
  }
  finish(expected:number):string {
    if(this.count!==expected||expected>2000||this.chunks.length>20)throw new LiveError(502,'INCOMPLETE_SNAPSHOT');
    const json=JSON.stringify({format:'muse-products-gzip-v1',count:this.count,chunks:this.chunks} satisfies Manifest);
    if(Buffer.byteLength(json,'utf8')>storedLimit)throw new LiveError(502,'SYNC_LIMIT_EXCEEDED');return json;
  }
}
export function snapshotPage(raw:string|null,resource:Resource,page=1):{data:unknown[]|null;pagination:{page:number;page_count:number;total_count:number;next_page:number|null;previous_page:number|null}|null}{
  if(!Number.isSafeInteger(page)||page<1||page>20||resource==='orders'&&page!==1)throw new LiveError(400,'INVALID_PAGE');
  if(raw===null)return {data:null,pagination:null};
  try{
    if(Buffer.byteLength(raw,'utf8')>storedLimit)throw new Error();const stored:unknown=JSON.parse(raw);
    if(resource==='orders'){if(!Array.isArray(stored))throw new Error();return {data:stored,pagination:null};}
    let count:number,pageCount:number,data:unknown[];
    if(Array.isArray(stored)){
      count=stored.length;pageCount=Math.max(1,Math.ceil(count/100));if(page>pageCount)throw new LiveError(400,'INVALID_PAGE');data=stored.slice((page-1)*100,page*100);
    }else{
      if(!record(stored)||stored.format!=='muse-products-gzip-v1'||typeof stored.count!=='number'||!Number.isSafeInteger(stored.count)||stored.count<0||stored.count>2000
        ||!Array.isArray(stored.chunks)||stored.chunks.length>20)throw new Error();
      let total=0;for(const chunk of stored.chunks){if(!record(chunk)||typeof chunk.count!=='number'||!Number.isSafeInteger(chunk.count)||chunk.count<1||chunk.count>100
          ||typeof chunk.data!=='string'||!chunk.data||!/^[A-Za-z0-9+/]+={0,2}$/.test(chunk.data))throw new Error();total+=chunk.count;}
      if(total!==stored.count)throw new Error();count=stored.count;pageCount=Math.max(1,stored.chunks.length);
      if(page>pageCount)throw new LiveError(400,'INVALID_PAGE');const chunk=stored.chunks[page-1] as Chunk|undefined;
      if(!chunk)data=[];
      else{const decoded:unknown=JSON.parse(gunzipSync(Buffer.from(chunk.data,'base64'),{maxOutputLength:pageLimit}).toString('utf8'));if(!Array.isArray(decoded)||decoded.length!==chunk.count)throw new Error();data=decoded;}
    }
    return {data,pagination:{page,page_count:pageCount,total_count:count,next_page:page<pageCount?page+1:null,previous_page:page>1?page-1:null}};
  }catch(error){if(error instanceof LiveError)throw error;throw new LiveError(503,'SNAPSHOT_UNAVAILABLE');}
}
