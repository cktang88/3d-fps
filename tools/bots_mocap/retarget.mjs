// Retarget an extracted 100STYLE cycle (lower body) onto the Mixamo-named Bamen rig → THREE.AnimationClip.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import fs from 'node:fs';
import { findCycle } from './extract.mjs';
const ALIGN = +(process.env.ALIGN ?? -1);

const buf = fs.readFileSync('/home/user/3d-fps/public/assets/models/characters/soldier.glb');
const gltf = await new Promise((res, rej) => new GLTFLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length), '', res, rej));
const scene = gltf.scene; scene.updateMatrixWorld(true);
const T = {}; scene.traverse((o) => { if (o.isBone) T[o.name.replace(/^mixamorig:?/, '')] = o; });
const V = () => new THREE.Vector3(), wp = (o) => o.getWorldPosition(V()), wq = (o) => o.getWorldQuaternion(new THREE.Quaternion());
// Rest (bind) reference of the target.
const rest = {};
for (const k of ['Hips', 'Spine', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase', 'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase', 'LeftToe_End', 'RightToe_End']) rest[k] = { p: wp(T[k]), q: wq(T[k]) };
const tRight = rest.RightUpLeg.p.clone().sub(rest.LeftUpLeg.p); // target pelvis right (world)
const legT = rest.Hips.p.y - rest.LeftFoot.p.y;
const UP = new THREE.Vector3(0, 1, 0);
// orthonormal frame from (dir, ref)
const frame = (d, r) => { const y = d.clone().normalize(); const x = r.clone().addScaledVector(y, -r.dot(y)).normalize(); const z = new THREE.Vector3().crossVectors(x, y); return new THREE.Matrix4().makeBasis(x, y, z); };
const rotBetween = (d0, r0, d1, r1) => { const m = frame(d1, r1).multiply(frame(d0, r0).transpose()); return new THREE.Quaternion().setFromRotationMatrix(m); };

function kneeAxis(hip, knee, ankle, pelvisRight) {
  const a = knee.clone().sub(hip).normalize(), b = ankle.clone().sub(knee).normalize();
  const c = new THREE.Vector3().crossVectors(a, b); const L = c.length();
  if (c.dot(pelvisRight) < 0) c.negate();
  const k = Math.min(1, L / 0.25);
  return c.normalize().multiplyScalar(k).addScaledVector(pelvisRight.clone().normalize(), 1 - k).normalize();
}

/**
 * @returns AnimationClip with tracks for hips (position+quaternion) and both legs, named for three's
 * sanitized Bamen bones (mixamorigHips …).
 */
export function retargetCycle(style, kind, want, name, opts = {}) {
  const { F, dt, yaw, best } = findCycle(style, kind, want, opts);
  if (!best) throw new Error('no cycle ' + style + kind + want);
  const { s, e } = best;
  const dirAng = { F: 0, R: Math.PI / 2, B: Math.PI, L: -Math.PI / 2, I: 0 }[want];
  const travelOff = ((best.ang - dirAng + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  const n = e - s;
  // canonical frame: facing yaw linearly detrended across the cycle, origin = linear hips trajectory
  const y0 = yaw[s], y1 = yaw[e];
  const h0 = F[s].Hips.clone(), h1 = F[e].Hips.clone();
  const srcLeg = ((F[s].Hips.y - F[s].LeftAnkle.y) + (F[s].Hips.y - F[s].RightAnkle.y)) / 2; // approx (ankle)
  const legS = F.slice(s, e).reduce((m, o) => Math.max(m, o.Hips.y - Math.min(o.LeftAnkle.y, o.RightAnkle.y)), 0);
  const tAnkleLeg = rest.Hips.p.y - rest.LeftFoot.p.y;
  const k = tAnkleLeg / legS;
  const fps = 30, outN = Math.round(n * dt * fps);
  const times = [], hipsP = [], quats = { Hips: [], LeftUpLeg: [], LeftLeg: [], LeftFoot: [], RightUpLeg: [], RightLeg: [], RightFoot: [] };
  const sampleAt = (fi) => { // fractional frame → canonical joint positions
    const i0 = Math.floor(fi), i1 = Math.min(F.length - 1, i0 + 1), t = fi - i0, o = {};
    const u = (fi - s) / n;
    const yw = y0 + (y1 - y0) * u + ALIGN * travelOff; // detrended facing, rotated so travel is exactly along the class direction
    const org = h0.clone().lerp(h1, u); org.y = 0;
    const c = Math.cos(-yw), sn = Math.sin(-yw);
    for (const j of Object.keys(F[i0])) {
      const p = F[i0][j].clone().lerp(F[i1][j], t).sub(org);
      o[j] = new THREE.Vector3(p.x * c + p.z * sn, p.y, -p.x * sn + p.z * c).multiplyScalar(k);
    }
    return o;
  };
  const blendN = 0.18; // crossfade the last 18% of the cycle toward the start pose (loop closure)
  for (let i = 0; i < outN; i++) {
    const u = i / outN, fi = s + u * n;
    let o = sampleAt(fi);
    if (u > 1 - blendN) { // blend toward the start-equivalent pose (frame s + (u-1)*n, i.e. before the start)
      const w = (u - (1 - blendN)) / blendN, wS = w * w * (3 - 2 * w);
      const o2 = sampleAt(Math.max(0, s + (u - 1) * n));
      // o2 is in a frame defined for u<0 (extrapolated linear trajectory) → consistent canonical space
      for (const j of Object.keys(o)) o[j].lerp(o2[j], wS);
    }
    times.push(i / fps);
    // --- hips ---
    const pelvisR = o.RightHip.clone().sub(o.LeftHip);
    const spineD = o.Chest.clone().sub(o.Hips);
    const qH = rotBetween(rest.Spine.p.clone().sub(rest.Hips.p), tRight, spineD, pelvisR).multiply(rest.Hips.q);
    // hips position: target world → hips parent local
    const hp = new THREE.Vector3(o.Hips.x, o.Hips.y + (rest.LeftFoot.p.y), o.Hips.z);
    const world = { Hips: qH };
    // --- legs ---
    for (const side of ['Left', 'Right']) {
      const hip = o[side + 'Hip'], knee = o[side + 'Knee'], ank = o[side + 'Ankle'], toe = o[side + 'Toe'];
      const kAx = kneeAxis(hip, knee, ank, pelvisR);
      const rUp = rest[side + 'UpLeg'], rLeg = rest[side + 'Leg'], rFoot = rest[side + 'Foot'], rToe = rest[side + 'ToeBase'];
      world[side + 'UpLeg'] = rotBetween(rLeg.p.clone().sub(rUp.p), tRight, knee.clone().sub(hip), kAx).multiply(rUp.q);
      world[side + 'Leg'] = rotBetween(rFoot.p.clone().sub(rLeg.p), tRight, ank.clone().sub(knee), kAx).multiply(rLeg.q);
      const fd0 = rToe.p.clone().sub(rFoot.p), fd1 = toe.clone().sub(ank);
      world[side + 'Foot'] = rotBetween(fd0, new THREE.Vector3().crossVectors(fd0, UP).negate(), fd1, new THREE.Vector3().crossVectors(fd1, UP).negate()).multiply(rFoot.q);
    }
    // world → local (parents: hips parent fixed, UpLeg←Hips, Leg←UpLeg, Foot←Leg)
    const hipsParentQ = wq(T.Hips.parent), hipsParentM = T.Hips.parent.matrixWorld.clone().invert();
    const loc = (q, parentWorld) => parentWorld.clone().invert().multiply(q);
    quats.Hips.push(...loc(world.Hips, hipsParentQ).toArray());
    hipsP.push(...hp.applyMatrix4(hipsParentM).toArray());
    for (const side of ['Left', 'Right']) {
      quats[side + 'UpLeg'].push(...loc(world[side + 'UpLeg'], world.Hips).toArray());
      quats[side + 'Leg'].push(...loc(world[side + 'Leg'], world[side + 'UpLeg']).toArray());
      quats[side + 'Foot'].push(...loc(world[side + 'Foot'], world[side + 'Leg']).toArray());
    }
  }
  const dur = outN / fps;
  // close the loop exactly: append first key at t = dur
  times.push(dur); hipsP.push(...hipsP.slice(0, 3)); for (const k2 in quats) quats[k2].push(...quats[k2].slice(0, 4));
  const tracks = [new THREE.VectorKeyframeTrack('mixamorigHips.position', times, hipsP)];
  for (const k2 in quats) tracks.push(new THREE.QuaternionKeyframeTrack(`mixamorig${k2}.quaternion`, times, quats[k2]));
  const clip = new THREE.AnimationClip(name, dur, tracks);
  clip.userData = { speedPerLeg: best.sp / (legS / 100), srcSpeed: best.sp, srcLeg: legS / 100, dir: want, close: best.close };
  return clip;
}

if (process.argv[2] === 'test') {
  const c = retargetCycle('Swat', 'FW', 'F', 'test');
  console.log(c.name, c.duration, c.userData, c.tracks.map((t) => t.name + ':' + t.times.length));
}
