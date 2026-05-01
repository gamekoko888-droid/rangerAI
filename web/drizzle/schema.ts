import { int, mysqlEnum, mysqlTable, text, timestamp, varchar, bigint, index } from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 */
export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/**
 * Chats table — stores conversation metadata.
 * Each chat maps to a Gateway sessionKey for AI communication.
 */
export const chats = mysqlTable("chats", {
  id: varchar("id", { length: 36 }).primaryKey(), // UUID
  userId: int("userId").notNull(), // FK to users.id
  sessionKey: varchar("sessionKey", { length: 128 }).notNull(), // Gateway sessionKey
  title: varchar("title", { length: 200 }).notNull().default("新对话"),
  model: varchar("model", { length: 100 }), // Primary model used
  titleGenerated: int("titleGenerated").notNull().default(0), // 0=false, 1=true
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  index("chats_userId_idx").on(table.userId),
  index("chats_sessionKey_idx").on(table.sessionKey),
]);

export type Chat = typeof chats.$inferSelect;
export type InsertChat = typeof chats.$inferInsert;

/**
 * Messages table — stores individual messages within a chat.
 * Both user messages and AI responses are stored here.
 */
export const messages = mysqlTable("messages", {
  id: int("id").autoincrement().primaryKey(),
  chatId: varchar("chatId", { length: 36 }).notNull(), // FK to chats.id
  role: mysqlEnum("role", ["user", "assistant", "system"]).notNull(),
  content: text("content").notNull(),
  model: varchar("model", { length: 100 }), // Model that generated this message (for assistant)
  tokens: int("tokens"), // Token count estimate
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("messages_chatId_idx").on(table.chatId),
]);

export type Message = typeof messages.$inferSelect;
export type InsertMessage = typeof messages.$inferInsert;


// --- FC26 Coins Price Tracking (TD-033) ---------------------
/**
 * FC26 Prices - stores scraped coin prices from various platforms.
 * Consumed by server/fc26-scraper.ts
 */
export const fc26Prices = mysqlTable("fc26_prices", {
  id: int("id").autoincrement().primaryKey(),
  site: varchar("site", { length: 100 }).notNull(),
  platform: varchar("platform", { length: 50 }).notNull(),
  priceUsd: varchar("priceUsd", { length: 20 }).notNull(),
  currency: varchar("currency", { length: 10 }).default("USD"),
  quantity: int("quantity").default(100000),
  scrapedAt: timestamp("scrapedAt").defaultNow().notNull(),
  batchId: varchar("batchId", { length: 36 }),
}, (table) => [
  index("fc26_prices_site_idx").on(table.site),
  index("fc26_prices_platform_idx").on(table.platform),
  index("fc26_prices_scrapedAt_idx").on(table.scrapedAt),
]);
export type Fc26Price = typeof fc26Prices.$inferSelect;
export type InsertFc26Price = typeof fc26Prices.$inferInsert;

/**
 * FC26 Scrape Logs - tracks scraping runs for auditing.
 */
export const fc26ScrapeLogs = mysqlTable("fc26_scrape_logs", {
  id: int("id").autoincrement().primaryKey(),
  batchId: varchar("batchId", { length: 36 }).notNull(),
  status: mysqlEnum("status", ["running", "completed", "failed"]).default("running"),
  sitesScraped: int("sitesScraped").default(0),
  sitesTotal: int("sitesTotal").default(0),
  errorMessage: text("errorMessage"),
  startedAt: timestamp("startedAt").defaultNow().notNull(),
  completedAt: timestamp("completedAt"),
}, (table) => [
  index("fc26_scrape_logs_batchId_idx").on(table.batchId),
]);
export type Fc26ScrapeLog = typeof fc26ScrapeLogs.$inferSelect;
export type InsertFc26ScrapeLog = typeof fc26ScrapeLogs.$inferInsert;
