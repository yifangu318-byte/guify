import { MemoryShopRepository, type ShopRepository } from '../shops/repository.js';
import { MemoryProductRepository, type ProductRepository } from '../products/repository.js';
import { MemoryOrderRepository, type OrderRepository } from '../orders/repository.js';
import { ShopQueries } from '../shops/service.js';
import { ProductQueries } from '../products/service.js';
import { OrderQueries } from '../orders/service.js';
import type { AgentGrant } from './contracts.js';
import { AgentGateway, type GatewayAudit } from './gateway.js';
import { GatewayService } from './service.js';
export interface GatewayOptions {
  shops?: ShopRepository; products?: ProductRepository; orders?: OrderRepository;
  agents?: readonly AgentGrant[]; now?: () => number; audit?: (record: GatewayAudit) => void;
}
export function createGateway(options: GatewayOptions = {}): AgentGateway {
  const now = options.now ?? Date.now;
  return new AgentGateway(new GatewayService(
    new ShopQueries(options.shops ?? new MemoryShopRepository(), { now }),
    new ProductQueries(options.products ?? new MemoryProductRepository()),
    new OrderQueries(options.orders ?? new MemoryOrderRepository())), options.agents ?? [],
  { now, ...(options.audit ? { audit: options.audit } : {}) });
}
