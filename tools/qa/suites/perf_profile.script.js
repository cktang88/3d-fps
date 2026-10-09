// Perf profile (owner: perf). Run with renderScript:true:
//   node tools/qa/submit.mjs perf tools/qa/suites/perf_profile.json
// For each standard view: per-pass draw calls / triangles (world, shadow, AO, viewmodel, PiP scope, post),
// plus a scene census by owner, top geometries/textures and the load timeline. Counts don't depend on viewport size.
(async () => {
  const g = window.__game, P = window.__perf, Q = window.__qa;
  const views = window.__perfViews || [
    { name: 'courtyard', pos: [0, 0, 20], yaw: 0.3, pitch: 0.02 },
    { name: 'sun', pos: [2, 0, -8], yaw: 2.68, pitch: 0.06 },
    { name: 'warehouse', pos: [13, 0, -35], yaw: 1.57, pitch: 0.12 },
    { name: 'containers', pos: [37, 0, 4], yaw: 0.1, pitch: 0.03 },
    { name: 'office', pos: [-12.5, 0, 40.5], yaw: -1.9, pitch: 0 },
    { name: 'scope_ads', pos: [0, 0.1, 10], yaw: 0.15, pitch: 0.02, scar: true },
    { name: 'courtyard_legacy', pos: [0, 0, 20], yaw: 0.3, pitch: 0.02, legacy: true },
  ].filter((v) => !window.__perfOnly || window.__perfOnly.includes(v.name));
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const out = { quality: g.settings.quality, views: {} };
  Q.god(); Q.freezeBots(false); Q.releaseAll();
  for (const v of views) {
    if (v.scar) { Q.loadout('scar'); Q.sim(1.2); Q.down('Mouse2'); }
    Q.place(v.pos, v.yaw, v.pitch);
    Q.sim(v.scar ? 0.8 : 0.3);
    g.player.yaw = v.yaw; g.player.pitch = v.pitch;
    window.__perfLegacy = !!v.legacy;
    // One warm rendered frame first: render-time LOD (bots, props) and occlusion settle on the frame they see.
    window.__qaSkipRender = false; await frame();
    window.__qaSkipRender = true; await frame();
    const cap = P.capture({ detail: !!v.detail || v.name === 'courtyard' });
    window.__qaSkipRender = false;
    const t0 = performance.now();
    const f = await cap;
    window.__qaSkipRender = true;
    const passes = {};
    for (const [k, p] of Object.entries(f.passes)) passes[k] = `${p.calls} calls / ${Math.round(p.tris / 1000)}k tris (x${p.n})`;
    out.views[v.name] = {
      total: `${f.total.calls} calls / ${Math.round(f.total.tris / 1000)}k tris`, calls: f.total.calls, tris: f.total.tris,
      botsHidden: g.botOcclusion?.hiddenCount, pvsHidden: g.pvs?.enabled ? `${g.pvs.stats.hiddenChunks}c/${g.pvs.stats.hiddenProps}p` : 'off', fov: +g.renderer.camera.fov.toFixed(2), botsLow: g.bots.filter((b) => b.model?._geoLod?.low).length, shadow: `${f.shadow.calls} calls / ${Math.round(f.shadow.tris / 1000)}k tris (x${f.shadow.n})`, passes, cpuMs: f.cpuMs, wallMs: Math.round(performance.now() - t0),
    };
    window.__perfLegacy = false;
    if (v.scar) Q.down('Mouse2', false);
    if (f.objects) out.views[v.name].detail = P.constructor.summarize(f.objects, 25);
    if (v.name === 'courtyard') out.census = P.census();
  }
  out.bots = { n: g.bots.length, rootsVisible: g.bots.filter((b) => b.model?.root.visible).length, sparesVisible: g.bots.filter((b) => b.spareModel?.root.visible && b.spareModel.root.parent).length, lowLod: g.bots.filter((b) => b.model?._geoLod?.low).length };
  out.bodyRoots = (() => { const s = []; g.renderer.scene.traverseVisible((o) => { if (o.isSkinnedMesh && o.name === 'Object_101') { let r = o; while (r.parent && r.parent !== g.renderer.scene) r = r.parent; s.push(g.bots.some((b) => b.model?.root === r) ? 'bot' : g.bots.some((b) => b.spareModel?.root === r) ? 'spare' : (r.name || r.type)); } }); return s; })();
  out.top = P.top(25);
  out.load = P.loadTimeline();
  out.lod = window.__lod?.lodStats; out.nav = { baked: !!g.nav?.baked, ms: g.nav?.buildTime }; out.pvs = { enabled: !!g.pvs?.enabled, ...(g.pvs?.stats || {}) }; out.shadowBakes = g.shadowCache?.bakes;
  return out;
})()
