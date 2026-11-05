import {toolkitCatalog,toolkitVersion,type CatalogEntry} from './official-catalog-data.js';
import {sellerModules} from './official.js';
import {officialUploadPaths} from './official-upload.js';

export const reference='https://partner.tiktokshop.com/docv2/api-document';
export const catalogPath='/api/ai/tiktok/catalog';
const authorizedShops='/authorization/202309/shops';
const modules=new Set<string>(sellerModules);
const entries:CatalogEntry[]=toolkitCatalog.filter(e=>modules.has(e.module)||e.path===authorizedShops);
// This release is documented by TikTok after the bundled schema snapshot.
if(!entries.some(e=>e.path==='/affiliate_seller/202608/media/upload'))entries.push({
  module:'affiliate_seller',method:'POST',path:'/affiliate_seller/202608/media/upload',name:'UploadMessageImageV2',request:'multipart',query:['shop_cipher'],fields:['data'],
});
export const officialCatalog=(writeEnabled:boolean)=>({
  source:{package:'@tts-open-toolkit/cli',version:toolkitVersion,reference},
  note:'Request format coverage only. TikTok checks each endpoint’s app permission, seller scope, market and eligibility at call time.',
  write_enabled:writeEnabled,
  endpoints:entries.map(e=>({...e,transport:e.request==='multipart'?(officialUploadPaths.includes(e.path)?'direct_upload':'unsupported'):e.request==='other'?'unsupported':'json'})),
});
