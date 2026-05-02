import test from 'node:test';
import assert from 'node:assert/strict';
import { enforceToolSchema } from '../../worker/tool-schema.mjs';
import { checkRateLimit } from '../../modules/rate-limit-session.mjs';
import { setToolCache, getToolCache, getToolCacheStats } from '../../worker/tool-cache.mjs';

test('v6 chat flow primitives', async () => {
  const shaped = enforceToolSchema({ ok: true }, { ok: { required: true } });
  assert.equal(shaped.ok, true);
  const rl1 = checkRateLimit('v6-user', 2, 60000);
  const rl2 = checkRateLimit('v6-user', 2, 60000);
  const rl3 = checkRateLimit('v6-user', 2, 60000);
  assert.equal(rl1.allowed, true);
  assert.equal(rl2.allowed, true);
  assert.equal(rl3.allowed, false);
  setToolCache("v6","A",{ok:true});
  const c1=getToolCache("v6","a");
  assert.equal(c1.ok, true);
  const st=getToolCacheStats();
  assert.equal(typeof st.hit, "number");
});
