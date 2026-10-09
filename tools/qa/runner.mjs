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

// Rendering backend: headful Chromium on a private Xvfb display with Mesa llvmpipe via ANGLE-GL is ~1.4x faster
// than headless SwiftShader on this box. Falls back to SwiftShader if Xvfb is unavailable (QA_BACKEND=swiftshader).
let headless = true, glArgs = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
if (process.env.QA_BACKEND !== 'swiftshader' && fs.existsSync('/usr/bin/Xvfb')) {
  const { spawn } = await import('node:child_process');
  const disp = ':' + (90 + (PORT % 9));
  const xvfb = spawn('/usr/bin/Xvfb', [disp, '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'], { stdio: 'ignore', detached: false });
  process.on('exit', () => xvfb.kill());
  await new Promise((r) => setTimeout(r, 800));
  process.env.DISPLAY = disp;
  process.env.GALLIUM_DRIVER = 'llvmpipe';
  headless = false;
  glArgs = ['--use-gl=angle', '--use-angle=gl'];
}
const launchOpts = {
  executablePath: '/opt/pw-browsers/chromium', headless,
  args: [...glArgs, '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--disable-gpu-vsync', '--disable-frame-rate-limit', '--disable-domain-blocking-for-3d-apis'],
};
let browser = null, launching = null;
// Self-healing browser: relaunch if Chromium dies (e.g. renderer OOM-killed by the container memory cap).
async function ensureBrowser() {
  if (browser?.isConnected()) return browser;
  if (!launching) launching = (async () => {
    warm.clear();
    browser = await chromium.launch(launchOpts);
    browser.on('disconnected', () => { log('browser disconnected'); });
    launching = null;
    return browser;
  })();
  return launching;
}

// On shutdown stop claiming at once; in-flight jobs stay in running/ and are re-queued by the next start.
let shuttingDown = false;
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { shuttingDown = true; log('shutting down'); setTimeout(() => process.exit(0), 50); await browser?.close().catch(() => {}); process.exit(0); });
log('browser backend:', headless ? 'swiftshader (headless)' : 'llvmpipe (Xvfb ' + process.env.DISPLAY + ')');

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

// Warm page pool: one loaded game per worker, reused across jobs on the same build snapshot.
const warm = new Map(); // worker -> { page, stamp, W, H, sink }
const current = new Map(); // worker -> page currently in use (also while still loading)
async function getPage(worker, job, buildInfo, result) {
  const W = job.w || 960, H = job.h || 540;
  let w = warm.get(worker);
  const reusable = w && !job.fresh && w.stamp === buildInfo.stamp && w.W === W && w.H === H && !w.page.isClosed();
  if (reusable) {
    w.sink.result = result;
    const ok = await w.page.evaluate(() => {
      try {
        const g = window.__game;
        if (!g?.menu) return false;
        g.started = false; g.paused = true; if (g.match) g.match.state = 'idle';
        if (window.__qaSettings0) { const s0 = structuredClone(window.__qaSettings0); for (const k of Object.keys(g.settings)) delete g.settings[k]; Object.assign(g.settings, s0); }
        g.renderer.applySettings?.(); g.applyLoadoutChange?.();
        for (const gr of g.grenadeObjs || []) g.renderer.scene.remove(gr.mesh);
        if (g.grenadeObjs) g.grenadeObjs.length = 0;
        g.input.down.clear(); g.input.pressed.clear(); g.input.released.clear();
        g.hud?.show(false); g.hud?.scoreboard?.(false);
        return true;
      } catch (e) { return false; }
    }).catch(() => false);
    if (ok) { w.uses = (w.uses || 0) + 1; if (w.uses < 6) { result.warm = true; return w.page; } }
  }
  if (w) { await w.page.close().catch(() => {}); warm.delete(worker); }
  const page = await (await ensureBrowser()).newPage({ viewport: { width: W, height: H } });
  current.set(worker, page);
  page.setDefaultTimeout(300000);
  const sink = { result };
  const CTX_LOST = /CONTEXT_LOST_WEBGL|context could not be created|Could not create a WebGL context|WebGL context was lost|caused context loss|QA: WebGL CONTEXT LOST/i;
  page.on('console', (m) => {
    const r = sink.result; if (!r) return;
    const t = m.text();
    if (CTX_LOST.test(t) && !r.contextLost) r.contextLost = t.slice(0, 200);
    if (m.type() === 'error' || m.type() === 'warning' || r._verbose) r.logs.push(`[${m.type()}] ${t}`.slice(0, 600));
  });
  // Surface context loss from the page itself (three only logs it lazily).
  await page.addInitScript(() => { addEventListener('webglcontextlost', () => console.error('QA: WebGL CONTEXT LOST (webglcontextlost event)'), true); });
  page.on('pageerror', (e) => sink.result?.logs.push('[pageerror] ' + e.message + ' ' + (e.stack || '').split('\n').slice(0, 3).join(' | ')));
  const t0 = Date.now();
  await page.goto(`http://localhost:${PORT}/${buildInfo.stamp}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game?.menu, null, { timeout: 480000 });
  await page.evaluate(() => { window.__qaSettings0 = structuredClone(window.__game.settings); });
  result.loadMs = Date.now() - t0;
  warm.set(worker, { page, stamp: buildInfo.stamp, W, H, sink });
  return page;
}

async function runJob(job, buildInfo, worker = 0) {
  const dir = path.join(RES, job.id);
  fs.mkdirSync(dir, { recursive: true });
  const result = { id: job.id, owner: job.owner, startedAt: new Date().toISOString(), build: { ms: buildInfo.ms }, shots: [], logs: [], data: {} };
  if (!buildInfo.ok) { result.error = 'BUILD FAILED'; result.build.out = buildInfo.out; return result; }
  result._verbose = !!job.verbose;
  let page;
  try {
    page = await getPage(worker, job, buildInfo, result);
    // Simulate n frames on a fixed 50 ms step; only the last `render` frames hit the GPU (SwiftShader is the bottleneck).
    const frames = (n, render = 1) => page.evaluate(([n, render]) => new Promise((r) => {
      window.__qaFixedDt = 0.05;
      let i = 0;
      const f = () => { i++; window.__qaSkipRender = i <= n - render; if (i >= n) { window.__qaSkipRender = false; r(); } else requestAnimationFrame(f); };
      requestAnimationFrame(f);
    }), [n, render]);
    // lofi: cheap functional screenshots (no AO, small shadows, half render scale). Art reviews omit it.
    await page.evaluate((lofi) => {
      const g = window.__game;
      if (lofi) { g.settings.quality = 0; g.settings.renderScale = 0.5; } 
      g.renderer.applySettings?.();
    }, !!job.lofi);
    if (job.setup) await page.evaluate(job.setup);
    if (job.match !== false) {
      await page.evaluate(async (mode) => { const g = window.__game; g.menu.close(); await g.startMatch(mode); g.paused = false; }, job.match || 'tdm');
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
      const tv = Date.now();
      // Optional: fast-forward `sim` seconds of game time without rendering (cheap on SwiftShader).
      if (v.sim) await page.evaluate((sec) => { const g = window.__game, r = g.renderer.render, wp = g.paused; g.renderer.render = () => {}; g.paused = false;
        try { for (let i = 0, n = Math.round(sec * 30); i < n; i++) g.update(1 / 30); } finally { g.renderer.render = r; g.paused = wp; } }, v.sim);
      await frames(v.frames || 8, v.shot === false ? 0 : 1);
      if (v.read) result.data[v.name] = await page.evaluate(v.read); // expression returning JSON-serialisable data
      if (v.shot !== false) {
        const f = `${v.name}.png`;
        await page.screenshot({ path: path.join(dir, f), timeout: 180000 });
        result.shots.push(path.join('tools/qa/results', job.id, f));
      }
      (result.viewMs ||= {})[v.name] = Date.now() - tv;
      result._lastProgressAt = Date.now(); // watchdog liveness: a view just completed
      if (v.release) await page.evaluate((keys) => { const g = window.__game; for (const k of keys) g.input.down.delete(k); }, v.release);
    }
    if (job.script) {
      // Scripts are usually logic: skip GPU work by default (a script can set window.__qaSkipRender=false itself).
      await page.evaluate((render) => { window.__qaFixedDt = 0.05; window.__qaSkipRender = !render; }, !!job.renderScript);
      result.data.script = await page.evaluate(job.script); // async expression string
      await page.evaluate(() => { window.__qaSkipRender = false; });
    }
    result.stats = await page.evaluate(() => {
      const g = window.__game, i = g.renderer.renderer.info;
      return { calls: i.render.calls, tris: i.render.triangles, geos: i.memory.geometries, tex: i.memory.textures };
    });
  } catch (e) {
    result.error = e.message.slice(0, 1000);
  }
  // A lost / uncreatable WebGL context makes every later shader "fail": report the real cause loudly.
  if (result.contextLost) result.error = `WEBGL CONTEXT LOST - results invalid (${result.contextLost})` + (result.error ? ' | ' + result.error : '');
  // Keep the page warm for the next job unless something went wrong.
  if (result.error || job.fresh) { await page?.close().catch(() => {}); warm.delete(worker); }
  delete result._verbose;
  result.finishedAt = new Date().toISOString();
  return result;
}

const RUN = path.join(Q, 'running');
fs.mkdirSync(RUN, { recursive: true });
// Re-queue jobs that were in flight when a previous runner stopped.
for (const f of fs.readdirSync(RUN)) fs.renameSync(path.join(RUN, f), path.join(REQ, f));
const WORKERS = +(process.env.QA_WORKERS || 2);
let buildInfo = null, buildAt = 0, building = null;
// Rebuild only when game sources/assets changed since the last snapshot (keeps warm pages valid).
function sourcesChangedSince(t) {
  const roots = ['src', 'index.html', 'public/assets'].map((r) => path.join(ROOT, r));
  const stack = [...roots];
  while (stack.length) {
    const p = stack.pop();
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (st.mtimeMs > t) return true;
    if (st.isDirectory()) for (const c of fs.readdirSync(p)) stack.push(path.join(p, c));
  }
  return false;
}
async function freshBuild() {
  // One build serves every job claimed within the next 20 s.
  const age = Date.now() - buildAt;
  let changed = false;
  try { changed = sourcesChangedSince(buildAt); } catch { changed = true; }
  // Reuse within 20 s, or while sources are unchanged — but never serve a snapshot older than 5 min.
  if (buildInfo && (age < 20000 || (!changed && age < 300000))) return buildInfo;
  if (!building) {
    // NB: build() is synchronous, so clear `building` only after the promise is stored and settled —
    // clearing it inside the async body (as before) left a resolved promise cached forever (stale snapshots).
    building = (async () => {
      await null;
      log('building snapshot…');
      const b = build();
      log(b.ok ? `build ok ${b.ms}ms` : 'BUILD FAILED');
      buildInfo = b; buildAt = Date.now();
      return b;
    })().finally(() => { building = null; });
  }
  return building;
}
function claim() {
  const files = fs.readdirSync(REQ).filter((f) => f.endsWith('.json')).sort();
  for (const f of files) {
    try { fs.renameSync(path.join(REQ, f), path.join(RUN, f)); return f; } catch { /* taken */ }
  }
  return null;
}
// Is the page still making progress? Samples game/physics counters twice, 5 s apart, reading them under
// Debugger.pause (works whether the page is busy in a long script or idle between rAF frames; a Runtime.evaluate
// would queue behind a running script and block the CDP session).
async function probeLiveness(page) {
  if (!page || page.isClosed()) return { alive: false, why: 'no page' };
  let cdp;
  try {
    cdp = await page.context().newCDPSession(page);
    await cdp.send('Debugger.enable');
    const expr = 'JSON.stringify({ frame: globalThis.__game?.frame ?? null, steps: globalThis.__physInfo?.().steps ?? null })';
    const sample = async () => {
      const paused = new Promise((ok) => cdp.once('Debugger.paused', (e) => ok(e.callFrames)));
      await cdp.send('Debugger.pause');
      const frames = await Promise.race([paused, new Promise((ok) => setTimeout(() => ok(null), 5000))]);
      let v = null;
      const js = frames?.find((f) => f.url && !/wasm/.test(f.url) && !/^\$/.test(f.functionName || '')) || frames?.[0];
      if (js) v = (await cdp.send('Debugger.evaluateOnCallFrame', { callFrameId: js.callFrameId, expression: expr, returnByValue: true, silent: true }).catch(() => null))?.result?.value ?? null;
      await cdp.send('Debugger.resume').catch(() => {});
      return v ? JSON.parse(v) : null;
    };
    const a = await sample();
    await new Promise((r) => setTimeout(r, 5000));
    const b = await sample();
    const df = a && b && a.frame != null ? b.frame - a.frame : null, ds = a && b && a.steps != null ? b.steps - a.steps : null;
    const alive = (df ?? 0) > 0 || (ds ?? 0) > 0;
    return { alive, why: `game frames +${df}, physics steps +${ds} in 5 s`, a, b };
  } catch (e) {
    return { alive: false, why: 'probe failed: ' + e.message };
  } finally { cdp?.detach().catch(() => {}); }
}

async function worker(n) {
  for (;;) {
    if (shuttingDown) return new Promise(() => {});
    const f = claim();
    if (!f) { await new Promise((r) => setTimeout(r, 1500)); continue; }
    const fp = path.join(RUN, f);
    let job;
    try { job = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { fs.renameSync(fp, fp + '.bad'); continue; }
    const b = await freshBuild();
    log(`[w${n}] run`, job.id, 'for', job.owner, 'snapshot', b.stamp);
    // Watchdog: a job that hangs (e.g. an infinite loop inside page.evaluate) must not block a worker forever.
    const limit = (job.timeoutS || 900) * 1000;
    // A page that is merely slow (CPU contention: 10+ min boots and 15-45 s views were seen) must not be reported as
    // hung: the five 'Rapier world.step hangs' of 2026-10-09 were exactly that (each job was still finishing views
    // seconds before the 900 s deadline; re-run with more time they completed). At the deadline we check liveness
    // (a view completed in the last PROGRESS_WINDOW_MS, else game/physics counters sampled 5 s apart) and grant up to
    // MAX_EXTENSIONS extra periods of EXTENSION_MS while the page keeps making progress. job.noExtend disables this.
    const EXTENSION_MS = Math.min(limit, 300000), MAX_EXTENSIONS = job.noExtend ? 0 : 2, PROGRESS_WINDOW_MS = 180000;
    let timer, extensions = 0;
    const r = await Promise.race([
      runJob(job, b, n),
      new Promise((res) => { const onDeadline = async () => {
        // Liveness: a view completed recently (cheap, works while a long view script blocks the page's main thread,
        // when CDP commands can't get through), or the game/physics counters advance under Debugger.pause.
        const res0 = warm.get(n)?.sink?.result;
        const sinceView = res0?._lastProgressAt ? Date.now() - res0._lastProgressAt : null;
        const live = sinceView != null && sinceView < PROGRESS_WINDOW_MS
          ? { alive: true, why: `last view completed ${Math.round(sinceView / 1000)}s ago (${Object.keys(res0.viewMs || {}).length}/${job.views?.length ?? '?'} views done)` }
          : await Promise.race([probeLiveness(warm.get(n)?.page || current.get(n)),
            new Promise((ok) => setTimeout(() => ok({ alive: false, why: `no view completed for ${sinceView == null ? 'the whole job' : Math.round(sinceView / 1000) + 's'} and the liveness probe got no answer in 40 s` }), 40000))]);
        if (live.alive && extensions < MAX_EXTENSIONS) {
          extensions++;
          log(`[w${n}] deadline`, job.id, `reached but page is alive (${live.why}) - extending by ${EXTENSION_MS / 1000}s (${extensions}/${MAX_EXTENSIONS})`);
          const cur = warm.get(n)?.sink?.result;
          if (cur) (cur.extended ||= []).push({ at: new Date().toISOString(), ...live });
          timer = setTimeout(onDeadline, EXTENSION_MS);
          return;
        }
        const total = limit + extensions * EXTENSION_MS;
        log(`[w${n}] TIMEOUT`, job.id, `after ${total / 1000}s - closing its page (liveness: ${live.why})`);
        const w = warm.get(n); warm.delete(n); const partial = w?.sink?.result;
        const hungPage = w?.page || current.get(n);
        // Grab the JS stack of the hung page (Debugger.pause interrupts a busy loop; if nothing is running the
        // page is idle - e.g. waiting for a frame - and we record that instead). Caveat: Chromium may only service
        // Debugger.enable/pause once a long-running evaluate returns, so for a slow (not hung) page the stack is a
        // sample of a LATER rAF frame, not of what was running at the deadline.
        let hangStack = 'no JS running (page idle: likely waiting on requestAnimationFrame / compositor)';
        let hangTrace = null;
        try {
          if (!hungPage) throw new Error('no page (stuck before page creation)');
          const cdp = await hungPage.context().newCDPSession(hungPage);
          await Promise.race([cdp.send('Debugger.enable'), new Promise((_, no) => setTimeout(() => no(new Error('Debugger.enable got no answer in 30 s (main thread stuck in a script CDP cannot interrupt)')), 30000))]);
          let frames = null;
          hangStack = await Promise.race([
            new Promise((ok) => cdp.once('Debugger.paused', (e) => { frames = e.callFrames; ok(e.callFrames.slice(0, 12).map((f) => `${f.functionName || '(anon)'} @ ${(f.url || '').split('/').pop()}:${f.location.lineNumber + 1}:${f.location.columnNumber + 1}`).join(' <- ')); })),
            cdp.send('Debugger.pause').then(() => new Promise((ok) => setTimeout(() => ok(hangStack), 5000))),
          ]);
          // While paused, read the game's physics ring buffer (window.__physTrace, see src/core/Physics.js) and
          // anything else cheap that helps diagnose the hang. Evaluate on a JS frame (wasm frames can't run JS).
          if (frames) {
            const expr = `JSON.stringify({ physTrace: globalThis.__physTrace?.slice?.(-20), physInfo: globalThis.__physInfo?.() })`;
            const jsFrame = frames.find((f) => !/wasm/.test(f.url || '') && !/^\$/.test(f.functionName || '') && f.url);
            try {
              const ev = jsFrame
                ? await cdp.send('Debugger.evaluateOnCallFrame', { callFrameId: jsFrame.callFrameId, expression: expr, returnByValue: true, silent: true })
                : await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, silent: true, timeout: 3000 });
              hangTrace = ev?.result?.value ?? (ev?.exceptionDetails ? 'eval error: ' + JSON.stringify(ev.exceptionDetails).slice(0, 400) : null);
            } catch (e) { hangTrace = 'hangTrace eval failed: ' + e.message; }
            // Physics replay bundle (world snapshot + per-step player pose log, see Physics.reproBundle): replay with
            // `node tools/qa/phys_replay.mjs tools/qa/results/<id>/physRepro.json`.
            try {
              const rx = 'globalThis.__physRepro ? JSON.stringify(globalThis.__physRepro()) : null';
              const ev = jsFrame
                ? await cdp.send('Debugger.evaluateOnCallFrame', { callFrameId: jsFrame.callFrameId, expression: rx, returnByValue: true, silent: true })
                : await cdp.send('Runtime.evaluate', { expression: rx, returnByValue: true, silent: true, timeout: 10000 });
              const v = ev?.result?.value;
              if (v) { fs.mkdirSync(path.join(RES, job.id), { recursive: true }); fs.writeFileSync(path.join(RES, job.id, 'physRepro.json'), v); }
            } catch (e) { log(`[w${n}] physRepro eval failed`, e.message); }
          }
          await cdp.send('Debugger.resume').catch(() => {});
        } catch (e) { hangStack = 'stack capture failed: ' + e.message; }
        log(`[w${n}] ${live.alive ? 'busy (alive, not hung) stack' : 'hang stack'}`, job.id, hangStack.slice(0, 600));
        if (hangTrace) {
          log(`[w${n}] hang trace`, job.id, String(hangTrace).length, 'chars (see result.hangTrace)');
          try { fs.mkdirSync(path.join(RES, job.id), { recursive: true }); fs.writeFileSync(path.join(RES, job.id, 'hangTrace.json'), String(hangTrace)); } catch {}
        }
        if (partial) { partial.hangStack = hangStack; partial.hangTrace = hangTrace; }
        // Resolve BEFORE closing the page so the timeout wins the race (closing makes runJob reject with "closed").
        const hung = !live.alive;
        res({ ...(partial || {}), id: job.id, owner: job.owner, startedAt: partial?.startedAt || new Date(Date.now() - total).toISOString(), finishedAt: new Date().toISOString(), shots: partial?.shots || [], logs: partial?.logs || [], data: partial?.data || {}, hangStack, hangTrace, liveness: live, timedOut: true,
          error: hung ? `TIMEOUT after ${total / 1000}s (page hung - possible infinite loop in game code or job script)`
            : `TIMEOUT after ${total / 1000}s (page still alive and progressing - job too slow for its timeoutS; NOT a hang. The stack below is just where it was busy)` });
        hungPage?.close().catch(() => {});
        // Stuck before the game even booted: the browser itself is wedged - recycle it.
        if (!w) { log(`[w${n}] page never booted - recycling browser`); warm.clear(); browser?.close().catch(() => {}); browser = null; }
      }; timer = setTimeout(onDeadline, limit); }),
    ]);
    clearTimeout(timer);
    if (shuttingDown) return new Promise(() => {}); // leave it in running/; the next start re-queues it
    // Browser died mid-job (OOM etc.): re-queue once instead of failing the requester.
    if (r.error && !r.timedOut && /has been closed|Target crashed|disconnected|Browser closed/i.test(r.error) && (job._retries || 0) < 2) {
      job._retries = (job._retries || 0) + 1;
      warm.delete(n);
      fs.writeFileSync(path.join(REQ, f), JSON.stringify(job));
      fs.unlinkSync(fp);
      log(`[w${n}] browser lost during`, job.id, '- re-queued (retry', job._retries + ')');
      await new Promise((res) => setTimeout(res, 3000));
      continue;
    }
    fs.mkdirSync(path.join(RES, job.id), { recursive: true });
    fs.writeFileSync(path.join(RES, job.id, 'job.json'), JSON.stringify(job)); // lets anyone re-submit it
    // Context loss can poison the whole browser (Chrome blocks 3D APIs per origin), and a boot that never reaches the
    // menu means the browser/GPU process is wedged: recycle it in both cases.
    if (!r.contextLost && !r.loadMs && /waitForFunction: Timeout/.test(r.error || '')) r.contextLost = 'boot timeout (browser wedged?)';
    if (r.contextLost) { log(`[w${n}] WebGL context lost in`, job.id, '- recycling browser'); warm.clear(); await browser?.close().catch(() => {}); browser = null; }
    fs.writeFileSync(path.join(RES, job.id, 'result.json'), JSON.stringify(r, null, 2));
    fs.unlinkSync(fp);
    log(`[w${n}] done`, job.id, r.error ? 'ERROR ' + r.error.split('\n')[0] : 'ok', `${Math.round((Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000)}s`);
  }
}
log(`QA runner ready (${WORKERS} workers); waiting for jobs in`, REQ);
await Promise.all(Array.from({ length: WORKERS }, (_, i) => worker(i + 1)));
