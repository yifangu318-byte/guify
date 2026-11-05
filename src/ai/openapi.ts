import {aiTools,instructions} from './contracts.js';
export const aiOpenApi = {
  openapi:'3.1.0',info:{title:'MUSE ERP AI API',version:'2.1.0',description:instructions},
  servers:[{url:'https://senaloerp.online'}],security:[{aiBearer:[]}],
  components:{securitySchemes:{aiBearer:{type:'http',scheme:'bearer',description:'A dedicated, scoped AI credential. Never use the ERP administrator or TikTok token.'}},
    schemas:{Error:{type:'object',required:['error','code','message','request_id'],properties:{error:{const:true},code:{type:'string'},message:{type:'string'},request_id:{type:'string'}}}}},
  paths:Object.fromEntries(aiTools.map(tool=>['/api/ai/tools/'+tool.name,{post:{operationId:tool.name,summary:tool.description,
    requestBody:{required:true,content:{'application/json':{schema:tool.inputSchema}}},
    responses:{'200':tool.name==='tiktok_request'?{description:'Official TikTok response. Check error and business_outcome, and verify writes with a read-back. Successful endpoints without a data field return null.',content:{'application/json':{schema:{type:'object',additionalProperties:true}}}}:{description:'Saved TikTok data. Timestamp values are UTC Unix milliseconds; window.start_at is inclusive and end_at exclusive. Null data means no successful snapshot. Read all pages for complete coverage.',content:{'application/json':{schema:{type:'object',properties:{source:{const:'tiktok_api'},mode:{const:'cached_snapshot'},synced_at:{type:['integer','null']},last_error:{type:['string','null']},data:{type:['array','object','null']},pagination:{type:['object','null']},window:{type:['object','null']},shops:{type:'array'}},additionalProperties:true}}}},
      ...Object.fromEntries([400,401,403,404,429,503].map(status=>[String(status),{description:status===429?'Per-credential rate limit. Honor Retry-After.':'Request rejected; inspect code.',content:{'application/json':{schema:{$ref:'#/components/schemas/Error'}}}}]))}}}]))
};
