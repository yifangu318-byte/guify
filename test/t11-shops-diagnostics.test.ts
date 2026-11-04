import {test} from 'node:test';
import assert from 'node:assert/strict';
import {requestJson,UpstreamError} from '../src/tiktok/http.js';
import {fetchAuthorizedShops} from '../src/tiktok/callback.js';
import {json,SHOP,NOW} from './oauth-fixture.js';
for(const status of [301,302,307,308,400,401,403,429,500,502,503,504]) test(`credential HTTP rejects status ${status} without body`,async()=>{
 const result=()=>requestJson(async()=>new Response('synthetic-private',{status,headers:{Location:'https://evil.test'}}),'https://auth.tiktok-shops.com/test');
 await assert.rejects(result,e=>e instanceof UpstreamError&&!e.message.includes('synthetic-private'));
});
for(const body of ['null','[]','{}','{"code":0}','{"code":0,"data":[]}','{"code":123,"data":{}}','invalid','{"data":{}}']) test(`malformed envelope ${body}`,async()=>{
 await assert.rejects(()=>requestJson(async()=>new Response(body),'https://auth.tiktok-shops.com/test'),UpstreamError);
});
test('size limit includes body bytes, not Content-Length claim',async()=>{
 await assert.rejects(()=>requestJson(async()=>new Response('x'.repeat(1024*1024+1),{headers:{'Content-Length':'1'}}),'https://auth.tiktok-shops.com/test'),e=>e instanceof UpstreamError&&e.category==='response_too_large');
});
test('fetch timeout aborts even an injected transport ignoring abort',async()=>{
 let signal:AbortSignal|undefined;await assert.rejects(()=>requestJson(async(u,i)=>{signal=i?.signal as AbortSignal;return new Promise(()=>{});},'https://auth.tiktok-shops.com/test',{},20),e=>e instanceof UpstreamError&&e.category==='timeout');assert.equal(signal?.aborted,true);
});
test('streaming body timeout is bounded',async()=>{
 await assert.rejects(()=>requestJson(async()=>new Response(new ReadableStream({start(){}})),'https://auth.tiktok-shops.com/test',{},20),e=>e instanceof UpstreamError&&e.category==='timeout');
});
test('shops read retries transient status at most twice, without unrelated probes',async()=>{
 let calls=0;const shops=await fetchAuthorizedShops({appKey:'synthetic-app',appSecret:'synthetic-secret',accessToken:'synthetic-access',nowMs:NOW,
 fetchImpl:async()=>++calls<3?new Response('',{status:503}):json({shops:[SHOP]})});assert.equal(calls,3);assert.equal(shops.length,1);
});
test('shops exhausted rate limit is bounded to three calls',async()=>{
 let calls=0;await assert.rejects(()=>fetchAuthorizedShops({appKey:'synthetic-app',appSecret:'synthetic-secret',accessToken:'synthetic-access',nowMs:NOW,
 fetchImpl:async()=>{calls++;return new Response('',{status:429});}}));assert.equal(calls,3);
});
