/**
 * Find API endpoints for each site by analyzing HTML/JS
 */

async function findU7buyPrices() {
  console.log("\n=== U7BUY: Extracting from __NUXT_DATA__ ===");
  const resp = await fetch('https://www.u7buy.com/fc26/fc26-coins', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  });
  const html = await resp.text();
  
  const nuxtMatch = html.match(/<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!nuxtMatch) { console.log("No NUXT data"); return; }
  
  const data = JSON.parse(nuxtMatch[1]);
  // Find coins/list data - look for price structures
  const dataStr = JSON.stringify(data);
  
  // Find "coins/list" key and extract nearby data
  const coinsIdx = data.indexOf("coins/list");
  if (coinsIdx >= 0) {
    console.log("coins/list found at index:", coinsIdx);
    // The value should be at the next index
    const listRef = data[coinsIdx + 1];
    console.log("List ref:", typeof listRef, JSON.stringify(listRef).substring(0, 200));
  }
  
  // Search for price-like objects
  for (let i = 0; i < data.length; i++) {
    const item = data[i];
    if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
      const keys = Object.keys(item);
      if (keys.includes('price') || keys.includes('salePrice') || keys.includes('originalPrice')) {
        console.log(`Index ${i}:`, JSON.stringify(item).substring(0, 300));
      }
    }
  }
  
  // Also try the prod-api
  console.log("\n--- Trying U7BUY prod-api ---");
  try {
    const apiResp = await fetch('https://www.u7buy.com/prod-api/product/spu/coins/list?gameCode=fc26&platformId=', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    console.log("API status:", apiResp.status);
    if (apiResp.ok) {
      const apiData = await apiResp.json();
      console.log("API response:", JSON.stringify(apiData).substring(0, 500));
    }
  } catch (e: any) {
    console.log("API error:", e.message);
  }
}

async function findLootbarPrices() {
  console.log("\n=== LootBar: Finding API ===");
  // LootBar is a React app, try common API patterns
  const apiUrls = [
    'https://lootbar.gg/api/game-coins/fc26',
    'https://api.lootbar.gg/game-coins/fc26',
    'https://lootbar.gg/api/v1/products?game=fc26',
  ];
  
  for (const url of apiUrls) {
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
      });
      console.log(`${url} → ${resp.status}`);
      if (resp.ok) {
        const text = await resp.text();
        console.log("Response:", text.substring(0, 500));
      }
    } catch (e: any) {
      console.log(`${url} → Error: ${e.message}`);
    }
  }
  
  // Check the HTML for API base URL
  const resp = await fetch('https://lootbar.gg/game-coins/fc26', {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  const html = await resp.text();
  
  // Find script sources
  const scripts = html.match(/src="([^"]*\.js[^"]*)"/g);
  if (scripts) {
    console.log("JS files:", scripts.slice(0, 5).join('\n'));
  }
  
  // Find any inline JSON or API references
  const apiRefs = html.match(/["']\/api\/[^"'\s]+["']/g);
  if (apiRefs) console.log("API refs:", Array.from(new Set(apiRefs)).join(', '));
  
  const baseUrls = html.match(/["'](https?:\/\/[^"'\s]*api[^"'\s]*)["']/gi);
  if (baseUrls) console.log("Base URLs:", Array.from(new Set(baseUrls)).slice(0, 10).join('\n'));
}

async function findEldoradoPrices() {
  console.log("\n=== Eldorado: Finding API ===");
  // Eldorado is a React SPA, likely has an API
  const resp = await fetch('https://www.eldorado.gg/ea-fc-coins/g/142-0-0?te_v0=PlayStation', {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': 'currency=USD' }
  });
  const html = await resp.text();
  
  // Find API references
  const apiRefs = html.match(/["'](https?:\/\/[^"'\s]*(?:api|graphql)[^"'\s]*)["']/gi);
  if (apiRefs) console.log("API refs:", Array.from(new Set(apiRefs)).slice(0, 10).join('\n'));
  
  // Find script bundles
  const scripts = html.match(/src="([^"]*(?:main|app|chunk)[^"]*\.js[^"]*)"/g);
  if (scripts) console.log("Main JS:", scripts.slice(0, 5).join('\n'));
  
  // Try common API patterns
  const tryUrls = [
    'https://www.eldorado.gg/api/offers?game=ea-fc-coins&platform=PlayStation',
    'https://api.eldorado.gg/v1/offers?game_id=142',
  ];
  for (const url of tryUrls) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      console.log(`${url} → ${r.status}`);
      if (r.ok) console.log(await r.text().then(t => t.substring(0, 300)));
    } catch (e: any) {
      console.log(`${url} → ${e.message}`);
    }
  }
}

async function findMmoexpPrices() {
  console.log("\n=== MMOexp: Finding API ===");
  const resp = await fetch('https://www.mmoexp.com/Fc-26/Coins.html', {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  const html = await resp.text();
  
  // MMOexp uses jQuery AJAX - find the API endpoint
  const ajaxCalls = html.match(/\$\.(?:ajax|get|post)\s*\(\s*["']([^"']+)["']/g);
  if (ajaxCalls) console.log("AJAX calls:", ajaxCalls.join('\n'));
  
  // Find URL patterns
  const urlPatterns = html.match(/["']\/(?:api|ajax|goods)[^"'\s]*["']/g);
  if (urlPatterns) console.log("URL patterns:", Array.from(new Set(urlPatterns)).join('\n'));
  
  // Find currencyCode and price data
  const currencyMatch = html.match(/currencyCode\s*=\s*["']([^"']+)["']/);
  if (currencyMatch) console.log("Currency:", currencyMatch[1]);
  
  // Find goods data
  const goodsMatch = html.match(/var\s+(?:goods|product|item)\w*\s*=\s*(\{[^;]+\})/);
  if (goodsMatch) console.log("Goods data:", goodsMatch[1].substring(0, 300));
  
  // Find script tags with price data
  const inlineScripts = html.match(/<script[^>]*>([^<]*(?:price|gold|coins)[^<]*)<\/script>/gi);
  if (inlineScripts) {
    for (const s of inlineScripts.slice(0, 3)) {
      const content = s.replace(/<[^>]+>/g, '').substring(0, 500);
      if (content.length > 20) console.log("Script with price:", content);
    }
  }
}

async function findLdshopPrices() {
  console.log("\n=== LDShop: Finding API ===");
  // LDShop uses Nuxt and has api.ldshop.gg
  const tryUrls = [
    'https://api.ldshop.gg/api/v1/product/game-coins/fc-26',
    'https://api.ldshop.gg/api/product/fc-26-coins',
    'https://api.ldshop.gg/v1/game-coins/fc-26-coins',
  ];
  
  for (const url of tryUrls) {
    try {
      const r = await fetch(url, { 
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } 
      });
      console.log(`${url} → ${r.status}`);
      if (r.ok) console.log(await r.text().then(t => t.substring(0, 500)));
    } catch (e: any) {
      console.log(`${url} → ${e.message}`);
    }
  }
  
  // Check the HTML for __NUXT_DATA__
  const resp = await fetch('https://www.ldshop.gg/game-coins/fc-26-coins.html', {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  const html = await resp.text();
  
  const nuxtMatch = html.match(/<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nuxtMatch) {
    console.log("Found __NUXT_DATA__, length:", nuxtMatch[1].length);
    const data = JSON.parse(nuxtMatch[1]);
    // Search for price data
    for (let i = 0; i < Math.min(data.length, 2000); i++) {
      const item = data[i];
      if (typeof item === 'string' && (item.includes('price') || item.includes('Price'))) {
        console.log(`Index ${i}: "${item}"`);
      }
    }
  }
  
  // Find API base
  const apiBase = html.match(/https:\/\/api\.ldshop\.gg[^"'\s]*/g);
  if (apiBase) console.log("API base URLs:", Array.from(new Set(apiBase)).slice(0, 10).join('\n'));
}

async function main() {
  await findU7buyPrices();
  await findLootbarPrices();
  await findEldoradoPrices();
  await findMmoexpPrices();
  await findLdshopPrices();
}

main().catch(console.error);

export {};
