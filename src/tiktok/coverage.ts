/** Intent registry only; no official endpoint paths or verified connections. */
export const coverage: ReadonlyArray<Readonly<{
  category: string; operations: readonly string[]; status: 'draft' | 'not_implemented';
}>> = [
  { category: 'products', operations: ['list', 'detail', 'skus'], status: 'draft' },
  { category: 'orders', operations: ['list', 'detail'], status: 'draft' },
  { category: 'inventory', operations: ['levels', 'warehouses'], status: 'draft' },
  { category: 'fulfillment', operations: ['packages', 'tracking'], status: 'not_implemented' },
  { category: 'finance_overview', operations: ['summary', 'settlements'], status: 'not_implemented' },
];
