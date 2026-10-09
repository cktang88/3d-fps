// Fall-through probe: runner-style teleport (pos + zero velocity + _syncBody, nothing else reset) at every
// key-art position and spawn, then step game.update at the runner's fixed 0.05 s and at 1/30 s. Records min y,
// deaths (and their type), and which colliders are under the player when it falls.
(() => {
  const g = window.__game, p = g.player, out = { fails: [], rows: [] };
  g.settings.godMode = false;
  const pts = (window.__keyArt || []).slice();
  for (const [k, list] of Object.entries(g.level.spawns)) list.forEach((s, i) => pts.push([`spawn_${k}_${i}`, [s.pos.x, 0, s.pos.z], s.yaw]));
  const deaths = []; const ok = g.onActorKilled.bind(g);
  g.onActorKilled = (v, k, info) => { if (v === p) deaths.push(info?.type || info?.weapon || '?'); return ok(v, k, info); };
  for (const dt of [0.05, 1 / 30]) for (const [name, pos, yaw] of pts) {
    if (!p.alive) g.spawnPlayer();
    p.spawnProtect = 0; p.health = 100; deaths.length = 0;
    p.position.set(pos[0], pos[1], pos[2]); p.velocity.set(0, 0, 0); p._syncBody(); p.yaw = yaw;
    let minY = 1e9, firstBelow = null;
    const r = g.renderer.render; g.renderer.render = () => {}; const wp = g.paused; g.paused = false;
    for (let i = 0; i < Math.round(3 / dt); i++) {
      g.update(dt);
      minY = Math.min(minY, p.position.y);
      if (firstBelow == null && p.position.y < pos[1] - 0.6) firstBelow = { step: i, y: +p.position.y.toFixed(2), vy: +p.velocity.y.toFixed(1), grounded: p.grounded, mantle: p.mantle?.type || null };
    }
    g.renderer.render = r; g.paused = wp;
    const row = { dt: +dt.toFixed(3), name, minY: +minY.toFixed(2), alive: p.alive, deaths: deaths.slice(), firstBelow };
    out.rows.push(row);
    if (deaths.length || firstBelow) {
      // What is under the player?
      const V = p.position.constructor; const hit = g.physics.raycast(new V(pos[0], pos[1] + 3, pos[2]), new V(0, -1, 0), 10);
      row.groundHit = hit ? { y: +hit.point.y.toFixed(2), surface: hit.data?.surface, n: [hit.normal.x, hit.normal.y, hit.normal.z].map((x) => +x.toFixed(2)) } : null;
      out.fails.push(`${name} @dt ${row.dt}: ${deaths.length ? 'DIED ' + deaths.join(',') : 'dropped'} minY ${row.minY} ${JSON.stringify(firstBelow)} ground ${JSON.stringify(row.groundHit)}`);
    }
  }
  g.onActorKilled = ok; delete g.onActorKilled; g.settings.godMode = true;
  return out;
})()
