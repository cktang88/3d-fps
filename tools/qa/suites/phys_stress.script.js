(async () => {
  // Usage: {"match":"tdm","timeoutS":480,"setup":"window.__stressSeconds=300;","scriptFile":"tools/qa/suites/phys_stress.script.js"}
  // Teleports (incl. inside geometry), crouch/stand height changes, jumps and the Player step-up KCC pattern, with
  // seeded RNG, on copies of the live world. Progress is console.warn-logged so a hang names its seed and frame.
  // In-page Rapier stress on a COPY of the game's world (Chromium's V8, same wasm as the game).
  const R = window.__game.physics.R;
  const snap = window.__game.physics.world.takeSnapshot();
  const SECONDS = window.__stressSeconds || 240;
  const t0 = performance.now();
  const boxes = [];
  window.__game.physics.world.forEachCollider((c) => { if (c.shapeType() === 1) { const t = c.translation(), h = c.halfExtents(); boxes.push({ t: [t.x, t.y, t.z], he: [h.x, h.y, h.z] }); } });
  const groups = (m, f) => ((m & 0xffff) << 16) | (f & 0xffff);
  const flags = R.QueryFilterFlags.EXCLUDE_SENSORS, filt = groups(0xffff, 1);
  const bmin = [1e9, 1e9, 1e9], bmax = [-1e9, -1e9, -1e9];
  for (const b of boxes) for (let k = 0; k < 3; k++) { bmin[k] = Math.min(bmin[k], b.t[k]); bmax[k] = Math.max(bmax[k], b.t[k]); }
  const out = { runs: [] };
  let seed = 1000;
  while ((performance.now() - t0) / 1000 < SECONDS) {
    seed++;
    const world = R.World.restoreSnapshot(snap);
    world.timestep = 1 / 60;
    let col = null; world.forEachCollider((c) => { if (c.shapeType() === 2) col = c; });
    const kcc = world.createCharacterController(0.02);
    kcc.setUp({ x: 0, y: 1, z: 0 }); kcc.setMaxSlopeClimbAngle(50 * Math.PI / 180); kcc.setMinSlopeSlideAngle(55 * Math.PI / 180);
    kcc.enableAutostep(0.45, 0.15, false); kcc.enableSnapToGround(0.35); kcc.setApplyImpulsesToDynamicBodies(true); kcc.setCharacterMass(80);
    let s = seed >>> 0;
    const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
    const pos = { x: -53, y: 0, z: -13 }; let height = 1.8, vy = 0, accum = 0;
    const sync = () => col.setTranslation({ x: pos.x, y: pos.y + height / 2, z: pos.z });
    const pick = () => boxes[Math.floor(rnd() * boxes.length)];
    const FR = 20000;
    for (let f = 0; f < FR; f++) {
      const r = rnd();
      if (r < 0.03) { const b = pick(); pos.x = b.t[0] + (rnd() - 0.5) * 2 * b.he[0]; pos.y = b.t[1] + (rnd() - 0.5) * 2 * b.he[1] - 0.9; pos.z = b.t[2] + (rnd() - 0.5) * 2 * b.he[2]; sync(); }
      else if (r < 0.05) { pos.x = bmin[0] + rnd() * (bmax[0] - bmin[0]); pos.y = rnd() * 10; pos.z = bmin[2] + rnd() * (bmax[2] - bmin[2]); sync(); }
      if (rnd() < 0.05) { const hts = [1.8, 1.2, 1.0]; height = hts[Math.floor(rnd() * 3)]; col.setHalfHeight(Math.max(0.05, (height - 0.7) / 2)); sync(); }
      if (rnd() < 0.05) vy = 6;
      vy -= 20 / 30;
      const sp = rnd() < 0.2 ? 12 : 5, a = rnd() * 6.283;
      const dt = rnd() < 0.1 ? 0.1 : 0.05;
      const d = { x: Math.cos(a) * sp * dt, y: vy * dt, z: Math.sin(a) * sp * dt };
      kcc.computeColliderMovement(col, d, flags, filt);
      const m = kcc.computedMovement(); if (kcc.computedGrounded()) vy = Math.max(vy, -2);
      if (rnd() < 0.3) {
        const cy = pos.y + height / 2;
        kcc.computeColliderMovement(col, { x: 0, y: 0.45, z: 0 }, flags, filt); const up = kcc.computedMovement().y;
        col.setTranslation({ x: pos.x, y: cy + up, z: pos.z });
        kcc.computeColliderMovement(col, { x: d.x, y: 0, z: d.z }, flags, filt); const am = kcc.computedMovement();
        col.setTranslation({ x: pos.x + am.x, y: cy + up, z: pos.z + am.z });
        kcc.computeColliderMovement(col, { x: 0, y: -(up + 0.1), z: 0 }, flags, filt);
        sync();
      }
      pos.x += m.x; pos.y += m.y; pos.z += m.z;
      if (pos.y < -50) { pos.y = 2; vy = 0; }
      sync();
      accum += Math.min(dt, 0.1); let n = 0;
      while (accum >= world.timestep && n < 8) { world.step(); accum -= world.timestep; n++; }
      if (f % 5000 === 0) { console.warn(`STRESS seed ${seed} frame ${f} t=${((performance.now() - t0) / 1000).toFixed(0)}s`); await new Promise((r) => setTimeout(r, 0)); }
    }
    out.runs.push(seed);
    world.free();
  }
  return out;
})()
