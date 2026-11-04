import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {createAiHttpClient} from './ai/client.js';
import {createLiveMcpServer} from './ai/mcp.js';
async function main(){
  if(process.argv.length!==2)throw new Error('Arguments are not supported; configure environment variables');
  const client=createAiHttpClient(process.env.MUSE_ERP_URL,process.env.MUSE_AI_TOKEN);
  const server=createLiveMcpServer(client);
  const close=()=>{void server.close().catch(()=>{});};
  for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,close);process.stdin.once('end',close);
  await server.connect(new StdioServerTransport());
}
main().catch(()=>{process.stderr.write('MUSE AI bridge startup failed. Check URL and dedicated AI credential configuration.\n');process.exitCode=1;});
