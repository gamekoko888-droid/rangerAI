export async function withSpan(name, fn, attrs = {}) {
  const start = Date.now();
  try { const res = await fn(); return res; }
  finally { const ms = Date.now() - start; console.log(`[otel-lite] span=${name} duration_ms=${ms} attrs=${JSON.stringify(attrs)}`); }
}
