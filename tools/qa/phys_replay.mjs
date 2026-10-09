// Deterministic offline replay of a physics hang bundle.
//   node tools/qa/phys_replay.mjs <physRepro.json> [--fix]
// The bundle comes from Physics.reproBundle() (window.__physRepro()), which the QA runner saves as
// tools/qa/results/<id>/physRepro.json when a job hangs. Each checkpoint is a world snapshot taken between steps plus
// the player collider pose/half-height before every following physics frame and the number of world.step() calls.
// The replay runs in a worker; if a step makes no progress for 10 s it reports the frame and sub-step that hung.
// --fix replays through Physics.js' guarded step path instead of raw world.step() (to verify a fix).
import { Worker, isMainThread, workerData } from 'node:worker_threads';
import fs from 'node:fs';

if (isMainThread) {
  const file = process.argv[2];
  if (!file) { console.log('usage: node tools/qa/phys_replay.mjs <physRepro.json> [--fix]'); process.exit(2); }
  const sab = new SharedArrayBuffer(16);
  const prog = new Int32Array(sab); // [checkpoint, frame index in log, sub-step, done]
  const w = new Worker(new URL(import.meta.url), { workerData: { file, sab, fix: process.argv.includes('--fix') } });
  let last = '', still = 0;
  const iv = setInterval(() => {
    const cur = `${prog[0]}/${prog[1]}/${prog[2]}`;
    if (cur === last && !prog[3]) still++; else { still = 0; last = cur; }
    if (still >= 20) {
      console.log(`HANG: checkpoint ${prog[0]}, log entry ${prog[1]}, sub-step ${prog[2]} did not return within 10 s`);
      clearInterval(iv); w.terminate(); process.exitCode = 1;
    }
  }, 500);
  w.on('message', (m) => console.log(m));
  w.on('exit', () => clearInterval(iv));
  w.on('error', (e) => { console.log('worker error', e); clearInterval(iv); });
} else {
  const { default: RAPIER } = await import('@dimforge/rapier3d-compat');
  await RAPIER.init();
  const { parentPort } = await import('node:worker_threads');
  const prog = new Int32Array(workerData.sab);
  const B = JSON.parse(fs.readFileSync(workerData.file, 'utf8'));
  let guardStep = null;
  if (workerData.fix) {
    const { Physics } = await import('../../src/core/Physics.js');
    guardStep = (phys) => phys.safeWorldStep();
    globalThis.__PhysicsClass = Physics;
  }
  parentPort.postMessage(`bundle: frame ${B.frame}, ${B.checkpoints.length} checkpoint(s), log lengths ${B.checkpoints.map((c) => c.log.length)}`);
  for (const [ci, ck] of B.checkpoints.entries()) {
    const world = RAPIER.World.restoreSnapshot(new Uint8Array(Buffer.from(ck.snap, 'base64')));
    world.timestep = B.timestep;
    let pc = null;
    world.forEachCollider((c) => { if (c.shapeType() === RAPIER.ShapeType.Capsule) pc = c; }); // the player: the only capsule (parent() is unreliable after restore)
    let phys = null;
    if (guardStep) { phys = Object.create(globalThis.__PhysicsClass.prototype); phys.R = RAPIER; phys.world = world; phys.playerCollider = pc; phys.stepFailures = 0; }
    prog[0] = ci;
    for (const [i, e] of ck.log.entries()) {
      prog[1] = i;
      const [x, y, z, hh, n] = e;
      if (pc && x !== null) { pc.setTranslation({ x, y, z }); if (Math.abs(pc.halfHeight() - hh) > 1e-7) pc.setHalfHeight(hh); }
      for (let k = 0; k < n; k++) { prog[2] = k; Atomics.add(prog, 3, 0); if (guardStep) guardStep(phys); else world.step(); }
    }
    const next = ck.all ? null : B.checkpoints[ci + 1];
    const same = next ? Buffer.compare(Buffer.from(world.takeSnapshot()), Buffer.from(next.snap, 'base64')) === 0 : null;
    parentPort.postMessage(`checkpoint ${ci} (frame ${ck.frame}): replayed ${ck.log.length} frames without hanging` +
      (next ? `; state ${same ? 'matches' : 'DIFFERS from'} checkpoint ${ci + 1} (replay fidelity)` : ''));
  }
  prog[3] = 1;
}
