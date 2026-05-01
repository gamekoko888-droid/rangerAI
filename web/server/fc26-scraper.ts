/**
 * TODO (TD-039): FC26 功能当前不可用
 * - drizzle/schema.ts 已定义 fc26_prices + fc26_scrape_logs 表
 * - 但 drizzle-kit generate + migrate 未执行，数据库表不存在
 * - server/routers.ts 未注册 fc26 tRPC router
 * - 前端 PriceMonitor.tsx 调用 /api/trpc/fc26.* 会 404
 * - 激活步骤：1) 执行 drizzle 迁移  2) 在 routers.ts 注册 fc26 router
 */
/**
 * FC26 Coins Price Scraper — Proxy to Aliyun v5 Scraper API
 *
 * Instead of scraping 6 websites directly (which fails for most due to
 * Cloudflare / SPA rendering), this module calls the v5 scraper API
 * running on the Aliyun server (8.219.186.244:3088) which has FlareSolverr
 * and all the correct extraction logic already working.
 *
 * The v5 scraper returns normalized USD prices for all 6 sites × 3 platforms.
 * This module stores the results in the database and exposes query helpers.
 */

import { getDb } from "./db";
import { fc26Prices, fc26ScrapeLogs, type InsertFc26Price } from "../drizzle/schema";
import { desc, eq, and, gte, sql } from "drizzle-orm";

// ── Constants ──────────────────────────────────────────────────────────
const SCRAPER_API_URL = "https://ranger.voyage/scraper-api/api/fc26-prices";
const SCRAPER_TIMEOUT = 120_000; // 2 minutes — some sites need FlareSolverr

const SITES = ["eldorado", "u7buy", "iggm", "lootbar", "mmoexp", "ldshop"] as const;
const PLATFORMS = ["PS", "Xbox", "PC"] as const;

type Site = (typeof SITES)[number];
type Platform = (typeof PLATFORMS)[number];

interface PriceEntry {
  site: string;
  platform: string;
  quantity: string;
  priceRaw: number;
  currencyRaw: string;
  priceUsd: number;
  pricePerK: number;
  bonus?: string;
}

// ── Types for the v5 API response ─────────────────────────────────────
interface V5SitePlatform {
  price_per_100k: number | null;
  price_per_1000k?: number | null;
  source?: string;
  tiers?: Array<{ qty_k: number; sgd?: number; usd?: number; price?: number }>;
  error?: string;
}

interface V5Site {
  site: string;
  type: string; // B2C or C2C
  currency: string;
  original_currency?: string;
  platforms: Record<string, V5SitePlatform>;
}

interface V5Response {
  timestamp: string;
  duration_ms: number;
  sgd_to_usd_rate: number;
  sites: V5Site[];
}

// ── Call the v5 scraper API ───────────────────────────────────────────
async function callScraperApi(): Promise<V5Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCRAPER_TIMEOUT);

  try {
    const resp = await fetch(SCRAPER_API_URL, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!resp.ok) {
      throw new Error(`Scraper API returned ${resp.status}: ${await resp.text()}`);
    }
    return (await resp.json()) as V5Response;
  } finally {
    clearTimeout(timer);
  }
}

// ── Convert v5 response into flat PriceEntry rows ─────────────────────
function flattenV5Response(data: V5Response): PriceEntry[] {
  const entries: PriceEntry[] = [];

  for (const site of data.sites) {
    for (const [platform, info] of Object.entries(site.platforms)) {
      if (!info || info.error || info.price_per_100k == null) continue;

      const originalCurrency = site.original_currency || site.currency || "USD";
      const priceUsd100k = info.price_per_100k;

      // 100K entry
      entries.push({
        site: site.site,
        platform: platform.toLowerCase(),
        quantity: "100k",
        priceRaw: priceUsd100k, // already in USD from v5
        currencyRaw: originalCurrency,
        priceUsd: Math.round(priceUsd100k * 100) / 100,
        pricePerK: Math.round((priceUsd100k / 100) * 1e6) / 1e6,
      });

      // 1000K entry if available
      if (info.price_per_1000k != null && info.price_per_1000k > 0) {
        entries.push({
          site: site.site,
          platform: platform.toLowerCase(),
          quantity: "1000k",
          priceRaw: info.price_per_1000k,
          currencyRaw: originalCurrency,
          priceUsd: Math.round(info.price_per_1000k * 100) / 100,
          pricePerK: Math.round((info.price_per_1000k / 1000) * 1e6) / 1e6,
        });
      }

      // Additional tiers
      if (info.tiers && info.tiers.length > 0) {
        for (const tier of info.tiers) {
          const qty = tier.qty_k;
          if (qty === 100 || qty === 1000) continue; // already added above
          const usdPrice = tier.usd ?? tier.price ?? 0;
          if (usdPrice <= 0) continue;
          entries.push({
            site: site.site,
            platform: platform.toLowerCase(),
            quantity: `${qty}k`,
            priceRaw: usdPrice,
            currencyRaw: originalCurrency,
            priceUsd: Math.round(usdPrice * 100) / 100,
            pricePerK: Math.round((usdPrice / qty) * 1e6) / 1e6,
          });
        }
      }
    }
  }

  return entries;
}

// ── Main scrape orchestrator ───────────────────────────────────────────
export async function runFullScrape(): Promise<{
  batchId: string;
  prices: PriceEntry[];
  errors: string[];
  duration: number;
}> {
  const batchId = crypto.randomUUID();
  const startTime = Date.now();
  const errors: string[] = [];

  const db = await getDb();

  // Create log entry
  if (db) {
    try {
      await db.insert(fc26ScrapeLogs).values({
        batchId,
        status: "running",
        startedAt: new Date(),
      });
    } catch (err: any) {
      // Handle duplicate entry (e.g., HMR re-trigger) gracefully
      if (err?.message?.includes('Duplicate entry')) {
        console.warn(`[FC26 Scraper] Duplicate batch_id ${batchId}, skipping log insert`);
      } else {
        throw err;
      }
    }
  }

  let allPrices: PriceEntry[] = [];
  let sitesScraped = 0;

  try {
    console.log("[FC26 Scraper] Calling v5 scraper API...");
    const data = await callScraperApi();
    console.log(`[FC26 Scraper] API returned ${data.sites.length} sites in ${data.duration_ms}ms`);

    allPrices = flattenV5Response(data);

    // Count unique sites with at least one price
    const sitesWithPrices = new Set(allPrices.map((p) => p.site));
    sitesScraped = sitesWithPrices.size;

    // Check for sites that returned no prices
    for (const site of data.sites) {
      const hasPrices = Object.values(site.platforms).some(
        (p) => p && !p.error && p.price_per_100k != null
      );
      if (!hasPrices) {
        errors.push(`${site.site}: no prices returned`);
      }
    }

    console.log(`[FC26 Scraper] ${allPrices.length} price entries from ${sitesScraped} sites`);
  } catch (err: any) {
    console.error("[FC26 Scraper] API call failed:", err);
    errors.push(`scraper_api: ${err.message}`);
  }

  const duration = Date.now() - startTime;

  // Save prices to database
  if (db && allPrices.length > 0) {
    const rows: InsertFc26Price[] = allPrices.map((p) => ({
      site: p.site,
      platform: p.platform,
      quantity: typeof p.quantity === 'number' ? p.quantity : parseInt(String(p.quantity)) || 100000,
      priceUsd: String(p.priceUsd),
      batchId,
    }));

    await db.insert(fc26Prices).values(rows);
  }

  // Update log entry
  if (db) {
    await db.update(fc26ScrapeLogs)
      .set({
        status: errors.length > 0 && allPrices.length === 0 ? "failed" : "completed",
        sitesScraped,
        errorMessage: errors.length > 0 ? JSON.stringify(errors) : null,
        completedAt: new Date(),
      })
      .where(eq(fc26ScrapeLogs.batchId, batchId));
  }

  return { batchId, prices: allPrices, errors, duration };
}

// ── Database query helpers ─────────────────────────────────────────────

/** Get latest prices (most recent completed batch) */
export async function getLatestPrices() {
  const db = await getDb();
  if (!db) return null;

  // Find the latest completed batch
  const latestLog = await db
    .select()
    .from(fc26ScrapeLogs)
    .where(eq(fc26ScrapeLogs.status, "completed"))
    .orderBy(desc(fc26ScrapeLogs.completedAt))
    .limit(1);

  if (latestLog.length === 0) return null;

  const batchId = latestLog[0].batchId;
  const prices = await db
    .select()
    .from(fc26Prices)
    .where(eq(fc26Prices.batchId, batchId));

  return {
    batchId,
    scrapedAt: latestLog[0].completedAt,
    duration: latestLog[0].completedAt && latestLog[0].startedAt ? Math.round((new Date(latestLog[0].completedAt).getTime() - new Date(latestLog[0].startedAt).getTime())) : 0,
    prices,
  };
}

/** Get price history for trend charts */
export async function getPriceHistory(days = 7) {
  const db = await getDb();
  if (!db) return [];

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  // Get all completed batches in the time range
  const logs = await db
    .select()
    .from(fc26ScrapeLogs)
    .where(
      and(
        eq(fc26ScrapeLogs.status, "completed"),
        gte(fc26ScrapeLogs.startedAt, since)
      )
    )
    .orderBy(desc(fc26ScrapeLogs.startedAt));

  if (logs.length === 0) return [];

  const batchIds = logs.map((l) => l.batchId);

  // Get all prices for these batches
  const prices = await db
    .select()
    .from(fc26Prices)
    .where(
      sql`${fc26Prices.batchId} IN (${sql.join(
        batchIds.map((id) => sql`${id}`),
        sql`, `
      )})`
    )
    .orderBy(desc(fc26Prices.scrapedAt));

  // Group by batch
  const batches = logs.map((log) => ({
    batchId: log.batchId,
    scrapedAt: log.startedAt,
    prices: prices.filter((p) => p.batchId === log.batchId),
  }));

  return batches;
}

/** Get scrape logs */
export async function getScrapeLogs(limit = 20) {
  const db = await getDb();
  if (!db) return [];

  return db
    .select()
    .from(fc26ScrapeLogs)
    .orderBy(desc(fc26ScrapeLogs.startedAt))
    .limit(limit);
}

// ── Scheduled scraper (runs every 4 hours) ─────────────────────────────
let scrapeInterval: ReturnType<typeof setInterval> | null = null;

export function startScheduledScraper() {
  if (scrapeInterval) return;

  const FOUR_HOURS = 4 * 60 * 60 * 1000;

  // Run immediately on start
  console.log("[FC26 Scraper] Starting initial scrape...");
  runFullScrape()
    .then((r) =>
      console.log(
        `[FC26 Scraper] Initial scrape done: ${r.prices.length} prices, ${r.errors.length} errors, ${r.duration}ms`
      )
    )
    .catch((err) => console.error("[FC26 Scraper] Initial scrape failed:", err));

  // Then every 4 hours
  scrapeInterval = setInterval(() => {
    console.log("[FC26 Scraper] Running scheduled scrape...");
    runFullScrape()
      .then((r) =>
        console.log(
          `[FC26 Scraper] Scheduled scrape done: ${r.prices.length} prices, ${r.errors.length} errors, ${r.duration}ms`
        )
      )
      .catch((err) =>
        console.error("[FC26 Scraper] Scheduled scrape failed:", err)
      );
  }, FOUR_HOURS);

  console.log(
    `[FC26 Scraper] Scheduled to run every ${FOUR_HOURS / 3600000} hours`
  );
}

export function stopScheduledScraper() {
  if (scrapeInterval) {
    clearInterval(scrapeInterval);
    scrapeInterval = null;
    console.log("[FC26 Scraper] Scheduler stopped");
  }
}
