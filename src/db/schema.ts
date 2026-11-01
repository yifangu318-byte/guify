import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';

export const shops = pgTable('shops', {
  id: uuid('id').defaultRandom().primaryKey(),
  market: text('market').notNull(),
  shopCode: text('shop_code').notNull(),
  shopName: text('shop_name').notNull(),
  status: text('status').default('inactive').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
