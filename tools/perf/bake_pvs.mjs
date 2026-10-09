// Bake the precomputed visibility set (PVS) for the level. Runs inside the game through the shared QA runner
// (it needs the real level + physics), in parallel chunks of cells, then merges, dilates and writes
// public/assets/pvs/level.json. See src/render/Pvs.js and docs/PERF.md.
//   node tools/perf/bake_pvs.mjs [--jobs 8]
// Re-run whenever level geometry or prop placement changes (the runtime disables the PVS on a hash mismatch).
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const src = fs.readFileSync(path.join(ROOT, 'src/render/Pvs.js'), 'utf8');
const grid = JSON.parse(src.match(/export const PVS_GRID = (\{[^}]+\})/)[1].replace(/(\w+):/g, '"$1":'));
const nJobs = +(process.argv[process.argv.indexOf('--jobs') + 1] || 8) || 8;
const total = grid.nx * grid.nz * grid.ny;
const cells = [...Array(total).keys()];
const REQ = path.join(ROOT, 'tools/qa/requests'), RES = path.join(ROOT, 'tools/qa/results');
const stamp = Date.now();
const ids = [];
for (let j = 0; j < nJobs; j++) {
  const part = cells.filter((c) => c % nJobs === j);
  const id = `${stamp}_perf_pvsbake${j}`;
  const job = {
    id, owner: 'perf', match: false, w: 320, h: 180, fresh: j === 0,
    script: `(()=>{const L=window.__pvsLib,g=window.__game;const {hash}=L.pvsTargets(g.level);const t0=performance.now();const r=L.bakePvsCells(g,${JSON.stringify(part)});return {hash,targets:r.targets,out:r.out,ms:performance.now()-t0};})()`,
  };
  fs.writeFileSync(path.join(REQ, id + '.json.tmp'), JSON.stringify(job));
  fs.renameSync(path.join(REQ, id + '.json.tmp'), path.join(REQ, id + '.json'));
  ids.push(id);
}
console.log(`submitted ${nJobs} jobs for ${total} cells`);
const results = [];
for (const id of ids) {
  const f = path.join(RES, id, 'result.json');
  while (!fs.existsSync(f)) await new Promise((r) => setTimeout(r, 3000));
  const r = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (r.error || !r.data?.script) throw new Error(`${id}: ${r.error || 'no data'}`);
  console.log(`${id}: ${Object.keys(r.data.script.out).length} cells in ${Math.round(r.data.script.ms / 1000)} s`);
  results.push(r.data.script);
}
const { hash, targets } = results[0];
if (results.some((r) => r.hash !== hash || r.targets !== targets)) throw new Error('inconsistent level between jobs');
const rowBytes = Math.ceil(targets / 8);
const raw = new Array(total).fill(null);
for (const r of results) for (const [c, b64] of Object.entries(r.out)) raw[+c] = b64 === null ? null : Buffer.from(b64, 'base64');
// Dilate: a cell sees what any of its 8 neighbours (same storey) sees — covers the camera between eye samples.
const dil = raw.map((row, c) => {
  if (!row) return null;
  const ix = c % grid.nx, iz = Math.floor(c / grid.nx) % grid.nz, iy = Math.floor(c / (grid.nx * grid.nz));
  const out = Buffer.from(row);
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    const x = ix + dx, z = iz + dz;
    if (x < 0 || z < 0 || x >= grid.nx || z >= grid.nz) continue;
    const n = raw[(iy * grid.nz + z) * grid.nx + x];
    if (n) for (let i = 0; i < rowBytes; i++) out[i] |= n[i];
  }
  return out;
});
// Deduplicate rows.
const uniq = new Map(), rows = [], cellRow = [];
for (const row of dil) {
  if (!row) { cellRow.push(-1); continue; }
  const k = row.toString('base64');
  if (!uniq.has(k)) { uniq.set(k, rows.length); rows.push(row); }
  cellRow.push(uniq.get(k));
}
const outFile = path.join(ROOT, 'public/assets/pvs/level.json');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify({ version: 1, hash, targets, grid, rows: Buffer.concat(rows).toString('base64'), cellRow }));
const vis = dil.filter(Boolean).map((r) => { let n = 0; for (const b of r) for (let k = 0; k < 8; k++) n += (b >> k) & 1; return n; });
console.log(`wrote ${outFile}: ${targets} targets, ${rows.length} unique rows, ${(fs.statSync(outFile).size / 1024).toFixed(0)} KB; ` +
  `mean visible ${(vis.reduce((a, b) => a + b, 0) / vis.length).toFixed(0)}/${targets}, cells without data ${cellRow.filter((x) => x < 0).length}`);
