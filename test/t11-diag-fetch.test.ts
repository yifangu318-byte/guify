import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildApp} from '../src/app.js';
import {Writable} from 'node:stream';
for(const suffix of ['', '?url=https://evil.test','?token=synthetic-secret']) test(`public network diagnostics removed ${suffix}`,async t=>{
 let calls=0;const app=buildApp({host:'127.0.0.1',port:0},new Writable({write(c,e,cb){cb();}}),{},{},{tiktok:{fetchImpl:async()=>{calls++;throw new Error();}}});t.after(()=>app.close());
 const r=await app.inject('/api/tiktok/diag-fetch'+suffix);assert.equal(r.statusCode,404);assert.equal(calls,0);assert.ok(!r.body.includes('synthetic-secret'));
});
