import {createHash} from 'node:crypto';
import {record} from '../live/models.js';
import {AiError} from './contracts.js';

const MiB=1024*1024;
export const maxUploadBytes=10*MiB;
export const officialBodyLimit=Math.ceil(maxUploadBytes/3)*4+73728;
const images={'jpg':'image/jpeg','jpeg':'image/jpeg','png':'image/png'};
const messageImages={...images,gif:'image/gif',webp:'image/webp'};
const pdf={pdf:'application/pdf'};
const videos={'mp4':'video/mp4','mov':'video/quicktime','mkv':'video/x-matroska','wmv':'video/x-ms-wmv',
  'webm':'video/webm','avi':'video/x-msvideo','3gp':'video/3gpp','flv':'video/x-flv','mpeg':'video/mpeg'};
const uploadRules={
  '/product/202309/images/upload':{types:{...images,webp:'image/webp',heic:'image/heic',bmp:'image/bmp'},max:10*MiB,shopCipher:false,field:'use_case'},
  '/product/202309/files/upload':{types:{pdf:'application/pdf',...videos},max:10*MiB,shopCipher:false,field:'name'},
  '/product/202508/import_external':{types:{},max:10*MiB,shopCipher:false,field:null},
  '/fulfillment/202309/files/upload':{types:pdf,max:10*MiB,shopCipher:true,field:'name'},
  '/fulfillment/202309/images/upload':{types:images,max:5*MiB,shopCipher:true,field:null},
  '/customer_service/202309/images/upload':{types:messageImages,max:10*MiB,shopCipher:true,field:null},
  '/affiliate_seller/202511/images/upload':{types:messageImages,max:10*MiB,shopCipher:false,field:null},
  '/affiliate_seller/202608/media/upload':{types:messageImages,max:10*MiB,shopCipher:true,field:null},
  '/review_rating/202410/media/upload':{types:{...images,...videos,m4a:'audio/mp4'},max:10*MiB,shopCipher:false,field:'file_type'},
} as const;
const shippingDocuments='/return_refund/202405/returns/shipping_documents';
export const officialUploadPaths=[...Object.keys(uploadRules),shippingDocuments];
const invalid=()=>new AiError(400,'INVALID_REQUEST');
function filePart(input:unknown,max:number,types:Readonly<Record<string,string>>,field:string,form:FormData){
  if(!record(input)||Object.keys(input).some(k=>!['filename','base64'].includes(k)))throw invalid();
  const {filename,base64}=input;
  if(typeof filename!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}\.[A-Za-z0-9]{2,5}$/.test(filename)
    ||typeof base64!=='string'||!base64.length||base64.length%4!==0)throw invalid();
  if(base64.length>Math.ceil(max/3)*4)throw new AiError(413,'REQUEST_TOO_LARGE');
  const content=Buffer.from(base64,'base64');
  if(!content.length||content.toString('base64')!==base64)throw invalid();
  if(content.length>max)throw new AiError(413,'REQUEST_TOO_LARGE');
  const extension=filename.slice(filename.lastIndexOf('.')+1).toLowerCase();
  if(Object.keys(types).length&&!Object.hasOwn(types,extension))throw invalid();
  form.append(field,new Blob([content],{type:types[extension]??'application/octet-stream'}),filename);
  return {field,filename,size:content.length,sha256:createHash('sha256').update(content).digest('hex')};
}
export function prepareOfficialUpload(path:string,method:string,body:unknown,input:unknown){
  const rule=Object.hasOwn(uploadRules,path)?uploadRules[path as keyof typeof uploadRules]:undefined;
  if(!rule&&path!==shippingDocuments){if(input!==undefined)throw invalid();return null;}
  if(method!=='POST'||body!==undefined||!record(input))throw invalid();
  const form=new FormData();
  if(!rule){
    if(Object.keys(input).some(k=>!['fields','files'].includes(k))||!record(input.fields)||!record(input.files))throw invalid();
    const fields=Object.entries(input.fields),files=Object.entries(input.files);
    if(!fields.length&&!files.length||fields.some(([k,v])=>!['return_provider_id','tracking_number'].includes(k)||typeof v!=='string'||!v.length||v.length>256)
      ||files.some(([k])=>!['return_qr_code','return_shipping_label'].includes(k)))throw invalid();
    for(const [key,value] of fields)form.append(key,value as string);
    let remaining=maxUploadBytes;
    const parts=files.map(([key,value])=>{const part=filePart(value,remaining,{...images,...pdf},key,form);remaining-=part.size;return part;});
    return {form,shopCipher:true,fingerprint:{fields,parts}};
  }
  if(Object.keys(input).some(k=>!['filename','base64','use_case','file_type'].includes(k)))throw invalid();
  const {filename,base64,use_case,file_type}=input;
  if(rule.field==='use_case'?!['MAIN_IMAGE','ATTRIBUTE_IMAGE','DESCRIPTION_IMAGE','CERTIFICATION_IMAGE','SIZE_CHART_IMAGE'].includes(use_case as string):use_case!==undefined)throw invalid();
  if(rule.field==='file_type'?file_type!=='IMAGE'&&file_type!=='VIDEO':file_type!==undefined)throw invalid();
  const file=filePart({filename,base64},rule.max,rule.types,'data',form);
  if(rule.field==='name')form.append('name',file.filename);
  if(rule.field==='use_case')form.append('use_case',use_case as string);
  if(rule.field==='file_type')form.append('file_type',file_type as string);
  return {form,shopCipher:rule.shopCipher,fingerprint:{file,use_case,file_type}};
}
