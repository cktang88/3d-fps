// Bake the Recast navmesh into public/assets/nav/level.{bin,json} (perf: skips navmesh generation at boot).
// Runs inside the game via the shared QA runner (needs the real level). Re-run when level geometry changes; the
// runtime ignores a bake whose input hash doesn't match (src/game/bots/Navigation.js).
//   node tools/perf/bake_nav.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const id = `${Date.now()}_perf_navbake`;
const job = {
  id, owner: 'perf', match: false, w: 320, h: 180, fresh: true,
  // Rebuild in-page (the page may have loaded a stale bake), then export.
  script: `(()=>{const n=window.__game.nav;n.build();const {hash,bin}=n.exportBaked();let s='';for(let i=0;i<bin.length;i+=0x8000)s+=String.fromCharCode.apply(null,bin.subarray(i,i+0x8000));return {hash,b64:btoa(s),ms:n.buildTime};})()`,
};
const REQ = path.join(ROOT, 'tools/qa/requests');
fs.writeFileSync(path.join(REQ, id + '.json.tmp'), JSON.stringify(job));
fs.renameSync(path.join(REQ, id + '.json.tmp'), path.join(REQ, id + '.json'));
const f = path.join(ROOT, 'tools/qa/results', id, 'result.json');
while (!fs.existsSync(f)) await new Promise((r) => setTimeout(r, 3000));
const r = JSON.parse(fs.readFileSync(f, 'utf8'));
if (r.error || !r.data?.script) throw new Error(r.error || 'no data');
const { hash, b64, ms } = r.data.script;
const out = path.join(ROOT, 'public/assets/nav');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'level.bin'), Buffer.from(b64, 'base64'));
fs.writeFileSync(path.join(out, 'level.json'), JSON.stringify({ hash, builtMs: Math.round(ms), at: new Date().toISOString() }));
console.log(`navmesh baked: ${(Buffer.from(b64, 'base64').length / 1024).toFixed(0)} KB, hash ${hash} (build took ${Math.round(ms)} ms)`);
