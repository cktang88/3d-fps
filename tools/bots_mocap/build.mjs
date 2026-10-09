// Rebuild the bots' 100STYLE (CC BY 4.0) locomotion clips. Steps: extract the Swat/Crouched/Neutral BVHs +
// Frame_Cuts.csv from https://zenodo.org/records/8127870 (100STYLE.zip) into S100 below, run `node build.mjs`
// (writes clips.json), then `node addclips.mjs <soldier.glb> clips.json <out.glb>` (needs @gltf-transform/*).
// Gait cycles are picked left-strike to left-strike, detrended, loop-closed and retargeted onto the Mixamo rig.
// Build mocap lower-body locomotion clips (100STYLE, CC BY 4.0) on the Bamen rig and append them to soldier.glb.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import fs from 'node:fs';
import { retargetCycle } from './retarget.mjs';
const SRC = '/home/user/3d-fps/public/assets/models/characters/soldier.glb';
const buf = fs.readFileSync(SRC);
const gltf = await new Promise((res, rej) => new GLTFLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length), '', res, rej));
const g = gltf.scene; const T = {}; g.traverse((o) => { if (o.isBone) T[o.name.replace(/^mixamorig:?/, '')] = o; });
g.updateMatrixWorld(true);
const legT = T.Hips.getWorldPosition(new THREE.Vector3()).y - T.LeftFoot.getWorldPosition(new THREE.Vector3()).y;
const mixer = new THREE.AnimationMixer(g);
function slip(clip, dir, spLeg) {
  const sp = spLeg * legT; mixer.stopAllAction(); const a = mixer.clipAction(clip); a.reset().play();
  const dirV = { F: [0, 0, 1], B: [0, 0, -1], L: [1, 0, 0], R: [-1, 0, 0] }[dir];
  const N = 90, dt = clip.duration / N; let prev = null; const s = [];
  for (let i = 0; i <= N * 2; i++) { a.time = (i * dt) % clip.duration; mixer.update(0); g.position.set(dirV[0] * sp * i * dt, 0, dirV[2] * sp * i * dt); g.updateMatrixWorld(true);
    const l = T.LeftFoot.getWorldPosition(new THREE.Vector3()), r = T.RightFoot.getWorldPosition(new THREE.Vector3());
    if (prev) { const [lo, p] = l.y < r.y ? [l, prev[0]] : [r, prev[1]]; s.push(Math.hypot(lo.x - p.x, lo.z - p.z) / dt / legT); } prev = [l, r]; }
  s.sort((x, y) => x - y); mixer.uncacheClip(clip); return s[s.length >> 2];
}
const SPECS = [
  ['walk_F', 'Swat', 'FW', 'F'], ['walk_B', 'Swat', 'BW', 'B'], ['walk_L', 'Swat', 'SW', 'L'], ['walk_R', 'Swat', 'SW', 'R'],
  ['jog_F', 'Swat', 'FR', 'F'], ['jog_B', 'Swat', 'BR', 'B'], ['jog_L', 'Swat', 'SR', 'L'],
  ['crouch_F', 'Crouched', 'FW', 'F'], ['crouch_B', 'Crouched', 'BW', 'B'], ['crouch_L', 'Crouched', 'SW', 'L'], ['crouch_R', 'Crouched', 'SW', 'R'],
];
const out = [];
for (const [name, st, kind, dir] of SPECS) {
  let clip;
  try { clip = retargetCycle(st, kind, dir, name); } catch (e) { console.log('skip', name, e.message); continue; }
  let best = { sm: 1, s: Infinity };
  for (let sm = 0.6; sm <= 1.3; sm += 0.05) { const s = slip(clip, dir, clip.userData.speedPerLeg * sm); if (s < best.s) best = { sm, s }; }
  const spLeg = clip.userData.speedPerLeg * best.sm;
  console.log(name, st, kind, dir, 'dur', clip.duration.toFixed(2), 'speed leg/s', spLeg.toFixed(3), 'slip p25', best.s.toFixed(3), 'close', clip.userData.close.toFixed(1));
  clip.name = `mocap_${name}@${spLeg.toFixed(4)}`;
  out.push(clip);
}
fs.writeFileSync('clips.json', JSON.stringify(out.map((c) => THREE.AnimationClip.toJSON(c))));
console.log('wrote', out.length);
