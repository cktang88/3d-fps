// QA helper library — inlined into job.setup by submit.mjs ("setupFiles":["tools/qa/suites/lib.js"]).
// Runs in the page before the match starts. Everything hangs off window.__qa.
(() => {
  const Q = (window.__qa = {});
  const G = () => window.__game;
  // Simulate N seconds without rendering (fast on SwiftShader). cb(t) runs before each step.
  Q.sim = (seconds, dt = 1 / 30, cb) => {
    const g = G(); const r = g.renderer.render; g.renderer.render = () => {};
    const wasPaused = g.paused; g.paused = false;
    const n = Math.max(1, Math.round(seconds / dt));
    const t0 = performance.now();
    try { for (let i = 0; i < n; i++) { cb?.(i * dt); g.update(dt); } } finally { g.renderer.render = r; g.paused = wasPaused; }
    return (performance.now() - t0) / n;
  };
  window.__sim = window.__sim || Q.sim;
  Q.down = (code, on = true) => { const i = G().input; if (on) i.down.add(code); else i.down.delete(code); };
  Q.press = (code) => { const i = G().input; i.down.add(code); i.pressed.add(code); };
  Q.tap = (code) => { const i = G().input; i.pressed.add(code); }; // press without holding
  Q.releaseAll = () => { const i = G().input; i.down.clear(); i.pressed.clear(); };
  Q.place = (pos, yaw = 0, pitch = 0) => {
    const p = G().player; p.position.set(pos[0], pos[1], pos[2]); p.velocity.set(0, 0, 0); p._syncBody(); p.yaw = yaw; p.pitch = pitch;
  };
  Q.god = (on = true) => { G().settings.godMode = on; };
  // Freeze bots in place (hidden) so they don't interfere with deterministic player tests.
  Q.freezeBots = (hide = true) => { for (const b of G().bots) { if (!b._qaU) b._qaU = b.update; b.update = () => {}; if (hide && b.model) b.model.root.visible = false; } };
  Q.thawBots = () => { for (const b of G().bots) { if (b._qaU) { b.update = b._qaU; b._qaU = null; } if (b.model) b.model.root.visible = true; } };
  Q.loadout = (primary, secondary) => {
    const g = G(); if (primary) g.settings.loadout.primary = primary; if (secondary) g.settings.loadout.secondary = secondary;
    g.applyLoadoutChange();
  };
  Q.decals = () => { let n = 0; for (const d of Object.values(G().effects.decals)) n += d.mesh.count; return n; };
  Q.fx = () => { const e = G().effects; return { tracers: e.tracers.length, sparks: e.sparks.count, dust: e.dust.count, flashes: e.flashes.count, decals: Q.decals(), bullets: G().ballistics.bullets.length }; };
  const bad = (v) => !Number.isFinite(v);
  Q.nanScan = () => {
    const g = G(), out = [];
    const chk = (name, v) => { if (v && (bad(v.x) || bad(v.y) || bad(v.z))) out.push(name); };
    chk('player.pos', g.player.position); chk('player.vel', g.player.velocity);
    if (bad(g.player.yaw) || bad(g.player.pitch)) out.push('player.look');
    chk('camera', g.renderer.camera.position);
    g.bots.forEach((b, i) => { chk('bot' + i + '.pos', b.position); if (bad(b.health)) out.push('bot' + i + '.health'); });
    return out;
  };
  Q.hspeed = () => { const v = G().player.velocity; return Math.hypot(v.x, v.z); };
  Q.r = (x, d = 2) => (typeof x === 'number' ? +x.toFixed(d) : x);
  Q.p = () => { const p = G().player.position; return [Q.r(p.x), Q.r(p.y), Q.r(p.z)]; };
  // Overlap check for HUD elements: returns pairs of visible HUD rects that intersect.
  Q.hudOverlaps = (sel = '#hud > *') => {
    const els = [...document.querySelectorAll(sel)].filter((e) => { const s = getComputedStyle(e), r = e.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && +s.opacity > 0.05 && r.width > 2 && r.height > 2 && r.width * r.height < innerWidth * innerHeight * 0.4 && e.childElementCount + e.textContent.trim().length > 0; });
    const out = [];
    for (let i = 0; i < els.length; i++) for (let j = i + 1; j < els.length; j++) {
      const a = els[i].getBoundingClientRect(), b = els[j].getBoundingClientRect();
      if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom && !els[i].contains(els[j]) && !els[j].contains(els[i])) out.push([els[i].id || els[i].className, els[j].id || els[j].className]);
    }
    return out;
  };
})();
(() => {
  const Q = window.__qa, G = () => window.__game;
  Q.perf = () => { const i = G().renderer.renderer.info; return { calls: i.render.calls, tris: i.render.triangles, geos: i.memory.geometries, tex: i.memory.textures, progs: i.programs?.length }; };
  // Run the live match for `seconds` (player in god mode, parked) and collect health stats of the sim.
  Q.matchSim = (seconds = 90, park = null) => {
    const g = G(); Q.god(); Q.releaseAll();
    if (park) Q.place(park, 0, 0);
    const bots = g.bots, n = bots.length;
    const last = bots.map((b) => b.position.clone()), stillT = new Array(n).fill(0), maxStill = new Array(n).fill(0);
    const kills = []; const deathsBefore = bots.map((b) => b.stats.deaths);
    const origKilled = g.onActorKilled.bind(g);
    g.onActorKilled = (v, k, info) => { kills.push({ t: +g.time.toFixed(1), victim: g.bots.indexOf(v), killer: k === g.player ? 'player' : g.bots.indexOf(k), head: !!info?.headshot }); return origKilled(v, k, info); };
    let nanAt = null, outOfBounds = new Set(), fallen = new Set();
    const t0 = performance.now(), dt = 1 / 30;
    Q.sim(seconds, dt, () => {
      if (park) { g.player.position.set(park[0], park[1], park[2]); g.player.velocity.set(0, 0, 0); }
      bots.forEach((b, i) => {
        if (!b.alive) { stillT[i] = 0; last[i].copy(b.position); return; }
        const d = b.position.distanceTo(last[i]);
        stillT[i] = d < 0.02 ? stillT[i] + dt : 0; maxStill[i] = Math.max(maxStill[i], stillT[i]); last[i].copy(b.position);
        if (b.position.y < -2) fallen.add(i);
        if (Math.abs(b.position.x) > 90 || Math.abs(b.position.z) > 90) outOfBounds.add(i);
      });
      if (!nanAt && Q.nanScan().length) nanAt = { t: g.time, what: Q.nanScan() };
    });
    g.onActorKilled = origKilled;
    return {
      simSeconds: seconds, wallMs: Math.round(performance.now() - t0), mode: g.mode.key, score: g.mode.score.slice(), timeLeft: Math.round(g.mode.timeLeft),
      kills: kills.length, headshots: kills.filter((k) => k.head).length, firstKills: kills.slice(0, 6),
      bots: bots.map((b, i) => ({ i, team: b.team, alive: b.alive, k: b.stats.kills, d: b.stats.deaths - deathsBefore[i], maxStill: +maxStill[i].toFixed(1), goal: b.goal?.name || b.goal || b.state, pos: [Math.round(b.position.x), +b.position.y.toFixed(1), Math.round(b.position.z)] })),
      stuckBots: maxStill.map((s, i) => [i, s]).filter(([, s]) => s > 15).map(([i, s]) => `bot${i} still ${s.toFixed(0)}s`),
      fallen: [...fallen], outOfBounds: [...outOfBounds], nanAt,
      visibleSkinnedRoots: Q.skinnedRoots(), aliveBots: bots.filter((b) => b.alive).length,
    };
  };
  // Count distinct visible top-level objects containing a visible SkinnedMesh (bots + corpses).
  Q.skinnedRoots = () => {
    const roots = new Set();
    G().renderer.scene.traverseVisible((o) => { if (o.isSkinnedMesh) { let r = o; while (r.parent && r.parent.type !== 'Scene') r = r.parent; roots.add(r); } });
    return roots.size;
  };
  // Put the camera ~dist m in front of the nearest alive bot, looking at it.
  Q.lookAtBot = (dist = 4, idx = null) => {
    const g = G(), p = g.player; Q.god();
    let b = idx != null ? g.bots[idx] : null;
    if (!b) { let best = 1e9; for (const x of g.bots) if (x.alive) { const d = x.position.distanceTo(p.position); if (d < best) { best = d; b = x; } } }
    if (!b) return null;
    const a = b.yaw, fx = -Math.sin(a), fz = -Math.cos(a);
    p.position.set(b.position.x + fx * dist, b.position.y + 0.05, b.position.z + fz * dist); p.velocity.set(0, 0, 0); p._syncBody();
    const dx = b.position.x - p.position.x, dz = b.position.z - p.position.z;
    p.yaw = Math.atan2(-dx, -dz); p.pitch = -0.08;
    return g.bots.indexOf(b);
  };
})();
