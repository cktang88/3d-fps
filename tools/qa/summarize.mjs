// Summarise QA results: errors, grouped console messages, perf budget violations, script fails.
// Usage: node tools/qa/summarize.mjs <result-id|dir> [...]
import fs from 'node:fs';
import path from 'node:path';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const BUDGET = { calls: 400, tris: 1.2e6, loadMs: 20000 };
for (const a of process.argv.slice(2)) {
  const dir = fs.existsSync(a) ? a : path.join(ROOT, 'tools/qa/results', a);
  const r = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
  console.log(`== ${r.id} (${r.owner}) ${r.startedAt?.slice(11, 19)}-${r.finishedAt?.slice(11, 19)} warm=${!!r.warm} load=${r.loadMs ?? '-'}ms shots=${r.shots.length}`);
  if (r.error) console.log('  ERROR', r.error.split('\n')[0]);
  if (!r.warm && r.loadMs > BUDGET.loadMs) console.log(`  PERF load ${r.loadMs} ms > ${BUDGET.loadMs}`);
  const g = {};
  for (const l of r.logs) { const k = l.replace(/0x[0-9a-f]+/g, '').replace(/\d{6,}/g, '#').slice(0, 140); g[k] = (g[k] || 0) + 1; }
  for (const [k, n] of Object.entries(g)) console.log(`  LOG x${n} ${k}`);
  const walk = (o, p = '') => {
    if (!o || typeof o !== 'object') return;
    if ('calls' in o && 'tris' in o && (o.calls > BUDGET.calls || o.tris > BUDGET.tris)) console.log(`  PERF ${p}: ${o.calls} calls / ${(o.tris / 1e6).toFixed(2)}M tris`);
    if (Array.isArray(o.fails) && o.fails.length) for (const f of o.fails) console.log(`  FAIL ${p}: ${f}`);
    for (const [k, v] of Object.entries(o)) if (v && typeof v === 'object' && k !== 'fails') walk(v, p ? `${p}.${k}` : k);
  };
  walk(r.data);
}
