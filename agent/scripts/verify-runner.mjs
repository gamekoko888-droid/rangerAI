#!/usr/bin/env node
import { execSync } from 'child_process';
const checks = [
  { name: 'quality_gate', cmd: 'node agent/scripts/r121-quality-gate.mjs' },
  { name: 'v6_integration', cmd: 'node --test agent/tests/integration/v6-chat-flow.integration.test.mjs' },
];
const results=[];
for (const c of checks) {
  try { execSync(c.cmd, { stdio: 'pipe' }); results.push({ name:c.name, pass:true }); }
  catch (e) { results.push({ name:c.name, pass:false, error:String(e.message||e) }); }
}
const pass = results.every(r => r.pass);
console.log(JSON.stringify({ pass, results, ts: Date.now() }, null, 2));
process.exit(pass ? 0 : 1);
