// Pistol low-zero check: ADS taps with FULL recovery between shots (1.2 s gap, no mouse input) vs a perfectly
// re-centred aim before each shot. Records each bullet's direction relative to the original aim (like w_spray)
// and converts to cm at 25 m. Rifles as control.
(async () => {
  const g = window.__game, Q = window.__qa, p = g.player, out = {};
  await Q.ready(); Q.god(); Q.freezeBots(true);
  const DEG = Math.PI / 180, wrap = (a) => ((a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  for (const id of ['p226', 'm1911', 'm4', 'scar']) {
    await Q.loadoutReady(id);
    const w = g.currentWeapon, s = w.stats; const r = {};
    for (const mode of ['natural', 'recentred']) {
      Q.releaseAll(); Q.place([0, 0.1, 10], 0, 0); p.spawnProtect = 0;
      const y0 = 0, p0 = 0; Q.down('Mouse2'); Q.sim(1.2, 1 / 60, () => { p.yaw = y0; p.pitch = p0; });
      if (g.recoilAccum) g.recoilAccum.set(0, 0); w.spread = 0; w.shotIndex = 0; w.refill(); w.state = 'idle';
      const hits = []; const bf = g.ballistics.fire;
      g.ballistics.fire = function (owner, origin, dir, ...rest) { if (owner === p) hits.push([-wrap(Math.atan2(-dir.x, -dir.z) - y0) / DEG, (Math.asin(Math.max(-1, Math.min(1, dir.y))) - p0) / DEG]); return bf.call(this, owner, origin, dir, ...rest); };
      const aimAt = [];
      for (let k = 0; k < 6; k++) {
        if (mode === 'recentred') { p.yaw = y0; p.pitch = p0; if (g.recoilAccum) g.recoilAccum.set(0, 0); }
        aimAt.push([+((p.yaw - y0) / DEG).toFixed(3), +((p.pitch - p0) / DEG).toFixed(3)]);
        Q.press('Mouse0'); Q.sim(1 / 60); Q.down('Mouse0', false);
        Q.sim(1.2, 1 / 60);
      }
      delete g.ballistics.fire; Q.down('Mouse2', false);
      const cm = hits.map(([yx, py]) => [+(Math.tan(yx * DEG) * 2500).toFixed(1), +(Math.tan(py * DEG) * 2500).toFixed(1)]);
      const mpi = cm.length ? [+(cm.reduce((a, c) => a + c[0], 0) / cm.length).toFixed(1), +(cm.reduce((a, c) => a + c[1], 0) / cm.length).toFixed(1)] : null;
      r[mode] = { n: cm.length, mpiCm25: mpi, firstShotCm25: cm[0], aimBeforeShotDeg: aimAt, hitsCm25: cm };
    }
    out[id] = r;
  }
  Q.thawBots();
  return out;
})()
