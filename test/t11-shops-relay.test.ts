import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fetchAuthorizedShops,validRelay} from '../src/tiktok/callback.js';
import {SHOP,NOW,json} from './oauth-fixture.js';
for(const url of ['http://relay.example.com','https://user:pass@relay.example.com','https://relay.example.com/path','https://relay.example.com/?q=1','https://relay.example.com/#fragment','https://127.0.0.1','https://localhost','https://relay.internal']) test(`relay rejects unsafe target ${url}`,()=>{
 assert.throws(()=>validRelay(url,new URL(url).origin));
});
test('relay requires separately pinned exact origin',()=>{assert.throws(()=>validRelay('https://relay.example.com'));assert.throws(()=>validRelay('https://relay.example.com','https://other.example.com'));});
test('relay forwards only fixed shops operation, rejects redirects, never retries',async()=>{
 let calls=0;await assert.rejects(()=>fetchAuthorizedShops({appKey:'synthetic-app',appSecret:'synthetic-secret',accessToken:'synthetic-access',nowMs:NOW,
 relayUrl:'https://relay.example.com',relayAllowedOrigin:'https://relay.example.com',relaySecret:'synthetic-relay-secret',fetchImpl:async(url,init)=>{
 calls++;assert.equal(init?.redirect,'manual');assert.equal(init?.method,'POST');assert.deepEqual(JSON.parse(String(init?.body)),{host:'open-api.tiktokglobalshop.com',path:'/authorization/202309/shops'});return new Response('',{status:302});}}));assert.equal(calls,1);
});
test('relay missing secret never reaches network',async()=>{
 let calls=0;await assert.rejects(()=>fetchAuthorizedShops({appKey:'synthetic-app',appSecret:'synthetic-secret',accessToken:'synthetic-access',nowMs:NOW,
 relayUrl:'https://relay.example.com',relayAllowedOrigin:'https://relay.example.com',fetchImpl:async()=>{calls++;return json({shops:[SHOP]});}}));assert.equal(calls,0);
});
