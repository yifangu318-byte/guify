import type { FastifyInstance } from 'fastify';

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>连接真实店铺 · MUSE ERP</title>
<style>:root{font-family:system-ui,sans-serif;color:#203046;background:#f3f6fa;line-height:1.6}*{box-sizing:border-box}main{max-width:740px;margin:3rem auto;padding:1.5rem}section{background:white;border:1px solid #d7dfeb;border-radius:12px;padding:1.5rem;margin:1rem 0}h1{font-size:1.8rem}a{color:#15529c}label{display:block;margin:1rem 0}input,select,button{font:inherit;padding:.75rem;border:1px solid #a5b4c8;border-radius:6px;max-width:100%}input,select{display:block;width:100%;margin-top:.4rem}button{background:#15529c;color:white;cursor:pointer}button:disabled{opacity:.5;cursor:default}:focus-visible{outline:3px solid #387ed6;outline-offset:3px}li{margin:.5rem 0}.note{color:#4a5b72;font-size:.95rem}[hidden]{display:none!important}#message{white-space:pre-wrap;overflow-wrap:anywhere}</style>
<script src="/connect.js" defer></script></head><body><main><a href="/web/connections">返回 ERP</a><h1>连接真实 TikTok 店铺</h1><p>检查后台配置，选择店铺，再前往 TikTok 授权。</p>
<section><h2>1. 验证接入管理员</h2><form id="access" autocomplete="off"><label for="credential">接入管理员凭据<input id="credential" type="password" autocomplete="off" spellcheck="false" required minlength="32" aria-describedby="credential-note"></label><p id="credential-note" class="note">使用 Cloudflare 中配置的 MUSE_OAUTH_ADMIN_TOKEN。凭据只用于向本站验证身份，不会放进链接或保存在本地。</p><button id="inspect" type="submit">检查接入条件</button></form><p id="message" role="status" aria-live="polite">等待检查。</p><ul id="checks"></ul></section>
<section id="selection" hidden><h2>2. 选择店铺</h2><label for="target">允许接入的店铺<select id="target"></select></label><button id="authorize" type="button" disabled>前往 TikTok 授权</button><p class="note">授权范围以 TikTok 确认页为准。连接成功后，现有 ERP 业务页面仍展示模拟数据；商品和订单同步需要另外接通。</p></section><noscript>请启用 JavaScript 后连接店铺。</noscript></main></body></html>`;

const script = `(() => {
  'use strict';
  const form=document.getElementById('access'), credential=document.getElementById('credential'), message=document.getElementById('message'), checks=document.getElementById('checks'), selection=document.getElementById('selection'), target=document.getElementById('target'), inspect=document.getElementById('inspect'), authorize=document.getElementById('authorize');
  let ready=false, targets=[];
  const labels={enabled:'授权功能已开启',public_origin:'本站回调地址已配置',application:'TikTok 应用凭据已配置',encryption_key:'Token 加密密钥格式正确',database:'新版授权数据表已就绪',targets:'已配置允许接入的店铺'};
  function reset(){ready=false;targets=[];selection.hidden=true;authorize.disabled=true;checks.replaceChildren();target.replaceChildren();}
  function report(error){message.textContent=error.message || '请求失败，请重试。';}
  async function request(path){
    const response=await fetch(path,{headers:{Authorization:'Bearer '+credential.value,Accept:'application/json'},credentials:'same-origin',cache:'no-store',redirect:'error'});
    if(!response.ok) throw new Error(response.status===401?'管理员凭据不正确或尚未配置。':response.status===503?'接入配置或数据表尚未就绪。':'请求未通过校验，请重新检查接入条件。');
    return response.json();
  }
  credential.addEventListener('input',()=>{reset();message.textContent='凭据已变更，请重新检查。';});
  form.addEventListener('submit',async event=>{
    event.preventDefault();reset();inspect.disabled=true;message.textContent='正在检查…';
    try{
      const result=await request('/api/tiktok/connection');
      for(const [key,label] of Object.entries(labels)){const li=document.createElement('li');li.textContent=(result.checks[key]?'✓ ':'待完成：')+label;checks.append(li);}
      targets=result.targets;for(let i=0;i<targets.length;i++){const row=targets[i],option=document.createElement('option');option.value=String(i);option.textContent=row.market+' · '+row.shop_id+' · '+(row.status==='active'?'已连接':row.status==='not_connected'?'未连接':'需要重新授权');target.append(option);}
      ready=result.ready===true;selection.hidden=!targets.length;authorize.disabled=!ready;message.textContent=ready?'接入条件已就绪，请选择店铺。':'请先完成上方配置，再重新检查。';
    }catch(error){report(error);}finally{inspect.disabled=false;}
  });
  authorize.addEventListener('click',async()=>{
    if(!ready || !targets[Number(target.value)])return;authorize.disabled=true;inspect.disabled=true;message.textContent='正在创建安全授权会话…';
    try{
      const row=targets[Number(target.value)],query=new URLSearchParams({market:row.market,shop_id:row.shop_id});
      const result=await request('/api/tiktok/authorize?'+query),url=new URL(result.authorization_url);
      if(url.origin!=='https://services.tiktokshop.com'||url.pathname!=='/open/authorize'||!url.searchParams.get('state')||!url.searchParams.get('service_id'))throw new Error('授权地址校验失败。');
      credential.value='';location.assign(url.href);
    }catch(error){report(error);authorize.disabled=false;inspect.disabled=false;}
  });
  window.addEventListener('pagehide',()=>{credential.value='';reset();});
})();`;

export function registerConnectionPage(app: FastifyInstance) {
  app.get('/connect', async (_request,reply) => reply.type('text/html; charset=utf-8')
    .header('Cache-Control','no-store').header('Referrer-Policy','no-referrer').header('X-Content-Type-Options','nosniff')
    .header('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'").send(html));
  app.get('/connect.js', async (_request,reply) => reply.type('application/javascript; charset=utf-8')
    .header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff').send(script));
}
