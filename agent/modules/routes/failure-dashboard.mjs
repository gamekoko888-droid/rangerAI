export function buildFailureSummary(rows = []){
  const byType = {};
  for (const r of rows){ const t=r.type||'unknown'; byType[t]=(byType[t]||0)+1; }
  return { total: rows.length, byType };
}
