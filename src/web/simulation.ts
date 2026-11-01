import { MemoryShopRepository } from '../shops/repository.js';
import { MemoryProductRepository } from '../products/repository.js';
import { MemoryOrderRepository } from '../orders/repository.js';
import { emptySnapshot as emptyProducts } from '../products/models.js';
import { emptySnapshot as emptyOrders } from '../orders/models.js';

// Deliberately synthetic identities/currency, isolated from Gateway configuration.
// Seeding happens once at app creation, never in response to a Web request.
export const demoShopIds = ['simulation-shop-a', 'simulation-shop-b'] as const;
export const demoWindow = { start_at: Date.UTC(2026, 9, 1), end_at: Date.UTC(2026, 10, 1) };
export function createWebSimulation() {
  const shops = new MemoryShopRepository(demoShopIds.map((id, index) => ({
    shop: { id, market: 'SIM', shopCode: '<placeholder-code>', shopName: `模拟店铺 ${index + 1}`, status: 'simulation' },
    authorization: { shop_id: id, status: 'authorized', expires_at: null, source: 'simulation' },
  })));
  const products = new MemoryProductRepository(demoShopIds.map(shop_id => {
    const s = emptyProducts(shop_id);
    s.products.push({ shop_id, product_id: 'simulation-product', title: '模拟旅行杯', status: 'active', category: 'simulation', updated_at: null });
    s.skus.push({ shop_id, product_id: 'simulation-product', sku_id: 'simulation-sku', price: '12.50', currency: 'TST', status: 'active' });
    s.warehouses.push({ shop_id, warehouse_id: 'simulation-warehouse', name: '模拟海外仓', warehouse_type: 'overseas' });
    s.inventory.push({ shop_id, sku_id: 'simulation-sku', warehouse_id: 'simulation-warehouse', quantity: shop_id === demoShopIds[0] ? 0 : 3, updated_at: null });
    return s;
  }));
  const orders = new MemoryOrderRepository(demoShopIds.map(shop_id => {
    const s = emptyOrders(shop_id);
    for (const [index, status] of (['pending_shipment', 'awaiting_payment', 'cancelled'] as const).entries()) {
      const order_id = `simulation-order-${index + 1}`;
      s.orders.push({ shop_id, order_id, buyer_ref: '<placeholder-buyer>', total_amount: '12.50', currency: 'TST',
        status, created_at: demoWindow.start_at, order_time: demoWindow.start_at + index, updated_at: null });
      s.items.push({ shop_id, order_id, item_id: 'simulation-item', sku_id: 'simulation-sku', quantity: 1, unit_price: '12.50' });
      s.packages.push({ shop_id, order_id, package_id: `simulation-package-${index + 1}`, tracking_ref: null,
        status: status === 'cancelled' ? 'cancelled' : 'pending_shipment', shipped_at: null });
    }
    return s;
  }));
  return { shops, products, orders };
}
