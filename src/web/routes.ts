import type { FastifyInstance } from 'fastify';
import { GatewayError, errorBody } from '../gateway/errors.js';
import type { ShopSummary, SyncState } from '../shops/models.js';
import { WebService, type WebScope, type WebOptions, WebAuditLog } from './service.js';
import { documentHtml, escapeHtml, href, link, overviewHtml, pages, table, timeText, type Page } from './html.js';

const identifier = /^[A-Za-z0-9_-]{1,128}$/;
function parseQuery(raw: Record<string, unknown>): { shop_id?: string; scope?: WebScope } {
  if (Object.keys(raw).some(k => !['shop_id', 'start_at', 'end_at'].includes(k))) throw new GatewayError(400);
  if (raw.shop_id !== undefined && (typeof raw.shop_id !== 'string' || (raw.shop_id !== '' && !identifier.test(raw.shop_id)))) throw new GatewayError(400);
  const shop_id = raw.shop_id || undefined;
  const hasStart = raw.start_at !== undefined, hasEnd = raw.end_at !== undefined;
  if (hasStart !== hasEnd) throw new GatewayError(400);
  let window: { start_at: number; end_at: number } | undefined;
  if (hasStart) {
    const time = (v: unknown): number => {
      if (typeof v !== 'string' || !/^\d+$/.test(v) || !Number.isSafeInteger(Number(v))) throw new GatewayError(400);
      return Number(v);
    };
    window = { start_at: time(raw.start_at), end_at: time(raw.end_at) };
    if (window.start_at >= window.end_at) throw new GatewayError(400);
  }
  return { ...(shop_id ? { shop_id } : {}), ...(shop_id && window ? { scope: { shop_id, ...window } } : {}) };
}
function syncHtml(states: readonly SyncState[]): string {
  return table('模拟同步状态（当前快照）', ['资源', '最近成功时间', '错误类别'], states.map(s => [s.resource, timeText(s.last_success_at), s.last_error ?? '无已记录错误']));
}
async function pageBody(page: Page, service: WebService, scope: WebScope, shop: ShopSummary, time: number, order_id?: string): Promise<string> {
  const snapshotNote = '<p>当前快照，非窗口内历史数据；本页窗口仅用于导航上下文。查询时间见上方。</p>';
  switch (page) {
    case 'overview':
    case 'analytics': {
      const a = await service.analytics(scope, time);
      return `<p>店铺：${escapeHtml(shop.shop.shopName)}；市场：${escapeHtml(shop.shop.market)}；模拟授权：${escapeHtml(shop.authorization.status)}</p>`
        + overviewHtml(a.overview)
        + table('窗口热销 SKU（全部状态订单）', ['SKU', '件数'], a.best_sellers.items.map(i => [i.sku_id, i.quantity]))
        + `<p>库存风险：当前快照，非历史窗口库存；阈值 5（零库存为缺货，正库存严格小于 5 为低库存）。缺货 ${a.inventory_risk.out_of_stock.length} 条，低库存 ${a.inventory_risk.low_stock.length} 条（按 SKU / 仓库，不跨仓合计）。</p>`;
    }
    case 'orders': {
      const orders = await service.orderList(scope);
      return '<p>按 order_time 筛选显式窗口。</p>' + table('窗口订单', ['订单', '状态', '原始金额', '币种', '下单时间'],
        orders.map(o => [link(o.order_id, href(`orders/${encodeURIComponent(o.order_id)}`, scope)), o.status, o.total_amount, o.currency, timeText(o.order_time)]));
    }
    case 'detail': {
      const d = await service.orderDetail(scope, order_id!);
      return `<p>${link('返回窗口订单列表', href('orders', scope)).html}</p>`
        + table('订单详情（属于所选窗口）', ['订单', '状态', '原始金额', '币种', '下单时间'], [[d.order.order_id, d.order.status, d.order.total_amount, d.order.currency, timeText(d.order.order_time)]])
        + table('订单明细', ['明细', 'SKU', '数量', '单价'], d.items.map(i => [i.item_id, i.sku_id, i.quantity, i.unit_price]))
        + table('包裹状态（当前快照）', ['包裹', '状态', '发出时间'], d.packages.map(p => [p.package_id, p.status, timeText(p.shipped_at)]));
    }
    case 'products': {
      const p = await service.catalog(scope);
      return snapshotNote + table('商品', ['商品', '名称', '状态', '类别', '更新时间'], p.products.map(p => [p.product_id, p.title, p.status, p.category, timeText(p.updated_at)]))
        + table('SKU', ['SKU', '所属商品', '价格', '币种', '状态'], p.skus.map(s => [s.sku_id, s.product_id, s.price, s.currency, s.status]));
    }
    case 'inventory': {
      const p = await service.catalog(scope);
      return snapshotNote + table('库存（不跨仓合计）', ['SKU', '仓库', '数量', '更新时间'], p.inventory.map(i => [i.sku_id, i.warehouse_id, i.quantity, timeText(i.updated_at)]))
        + table('仓库', ['仓库', '名称', '类型'], p.warehouses.map(w => [w.warehouse_id, w.name, w.warehouse_type]))
        + '<p>regular：常规仓；overseas：海外仓；other：其他。类型沿用 T4，不按国家推断国内或海外。</p>';
    }
    case 'alerts': {
      const r = await service.alerts(scope, shop.authorization, time);
      return '<p>查询时计算 T7 证据，不保存告警；当前快照巡检，不按订单统计窗口截断。库存阈值 5；待发货超过 48 小时、物流停滞超过 72 小时。时间阈值单位为毫秒，库存为件数。</p>'
        + `<p>巡检时间：${escapeHtml(timeText(r.inspected_at))}；异常总数：${r.total_anomalies}</p>`
        + table('巡检证据', ['类型', '实体类型', '实体', '触发值', '阈值'], [...r.stock, ...r.order_timeouts, ...r.authorization].map(a => [a.type, a.entity_type, a.entity_id, a.trigger_value, a.threshold]));
    }
    case 'connections':
      return snapshotNote + '<p>真实 API：未连接、未验证。以下授权与同步状态均为 simulation，不代表真实接通。</p>'
        + table('模拟店铺授权', ['店铺', '市场', '状态', '到期时间'], [[shop.shop.shopName, shop.shop.market, shop.authorization.status, timeText(shop.authorization.expires_at)]])
        + syncHtml(shop.sync)
        + (shop.authorization.status === 'authorized' ? syncHtml(await service.sync(scope)) : '<p>模拟授权无效，不读取商品或订单同步快照。</p>');
    case 'agents':
      return '<p>Agent 任务存储未接通，暂无任务记录。MCP 传输层未接通。</p><p>以下仅为本进程最近最多 100 条 Gateway 审计摘要，按所选店铺与记录时间窗口筛选；重启清空，不是持久化任务历史。Web 浏览不生成 Agent 任务。</p>'
        + table('Gateway 执行日志', ['记录时间', 'Agent', '工具', '结果', 'HTTP 状态', '耗时 ms'], service.audit.read(scope).map(r => [timeText(r.recorded_at), r.agent_id, r.tool, r.result, r.status_code, r.duration_ms]));
  }
}

export function registerWeb(app: FastifyInstance, options: WebOptions, audit: WebAuditLog): void {
  const service = new WebService(options, audit);
  const routes: Array<[string, Page, string]> = [
    ['/web/', 'overview', '店铺概览'], ...pages.map(([page, title]): [string, Page, string] => [`/web/${page}`, page, title]),
    ['/web/orders/:order_id', 'detail', '订单详情'],
  ];
  for (const [path, page, title] of routes) {
    app.get(path, { exposeHeadRoute: false }, async (request, reply) => {
      reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
      try {
        const { shop_id, scope } = parseQuery(request.query as Record<string, unknown>);
        const time = service.now();
        const shop = shop_id ? await service.shop(shop_id, time) : undefined;
        if (shop && page !== 'connections' && shop.authorization.status !== 'authorized') throw new GatewayError(403);
        const order_id = (request.params as { order_id?: string }).order_id;
        if (page === 'detail' && (!order_id || !identifier.test(order_id))) throw new GatewayError(400);
        const body = !shop ? '<p>请选择店铺；未选择店铺时不读取业务数据，也不默认汇总全部店铺。</p>'
          : !scope ? '<p>请显式选择统计窗口，传入 start_at 与 end_at（Unix 毫秒）。</p>'
            : await pageBody(page, service, scope, shop, time, order_id);
        return reply.type('text/html; charset=utf-8').send(documentHtml({ page, title, shopIds: service.shopIds, queried_at: time,
          ...(shop_id ? { shop_id } : {}), ...(scope ? { scope } : {}), body }));
      } catch (error) {
        const status = error instanceof GatewayError ? error.statusCode : 500;
        return reply.code(status).send(errorBody(status));
      }
    });
  }
}
