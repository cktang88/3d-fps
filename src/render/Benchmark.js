import { QUALITY_PRESETS } from './Renderer.js';

/**
 * Built-in graphics benchmark (render owner). Settings → "Run graphics benchmark".
 *
 * A fixed camera tour (5 standard views, slow pan each, ADS with a magnified optic on the last one so the scope PiP
 * renders) is replayed once per step. Each step changes ONE feature on top of the player's current settings
 * (Renderer.bench overrides), waits for shaders to compile and the frame time to settle, then measures:
 *   - frame ms (rAF wall time, mean + p95) and fps,
 *   - main-thread ms inside game.update (simulation + GL submission; a GPU→CPU sync stall shows up here),
 *   - GPU ms per pass via EXT_disjoint_timer_query_webgl2 when available,
 *   - draw calls and shader-program count (a growing count = recompiles).
 * Results: an on-screen table with "Copy results" (plain-text table for pasting into a bug report).
 */

const VIEWS = [
  { pos: [0, 0, 20], yaw: 0.3, pitch: 0.02 },     // courtyard
  { pos: [2, 0, -8], yaw: 2.68, pitch: 0.06 },    // toward the sun
  { pos: [13, 0, -35], yaw: 1.57, pitch: 0.12 },  // warehouse
  { pos: [37, 0, 4], yaw: 0.1, pitch: 0.03 },     // containers
  { pos: [0, 0.1, 10], yaw: 0.15, pitch: 0.02, ads: true }, // scope ADS
];

const ALL_OFF = {
  ao: null, godRays: 0, bloom: false, lens: false, shadow: 0, probe: 0, vmShadow: 0, lights: 2, pip: 0,
  unify: 'off', fog: false, renderScale: 0.5, smaa: false, particles: false,
};

export const BENCH_STEPS = [
  { name: 'Baseline (current settings)', o: {} },
  { name: 'No N8AO (ambient occlusion)', o: { ao: null } },
  { name: 'No god rays', o: { godRays: 0 } },
  { name: 'No bloom / lens', o: { bloom: false, lens: false } },
  { name: 'Shadows off', o: { shadow: 0 } },
  { name: 'Shadow map 1024', o: { shadow: 1024 } },
  { name: 'Shadow map 1024 + 1-tap PCF', o: { shadow: 1024, pcfLite: true } },
  { name: 'No light probe / viewmodel sun shadow', o: { probe: 0, vmShadow: 0 } },
  { name: 'Light pool 2', o: { lights: 2 } },
  { name: 'No scope PiP', o: { pip: 0 } },
  { name: 'Material cohesion (applyUnify) off', o: { unify: 'off' } },
  { name: 'Material cohesion lite', o: { unify: 'lite' } },
  { name: 'Fog shader off', o: { fog: false } },
  { name: 'Render scale 0.5', o: { renderScale: 0.5 } },
  { name: 'SMAA off', o: { smaa: false } },
  { name: 'Transparent particles off', o: { particles: false } },
  { name: 'Low preset features', o: { ...QUALITY_PRESETS[0] } },
  { name: 'Everything above off', o: ALL_OFF },
];

const raf = () => new Promise((r) => requestAnimationFrame(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function overlay() {
  let el = document.getElementById('gfxBench');
  if (!el) {
    el = document.createElement('div');
    el.id = 'gfxBench';
    el.style.cssText = 'position:fixed;inset:auto 16px 16px 16px;max-height:calc(100vh - 32px);overflow:auto;z-index:9999;background:rgba(10,11,12,.92);color:#e8e2d6;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;padding:14px 16px;border:1px solid rgba(255,255,255,.12);border-radius:6px;box-shadow:0 10px 40px rgba(0,0,0,.5)';
    document.body.appendChild(el);
  }
  return el;
}

const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0; };

/** Run the benchmark. opts: { stepMs, settleMs, steps } (QA uses short steps). Resolves with the results object. */
export async function runBenchmark(g, opts = {}) {
  if (g._benchRunning) return null;
  g._benchRunning = true;
  const R = g.renderer, rr = R.renderer, s = g.settings, menu = g.menu;
  const stepMs = opts.stepMs ?? 2500, settleMs = opts.settleMs ?? 700;
  const steps = opts.steps ? BENCH_STEPS.filter((st, i) => opts.steps.includes(i)) : BENCH_STEPS;
  const ui = overlay();
  ui.innerHTML = '<b>Graphics benchmark</b> — preparing…';
  const wasStarted = g.started, wasGod = s.godMode, wasPaused = g.paused;
  const savedLoadout = structuredClone(s.loadout);
  const savedPlayer = g.player ? { pos: g.player.position.clone(), yaw: g.player.yaw, pitch: g.player.pitch } : null;
  menu?.close?.();
  R.benchRunning = true; // holds dynamic resolution at 100% of the mode's scale
  const out = { steps: [], env: {} };
  let restoreUpdate = null;
  try {
    if (!g.started) { await g.startMatch('tdm'); }
    g.paused = false;
    s.godMode = true;
    g.hud?.show(false);
    // Magnified optic so the PiP is part of the tour (restored afterwards).
    if (s.loadout.primary !== 'scar') {
      s.loadout.primary = 'scar'; g.applyLoadoutChange();
      for (let i = 0; i < 600 && g.currentWeapon?.id !== 'scar'; i++) await sleep(50);
    }
    // Bots stay visible (their cost is real) but hold still.
    const frozen = [];
    for (const b of g.bots || []) { frozen.push([b, b.update]); b.update = () => {}; }

    // Tour driver: runs before every game.update while the benchmark is active.
    let tourT0 = performance.now(), cpu = [], frames = [], lastNow = 0, measuring = false;
    const tourMs = stepMs;
    const origUpdate = g.update;
    g.update = function (dt) {
      const now = performance.now();
      const t = ((now - tourT0) % tourMs) / tourMs;
      const vi = Math.min(VIEWS.length - 1, Math.floor(t * VIEWS.length)), v = VIEWS[vi];
      const lt = t * VIEWS.length - vi, p = g.player;
      if (p) {
        if (!p.alive) g.spawnPlayer();
        p.crouching = p.sliding = false; p.mantle = null;
        p.position.set(v.pos[0], v.pos[1], v.pos[2]); p.velocity.set(0, 0, 0); p._syncBody?.();
        p.yaw = v.yaw + (v.ads ? 0.05 : 0.5) * (lt - 0.5); p.pitch = v.pitch;
      }
      if (v.ads) g.input.down.add('Mouse2'); else g.input.down.delete('Mouse2');
      g.input.down.delete('Mouse0');
      const c0 = performance.now();
      try { return origUpdate.call(this, dt); } finally {
        if (measuring) {
          cpu.push(performance.now() - c0);
          if (lastNow) frames.push(now - lastNow);
        }
        lastNow = now;
      }
    };
    restoreUpdate = () => { g.update = origUpdate; for (const [b, u] of frozen) b.update = u; g.input.down.delete('Mouse2'); };

    const gl = rr.getContext();
    const timer = R.gpuTimer;
    out.env = {
      gpu: R.gpuInfo?.name, tier: R.gpuInfo?.tier, dpr: devicePixelRatio, ua: navigator.userAgent,
      quality: QUALITY_PRESETS[s.quality]?.name, upscaling: R.upscaling, internal: `${R.internalSize?.w}x${R.internalSize?.h}`,
      output: `${R.outputSize?.w}x${R.outputSize?.h}`, timerQuery: timer.available, parallelCompile: !!gl.getExtension('KHR_parallel_shader_compile'),
      adaptiveLevel: s.adaptiveLevel | 0,
    };
    timer.enabled = true;
    for (let i = 0; i < steps.length; i++) {
      const st = steps[i];
      ui.innerHTML = `<b>Graphics benchmark</b> — step ${i + 1}/${steps.length}: ${st.name}<br><span style="opacity:.6">Don't touch the mouse or keyboard. Takes about ${Math.round(steps.length * (stepMs + settleMs + 400) / 1000)} s.</span>`;
      R.bench = { ...st.o };
      R.applySettings();
      // Shader-define changes (shadows, fog, light count) recompile: finish that before measuring.
      try { await Promise.all([rr.compileAsync(R.scene, R.camera), rr.compileAsync(R.viewScene, R.viewCamera)]); } catch { /* older drivers */ }
      measuring = false;
      tourT0 = performance.now();
      await sleep(settleMs);
      const prog0 = rr.info.programs?.length ?? 0;
      cpu = []; frames = []; lastNow = 0;
      timer.reset();
      tourT0 = performance.now();
      measuring = true;
      const t0 = performance.now();
      let calls = 0, n = 0;
      while (performance.now() - t0 < stepMs) { await raf(); calls += rr.info.render.calls; n++; }
      measuring = false;
      // Let outstanding timer queries land.
      for (let k = 0; k < 6; k++) { await raf(); timer.poll(); }
      const mean = frames.reduce((a, b) => a + b, 0) / Math.max(1, frames.length);
      const cpuMean = cpu.reduce((a, b) => a + b, 0) / Math.max(1, cpu.length);
      const gw = timer.window();
      out.steps.push({
        name: st.name, frames: frames.length, ms: +mean.toFixed(2), p95: +pct(frames, 0.95).toFixed(2), fps: +(1000 / Math.max(1e-3, mean)).toFixed(1),
        cpuMs: +cpuMean.toFixed(2), gpuMs: timer.available && gw.frames ? gw.total : null, gpuPasses: timer.available ? gw.ms : null,
        calls: Math.round(calls / Math.max(1, n)), programs: rr.info.programs?.length ?? 0, newPrograms: (rr.info.programs?.length ?? 0) - prog0,
        internal: `${R.internalSize?.w}x${R.internalSize?.h}`,
      });
    }
  } catch (e) {
    out.error = String(e?.message || e);
    console.error('benchmark', e);
  } finally {
    R.gpuTimer.enabled = false;
    restoreUpdate?.();
    R.bench = {};
    R.benchRunning = false;
    R.applySettings();
    s.godMode = wasGod;
    if (JSON.stringify(s.loadout) !== JSON.stringify(savedLoadout)) { s.loadout = savedLoadout; g.applyLoadoutChange(); }
    if (!wasStarted) { g.started = false; g.match.state = 'idle'; g.hud?.show(false); g.paused = true; menu?.open?.(false, 'settings'); } else {
      if (savedPlayer && g.player) { g.player.position.copy(savedPlayer.pos); g.player.velocity.set(0, 0, 0); g.player._syncBody?.(); g.player.yaw = savedPlayer.yaw; g.player.pitch = savedPlayer.pitch; }
      g.hud?.show(true); g.paused = wasPaused; if (wasPaused) menu?.open?.(true, 'settings');
    }
    g._benchRunning = false;
  }
  showResults(ui, out);
  window.__benchResults = out;
  return out;
}

export function benchText(out) {
  const e = out.env, base = out.steps[0];
  const lines = [];
  lines.push('Ironline graphics benchmark');
  lines.push(`GPU: ${e.gpu} (tier ${e.tier}) · DPR ${e.dpr} · ${e.quality} · upscaling ${e.upscaling} · internal ${e.internal} → output ${e.output}`);
  lines.push(`GPU timer: ${e.timerQuery ? 'yes' : 'no (frame time only)'} · parallel compile: ${e.parallelCompile ? 'yes' : 'no'} · adaptive level ${e.adaptiveLevel}`);
  lines.push(`UA: ${e.ua}`);
  if (out.error) lines.push('ERROR: ' + out.error);
  lines.push('');
  const head = ['step', 'frame ms', 'p95', 'fps', 'Δ ms', 'cpu ms', 'gpu ms', 'calls', 'progs(+new)'];
  const rows = out.steps.map((r) => [r.name, r.ms, r.p95, r.fps, base ? (r.ms - base.ms).toFixed(1) : '', r.cpuMs, r.gpuMs ?? '–', r.calls, `${r.programs}(+${r.newPrograms})`]);
  const w = head.map((h, i) => Math.max(String(h).length, ...rows.map((r) => String(r[i]).length)));
  const fmt = (r) => r.map((c, i) => (i === 0 ? String(c).padEnd(w[i]) : String(c).padStart(w[i]))).join('  ');
  lines.push(fmt(head));
  for (const r of rows) lines.push(fmt(r));
  if (base?.gpuPasses) {
    lines.push('');
    lines.push('Baseline GPU ms per pass: ' + Object.entries(base.gpuPasses).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(' · '));
  }
  return lines.join('\n');
}

function showResults(ui, out) {
  const text = benchText(out);
  const esc = (t) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  ui.innerHTML = `<div style="display:flex;gap:8px;align-items:center;margin-bottom:8px"><b style="flex:1">Graphics benchmark results</b>
    <button data-bcopy style="font:inherit;padding:4px 10px;background:#d8b46a;color:#111;border:0;border-radius:3px;cursor:pointer">Copy results</button>
    <button data-bclose style="font:inherit;padding:4px 10px;background:#333;color:#ddd;border:0;border-radius:3px;cursor:pointer">Close</button></div>
    <pre style="margin:0;white-space:pre;overflow:auto">${esc(text)}</pre>`;
  ui.querySelector('[data-bcopy]').onclick = async (ev) => {
    try { await navigator.clipboard.writeText(text); ev.target.textContent = 'Copied'; } catch {
      const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); ev.target.textContent = 'Copied'; } catch { /* ignore */ } ta.remove();
    }
  };
  ui.querySelector('[data-bclose]').onclick = () => ui.remove();
}

// QA / console access: await __bench.run(__game, { stepMs, settleMs, steps: [0, 3] }); __bench.text(__benchResults)
window.__bench = { run: runBenchmark, text: benchText, steps: BENCH_STEPS };
