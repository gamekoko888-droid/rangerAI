/**
 * Debug script: test each scraper's HTTP response to understand the HTML structure
 * Run: npx tsx server/debug-scraper.ts
 */

async function debugSite(name: string, url: string) {
  console.log(`\n=== ${name} ===`);
  console.log(`URL: ${url}`);
  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Cookie": "currency=USD",
      },
    });
    console.log(`Status: ${resp.status}`);
    const html = await resp.text();
    console.log(`HTML length: ${html.length}`);
    
    // Look for price patterns
    const dollarPrices = html.match(/\$\s*\d+\.\d{2}/g);
    console.log(`Dollar prices found: ${dollarPrices?.length || 0}`);
    if (dollarPrices) {
      console.log(`First 10: ${dollarPrices.slice(0, 10).join(', ')}`);
    }
    
    // Look for S$ prices
    const sgdPrices = html.match(/S\$\s*\d+\.\d{2}/g);
    console.log(`SGD prices found: ${sgdPrices?.length || 0}`);
    if (sgdPrices) {
      console.log(`First 10: ${sgdPrices.slice(0, 10).join(', ')}`);
    }
    
    // Check for Cloudflare challenge
    if (html.includes('challenge-platform') || html.includes('cf-browser-verification')) {
      console.log(`⚠️ CLOUDFLARE CHALLENGE DETECTED`);
    }
    
    // Check for JS rendering markers
    if (html.includes('__NEXT_DATA__') || html.includes('__NUXT__')) {
      console.log(`📦 SSR framework detected`);
    }
    
    // Save first 2000 chars for inspection
    const snippet = html.substring(0, 2000);
    console.log(`\nFirst 2000 chars:\n${snippet}`);
    
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
  }
}

async function main() {
  await debugSite("Eldorado PS", "https://www.eldorado.gg/ea-fc-coins/g/142-0-0?te_v0=PlayStation");
  await debugSite("U7BUY PS", "https://www.u7buy.com/fc26/fc26-coins");
  await debugSite("LootBar PS", "https://lootbar.gg/game-coins/fc26");
  await debugSite("MMOexp PS", "https://www.mmoexp.com/Fc-26/Coins.html");
  await debugSite("LDShop PS", "https://www.ldshop.gg/game-coins/fc-26-coins.html");
}

main();

export {};
