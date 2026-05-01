/**
 * inventory-api.mjs — Inventory Read API
 * 
 * Endpoints:
 *   GET /api/inventory       — list all inventory items with optional filters
 *   GET /api/inventory/stats — inventory stats only (for dashboard widgets)
 *
 * v2.0.0 Changes:
 *   - Separate /api/inventory/stats endpoint
 *   - Internal-call bypass for role checks
 *   - Exported checkLowStockAlerts() for cron use
 *
 * @version 2.0.0
 */
import { logger } from "../lib/logger.mjs";
import { ts } from "../modules/helpers.mjs";
import { query, queryOne } from "../db-adapter.mjs";

// ─── Internal call detection ────────────────────────────────────────────────
function isInternalCall(req) {
  const addr = req.socket?.remoteAddress || '';
  return req.headers['x-internal-call'] === '1' &&
    (addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1');
}

function computeStatus(item) {
  const safetyStock = item.safety_stock || 1;
  const ratio = (item.quantity || 0) / safetyStock;
  if (ratio <= 0.25) return 'critical';
  if (ratio <= 0.75) return 'low';
  if (ratio >= 1.5) return 'surplus';
  return 'normal';
}

function computeTrend(item) {
  if (!item.last_restocked) return 'stable';
  const daysSinceRestock = (Date.now() - new Date(item.last_restocked).getTime()) / (1000 * 60 * 60 * 24);
  if (daysSinceRestock <= 2) return 'up';
  if (daysSinceRestock >= 7) return 'down';
  return 'stable';
}

function transformItem(row) {
  const status = computeStatus(row);
  const trend = computeTrend(row);
  const dailyConsumption = Math.max(1, Math.round((row.quantity || 0) / 10));
  const daysRemaining = dailyConsumption > 0 ? +((row.quantity || 0) / dailyConsumption).toFixed(1) : 999;
  
  return {
    id: String(row.id),
    product: row.product_name,
    sku: row.sku,
    category: row.category || '未分类',
    region: row.region || 'Global',
    currentStock: row.quantity || 0,
    safetyStock: row.safety_stock || 0,
    dailyConsumption,
    daysRemaining,
    lastRestocked: row.last_restocked || row.recorded_date || '',
    supplier: row.supplier || '未知',
    status,
    trend,
    costPerUnit: row.unit_cost || 0,
    currency: 'USD',
  };
}

/**
 * Compute inventory stats from all items.
 */
async function getInventoryStats() {
  const rows = await query("SELECT * FROM inventory_items ORDER BY id");
  const items = rows.map(transformItem);
  const criticalItems = items.filter(i => i.status === 'critical');
  const lowItems = items.filter(i => i.status === 'low');
  const totalValue = items.reduce((sum, i) => sum + i.currentStock * i.costPerUnit, 0);
  const avgDaysRemaining = items.length > 0
    ? items.reduce((sum, i) => sum + i.daysRemaining, 0) / items.length
    : 0;
  return {
    totalSKUs: items.length,
    criticalCount: criticalItems.length,
    lowCount: lowItems.length,
    totalValue,
    avgDaysRemaining,
    criticalItems: criticalItems.map(i => ({ sku: i.sku, product: i.product, currentStock: i.currentStock, safetyStock: i.safetyStock })),
    lowItems: lowItems.map(i => ({ sku: i.sku, product: i.product, currentStock: i.currentStock, safetyStock: i.safetyStock })),
  };
}

/**
 * Check low stock alerts — called by cron daily.
 * Returns { shouldAlert, stats } if any critical items exist.
 */
export async function checkLowStockAlerts() {
  try {
    const stats = await getInventoryStats();
    return {
      shouldAlert: stats.criticalCount > 0,
      stats,
    };
  } catch (err) {
    logger.error(`[${ts()}] [inventory-api] Alert check error: ${err.message}`);
    return { shouldAlert: false, stats: null, error: err.message };
  }
}

/**
 * Handle inventory API requests.
 */
export async function handleInventoryApi(req, res, options = {}) {
  const urlPath = req.url?.split("?")[0] || "";
  const method = req.method;
  const url = new URL(req.url, "http://localhost");
  
  const sendJson = (statusCode, data) => {
    res.writeHead(statusCode, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };

  // GET /api/inventory/stats — stats only (separate endpoint)
  if (urlPath === "/api/inventory/stats" && method === "GET") {
    try {
      const stats = await getInventoryStats();
      sendJson(200, { stats });
      return true;
    } catch (err) {
      logger.error(`[${ts()}] [inventory-api] Error fetching stats: ${err.message}`);
      sendJson(500, { error: "Failed to fetch inventory stats", detail: err.message });
      return true;
    }
  }

  // GET /api/inventory — list all inventory items with optional filters
  if ((urlPath === "/api/inventory" || urlPath === "/api/inventory/") && method === "GET") {
    try {
      const category = url.searchParams.get("category");
      const region = url.searchParams.get("region");
      const search = url.searchParams.get("search");
      const status = url.searchParams.get("status");
      
      let sql = "SELECT * FROM inventory_items WHERE 1=1";
      const params = [];
      
      if (category && category !== 'all') {
        sql += " AND category = ?";
        params.push(category);
      }
      if (region && region !== 'all') {
        sql += " AND region = ?";
        params.push(region);
      }
      if (search) {
        sql += " AND (product_name LIKE ? OR sku LIKE ?)";
        params.push(`%${search}%`, `%${search}%`);
      }
      
      sql += " ORDER BY recorded_date DESC, id DESC";
      
      const rows = await query(sql, params);
      let items = rows.map(transformItem);
      
      // Post-filter by computed status if requested
      if (status && status !== 'all') {
        items = items.filter(i => i.status === status);
      }
      
      // Compute stats from ALL items (not filtered)
      const allRows = await query("SELECT * FROM inventory_items");
      const allItems = allRows.map(transformItem);
      const criticalItems = allItems.filter(i => i.status === 'critical').length;
      const lowItems = allItems.filter(i => i.status === 'low').length;
      const totalValue = allItems.reduce((sum, i) => sum + i.currentStock * i.costPerUnit, 0);
      const avgDaysRemaining = allItems.length > 0 
        ? allItems.reduce((sum, i) => sum + i.daysRemaining, 0) / allItems.length 
        : 0;
      
      const stats = {
        totalSKUs: allItems.length,
        criticalItems,
        lowItems,
        totalValue,
        avgDaysRemaining,
      };
      
      sendJson(200, { items, stats });
      return true;
    } catch (err) {
      logger.error(`[${ts()}] [inventory-api] Error fetching inventory: ${err.message}`);
      sendJson(500, { error: "Failed to fetch inventory data", detail: err.message });
      return true;
    }
  }

  return false;
}

export default { handleInventoryApi, checkLowStockAlerts };
