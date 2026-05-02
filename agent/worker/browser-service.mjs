import { classifyBrowserFailure } from './browser-failure-taxonomy.mjs';

const MAX_PAGES = 3;
const TTL_MS = 5 * 60 * 1000;
const sessions = new Map();
let browserPromise = null;

async function getBrowser() {
  try {
    if (!browserPromise) {
      browserPromise = import('puppeteer-core').then(({ default: puppeteer }) => puppeteer.connect({ browserURL: 'http://127.0.0.1:9222' }));
      browserPromise.then((br)=>{ br.on?.('disconnected', ()=>{ browserPromise=null; sessions.clear(); }); });
    }
    return await browserPromise;
  } catch {
    browserPromise = null;
    return null;
  }
}

async function getPage(sessionId = 'default') {
  const now = Date.now();
  for (const [k, v] of sessions) {
    if (now - v.lastUsed > TTL_MS) {
      try { await v.page.close(); } catch {}
      sessions.delete(k);
    }
  }
  if (sessions.has(sessionId)) {
    const s = sessions.get(sessionId); s.lastUsed = now; return s.page;
  }
  const browser = await getBrowser();
  if (!browser) throw new Error('Browser not available');
  if (sessions.size >= MAX_PAGES) {
    const oldest = [...sessions.entries()].sort((a,b)=>a[1].lastUsed-b[1].lastUsed)[0];
    if (oldest) { try { await oldest[1].page.close(); } catch {} sessions.delete(oldest[0]); }
  }
  const page = await browser.newPage();
  sessions.set(sessionId, { page, lastUsed: now });
  return page;
}

function fail(action, err) {
  const c = classifyBrowserFailure({ action, errorMsg: String(err?.message || err) });
  return { success: false, error: 'Browser not available', degraded: true, category: c.category };
}

export async function browserNavigate(sessionId, url) {
  try {
    const page = await getPage(sessionId);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const title = await page.title();
    const text = await page.evaluate(() => (document.body?.innerText || '').slice(0, 2000));
    return { success: true, title, text, url: page.url() };
  } catch (e) { return fail('navigate', e); }
}
export async function browserScreenshot(sessionId) {
  try {
    const page = await getPage(sessionId);
    const vp = page.viewport() || { width: 1280, height: 720 };
    const base64png = await page.screenshot({ encoding: 'base64', fullPage: false });
    return { success: true, base64png, width: vp.width, height: vp.height };
  } catch (e) { return fail('screenshot', e); }
}
export async function browserExtractText(sessionId, selector) {
  try {
    const page = await getPage(sessionId);
    const text = await page.evaluate((sel) => sel ? (document.querySelector(sel)?.innerText || '') : (document.body?.innerText || ''), selector);
    return { success: true, text };
  } catch (e) { return fail('extract_text', e); }
}
export async function browserClick(sessionId, selector) { try { const p=await getPage(sessionId); await p.click(selector); return { success:true }; } catch(e){ return fail('click',e);} }
export async function browserInput(sessionId, selector, text) { try { const p=await getPage(sessionId); await p.focus(selector); await p.keyboard.type(text ?? ''); return { success:true }; } catch(e){ return fail('input',e);} }
export async function browserScroll(sessionId, direction='down', amount=600) { try { const p=await getPage(sessionId); const delta = (direction==='up'?-1:1)*Number(amount||600); await p.evaluate((d)=>window.scrollBy(0,d), delta); return { success:true }; } catch(e){ return fail('scroll',e);} }
export function getPoolStatus() { return { active: sessions.size, idle: 0, total: sessions.size, available: true }; }
