// Extract clean gait cycles from 100STYLE BVH files and retarget the lower body onto the Mixamo (Bamen) rig.
import * as THREE from 'three';
import { BVHLoader } from 'three/addons/loaders/BVHLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import fs from 'node:fs';

const S100 = process.env.S100 || '../style100/100STYLE/';
const cuts = Object.fromEntries(fs.readFileSync(S100 + 'Frame_Cuts.csv', 'utf8').trim().split('\n').slice(1).map((l) => { const c = l.split(','); return [c[0], c]; }));
const COLS = ['BR', 'BW', 'FR', 'FW', 'ID', 'SR', 'SW', 'TR1'];
const cutOf = (style, kind) => { const c = cuts[style]; const i = COLS.indexOf(kind); return [+c[1 + i * 2], +c[2 + i * 2]]; };

const J = ['Hips', 'Chest', 'LeftHip', 'LeftKnee', 'LeftAnkle', 'LeftToe', 'RightHip', 'RightKnee', 'RightAnkle', 'RightToe'];
const LEND = (b) => b.children[0]; // end sites
function loadBVH(file) {
  const res = new BVHLoader().parse(fs.readFileSync(file, 'utf8'));
  const root = res.skeleton.bones[0], holder = new THREE.Object3D(); holder.add(root);
  const mixer = new THREE.AnimationMixer(holder), act = mixer.clipAction(res.clip); act.play();
  const by = Object.fromEntries(res.skeleton.bones.map((b) => [b.name, b]));
  const dt = res.clip.tracks[0].times[1] - res.clip.tracks[0].times[0], N = res.clip.tracks[0].times.length;
  const frames = [];
  for (let f = 0; f < N; f++) {
    act.time = f * dt; mixer.update(0); holder.updateMatrixWorld(true);
    const o = {}; for (const j of J) o[j] = by[j].getWorldPosition(new THREE.Vector3());
    o.LeftToeEnd = (by.LeftToe.children.find((c) => c.isBone) || by.LeftToe).getWorldPosition(new THREE.Vector3());
    o.RightToeEnd = (by.RightToe.children.find((c) => c.isBone) || by.RightToe).getWorldPosition(new THREE.Vector3());
    frames.push(o);
  }
  return { frames, dt, N };
}
const unwrap = (a) => { const o = [a[0]]; for (let i = 1; i < a.length; i++) { let d = a[i] - a[i - 1]; d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI; o.push(o[i - 1] + d); } return o; };
const smoothArr = (a, r) => a.map((_, i) => { let s = 0, n = 0; for (let k = -r; k <= r; k++) { const j = i + k; if (j >= 0 && j < a.length) { s += a[j]; n++; } } return s / n; });

// facing yaw: forward = up x right(pelvis), right = RightHip - LeftHip; yaw = atan2(fwd.x, fwd.z)
function analyse(F, dt) {
  const yaw = unwrap(F.map((o) => { const r = o.RightHip.clone().sub(o.LeftHip); return Math.atan2(r.z, -r.x); }));
  // check: right = (-1,0,0) for facing +Z → atan2(0, 1) = 0 ✓
  const ys = smoothArr(yaw, 20);
  const vel = F.map((o, i) => { const a = F[Math.max(0, i - 3)].Hips, b = F[Math.min(F.length - 1, i + 3)].Hips; const v = b.clone().sub(a).divideScalar((Math.min(F.length - 1, i + 3) - Math.max(0, i - 3)) * dt); v.y = 0; return v; });
  const local = vel.map((v, i) => { const c = Math.cos(ys[i]), s = Math.sin(ys[i]); return { f: v.x * s + v.z * c, r: -(v.x * c - v.z * s) }; }); // fwd=(sin,0,cos), right=(-cos,0,sin)... see below
  return { yaw: ys, local };
}

function strikes(F, side, a, b) { // indices of foot contact starts (ankle near its local minimum height)
  const h = F.map((o) => o[side + 'Ankle'].y);
  let minH = Infinity; for (let i = a; i < b; i++) minH = Math.min(minH, h[i]);
  const out = [];
  for (let i = a + 2; i < b - 2; i++) if (h[i] < minH + 3 && h[i - 2] >= minH + 3) out.push(i);
  return out;
}

export function findCycle(style, kind, want /* 'F','B','L','R','I' */, opts = {}) {
  const file = S100 + `${style}/${style}_${kind}.bvh`;
  const { frames: F, dt } = loadBVH(file);
  const [c0, c1] = cutOf(style, kind);
  const { yaw, local } = analyse(F, dt);
  const dirAng = { F: 0, R: Math.PI / 2, B: Math.PI, L: -Math.PI / 2 }[want];
  const ls = strikes(F, 'Left', c0, Math.min(c1, F.length));
  let best = null;
  for (let k = 0; k + 1 < ls.length; k++) {
    const s = ls[k], e = ls[k + 1], n = e - s;
    if (n < 0.6 / dt || n > 1.8 / dt) continue;
    let vf = 0, vr = 0; for (let i = s; i < e; i++) { vf += local[i].f; vr += local[i].r; } vf /= n; vr /= n;
    const sp = Math.hypot(vf, vr) / 100;
    if (want !== 'I' && sp < (opts.minSpeed ?? 0.4)) continue;
    const ang = Math.atan2(vr, vf);
    let dErr = Math.abs(((ang - dirAng + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    if (dErr > 0.35) continue;
    const dyaw = Math.abs(yaw[e] - yaw[s]);
    if (dyaw > 0.25) continue;
    // speed steadiness
    let sv = 0; for (let i = s; i < e; i++) sv += (Math.hypot(local[i].f, local[i].r) / 100 - sp) ** 2; sv = Math.sqrt(sv / n);
    // loop closure: leg pose (relative to hips, in facing frame) at s vs e
    const rel = (i, j) => { const c = Math.cos(-yaw[i]), sn = Math.sin(-yaw[i]); const p = F[i][j].clone().sub(F[i].Hips); return new THREE.Vector3(p.x * c + p.z * sn, p.y, -p.x * sn + p.z * c); };
    let close = 0; for (const j of ['LeftKnee', 'LeftAnkle', 'RightKnee', 'RightAnkle', 'LeftToe', 'RightToe']) close += rel(s, j).distanceTo(rel(e, j));
    const score = close + dErr * 30 + dyaw * 40 + sv * 30;
    if (!best || score < best.score) best = { s, e, sp, ang, score, close, dyaw, dErr, sv };
  }
  return { file, F, dt, yaw, best };
}

if (process.argv[2] === 'scan') {
  for (const [style, kind] of [['Swat', 'FW'], ['Swat', 'FR'], ['Swat', 'BW'], ['Swat', 'BR'], ['Swat', 'SW'], ['Swat', 'SR'], ['Crouched', 'FW'], ['Crouched', 'BW'], ['Crouched', 'SW'], ['Neutral', 'FR'], ['Neutral', 'FW']]) {
    for (const want of kind[0] === 'F' ? ['F'] : kind[0] === 'B' ? ['B'] : ['L', 'R']) {
      const r = findCycle(style, kind, want);
      const b = r.best;
      console.log(style, kind, want, b ? `frames ${b.s}-${b.e} dur ${((b.e - b.s) * r.dt).toFixed(2)}s speed ${b.sp.toFixed(2)} dirErr ${(b.dErr * 57).toFixed(0)}° dyaw ${(b.dyaw * 57).toFixed(0)}° close ${b.close.toFixed(1)}cm sv ${b.sv.toFixed(2)}` : 'NONE');
    }
  }
}
