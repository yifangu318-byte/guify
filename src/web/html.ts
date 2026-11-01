import type { ShopOverview } from '../analytics/models.js';
import type { WebScope } from './service.js';
import { demoWindow } from './simulation.js';

export const pages = [
  ['overview', '店铺概览'], ['orders', '订单列表'], ['products', '商品与 SKU'], ['inventory', '库存与仓库'],
  ['analytics', '经营数据'], ['alerts', '巡检告警'], ['connections', 'API 连接状态'], ['agents', 'Agent 任务与执行日志'],
] as const;
export type Page = typeof pages[number][0] | 'detail';
export function escapeHtml(value: unknown): string {
  return String(value ?? '未知').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
export function timeText(value: number | null): string {
  if (value === null) return '未知 / 未同步';
  const date = new Date(value);
  return `${Number.isNaN(date.getTime()) ? 'Unix ms' : date.toISOString()} (${value})`;
}
export function href(page: string, scope?: WebScope): string {
  const query = scope ? new URLSearchParams({ shop_id: scope.shop_id, start_at: String(scope.start_at), end_at: String(scope.end_at) }) : undefined;
  return `/web/${page}${query ? `?${query}` : ''}`;
}
export function link(label: string, url: string): { html: string } {
  return { html: `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>` };
}
type Cell = string | number | null | { html: string };
export function table(caption: string, columns: readonly string[], rows: readonly Cell[][]): string {
  if (!rows.length) return `<section><h2>${escapeHtml(caption)}</h2><p>暂无记录。</p></section>`;
  return `<div class="table-scroll" role="region" aria-label="${escapeHtml(caption)}" tabindex="0"><table><caption>${escapeHtml(caption)}</caption>
    <thead><tr>${columns.map(c => `<th scope="col">${escapeHtml(c)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(row => `<tr>${row.map(c => `<td>${c && typeof c === 'object' ? c.html : escapeHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
export const gmvNotice = '<p class="notice">GMV：全部状态原始合计（含未付款、已取消），非实收，非结算收入；按币种分列，不跨币种相加。</p>';
export function overviewHtml(o: ShopOverview): string {
  return `<dl class="metrics"><div><dt>窗口订单量</dt><dd>${o.order_count}</dd></div><div><dt>已妥投订单</dt><dd>${o.delivered_order_count}</dd></div>
    <div><dt>待发货订单</dt><dd>${o.pending_shipment_order_count}</dd></div></dl>${gmvNotice}`
    + table('窗口 GMV', ['币种', '全部状态原始合计'], o.gmv.by_currency.map(g => [g.currency, g.total_amount]));
}

// No JavaScript, fonts, images, CDN, or front-end build. Wide tables scroll
// within their own focusable region, leaving navigation/forms usable on phones.
const css = `:root{font-family:system-ui,sans-serif;color:#202c3d;background:#f3f6fa;line-height:1.55}
*{box-sizing:border-box}body{margin:0}header,main,footer{width:min(1120px,100%);margin:auto;padding:1rem}
h1{font-size:1.65rem}h2{font-size:1.1rem}a{color:#15529c;overflow-wrap:anywhere}a:focus-visible,input:focus-visible,select:focus-visible,button:focus-visible,.table-scroll:focus-visible{outline:3px solid #15529c;outline-offset:2px}
nav{display:flex;flex-wrap:wrap;gap:.5rem}nav a{padding:.5rem .75rem;border:1px solid #c9d3e1;border-radius:.4rem;background:white;text-decoration:none}nav a[aria-current]{background:#15529c;color:white}
.context,.panel,form{background:white;border:1px solid #d7dfeb;border-radius:.5rem;padding:1rem;margin:1rem 0;min-width:0;overflow-wrap:anywhere}
.badge{display:inline-block;background:#fff1bf;color:#534000;padding:.2rem .65rem;border-radius:.3rem}.notice{background:#fff5d8;padding:.75rem}
form{display:flex;flex-wrap:wrap;gap:.8rem;align-items:end}label{display:grid;gap:.25rem;flex:1 1 220px;min-width:0}input,select,button{font:inherit;padding:.6rem;max-width:100%;min-width:0}button{background:#15529c;color:white;border:0;border-radius:.3rem;cursor:pointer}
.metrics{display:flex;flex-wrap:wrap;gap:1rem}.metrics div{background:#eef4fd;padding:1rem;flex:1 1 160px}.metrics dd{font-size:1.5rem;margin:0}
.table-scroll{max-width:100%;overflow-x:auto;margin:1rem 0;background:white}table{border-collapse:collapse;width:100%;text-align:left}caption{text-align:left;font-weight:600;padding:.7rem}th,td{border-bottom:1px solid #d7dfeb;padding:.7rem;overflow-wrap:anywhere;min-width:7rem}th{background:#edf2f8}
footer{font-size:.9rem;color:#4a5b72}@media(max-width:600px){header,main,footer{padding:.75rem}h1{font-size:1.35rem}form{display:block}label,button{width:100%;margin-top:.75rem}nav a{flex:1 1 42%}.context{font-size:.9rem}}`;

export function documentHtml(input: {
  page: Page; title: string; shopIds: readonly string[]; queried_at: number;
  shop_id?: string; scope?: WebScope; body: string;
}): string {
  const { page, title, shopIds, queried_at, shop_id, scope, body } = input;
  const metadata = `<section class="context" aria-label="数据范围"><span class="badge">source: simulation</span>
    <p>适用店铺：${escapeHtml(shop_id ?? '未选择（不汇总全部店铺）')}</p>
    <p>查询时间：${escapeHtml(timeText(queried_at))}</p>
    <p>统计窗口：${scope ? `${escapeHtml(timeText(scope.start_at))} ≤ ${page === 'agents' ? 'recorded_at' : 'order_time'} &lt; ${escapeHtml(timeText(scope.end_at))}` : '未选择，请显式传入 start_at 与 end_at'}；含起点、不含终点 [start_at, end_at)。</p></section>`;
  // Read-only GET selection is the only form. No hidden defaults or credentials.
  const form = `<form method="get" action="/web/${page === 'detail' ? 'orders' : page}">
    <label>店铺（必选）<select name="shop_id" required><option value="">请选择店铺</option>${shopIds.map(id => `<option value="${escapeHtml(id)}"${id === shop_id ? ' selected' : ''}>${escapeHtml(id)}</option>`).join('')}</select></label>
    <label>窗口起点 start_at（Unix 毫秒，含）<input name="start_at" type="number" min="0" max="9007199254740991" step="1" required${scope ? ` value="${scope.start_at}"` : ''}></label>
    <label>窗口终点 end_at（Unix 毫秒，不含）<input name="end_at" type="number" min="0" max="9007199254740991" step="1" required${scope ? ` value="${scope.end_at}"` : ''}></label>
    <button type="submit">查询（只读）</button></form>
    <details><summary>模拟窗口示例（UTC）</summary><p>2026-10-01 至 2026-11-01：start_at=${demoWindow.start_at}，end_at=${demoWindow.end_at}。需选择店铺并明确提交。</p></details>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)} · MUSE ERP</title><style>${css}</style></head><body>
    <header><p>MUSE ERP · 只读模拟后台</p><nav aria-label="后台导航">${pages.map(([key, label]) => `<a href="${escapeHtml(href(key, scope))}"${key === page || (page === 'detail' && key === 'orders') ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav></header>
    <main><h1>${escapeHtml(title)}</h1>${metadata}${form}<section class="panel">${body}</section></main>
    <footer>仍是模拟骨架，未接真实数据。持久化待 PG 就绪。仅本地模拟只读展示。</footer></body></html>`;
}
