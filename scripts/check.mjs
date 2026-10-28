// Sanity checks: matcher picks the right SKU for each written line, and every demo
// fixture still validates against the current product master.   npm test
import assert from 'node:assert/strict';
import { fixtures } from '../lib/demo.mjs';
import { finalizeOrder, runTool } from '../lib/tools.mjs';

const expectTop = {
  '六角ボルト M8×30': 'YB-0830',
  '六ボル M10-30': 'YB-1030',
  'SUS六角ボルト M10×40': 'SB-1040',
  'ステンナット M10': 'SN-10',
  'キャップボルト M6×20': 'CB-0620',
  'コーススレッド 4.2×51': 'CS-4251',
  'ﾅｯﾄ M8': 'HN-08',
};
for (const [q, sku] of Object.entries(expectTop)) {
  const r = runTool('search_products', { query: q });
  assert.equal(r.candidates[0].sku, sku, `search "${q}" → ${r.candidates[0].sku}, expected ${sku}`);
}
assert.equal(runTool('search_products', { query: 'ワッシャー M10' }).ambiguous, true, '"ワッシャー M10" should be ambiguous');
assert.equal(runTool('search_products', { query: '六角ボルト M8×30' }).ambiguous, false);
assert.equal(runTool('search_products', { query: 'SUS六角ボルト M10×40' }).ambiguous, false);
assert.equal(runTool('lookup_customer', { fax_or_name: '06 6728 9902' }).customer.id, 'C003');
assert.equal(runTool('lookup_customer', { fax_or_name: '森田工務店' }).customer.id, 'C002');
assert.equal(runTool('check_stock', { sku: 'SB-1040', qty: 3 }).available, false);
assert.equal(runTool('propose_substitute', { sku: 'SB-1040', qty: 3 }).substitutes[0].sku, 'SB-1045');

for (const fx of fixtures.values()) {
  for (const step of fx.script) {
    const r = runTool(step.tool, step.args);
    assert.ok(!r.error, `${fx.sample}: ${step.tool} → ${r.error}`);
  }
  const res = finalizeOrder(fx.final);
  assert.ok(res.ok, `${fx.sample}: ${res.errors.join('; ')}`);
  for (const l of res.order.lines) assert.deepEqual(l.server_flags, [], `${fx.sample} line ${l.line_no}: ${l.server_flags}`);
}
console.log(`ok — matcher checks and ${fixtures.size} fixtures valid`);
