import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {createAiHttpClient} from './client.js';
import {instructions} from './contracts.js';
export function createLiveMcpServer(client:ReturnType<typeof createAiHttpClient>){
  const server=new Server({name:'muse-erp-live',version:'1.0.0'},{capabilities:{tools:{}},instructions});
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:await client.listTools()}));
  server.setRequestHandler(CallToolRequestSchema,async request=>{
    const result=await client.invoke(request.params.name,request.params.arguments??{});
    return {isError:result.error===true,content:[{type:'text' as const,text:JSON.stringify(result)}],structuredContent:result};
  });
  return server;
}
