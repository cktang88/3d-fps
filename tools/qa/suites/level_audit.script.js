// Level audit (owner: level). node tools/qa/submit.mjs level tools/qa/suites/level_audit.json
// 1) LOS at eye height between every TDM team-0/team-1 spawn pair and every FFA spawn pair;
// 2) door clearance: rays through each recorded doorway (level.doors) at waist + head height, both ways;
// 3) stair walk: hold W from the foot of each stair for 7 s and report the height reached;
// 4) 120 s bot match: kills of actors that spawned < 3 s earlier ("spawn kills").
(async () => {
  const g = window.__game, Q = window.__qa, THREE = g.renderer.scene.position.constructor;
  const V = (x, y, z) => new THREE(x, y, z);
  const out = {};
  const eye = (p) => V(p.x, 1.6, p.z);
  const los = (a, b) => g.physics.lineOfSight(eye(a), eye(b));
  const S = g.level.spawns;
  const tdm = [];
  for (const a of S[0]) for (const b of S[1]) if (los(a.pos, b.pos)) tdm.push([[a.pos.x, a.pos.z].map(Math.round), [b.pos.x, b.pos.z].map(Math.round), Math.round(a.pos.distanceTo(b.pos))]);
  const ffa = [];
  for (let i = 0; i < S.ffa.length; i++) for (let j = i + 1; j < S.ffa.length; j++) if (los(S.ffa[i].pos, S.ffa[j].pos)) ffa.push([i, j, Math.round(S.ffa[i].pos.distanceTo(S.ffa[j].pos))]);
  // Team spawns vs mid-map (FFA) points the enemy can also spawn on in TDM.
  const mix = [];
  // Only mid points the ENEMY team may use (pickSpawn excludes points within 14 m of the enemy base).
  for (const t of [0, 1]) for (const a of S[t]) S.ffa.forEach((b, j) => { if (S[t].some((o) => o.pos.distanceTo(b.pos) < 14)) return; if (los(a.pos, b.pos)) mix.push([t, [a.pos.x, a.pos.z].map(Math.round), j, Math.round(a.pos.distanceTo(b.pos))]); });
  out.los = { tdmPairs: S[0].length * S[1].length, tdmVisible: tdm.length, tdm, ffaPairs: S.ffa.length * (S.ffa.length - 1) / 2, ffaVisible: ffa.length, ffa, teamToMidVisible: mix.length, teamToMid: mix.slice(0, 40) };
  // Doors.
  const doors = g.level.doors || [];
  out.doors = doors.map((d) => {
    const res = [];
    for (const h of [1.0, 1.6]) for (const s of [-1, 1]) {
      if (h > d.top - 0.15) continue;
      const o = V(d.x - d.nx * s * 1.2, (d.y0 || 0) + h, d.z - d.nz * s * 1.2), dir = V(d.nx * s, 0, d.nz * s);
      const hit = g.physics.raycast(o, dir, 2.4, undefined);
      res.push(hit ? +hit.distance.toFixed(2) : null);
    }
    return { name: d.name, at: [+d.x.toFixed(1), +d.z.toFixed(1)], blocked: res.some((r) => r !== null), hits: res };
  });
  out.blockedDoors = out.doors.filter((d) => d.blocked).map((d) => d.name + '@' + d.at.join(','));
  // Stairs.
  const stairs = g.level.stairsAudit || [];
  out.stairs = [];
  Q.god(); Q.freezeBots(true);
  for (const s of stairs) {
    Q.releaseAll(); Q.place(s.start, Math.atan2(-s.dir[0], -s.dir[1]), 0);
    Q.down('KeyW');
    let maxY = 0; Q.sim(7, 1 / 30, () => { maxY = Math.max(maxY, g.player.position.y); });
    Q.releaseAll();
    out.stairs.push({ name: s.name, want: s.top, reached: +maxY.toFixed(2), ok: maxY > s.top - 0.15, end: Q.p() });
  }
  Q.thawBots();
  // Spawn kills in a 120 s bot match.
  const m = g.match, orig = m.pickSpawn.bind(m);
  m.pickSpawn = (actor) => { const r = orig(actor); actor._qaSpawnT = g.time; return r; };
  let spawnKills = 0, spawnKills6 = 0, kills = 0; const sk = [];
  const ok = g.onActorKilled.bind(g);
  g.onActorKilled = (v, k, info) => { kills++; if (v._qaSpawnT != null && g.time - v._qaSpawnT < 6) spawnKills6++;
    if (v._qaSpawnT != null && g.time - v._qaSpawnT < 3) { spawnKills++; sk.push([+(g.time - v._qaSpawnT).toFixed(1), Math.round(v.position.x), Math.round(v.position.z)]); } return ok(v, k, info); };
  const res = Q.matchSim(120, [0, -30, 0]);
  g.onActorKilled = ok; m.pickSpawn = orig;
  out.match = { kills, spawnKills, spawnKills6, spawnKillRate: kills ? +(spawnKills / kills).toFixed(2) : 0, examples: sk.slice(0, 12), stuck: res.stuckBots, fallen: res.fallen, score: res.score };
  return out;
})()
