// Headless spray test for weapon recoil + spread tuning (no browser). Drives the real Weapon / AimRecoil logic
// with the same per-frame flow as Game.js, records the angular impact of every bullet relative to the original
// aim point and reports group sizes on a 10 / 25 / 50 m wall.
//   node tools/spray_sim.mjs [--json] [--runs N] [--weapons m4,ak] [--old <root with src/game/weapons (pre-change)>]
// Cases: auto (full mag, no compensation), autoC (full mag, simulated pull-down), burst3C (3-round bursts),
// tapC (aimed single taps every 0.4 s), hip10 (10-shot hip spray). C = simulated compensation: a decent
// player correcting what they saw ~100 ms ago (gain 9/s vertical, 6/s horizontal, max 30 deg/s).
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const oldRoot = opt('--old', null);
const RUNS = +opt('--runs', 24);
const root = oldRoot ? path.resolve(oldRoot) : path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
const { Weapon } = await imp('src/game/weapons/Weapon.js');
const { WEAPONS, PRIMARY_LIST, SECONDARY_LIST } = await imp('src/game/weapons/WeaponDefs.js');
const AimRecoil = oldRoot ? null : (await imp('src/game/weapons/Recoil.js')).AimRecoil;
const DEG = Math.PI / 180;
const ids = (opt('--weapons', null)?.split(',')) || [...PRIMARY_LIST, ...SECONDARY_LIST];
const DT = 1 / 60;

// Old Game.js recoil handling (pre-change), for the baseline.
class OldRecoil {
  constructor() { this.x = 0; this.y = 0; }
  add(p, y, aim) { aim.p += p; aim.y += y; this.x += p; this.y += y; }
  look(dP) { if (dP < 0 && this.x > 0) this.x = Math.max(0, this.x + dP); }
  update(dt, w, aim) {
    if (w.time - w.lastShotTime > Math.max(0.12, 60 / w.stats.rpm * 1.2) || w.lastShotTime < 0) {
      const rate = 9 * DEG * dt * (w.stats.recoveryMul ?? 1);
      const rx = Math.min(this.x, rate); aim.p -= rx; this.x -= rx;
      const ry = Math.max(-rate * 0.5, Math.min(rate * 0.5, this.y)); aim.y -= ry; this.y -= ry;
    }
  }
}
class NewRecoil {
  constructor() { this.r = new AimRecoil(); }
  add(p, y) { this.r.add(p, y); }
  look(dP, dY) { this.r.look(dP, dY); }
  update(dt, w, aim) { const d = this.r.update(dt, w); aim.p += d.dp; aim.y += d.dy; }
}

function sampleSpread(spDeg) {
  if (spDeg <= 0) return [0, 0];
  const r = Math.atan(Math.tan(spDeg * DEG) * Math.pow(Math.random(), 0.65)) / DEG, a = Math.random() * Math.PI * 2;
  return [Math.cos(a) * r, Math.sin(a) * r];
}

function runCase(id, kind, ctxExtra = {}) {
  const def = WEAPONS[id];
  const w = new Weapon(id, def.defaults || {});
  w.state = 'idle';
  const s = w.stats;
  const ads = kind !== 'hip10';
  const comp = kind.endsWith('C');
  const rec = oldRoot ? new OldRecoil() : new NewRecoil();
  const aim = { p: 0, y: 0 };
  const hist = [];
  const hits = [];
  // Pre-aim.
  for (let i = 0; i < 60; i++) w.update(DT, { aim: ads, fire: false, firePressed: false, canFire: true, ...ctxExtra });
  const pref = kind === 'tapC' ? ['semi', 'bolt', 'pump'] : kind === 'burst3C' ? ['burst', 'auto', 'semi'] : ['auto', 'semi'];
  const pick = pref.find((m) => s.modes.includes(m));
  if (pick) while (w.mode !== pick) w.cycleMode();
  const mode = w.mode;
  const bolt = mode === 'bolt' || mode === 'pump';
  let t = 0, shots = 0, phaseShots = 0, gapUntil = 0, held = false;
  const want = kind === 'hip10' ? 10 : kind === 'burst3C' ? 15 : kind === 'tapC' ? (bolt ? 5 : 8) : s.mag;
  const T = 12;
  let lastPress = -9;
  while (t < T && shots < want) {
    t += DT;
    // Simulated compensation: correct the error observed `lag` ago.
    // Tapping: a disciplined shooter lets the sights settle before correcting (no chasing the flip).
    if (comp && !(kind === 'tapC' && w.time - w.lastShotTime < (bolt ? 0.7 : 0.3))) {
      const lagN = Math.round(0.1 / DT);
      const h = hist.length > lagN ? hist[hist.length - 1 - lagN] : { p: 0, y: 0 };
      const ep = h.p, ey = h.y;
      const cap = 30 * DEG * DT;
      const dp = Math.abs(ep) > 0.03 * DEG ? Math.max(-cap, Math.min(cap, -ep * 9 * DT)) : 0;
      const dy = Math.abs(ey) > 0.03 * DEG ? Math.max(-cap, Math.min(cap, -ey * 6 * DT)) : 0;
      aim.p += dp; aim.y += dy; rec.look(dp, dy);
    }
    // Trigger schedule.
    let fire = false, pressed = false;
    if (kind === 'auto' || kind === 'autoC' || kind === 'hip10') {
      if (mode === 'auto') { fire = true; pressed = !held; }
      else if (w.state === 'idle' && t - lastPress > 60 / s.rpm + DT) { fire = pressed = true; } // spam semi
    } else if (kind === 'burst3C') {
      if (t >= gapUntil) {
        if (mode === 'auto') { fire = true; pressed = !held; }
        else if (mode === 'burst') { if (!held && w.burstLeft === 0) { fire = pressed = true; } }
        else if (w.state === 'idle' && t - lastPress > 60 / s.rpm + DT) { fire = pressed = true; }
      }
    } else if (kind === 'tapC') {
      if (t >= gapUntil && w.state === 'idle') { fire = pressed = true; }
    }
    if (pressed) lastPress = t;
    held = fire;
    const before = w.ammo;
    const out = w.update(DT, { aim: ads, fire, firePressed: pressed, canFire: true, crouched: false, moveF: 0, airborne: false, ...ctxExtra });
    for (const shot of out) {
      const sp = oldRoot ? (w.shotIndex <= 1 && w.adsT > 0.9 ? 0 : w.currentSpread(0, false, false)) : shot.spread;
      const [ox, oy] = sampleSpread(s.pellets > 1 ? 0 : sp);
      hits.push([-aim.y / DEG + ox, aim.p / DEG + oy]); // [right, up] degrees
      rec.add(shot.pitch, shot.yaw, aim);
      shots++; phaseShots++;
      if (kind === 'burst3C' && phaseShots >= 3) { phaseShots = 0; gapUntil = t + 0.35; held = false; if (mode === 'burst') gapUntil = t + 0.3; }
      if (kind === 'tapC') gapUntil = t + (bolt ? 0.3 : 0.4);
    }
    if (kind === 'burst3C' && mode === 'auto' && t < gapUntil) held = false;
    if (before !== w.ammo && kind === 'burst3C' && mode === 'auto' && phaseShots === 0) held = false;
    rec.update(DT, w, aim);
    hist.push({ p: aim.p, y: aim.y });
  }
  // Let it settle 1.5 s with hands off: residual = how far the sights ended from the target.
  for (let i = 0; i < 90; i++) { w.update(DT, { aim: ads, fire: false, firePressed: false, canFire: true }); rec.update(DT, w, aim); }
  return { hits, residual: [-aim.y / DEG, aim.p / DEG] };
}

// Stats on a wall at distance D (m): torso box 0.45 x 0.6 m centred on the aim point, head disc r = 0.1 m.
function stats(hits, D) {
  const pts = hits.map(([x, y]) => [D * Math.tan(x * DEG), D * Math.tan(y * DEG)]);
  const torso = pts.filter(([x, y]) => Math.abs(x) <= 0.225 && Math.abs(y) <= 0.3).length / pts.length;
  const r = pts.map(([x, y]) => Math.hypot(x, y)).sort((a, b) => a - b);
  const med = r[Math.floor(r.length / 2)];
  let es = 0; for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) es = Math.max(es, Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]));
  const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length, my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  return { torso, med, es, mx, my };
}

const KINDS = ['auto', 'autoC', 'autoCrouchC', 'burst3C', 'tapC', 'hip10'];
const result = {};
for (const id of ids) {
  const def = WEAPONS[id];
  const bolt = def.modes[0] === 'bolt' || def.modes[0] === 'pump';
  result[id] = {};
  for (const kind of KINDS) {
    if (bolt && kind !== 'tapC') continue;
    if (kind === 'autoCrouchC' && !['m4', 'ak', 'rpk'].includes(id)) continue;
    const agg = { 10: [], 25: [], 50: [] }; let resid = [0, 0]; let n = 0; const sample = [];
    for (let r = 0; r < RUNS; r++) {
      const { hits, residual } = kind === 'autoCrouchC' ? runCase(id, 'autoC', { crouched: true }) : runCase(id, kind);
      if (r === 0) sample.push(...hits);
      n = hits.length; resid = [resid[0] + residual[0] / RUNS, resid[1] + residual[1] / RUNS];
      for (const D of [10, 25, 50]) agg[D].push(stats(hits, D));
    }
    const avg = (arr, k) => arr.reduce((a, s) => a + s[k], 0) / arr.length;
    result[id][kind] = { shots: n, residualDeg: resid.map((v) => +v.toFixed(2)), sample: sample.map(([x, y]) => [+x.toFixed(3), +y.toFixed(3)]) };
    for (const D of [10, 25, 50]) result[id][kind][D] = { torsoPct: Math.round(avg(agg[D], 'torso') * 100), medCm: Math.round(avg(agg[D], 'med') * 100), esCm: Math.round(avg(agg[D], 'es') * 100), mpiCm: [Math.round(avg(agg[D], 'mx') * 100), Math.round(avg(agg[D], 'my') * 100)] };
  }
}
if (args.includes('--json')) { console.log(JSON.stringify(result)); process.exit(0); }
console.log(`${oldRoot ? 'OLD' : 'NEW'} code — torso hit % (45x60 cm box) | median radius cm @10/25/50 m | residual after release (deg right, up)`);
for (const id of ids) for (const [kind, r] of Object.entries(result[id])) {
  const f = (D) => `${String(r[D].torsoPct).padStart(3)}% ${String(r[D].medCm).padStart(4)}cm`;
  console.log(`${id.padEnd(6)} ${kind.padEnd(8)} n=${String(r.shots).padStart(2)}  10m ${f(10)} | 25m ${f(25)} | 50m ${f(50)} | ES25 ${String(r[25].esCm).padStart(4)}cm  MPI25 ${r[25].mpiCm.join(',').padStart(8)}  resid ${r.residualDeg.join(',')}`);
}
