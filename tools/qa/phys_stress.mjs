// Headless Rapier stress test on the game's real collider set (same @dimforge/rapier3d-compat build as the game).
//   node tools/qa/phys_stress.mjs <world.json> [seeds=8] [frames=200000]
// <world.json>: a physics bundle from the page (`JSON.stringify(__physRepro())`, or a runner-saved
// tools/qa/results/<id>/physRepro.json) - its first checkpoint's snapshot is the world to stress.
// Each seed runs in a worker: teleports anywhere (incl. deep inside boxes), crouch/slide/stand half-height changes,
// jumps, the Player step-up KCC pattern (up/across/down setTranslation probes), dt spikes, 1-8 world.step() per frame.
// A worker that makes no progress for 15 s is reported as a HANG with its seed and frame (replay: same seed).
// Run under `nice -n 19` on the shared host.
import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads';
import fs from 'node:fs';

if (isMainThread) {
  const [file, seedsArg = '8', framesArg = '200000'] = process.argv.slice(2);
  if (!file) { console.log('usage: node tools/qa/phys_stress.mjs <world.json> [seeds] [frames]'); process.exit(2); }
  const B = JSON.parse(fs.readFileSync(file, 'utf8'));
  const snap = (B.checkpoints?.[0] ?? B).snap;
  let bad = 0;
  for (let seed = 1; seed <= +seedsArg; seed++) {
    const sab = new SharedArrayBuffer(8), prog = new Int32Array(sab);
    const w = new Worker(new URL(import.meta.url), { workerData: { snap, seed, frames: +framesArg, sab } });
    const res = await new Promise((done) => {
      let last = -1, still = 0;
      const iv = setInterval(() => { if (prog[0] === last) { if (++still >= 30) { clearInterval(iv); w.terminate(); done(`HANG seed ${seed} at frame ${last}`); } } else { still = 0; last = prog[0]; } }, 500);
      w.on('message', (m) => { clearInterval(iv); done(m); });
      w.on('error', (e) => { clearInterval(iv); done(`ERROR seed ${seed}: ${e.message}`); });
    });
    if (!/^ok/.test(res)) bad++;
    console.log(res);
  }
  process.exit(bad ? 1 : 0);
} else {
  const { default: R } = await import('@dimforge/rapier3d-compat');
  await R.init();
  const { snap, seed, frames, sab } = workerData, prog = new Int32Array(sab);
  const world = R.World.restoreSnapshot(new Uint8Array(Buffer.from(snap, 'base64')));
  world.timestep = 1 / 60;
  const boxes = [];
  let col = null;
  world.forEachCollider((c) => {
    if (c.shapeType() === R.ShapeType.Capsule) col = c;
    else if (c.shapeType() === R.ShapeType.Cuboid) { const t = c.translation(), h = c.halfExtents(); boxes.push({ t: [t.x, t.y, t.z], he: [h.x, h.y, h.z] }); }
  });
  const groups = (m, f) => ((m & 0xffff) << 16) | (f & 0xffff);
  if (!col) col = world.createCollider(R.ColliderDesc.capsule(0.55, 0.35).setCollisionGroups(groups(2, 1)));
  const kcc = world.createCharacterController(0.02);
  kcc.setUp({ x: 0, y: 1, z: 0 }); kcc.setMaxSlopeClimbAngle(50 * Math.PI / 180); kcc.setMinSlopeSlideAngle(55 * Math.PI / 180);
  kcc.enableAutostep(0.45, 0.15, false); kcc.enableSnapToGround(0.35); kcc.setApplyImpulsesToDynamicBodies(true); kcc.setCharacterMass(80);
  const flags = R.QueryFilterFlags.EXCLUDE_SENSORS, filt = groups(0xffff, 1);
  const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (const b of boxes) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], b.t[k]); hi[k] = Math.max(hi[k], b.t[k]); }
  let s = (seed * 2654435761) >>> 0 || 1;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  const pos = { x: 0, y: 1, z: 0 }; let height = 1.8, vy = 0, accum = 0;
  const sync = () => col.setTranslation({ x: pos.x, y: pos.y + height / 2, z: pos.z });
  for (let f = 0; f < frames; f++) {
    prog[0] = f;
    const r = rnd();
    if (r < 0.03 && boxes.length) { // teleport into/onto a random box (often deep inside geometry)
      const b = boxes[Math.floor(rnd() * boxes.length)];
      pos.x = b.t[0] + (rnd() - 0.5) * 2 * b.he[0]; pos.y = b.t[1] + (rnd() - 0.5) * 2 * b.he[1] - 0.9; pos.z = b.t[2] + (rnd() - 0.5) * 2 * b.he[2]; sync();
    } else if (r < 0.05) { pos.x = lo[0] + rnd() * (hi[0] - lo[0]); pos.y = rnd() * 10; pos.z = lo[2] + rnd() * (hi[2] - lo[2]); sync(); }
    if (rnd() < 0.05) { height = [1.8, 1.2, 1.0][Math.floor(rnd() * 3)]; col.setHalfHeight(Math.max(0.05, (height - 0.7) / 2)); sync(); }
    if (rnd() < 0.05) vy = 6;
    const dt = rnd() < 0.1 ? 0.1 : rnd() < 0.5 ? 1 / 30 : 0.05;
    vy -= 20 * dt;
    const sp = rnd() < 0.2 ? 12 : 5, a = rnd() * 6.283;
    const d = { x: Math.cos(a) * sp * dt, y: vy * dt, z: Math.sin(a) * sp * dt };
    kcc.computeColliderMovement(col, d, flags, filt);
    const m = kcc.computedMovement(); if (kcc.computedGrounded()) vy = Math.max(vy, -2);
    if (rnd() < 0.3) { // Player._tryStep: up, across, down
      const cy = pos.y + height / 2;
      kcc.computeColliderMovement(col, { x: 0, y: 0.45, z: 0 }, flags, filt); const up = kcc.computedMovement().y;
      col.setTranslation({ x: pos.x, y: cy + up, z: pos.z });
      kcc.computeColliderMovement(col, { x: d.x, y: 0, z: d.z }, flags, filt); const am = kcc.computedMovement();
      col.setTranslation({ x: pos.x + am.x, y: cy + up, z: pos.z + am.z });
      kcc.computeColliderMovement(col, { x: 0, y: -(up + 0.1), z: 0 }, flags, filt);
    }
    pos.x += m.x; pos.y += m.y; pos.z += m.z;
    if (pos.y < -50) { pos.y = 2; vy = 0; }
    sync();
    accum += Math.min(dt, 0.1);
    for (let n = 0; accum >= world.timestep && n < 8; n++) { world.step(); accum -= world.timestep; }
  }
  parentPort.postMessage(`ok seed ${seed}: ${frames} frames`);
}
