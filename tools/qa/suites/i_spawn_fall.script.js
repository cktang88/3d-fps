// Spawn / placement sanity: spawn the player at every spawn point (TDM teams + FFA) and at every key-art position;
// simulate 2 s; flag deaths, fall damage, falling through the world, or getting stuck airborne.
(() => {
  const g = window.__game, Q = window.__qa, p = g.player, out = { fails: [], rows: [] };
  Q.freezeBots(true); g.settings.godMode = false;
  const pts = [];
  for (const [k, list] of Object.entries(g.level.spawns)) list.forEach((s, i) => pts.push([`spawn_${k}_${i}`, [s.pos.x, s.pos.y, s.pos.z], s.yaw]));
  for (const [n, pos, yaw] of window.__keyArt || []) pts.push([n, pos, yaw]);
  for (const [name, pos, yaw] of pts) {
    if (!p.alive) g.spawnPlayer();
    p.health = p.maxHealth ?? 100; p.spawnProtect = 0;
    Q.place(pos, yaw, 0);
    let minVy = 0, airT = 0, maxAir = 0; const y0 = p.position.y;
    const dmg = []; const od = g.onPlayerDamaged; g.onPlayerDamaged = function (a, at, info) { dmg.push([a, info?.type]); return od.call(this, a, at, info); };
    Q.sim(2, 1 / 30, () => { minVy = Math.min(minVy, p.velocity.y); if (!p.grounded) { airT += 1 / 30; maxAir = Math.max(maxAir, airT); } else airT = 0; });
    delete g.onPlayerDamaged;
    const r = { name, pos: pos.map((x) => Q.r(x, 1)), end: Q.p(), alive: p.alive, hp: Math.round(p.health), minVy: Q.r(minVy, 1), maxAir: Q.r(maxAir, 2), grounded: p.grounded, dmg };
    out.rows.push(r);
    if (!p.alive || dmg.length) out.fails.push(`${name}: ${p.alive ? 'damaged' : 'DIED'} ${JSON.stringify(dmg)} minVy ${r.minVy} end ${JSON.stringify(r.end)}`);
    else if (!p.grounded || maxAir > 1.0) out.fails.push(`${name}: airborne ${r.maxAir}s, grounded=${p.grounded}, end ${JSON.stringify(r.end)}`);
    else if (r.end[1] < y0 - 1.5) out.fails.push(`${name}: fell ${Q.r(y0 - r.end[1])} m`);
  }
  g.settings.godMode = true; Q.thawBots();
  return out;
})()
