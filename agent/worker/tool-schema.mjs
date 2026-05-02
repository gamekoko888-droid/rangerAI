export function enforceToolSchema(result, schema = {}) {
  if (!schema || Object.keys(schema).length === 0) return result;
  const out = {};
  for (const [k, rule] of Object.entries(schema)) {
    const v = result?.[k];
    if (rule?.required && (v === undefined || v === null)) throw new Error(`schema required field missing: ${k}`);
    if (v !== undefined) out[k] = v;
  }
  return { ...result, ...out };
}
