// Input: extracted references/oas directory from the official @tts-open-toolkit/cli package.
// Copy identifiers and request shape only; never copy examples, credentials or response payloads.
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const [source,version]=process.argv.slice(2);
if(!source||!/^\d+\.\d+\.\d+$/.test(version??''))throw new Error('Usage: node scripts/import-tiktok-catalog.mjs <official-oas-dir> <package-version>');
const {modules}=JSON.parse(readFileSync(join(source,'index.json'),'utf8'));
const entries=[];
for(const module of modules.map(entry=>entry.first_level_path).sort()){
  if(!/^[a-z_]+$/.test(module))throw new Error('Invalid official module: '+module);
  const {paths}=JSON.parse(readFileSync(join(source,'paths',module+'.json'),'utf8'));
  for(const [path,operations] of Object.entries(paths))for(const [method,operation] of Object.entries(operations)){
    if(!/^(get|post|put|patch|delete)$/.test(method))continue;
    const content=operation.requestBody?.content??{};
    const request=Object.hasOwn(content,'multipart/form-data')?'multipart':Object.hasOwn(content,'application/json')?'json':Object.keys(content).length?'other':'none';
    entries.push({module,method:method.toUpperCase(),path,name:operation.summary,request,
      query:(operation.parameters??[]).filter(p=>p.in==='query').map(p=>p.name),
      ...(request==='multipart'?{fields:Object.keys(content['multipart/form-data']?.schema?.properties??{})}:{})});
  }
}
entries.sort((a,b)=>a.path.localeCompare(b.path)||a.method.localeCompare(b.method));
const header='// Generated from the official TikTok Shop Open Toolkit schema by scripts/import-tiktok-catalog.mjs.\n';
writeFileSync(new URL('../src/ai/official-catalog-data.ts',import.meta.url),
  header+'export const toolkitVersion = '+JSON.stringify(version)+';\n'+
  'export interface CatalogEntry {module:string;method:string;path:string;name:string;request:string;query:string[];fields?:string[]}\n'+
  'export const toolkitCatalog:CatalogEntry[] = [\n'+entries.map(row=>'  '+JSON.stringify(row)).join(',\n')+'\n];\n');
