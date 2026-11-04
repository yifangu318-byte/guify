import {test} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {registerOAuth} from '../src/tiktok/routes.js';
import {fixture,SECRET,TARGET,NOW} from './oauth-fixture.js';
import {handleTikTokCallback} from '../src/tiktok/oauth.js';
const admin='synthetic-administrator-credential-12345';
const headers={authorization:`Bearer ${admin}`,host:'erp.example.test',origin:'https://erp.example.test'};
async function appFor(db?:any, overrides:Record<string,any>={}){
 const app=Fastify();registerOAuth(app,{getAdminToken:()=>admin,getDb:()=>db,getSecret:()=>SECRET,getAppKey:()=> 'synthetic-app',getAppSecret:()=> 'synthetic-app-secret',getServiceId:()=> 'synthetic-service',getPublicUrl:()=> 'https://erp.example.test',getEnvironment:()=> 'test',getEnabled:()=> 'true',getTargets:()=>JSON.stringify([TARGET]),now:()=>NOW,...overrides});await app.ready();return app;
}
test('connection checks reject anonymous requests before reading configuration or database',async t=>{
 const app=await appFor(undefined,{getTargets:()=>{throw new Error('must not read');}});t.after(()=>app.close());
 const result=await app.inject('/api/tiktok/connection');assert.equal(result.statusCode,401);assert.deepEqual(Object.keys(result.json()).sort(),['code','error','message']);
});
test('preflight reports missing schema and invalid encryption without exposing credentials',async t=>{
 const app=await appFor(undefined,{getSecret:()=> 'synthetic-invalid-key',getEnabled:()=> 'false'});t.after(()=>app.close());
 const result=await app.inject({url:'/api/tiktok/connection',headers});assert.equal(result.statusCode,200);assert.equal(result.json().ready,false);assert.equal(result.json().checks.database,false);assert.equal(result.json().checks.encryption_key,false);assert.equal(result.json().checks.enabled,false);
 for(const value of [admin,'synthetic-invalid-key','synthetic-app-secret',TARGET.subjectId])assert.ok(!result.body.includes(value));
});
test('preflight binds host and origin, never makes outbound requests',async t=>{
 const app=await appFor(undefined,{fetchImpl:()=>{throw new Error('no network');}});t.after(()=>app.close());
 for(const change of [{host:'foreign.example.test'},{origin:'https://foreign.example.test'},{'sec-fetch-site':'cross-site'}])assert.equal((await app.inject({url:'/api/tiktok/connection',headers:{...headers,...change}})).statusCode,403);
});
test('preflight shows exact allowlisted store and verified authorization status, never token material',async t=>{
 const f=await fixture();const app=await appFor(f.db);t.after(()=>app.close());
 let result=await app.inject({url:'/api/tiktok/connection',headers});assert.equal(result.json().ready,true);assert.deepEqual(result.json().targets,[{shop_id:TARGET.shopId,market:'MY',status:'not_connected'}]);
 assert.equal((await handleTikTokCallback(f.query,f.deps)).status,200);
 result=await app.inject({url:'/api/tiktok/connection',headers});assert.equal(result.json().targets[0].status,'active');
 for(const value of ['synthetic-access','synthetic-refresh','synthetic-cipher',TARGET.subjectId])assert.ok(!result.body.includes(value));
 await f.db.prepare('UPDATE authorizations SET refresh_expires_at=?').bind(NOW-1).run();
 result=await app.inject({url:'/api/tiktok/connection',headers});assert.equal(result.json().targets[0].status,'reauthorize_required');
});
test('connection page uses same-origin script, no-store, restrictive CSP and no credential persistence',async t=>{
 const app=await appFor();t.after(()=>app.close());const page=await app.inject('/connect'),script=await app.inject('/connect.js');
 assert.equal(page.statusCode,200);assert.equal(page.headers['cache-control'],'no-store');assert.match(String(page.headers['content-security-policy']),/connect-src 'self'/);assert.match(page.body,/type="password"/);assert.match(page.body,/script src="\/connect.js"/);
 assert.equal(script.statusCode,200);assert.doesNotMatch(script.body,/localStorage|sessionStorage|document.cookie|innerHTML/);assert.match(script.body,/Authorization:'Bearer '/);assert.match(script.body,/credentials:'same-origin'/);assert.match(script.body,/pagehide/);assert.match(script.body,/url.origin!=='https:\/\/services.tiktokshop.com'/);
});
