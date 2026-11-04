import { spawn } from 'node:child_process';
// Do not inherit account credentials, NODE_OPTIONS or live integration variables.
const allowed = ['PATH','SystemRoot','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','TEMP','TMP','TMPDIR'];
const env = Object.fromEntries(allowed.filter(key => process.env[key] !== undefined).map(key => [key,process.env[key]]));
Object.assign(env,{MUSE_ENV:'test',TIKTOK_OAUTH_ENABLED:'false',WRANGLER_SEND_METRICS:'false'});
const mode = process.argv[2];
if (mode && mode !== '--mcp-smoke') throw new Error('Unknown local verification mode');
const args = mode === '--mcp-smoke' ? ['scripts/mcp-smoke.mjs'] : ['--import','tsx','--test','--test-isolation=none','test/*.test.ts'];
const child = spawn(process.execPath,args,{env,stdio:'inherit'});
child.on('error',()=>{process.stderr.write('Local test runner failed\n');process.exitCode=1;});
child.on('exit',(code)=>{process.exitCode=code ?? 1;});
