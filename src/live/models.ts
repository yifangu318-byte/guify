export type Resource = 'products' | 'orders';
export interface Window { start_at: number; end_at: number }
export interface LiveInventory {warehouse_id:string;quantity:number}
export interface LiveSku {sku_id:string;seller_sku:string|null;currency:string|null;tax_exclusive_price:string|null;sale_price:string|null;inventory:LiveInventory[]|null}
export interface LiveProduct {product_id:string;title:string|null;status:string;created_at:number|null;updated_at:number|null;skus:LiveSku[]|null}
export interface LiveOrder {order_id:string;status:string;created_at:number;updated_at:number|null;currency:string|null;total_amount:string|null}
export interface LimitDiagnostic {kind:'records'|'bytes'|'duration'|'requests'|'pages';limit:number;actual:number}
export class LiveError extends Error {
  constructor(readonly status:number,readonly code:string,readonly upstreamCode:number|null=null,readonly limit:LimitDiagnostic|null=null){super('Live data request failed');}
}
export function limitDiagnostic(value:unknown):LimitDiagnostic|null {
  if(!record(value)||!['records','bytes','duration','requests','pages'].includes(String(value.kind))||typeof value.limit!=='number'||typeof value.actual!=='number'
    ||!Number.isSafeInteger(value.limit)||!Number.isSafeInteger(value.actual)||value.limit<=0||value.actual<0)return null;
  return {kind:value.kind as LimitDiagnostic['kind'],limit:value.limit,actual:value.actual};
}
export const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export function text(v:unknown,max=128):string {if(typeof v!=='string'||!v.trim()||v.length>max)throw new LiveError(502,'INVALID_UPSTREAM_DATA');return v;}
export function id(v:unknown):string {const s=text(v);if(!/^[A-Za-z0-9_-]+$/.test(s))throw new LiveError(502,'INVALID_UPSTREAM_DATA');return s;}
function nullable(v:unknown,parse:(v:unknown)=>string):string|null{return v===undefined||v===null||v===''?null:parse(v);}
const currency=(v:unknown)=>{const s=text(v,3);if(!/^[A-Z]{3}$/.test(s))throw new LiveError(502,'INVALID_UPSTREAM_DATA');return s;};
const amount=(v:unknown)=>{const s=text(v,64);if(!/^(0|[1-9]\d*)(\.\d+)?$/.test(s))throw new LiveError(502,'INVALID_UPSTREAM_DATA');return s;};
export function time(v:unknown):number|null {
  if(v===undefined||v===null)return null;
  if(typeof v!=='number'||!Number.isSafeInteger(v)||v<=0||v>8640000000000)throw new LiveError(502,'INVALID_UPSTREAM_DATA');
  return v*1000;
}
export function parseWindow(value:unknown,now:number):Window {
  if(!record(value)||Object.keys(value).some(k=>!['start_at','end_at'].includes(k)))throw new LiveError(400,'INVALID_REQUEST');
  const {start_at,end_at}=value;
  if(typeof start_at!=='number'||typeof end_at!=='number'||!Number.isSafeInteger(start_at)||!Number.isSafeInteger(end_at)
    ||start_at<0||start_at%1000!==0||end_at%1000!==0||start_at>=end_at||end_at>now||end_at-start_at>31*86400000)throw new LiveError(400,'INVALID_REQUEST');
  return {start_at,end_at};
}
export function product(raw:unknown):LiveProduct {
  if(!record(raw))throw new LiveError(502,'INVALID_UPSTREAM_DATA');
  let skus:LiveSku[]|null=null;
  if(raw.skus!==undefined&&raw.skus!==null){
    if(!Array.isArray(raw.skus)||raw.skus.length>1000)throw new LiveError(502,'INVALID_UPSTREAM_DATA');
    const seen=new Set<string>();
    skus=raw.skus.map(s=>{
      if(!record(s))throw new LiveError(502,'INVALID_UPSTREAM_DATA');const sku_id=id(s.id);
      if(seen.has(sku_id))throw new LiveError(502,'INVALID_UPSTREAM_DATA');seen.add(sku_id);
      if(s.price!==undefined&&s.price!==null&&!record(s.price))throw new LiveError(502,'INVALID_UPSTREAM_DATA');
      const price=record(s.price)?s.price:{};let inventory:LiveInventory[]|null=null;
      if(s.inventory!==undefined&&s.inventory!==null){
        if(!Array.isArray(s.inventory)||s.inventory.length>100)throw new LiveError(502,'INVALID_UPSTREAM_DATA');const warehouses=new Set<string>();
        inventory=s.inventory.map(i=>{if(!record(i)||typeof i.quantity!=='number'||!Number.isSafeInteger(i.quantity)||i.quantity<0)throw new LiveError(502,'INVALID_UPSTREAM_DATA');
          const warehouse_id=id(i.warehouse_id);if(warehouses.has(warehouse_id))throw new LiveError(502,'INVALID_UPSTREAM_DATA');warehouses.add(warehouse_id);return {warehouse_id,quantity:i.quantity};});
      }
      return {sku_id,seller_sku:nullable(s.seller_sku,v=>text(v,256)),currency:nullable(price.currency,currency),tax_exclusive_price:nullable(price.tax_exclusive_price,amount),sale_price:nullable(price.sale_price,amount),inventory};
    });
  }
  return {product_id:id(raw.id),title:nullable(raw.title,v=>text(v,1024)),status:text(raw.status,64),created_at:time(raw.create_time),updated_at:time(raw.update_time),skus};
}
export function order(raw:unknown,window:Window):LiveOrder {
  if(!record(raw))throw new LiveError(502,'INVALID_UPSTREAM_DATA');const created_at=time(raw.create_time);
  if(created_at===null||created_at<window.start_at||created_at>=window.end_at)throw new LiveError(502,'INVALID_UPSTREAM_DATA');
  if(raw.payment!==undefined&&raw.payment!==null&&!record(raw.payment))throw new LiveError(502,'INVALID_UPSTREAM_DATA');const payment=record(raw.payment)?raw.payment:{};
  return {order_id:id(raw.id),status:text(raw.status,64),created_at,updated_at:time(raw.update_time),currency:nullable(payment.currency,currency),total_amount:nullable(payment.total_amount,amount)};
}
