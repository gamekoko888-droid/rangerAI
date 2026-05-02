import fs from 'fs';
const payload = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!payload?.files || (Array.isArray(payload.files) && payload.files.length===0)) { throw new Error('payload.files required'); }
const resp = await fetch('https://ranger.voyage/codex-deploy/apply-patch', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)});
const text = await resp.text();
let parsed=null; try { parsed=JSON.parse(text);} catch {}
console.log(JSON.stringify({ status: resp.status, ok: resp.ok, hasJson: !!parsed, body: (parsed||text).toString?.().slice?.(0,500) || text.slice(0,500) }, null, 2));
if (!resp.ok) process.exit(1);
