import type {FastifyInstance} from 'fastify';
const html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MUSE · API 接入</title><style>
:root{font:16px/1.6 system-ui,sans-serif;color:#192b37;background:#f5f7f8}*{box-sizing:border-box}body{margin:0}main{max-width:520px;margin:12vh auto;padding:24px}section{padding:28px;background:white;border:1px solid #e2e8ec;border-radius:16px}h1{font-size:24px;margin:0 0 8px}p{color:#65747d}label{display:block;margin:24px 0 8px}input,button{width:100%;font:inherit;padding:12px;border:1px solid #cbd5db;border-radius:8px}button{background:#176d61;color:white;cursor:pointer;margin-top:16px;border:0}button:disabled{opacity:.45;cursor:default}a{color:#39616a;font-size:14px}.secondary{background:transparent;color:#65747d}#message{font-size:14px;overflow-wrap:anywhere}#summary{color:#192b37}#mode{font-size:14px}[hidden]{display:none!important}:focus-visible{outline:3px solid #57a99d;outline-offset:3px}</style><script src="/developers.js" defer></script></head><body><main><section>
<h1>MUSE</h1><p>连接店铺，交给 AI。</p>
<form id="access" autocomplete="off"><label for="admin">管理员密码</label><input id="admin" type="password" minlength="8" maxlength="256" required autocomplete="off" spellcheck="false"><button id="login" type="submit">登录</button></form>
<div id="workspace" hidden><p id="summary"></p><p id="mode"></p><button id="download" type="button">下载 AI 接入包 .md</button><button id="logout" type="button" class="secondary">退出</button><a href="/connect">连接店铺</a></div>
<p id="message" role="status" aria-live="polite"></p></section></main></body></html>`;
export const aiPageScript=`(() => {
'use strict';const el=id=>document.getElementById(id);let generation=0,busy=false,ready=false;
const messages={UNAUTHORIZED:'密码不正确。',AI_MIGRATION_REQUIRED:'接入服务尚未就绪。',AI_UNAVAILABLE:'服务暂时不可用，请稍后再试。'};
if(['MY','PH','SG','TH','VN'].includes(new URLSearchParams(location.search).get('connected'))){el('message').textContent='授权流程已返回，请登录确认已连接店铺并下载更新的接入包。';history.replaceState(null,'','/developers');}
function reset(){generation++;ready=false;el('admin').value='';el('workspace').hidden=true;el('access').hidden=false;el('summary').textContent='';el('mode').textContent='';el('message').textContent='';}
function lock(value){busy=value;el('login').disabled=value;el('download').disabled=value||!ready;}
async function request(path,markdown=false){const response=await fetch(path,{headers:{Authorization:'Bearer '+el('admin').value,Accept:markdown?'text/markdown':'application/json'},cache:'no-store',credentials:'same-origin',redirect:'error',signal:AbortSignal.timeout(15000)});if(!response.ok){const data=await response.json();throw new Error(messages[data.code]||'请求未完成，请稍后再试。');}return markdown?response.text():response.json();}
async function run(fn){if(busy)return;const epoch=generation;lock(true);try{await fn(epoch);}catch(error){if(epoch===generation)el('message').textContent=error.name==='TimeoutError'?'请求超时，请稍后再试。':error.message;}finally{lock(false);}}
el('access').addEventListener('submit',event=>{event.preventDefault();void run(async epoch=>{const state=await request('/api/ai/admin/status');if(epoch!==generation)return;ready=state.enabled&&state.database&&state.live_enabled&&state.shops.length>0;el('access').hidden=true;el('workspace').hidden=false;el('summary').textContent='已连接 '+state.shops.length+' 家店铺 · '+state.tools.length+' 项工具';el('mode').textContent=state.public_enabled?'公开免认证 · 不设到期时间 · 应用不限流':'公开免认证尚未启用';el('message').textContent=ready?'':'请先完成店铺授权与服务配置。';});});
el('download').addEventListener('click',()=>void run(async epoch=>{const markdown=await request('/api/ai/admin/handoff',true);if(epoch!==generation)return;const url=URL.createObjectURL(new Blob([markdown],{type:'text/markdown;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='MUSE-AI.md';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);el('message').textContent='已下载，直接将文件发送给 AI。';}));
el('logout').addEventListener('click',reset);el('admin').addEventListener('input',()=>{generation++;ready=false;el('workspace').hidden=true;});window.addEventListener('pagehide',reset);
})();`;
export function registerAiPage(app:FastifyInstance){
  const headers=(reply:any)=>reply.header('Cache-Control','no-store').header('Referrer-Policy','no-referrer').header('X-Content-Type-Options','nosniff')
    .header('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  app.get('/developers',async(_request,reply)=>headers(reply).type('text/html; charset=utf-8').send(html));
  app.get('/developers.js',async(_request,reply)=>headers(reply).type('text/javascript; charset=utf-8').send(aiPageScript));
}
