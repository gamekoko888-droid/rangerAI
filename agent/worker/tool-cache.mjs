let _metricHook = null;
export function onToolCacheMetric(fn){ _metricHook = fn; }
const cacheStats = { hit: 0, miss: 0 };
const store = new Map();
function normalizeKey(k){ return String(k||"" ).trim().toLowerCase(); }
export function getToolCache(sessionKey, key) { const v=store.get(`${sessionKey}:${normalizeKey(key)}`) ?? null; if(v===null){ cacheStats.miss++; _metricHook?.({type:"miss", key:normalizeKey(key)});} else { cacheStats.hit++; _metricHook?.({type:"hit", key:normalizeKey(key)});} return v; }
export function setToolCache(sessionKey, key, value, ttlMs = 300000) { const k=`${sessionKey}:${normalizeKey(key)}`; store.set(k, value); setTimeout(()=>store.delete(k), ttlMs).unref?.(); }

export function getToolCacheStats(){ return { ...cacheStats, size: store.size }; }
