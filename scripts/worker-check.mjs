import {spawn} from 'node:child_process';
import {access} from 'node:fs/promises';
import assert from 'node:assert/strict';
const allowed=['PATH','SystemRoot','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','TEMP','TMP','TMPDIR'];
const env=Object.fromEntries(allowed.filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
Object.assign(env,{WRANGLER_SEND_METRICS:'false',MUSE_ENV:'test',TIKTOK_OAUTH_ENABLED:'false',CI:'true'});
// Wrangler auto-loads these files. Refuse them instead of reading or risking live secrets.
for(const name of ['.env','.env.local','.env.test','.dev.vars','.dev.vars.test']) {
  let exists=false;try{await access(name);exists=true;}catch{}
  if(exists) throw new Error('Use a clean isolated checkout for Worker verification');
}
const run=(args)=>new Promise((resolve,reject)=>{
 const child=spawn(process.execPath,args,{env,stdio:'inherit'});
 child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error('Local verification failed')));
});
await run(['node_modules/wrangler/bin/wrangler.js','deploy','--dry-run','--config','wrangler.test.jsonc','--outdir','.wrangler/test-bundle']);
const child=spawn(process.execPath,['node_modules/wrangler/bin/wrangler.js','dev','--local','--config','wrangler.test.jsonc','--ip','127.0.0.1','--port','18787'],{env,stdio:['ignore','pipe','pipe']});
let output='';child.stdout.on('data',c=>{output=(output+c).slice(-16000);});child.stderr.on('data',c=>{output=(output+c).slice(-16000);});
let spawnError;child.on('error',e=>{spawnError=e;});
const closed=new Promise(resolve=>child.once('exit',resolve));
try {
 const deadline=Date.now()+20000;let ready=false;
 while(Date.now()<deadline&&!spawnError&&child.exitCode===null){
  try{const r=await fetch('http://127.0.0.1:18787/health',{signal:AbortSignal.timeout(500)});if(r.ok){ready=true;break;}}catch{}
  await new Promise(r=>setTimeout(r,100));
 }
 if(!ready) throw new Error('Isolated Worker did not start');
 await run(['scripts/cloudflare-smoke.mjs','http://127.0.0.1:18787']);
 for(const path of ['/api/tiktok/diag-fetch','/api/tiktok/authorize?market=MY&shop_id=synthetic-shop']){
  const r=await fetch('http://127.0.0.1:18787'+path);assert.equal(r.status,path.includes('diag-fetch')?404:401);
 }
 console.log('PASS: isolated Worker build, HTTP smoke, protected authorization and removed public diagnostics');
} catch(error){process.stderr.write(output);throw error;}
finally {child.kill();await Promise.race([closed,new Promise(resolve=>setTimeout(resolve,5000))]);}
