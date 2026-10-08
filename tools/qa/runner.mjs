// Central QA runner: ONE browser + ONE static server for the whole team.
// Engineers enqueue jobs with tools/qa/submit.mjs; the runner builds a snapshot of the shared tree
// (vite build), then executes queued jobs serially and writes results to tools/qa/results/<id>/.
// Start once:  node tools/qa/runner.mjs   (keeps running)
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const Q = path.join(ROOT, 'tools/qa');
const REQ = path.join(Q, 'requests'), RES = path.join(Q, 'results'), BUILD = path.join(Q, 'build');
for (const d of [REQ, RES]) fs.mkdirSync(d, { recursive: true });
const PORT = +(process.env.QA_PORT || 5300);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// --- static server for the built snapshot ---
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream',
  '.hdr': 'application/octet-stream', '.ogg': 'audio/ogg', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml' };
http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  const f = path.join(BUILD, p.endsWith('/') ? p + 'index.html' : p);
  if (!f.startsWith(BUILD) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}).listen(PORT, () => log('QA server on', PORT));

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});

function build() {
  // Each snapshot gets its own directory so in-flight jobs keep a consistent build.
  const t = Date.now();
  const stamp = String(t);
  const out = path.join(BUILD, stamp);
  const r = spawnSync('npx', ['vite', 'build', '--outDir', out, '--emptyOutDir', '--logLevel', 'error'], { cwd: ROOT, encoding: 'utf8' });
  const olds = fs.existsSync(BUILD) ? fs.readdirSync(BUILD).sort() : [];
  for (const o of olds.slice(0, Math.max(0, olds.length - 4))) fs.rmSync(path.join(BUILD, o), { recursive: true, force: true });
  return { ok: r.status === 0, ms: Date.now() - t, out: (r.stdout + r.stderr).slice(-4000), stamp };
}

async function runJob(job, buildInfo) {
  const dir = path.join(RES, job.id);
  fs.mkdirSync(dir, { recursive: true });
  const result = { id: job.id, owner: job.owner, startedAt: new Date().toISOString(), build: { ms: buildInfo.ms }, shots: [], logs: [], data: {} };
  if (!buildInfo.ok) { result.error = 'BUILD FAILED'; result.build.out = buildInfo.out; return result; }
  const W = job.w || 960, H = job.h || 540;
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  page.setDefaultTimeout(300000);
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning' || job.verbose) result.logs.push(`[${m.type()}] ${m.text()}`.slice(0, 600)); });
  page.on('pageerror', (e) => result.logs.push('[pageerror] ' + e.message + ' ' + (e.stack || '').split('\n').slice(0, 3).join(' | ')));
  try {
    const t0 = Date.now();
    await page.goto(`http://localhost:${PORT}/${buildInfo.stamp}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__game?.menu, null, { timeout: 240000 });
    result.loadMs = Date.now() - t0;
    const frames = (n) => page.evaluate((n) => new Promise((r) => { let i = 0; const f = () => (++i >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
    if (job.setup) await page.evaluate(job.setup);
    if (job.match !== false) {
      await page.evaluate((mode) => { const g = window.__game; g.menu.close(); g.startMatch(mode); g.paused = false; }, job.match || 'tdm');
      await frames(10);
    }
    for (const v of job.views || []) {
      await page.evaluate((v) => {
        const g = window.__game, p = g.player;
        if (v.pos) { p.position.set(v.pos[0], v.pos[1], v.pos[2]); p.velocity.set(0, 0, 0); p._syncBody(); }
        if (v.yaw !== undefined) p.yaw = v.yaw;
        if (v.pitch !== undefined) p.pitch = v.pitch;
        if (v.weapon !== undefined) g.switchSlot(v.weapon);
        const set = (code, on) => (on ? g.input.down.add(code) : g.input.down.delete(code));
        set('Mouse2', !!v.ads);
        if (v.fire) { g.input.down.add('Mouse0'); g.input.pressed.add('Mouse0'); } else g.input.down.delete('Mouse0');
        if (v.reload) g.input.pressed.add('KeyR');
        set('ShiftLeft', !!v.sprint); set('KeyW', !!v.sprint || !!v.forward);
        for (const k of v.keys || []) { g.input.down.add(k); g.input.pressed.add(k); }
        if (v.eval) (0, eval)(v.eval);
      }, v);
      await frames(v.frames || 8);
      if (v.read) result.data[v.name] = await page.evaluate(v.read); // expression returning JSON-serialisable data
      if (v.shot !== false) {
        const f = `${v.name}.png`;
        await page.screenshot({ path: path.join(dir, f), timeout: 180000 });
        result.shots.push(path.join('tools/qa/results', job.id, f));
      }
      if (v.release) await page.evaluate((keys) => { const g = window.__game; for (const k of keys) g.input.down.delete(k); }, v.release);
    }
    if (job.script) result.data.script = await page.evaluate(job.script); // async expression string
    result.stats = await page.evaluate(() => {
      const g = window.__game, i = g.renderer.renderer.info;
      return { calls: i.render.calls, tris: i.render.triangles, geos: i.memory.geometries, tex: i.memory.textures };
    });
  } catch (e) {
    result.error = e.message.slice(0, 1000);
  }
  await page.close();
  result.finishedAt = new Date().toISOString();
  return result;
}

const RUN = path.join(Q, 'running');
fs.mkdirSync(RUN, { recursive: true });
// Re-queue jobs that were in flight when a previous runner stopped.
for (const f of fs.readdirSync(RUN)) fs.renameSync(path.join(RUN, f), path.join(REQ, f));
const WORKERS = +(process.env.QA_WORKERS || 2);
let buildInfo = null, buildAt = 0, building = null;
async function freshBuild() {
  // One build serves every job claimed within the next 20 s.
  if (buildInfo && Date.now() - buildAt < 20000) return buildInfo;
  if (!building) building = (async () => {
    log('building snapshot…');
    const b = build();
    log(b.ok ? `build ok ${b.ms}ms` : 'BUILD FAILED');
    buildInfo = b; buildAt = Date.now(); building = null;
    return b;
  })();
  return building;
}
function claim() {
  const files = fs.readdirSync(REQ).filter((f) => f.endsWith('.json')).sort();
  for (const f of files) {
    try { fs.renameSync(path.join(REQ, f), path.join(RUN, f)); return f; } catch { /* taken */ }
  }
  return null;
}
async function worker(n) {
  for (;;) {
    const f = claim();
    if (!f) { await new Promise((r) => setTimeout(r, 1500)); continue; }
    const fp = path.join(RUN, f);
    let job;
    try { job = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { fs.renameSync(fp, fp + '.bad'); continue; }
    const b = await freshBuild();
    log(`[w${n}] run`, job.id, 'for', job.owner);
    const r = await runJob(job, b);
    fs.mkdirSync(path.join(RES, job.id), { recursive: true });
    fs.writeFileSync(path.join(RES, job.id, 'result.json'), JSON.stringify(r, null, 2));
    fs.unlinkSync(fp);
    log(`[w${n}] done`, job.id, r.error ? 'ERROR ' + r.error.split('\n')[0] : 'ok', `${Math.round((Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000)}s`);
  }
}
log(`QA runner ready (${WORKERS} workers); waiting for jobs in`, REQ);
await Promise.all(Array.from({ length: WORKERS }, (_, i) => worker(i + 1)));
