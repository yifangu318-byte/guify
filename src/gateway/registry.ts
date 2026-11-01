import type { ToolName, ToolInput } from './contracts.js';

// Input schemas are flat and closed. The module caller and REST use the same
// validator, including rejecting extra fields instead of silently dropping them.
type Field = Readonly<{ type: 'string'; pattern: string; maxLength: number }
  | { type: 'integer'; minimum: number; maximum: number }>;
export interface ToolDefinition {
  name: ToolName; description: string; path: string;
  inputSchema: { type: 'object'; properties: Readonly<Record<string, Field>>; required: readonly string[]; additionalProperties: false };
  outputType: string;
  annotations: { readOnlyHint: true; destructiveHint: false; idempotentHint: true; openWorldHint: false };
}
const id: Field = { type: 'string', pattern: '^[A-Za-z0-9_-]+$', maxLength: 128 };
const integer: Field = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
function define(name: ToolName, description: string, path: string, properties: Record<string, Field> = {}, required: string[] = []): ToolDefinition {
  return { name, description, path, inputSchema: { type: 'object',
    properties: { shop_id: id, ...properties }, required: ['shop_id', ...required], additionalProperties: false },
  outputType: `ToolOutputs['${name}']`,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } };
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
export const toolRegistry: readonly ToolDefinition[] = freeze([
  define('get_shop_overview', 'Simulation overview; raw GMV includes all order statuses.', '/api/shops/:shop_id/overview',
    { start_at: integer, end_at: integer }, ['start_at', 'end_at']),
  define('get_orders', 'Read simulation orders for one explicitly scoped shop.', '/api/shops/:shop_id/orders'),
  define('get_order_detail', 'Read simulation order items and packages without buyer/tracking references.', '/api/shops/:shop_id/orders/:order_id',
    { order_id: id }, ['order_id']),
  define('get_products', 'Read simulation products and SKUs.', '/api/shops/:shop_id/products'),
  define('get_inventory', 'Read simulation inventory and warehouses.', '/api/shops/:shop_id/inventory'),
  define('get_shop_alerts', 'Run existing T7 inspection on current simulation snapshots.', '/api/shops/:shop_id/alerts',
    { stock_threshold: integer }),
  define('diagnose_fulfillment_issue', 'Associate only T5/T7 evidence; no causal certainty or write advice.', '/api/shops/:shop_id/orders/:order_id/fulfillment-diagnosis',
    { order_id: id, stock_threshold: integer }, ['order_id']),
]);
export function definitionFor(name: unknown): ToolDefinition | undefined {
  return toolRegistry.find(tool => tool.name === name);
}
export function validateInput(definition: ToolDefinition, value: unknown): ToolInput | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const row = value as Record<string, unknown>, schema = definition.inputSchema;
  if (schema.required.some(key => !Object.hasOwn(row, key))
    || Object.keys(row).some(key => !Object.hasOwn(schema.properties, key))) return;
  const copy: Record<string, string | number> = {};
  for (const [key, field] of Object.entries(schema.properties)) {
    if (!Object.hasOwn(row, key)) continue;
    const item = row[key];
    if (field.type === 'string') {
      if (typeof item !== 'string' || item.length > field.maxLength || !new RegExp(field.pattern).test(item)) return;
    } else if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < field.minimum || item > field.maximum) return;
    copy[key] = item as string | number;
  }
  if (definition.name === 'get_shop_overview' && !(Number(copy.start_at) < Number(copy.end_at))) return;
  return copy as unknown as ToolInput;
}
