import {aiTools,isTool,validToken,type AiTool} from './contracts.js';

export function createAiHttpClient(base:string|undefined,token:string|undefined,fetchImpl:typeof fetch=fetch){
  let origin:URL;try{origin=new URL(base??'');if(origin.protocol!=='https:'||origin.pathname!=='/'||origin.username||origin.password||origin.search||origin.hash)throw new Error();}
  catch{throw new Error('MUSE_ERP_URL must be an HTTPS origin');}
  if(!validToken(token))throw new Error('MUSE_AI_TOKEN is missing or invalid');
  const request=async(path:string,args?:unknown)=>{
    try{
      const response=await fetchImpl(new URL(path,origin),{method:args===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,Accept:'application/json','User-Agent':'MUSE-ERP-AI-Bridge/1.0',...(args===undefined?{}:{'Content-Type':'application/json'})},...(args===undefined?{}:{body:JSON.stringify(args)}),redirect:'error',credentials:'omit',signal:AbortSignal.timeout(10000)});
      if(!response.ok){await response.body?.cancel().catch(()=>{});return {error:true,code:response.status===401?'UNAUTHORIZED':response.status===429?'RATE_LIMITED':'ERP_REQUEST_FAILED',status:response.status};}
      const reader=response.body?.getReader();if(!reader)throw new Error();const chunks:Uint8Array[]=[];let size=0;
      try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>8_000_000)throw new Error();chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
      const data:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(!data||typeof data!=='object'||Array.isArray(data))throw new Error();return data as Record<string,unknown>;
    }catch{return {error:true,code:'ERP_UNAVAILABLE'};}
  };
  return {
    async listTools(){const data=await request('/api/ai/tools');if(data.error||!Array.isArray(data.tools))throw new Error('ERP tools unavailable');
      const names=data.tools.map((t:unknown)=>t&&typeof t==='object'&&'name' in t?t.name:undefined);
      return aiTools.filter(t=>names.includes(t.name));},
    async invoke(name:string,args:unknown){if(!isTool(name))return {error:true,code:'TOOL_NOT_FOUND'};return request('/api/ai/tools/'+(name as AiTool),args);},
  };
}
