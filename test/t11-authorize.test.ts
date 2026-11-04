import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Writable} from 'node:stream';
import {buildApp} from '../src/app.js';
import {fixture,SECRET,TARGET} from './oauth-fixture.js';
const ADMIN='synthetic-admin-token-01234567890123456789';
async function appFixture(t:any) {
 const f=await fixture();let logs='';
 const app=buildApp({host:'127.0.0.1',port:0},new Writable({write(c,e,cb){logs+=c;cb();}}),{},{},{tiktok:{getSecret:()=>SECRET,getAppKey:()=>f.deps.appKey,getAppSecret:()=>f.deps.appSecret,
 getDb:()=>f.db,getServiceId:()=> 'synthetic-service',getAdminToken:()=>ADMIN,getTargets:()=>JSON.stringify([TARGET]),getEnvironment:()=> 'test',getEnabled:()=> 'true',getPublicUrl:()=> 'https://erp.test',fetchImpl:f.deps.fetchImpl,now:f.deps.now}});
 t.after(()=>app.close());return {...f,app,logs:()=>logs};
}
for(const authorization of [undefined,'Bearer bad','Basic synthetic',`Bearer ${ADMIN} extra`]) test(`authorize requires admin ${authorization?.slice(0,12)}`,async t=>{
 const f=await appFixture(t);const r=await f.app.inject({url:'/api/tiktok/authorize?market=MY&shop_id=synthetic-shop',headers:{host:'erp.test',...(authorization?{authorization}:{})}});
 assert.equal(r.statusCode,401);assert.equal(f.calls.length,0);
});
for(const query of ['', '?market=MY','?market=MY&shop_id=unknown','?market=SG&shop_id=synthetic-shop','?market=MY&market=PH&shop_id=synthetic-shop','?market=MY&shop_id=synthetic-shop&redirect_uri=https://evil.test']) test(`authorize rejects target/query ${query}`,async t=>{
 const f=await appFixture(t);const r=await f.app.inject({url:'/api/tiktok/authorize'+query,headers:{host:'erp.test',authorization:`Bearer ${ADMIN}`}});assert.equal(r.statusCode,400);assert.equal(f.calls.length,0);
});
for(const headers of [{origin:'https://evil.test'},{host:'evil.test'},{'sec-fetch-site':'cross-site'}]) test(`authorize origin guard ${JSON.stringify(headers)}`,async t=>{
 const f=await appFixture(t);const r=await f.app.inject({url:'/api/tiktok/authorize?market=MY&shop_id=synthetic-shop',headers:{host:'erp.test',authorization:`Bearer ${ADMIN}`,...headers}});assert.equal(r.statusCode,403);
});
test('authorize persists browser-bound state then full HTTP callback succeeds without credentials escaping',async t=>{
 const f=await appFixture(t);const r=await f.app.inject({url:'/api/tiktok/authorize?market=MY&shop_id=synthetic-shop',headers:{host:'erp.test',authorization:`Bearer ${ADMIN}`}});
 assert.equal(r.statusCode,302);const url=new URL(r.headers.location!);assert.equal(url.origin,'https://services.tiktokshop.com');
 assert.deepEqual([...url.searchParams.keys()].sort(),['service_id','state']);
 const cookie=String(r.headers['set-cookie']);assert.match(cookie,/Secure; HttpOnly; SameSite=Lax/);
 const response=await f.app.inject({url:'/api/tiktok/callback?code=synthetic-code&state='+encodeURIComponent(url.searchParams.get('state')!),headers:{host:'erp.test',cookie:cookie.split(';')[0]!}});
 assert.equal(response.statusCode,200);assert.equal(response.json().market,'MY');assert.equal(f.calls.length,2);
 for(const secret of [SECRET,ADMIN,'synthetic-access','synthetic-refresh','synthetic-code','synthetic-cipher',url.searchParams.get('state')!]) assert.ok(!(response.body+f.logs()).includes(secret));
});
test('authorize JSON option supports same-origin authenticated browser bootstrap',async t=>{
 const f=await appFixture(t);const r=await f.app.inject({url:'/api/tiktok/authorize?market=MY&shop_id=synthetic-shop',headers:{host:'erp.test',authorization:`Bearer ${ADMIN}`,accept:'application/json'}});
 assert.equal(r.statusCode,200);assert.ok(r.json().authorization_url);assert.ok(r.headers['set-cookie']);
});
test('callback rejects duplicate browser cookies and cross-host requests',async t=>{
 const f=await appFixture(t);for(const headers of [{host:'evil.test'},{host:'erp.test',cookie:'__Host-muse_oauth=x; __Host-muse_oauth=y'}]) {
 const r=await f.app.inject({url:'/api/tiktok/callback?code=synthetic-code&state='+encodeURIComponent(f.state),headers});assert.equal(r.statusCode,400);}
 assert.equal(f.calls.length,0);
});
