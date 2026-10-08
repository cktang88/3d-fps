import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { damp, clamp, DEG } from '../../core/MathUtil.js';
import { POSES } from '../weapons/GunModels.js';
import { G } from '../../core/Physics.js';

/*
 * Third-person soldier: Bamen military soldier (CC-BY 4.0) with retargeted Mixamo-named clips.
 *
 * Animation stack (per bot):
 *   lower body  idle / walk / run / sprint / crouch idle / crouch walk / jump, blended by actual ground
 *               speed. Moving clips share one distance-driven gait phase (stride lengths are measured
 *               from the clips at load), so feet never slide whatever the speed; backpedal reverses it.
 *   upper body  aim (standing / crouched) with reload + throw one-shots and an additive hit flinch.
 *   procedural  spine twist + pitch toward the aim, lean into turns, fire recoil, directional flinch,
 *               left hand IK onto the weapon's support grip, gun locked to the right palm along the aim.
 *   death       either the authored backward fall (yawed to match the hit) or a knee-buckle topple in
 *               the hit direction, with knockback, weapon drop, ground settling and a late sink.
 *   LOD         distant / off-screen bots evaluate their skeleton at a reduced rate.
 */

const UPPER = /Spine|Neck|Head|Shoulder|Arm|Hand|Thumb|Index|Middle|Ring|Pinky/;

function splitClip(clip, upper) {
  const tracks = clip.tracks.filter((t) => {
    const bone = t.name.split('.')[0];
    if (bone.includes('Hips')) return !upper; // hips belong to locomotion
    return upper ? UPPER.test(bone) : !UPPER.test(bone);
  });
  return new THREE.AnimationClip(clip.name + (upper ? '_up' : '_lo'), clip.duration, tracks);
}

const BONES = {
  hips: 'mixamorigHips', spine: 'mixamorigSpine', spine1: 'mixamorigSpine1', spine2: 'mixamorigSpine2', neck: 'mixamorigNeck', head: 'mixamorigHead', headTop: 'mixamorigHeadTop_End',
  lArm: 'mixamorigLeftArm', lFore: 'mixamorigLeftForeArm', lHand: 'mixamorigLeftHand', lMid: 'mixamorigLeftHandMiddle1',
  rArm: 'mixamorigRightArm', rFore: 'mixamorigRightForeArm', rHand: 'mixamorigRightHand', rMid: 'mixamorigRightHandMiddle1',
  lUp: 'mixamorigLeftUpLeg', lLeg: 'mixamorigLeftLeg', lFoot: 'mixamorigLeftFoot', lToe: 'mixamorigLeftToeBase',
  rUp: 'mixamorigRightUpLeg', rLeg: 'mixamorigRightLeg', rFoot: 'mixamorigRightFoot', rToe: 'mixamorigRightToeBase',
};
/** Rig-independent bone key: 'mixamorig:LeftArm', 'mixamorigLeftArm', 'mixamorigLeftArm_033' → 'LeftArm'. */
const boneKey = (n) => n.replace(/^mixamorig:?/, '').replace(/_\d+$/, '');
function findBones(root) {
  const out = {};
  const byKey = new Map(Object.entries(BONES).map(([k, n]) => [boneKey(n), k]));
  root.traverse((o) => { if (o.isBone) { const k = byKey.get(boneKey(o.name)); if (k && !out[k]) out[k] = o; } });
  return out;
}

/**
 * Retarget clips between two Mixamo-convention rigs (identical bone-local axes, different proportions
 * and rest poses): local rotations transfer as-is; the hips rotation/translation are re-expressed
 * through each rig's armature transform and the translation scaled by leg length. Bone translation /
 * scale tracks are dropped so the target keeps its own proportions.
 */
function retargetClips(clips, srcScene, dstScene) {
  srcScene.updateMatrixWorld(true); dstScene.updateMatrixWorld(true);
  const S = new Map(), D = new Map();
  srcScene.traverse((o) => { if (o.isBone && !S.has(boneKey(o.name))) S.set(boneKey(o.name), o); });
  dstScene.traverse((o) => { if (o.isBone && !D.has(boneKey(o.name))) D.set(boneKey(o.name), o); });
  const sh = S.get('Hips'), dh = D.get('Hips');
  const wp = (o) => o.getWorldPosition(new THREE.Vector3());
  const legS = wp(sh).y - wp(S.get('LeftFoot')).y, legD = wp(dh).y - wp(D.get('LeftFoot')).y;
  const k = legD / legS;
  const PsQ = sh.parent.getWorldQuaternion(new THREE.Quaternion()), PdQ = dh.parent.getWorldQuaternion(new THREE.Quaternion());
  const convQ = PdQ.clone().invert().multiply(PsQ);
  const Ps = sh.parent.matrixWorld.clone(), PdInv = dh.parent.matrixWorld.clone().invert();
  const q = new THREE.Quaternion(), v = new THREE.Vector3();
  return clips.map((clip) => {
    const tracks = [];
    for (const t of clip.tracks) {
      const dot = t.name.lastIndexOf('.');
      const node = t.name.slice(0, dot), prop = t.name.slice(dot + 1);
      const key = boneKey(node), d = D.get(key);
      if (!d) continue;
      if (prop === 'quaternion') {
        const vals = t.values.slice();
        if (key === 'Hips') for (let i = 0; i < vals.length; i += 4) { q.fromArray(vals, i).premultiply(convQ).toArray(vals, i); }
        tracks.push(new THREE.QuaternionKeyframeTrack(d.name + '.quaternion', t.times.slice(), vals));
      } else if (prop === 'position' && key === 'Hips') {
        const vals = t.values.slice();
        for (let i = 0; i < vals.length; i += 3) { v.fromArray(vals, i).applyMatrix4(Ps).multiplyScalar(k).applyMatrix4(PdInv).toArray(vals, i); }
        tracks.push(new THREE.VectorKeyframeTrack(d.name + '.position', t.times.slice(), vals));
      }
    }
    return new THREE.AnimationClip(clip.name, clip.duration, tracks);
  });
}

/** Merge skinned meshes that share skeleton + material into one draw call each. */
function mergeSkinnedByMaterial(scene) {
  const groups = new Map();
  scene.traverse((o) => { if (o.isSkinnedMesh && !Array.isArray(o.material)) { const key = o.material.uuid + '|' + o.skeleton.bones[0].uuid + o.skeleton.bones.length + '|' + o.parent.uuid; (groups.get(key) || groups.set(key, []).get(key)).push(o); } });
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const base = list[0];
    if (!list.every((m) => m.bindMatrix.equals(base.bindMatrix) && m.matrix.equals(base.matrix))) continue;
    const names = Object.keys(base.geometry.attributes).sort().join();
    if (!list.every((m) => Object.keys(m.geometry.attributes).sort().join() === names && !!m.geometry.index === !!base.geometry.index)) continue;
    const merged = mergeGeometries(list.map((m) => m.geometry), false);
    if (!merged) continue;
    base.geometry = merged;
    for (const m of list.slice(1)) m.parent.remove(m);
  }
}

// ---------------------------------------------------------------------------------------------
// Materials: believable PBR soldier kit. Object-space (rest pose) triplanar detail so the weave and
// dirt stick to the cloth while it deforms: fabric twill bump, macro blotching, worn armour edges,
// dust gradient up boots and trousers. Team identity is carried by the uniform palette (friendly =
// ranger green / coyote, enemy = charcoal / urban grey) plus a team-coloured armband on both arms.
// ---------------------------------------------------------------------------------------------
let _detailTex = null;
function detailTex() {
  if (_detailTex) return _detailTex;
  const N = 256, data = new Uint8Array(N * N * 4);
  let s = 1337;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const P = 64, lat = new Float32Array(P * P);
  for (let i = 0; i < lat.length; i++) lat[i] = rnd();
  const vn = (x, y, f) => { // periodic value noise, f cells per tile
    const xi = Math.floor(x), yi = Math.floor(y), tx = x - xi, ty = y - yi;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const L = (a, b) => lat[(((b % f) + f) % f) * P + (((a % f) + f) % f)];
    const a = L(xi, yi), b = L(xi + 1, yi), c = L(xi, yi + 1), d = L(xi + 1, yi + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
  const fbm = (u, v, f0, oct) => { let r = 0, amp = 0.5, n = 0; for (let o = 0; o < oct; o++) { const f = f0 << o; r += amp * vn(u * f, v * f, f); n += amp; amp *= 0.5; } return r / n; };
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = x / N, v = y / N, i = (y * N + x) * 4;
    // 2/2 twill: diagonal ribs with alternating thread crossings.
    const t = (x + y) % 8, cross = ((x >> 2) + (y >> 2)) & 1;
    const twill = 0.5 + 0.5 * Math.sin((t / 8) * Math.PI * 2) * (cross ? 1 : 0.7);
    const det = fbm(u, v, 8, 4);
    const blot = fbm(u, v, 2, 5);
    const scratch = Math.pow(fbm(u, v, 16, 3), 3);
    data[i] = Math.round(twill * 255); data[i + 1] = Math.round(det * 255);
    data[i + 2] = Math.round(clamp((blot - 0.5) * 1.8 + 0.5, 0, 1) * 255); data[i + 3] = Math.round(clamp(scratch * 3, 0, 1) * 255);
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.anisotropy = 4;
  t.needsUpdate = true;
  return (_detailTex = t);
}

// Per-material look: colour (linear), roughness, metalness, weave bump, weave scale (tiles / m), dirt.
const PALETTES = {
  friendly: {
    Soldier_Clothes: [[0.055, 0.068, 0.048], 0.86, 0, 1.0, 22, 1.0],
    Soldier_Fabric: [[0.135, 0.118, 0.080], 0.9, 0, 1.0, 26, 1.0],
    Soldier_Armor: [[0.105, 0.095, 0.066], 0.62, 0.02, 0.35, 14, 0.7],
    Soldier_Elements: [[0.035, 0.040, 0.034], 0.55, 0.05, 0.25, 30, 0.5],
  },
  enemy: {
    Soldier_Clothes: [[0.030, 0.031, 0.033], 0.86, 0, 1.0, 22, 1.0],
    Soldier_Fabric: [[0.060, 0.060, 0.058], 0.9, 0, 1.0, 26, 1.0],
    Soldier_Armor: [[0.042, 0.043, 0.045], 0.6, 0.02, 0.35, 14, 0.7],
    Soldier_Elements: [[0.020, 0.021, 0.022], 0.55, 0.05, 0.25, 30, 0.5],
  },
  common: {
    Soldier_Iron: [[0.09, 0.095, 0.092], 0.42, 0.8, 0.1, 40, 0.3],
    Soldier_Metal: [[0.16, 0.165, 0.16], 0.38, 0.75, 0.1, 40, 0.3],
    Soldier_Flesh: [[0.33, 0.21, 0.14], 0.62, 0, 0.12, 60, 0.15],
    Soldier_Shoes: [[0.030, 0.027, 0.023], 0.74, 0, 0.4, 35, 1.4],
    Soldier_Boots: [[0.038, 0.031, 0.024], 0.72, 0, 0.45, 35, 1.4],
    Soldier_Glass: [[0.012, 0.016, 0.016], 0.12, 0.6, 0, 1, 0],
    Soldier_Skin: [[0.022, 0.024, 0.023], 0.78, 0, 0.7, 30, 0.6], // gloves / balaclava
  },
};
const CAMO = {
  friendly: { a: [0.11, 0.085, 0.052], b: [0.028, 0.032, 0.022] }, // coyote blotches + dark olive spots
  enemy: { a: [0.012, 0.012, 0.013], b: [0.075, 0.075, 0.072] }, // black blotches + grey spots
};
const TEAM_COLORS = { friendly: new THREE.Color(0.08, 0.32, 1.0), enemy: new THREE.Color(1.0, 0.11, 0.06) };

function soldierMaterial(src, look, camo = null) {
  const m = new THREE.MeshStandardMaterial({ name: src.name, side: THREE.FrontSide });
  const [col, rough, metal, weave, scale, dirt] = look;
  m.color.setRGB(col[0], col[1], col[2], THREE.LinearSRGBColorSpace);
  m.roughness = rough; m.metalness = metal; m.envMapIntensity = 0.85;
  m.userData.character = true;
  const uDet = { value: new THREE.Vector4(weave, scale, dirt, metal > 0.5 ? 1 : 0) };
  const uCamoA = { value: new THREE.Color().setRGB(...(camo?.a || col), THREE.LinearSRGBColorSpace) };
  const uCamoB = { value: new THREE.Color().setRGB(...(camo?.b || col), THREE.LinearSRGBColorSpace) };
  const uCamoK = { value: camo ? 1 : 0 };
  if (globalThis.__noSoldierShader) return m;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uSoldierTex = { value: detailTex() };
    sh.uniforms.uSoldierDet = uDet;
    sh.uniforms.uCamoA = uCamoA; sh.uniforms.uCamoB = uCamoB; sh.uniforms.uCamoK = uCamoK;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aRest; attribute vec3 aRestN; varying vec3 vRest; varying vec3 vRestN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRest = aRest; vRestN = aRestN;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uSoldierTex; uniform vec4 uSoldierDet; varying vec3 vRest; varying vec3 vRestN;
        uniform vec3 uCamoA; uniform vec3 uCamoB; uniform float uCamoK;
        vec4 sTri(vec3 p, vec3 w, float s) {
          return texture2D(uSoldierTex, p.zy * s) * w.x + texture2D(uSoldierTex, p.xz * s) * w.y + texture2D(uSoldierTex, p.xy * s) * w.z;
        }
        vec3 sPerturb(vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDirection) {
          vec3 vSigmaX = normalize(dFdx(surf_pos.xyz)); vec3 vSigmaY = normalize(dFdy(surf_pos.xyz));
          vec3 vN = surf_norm; vec3 R1 = cross(vSigmaY, vN); vec3 R2 = cross(vN, vSigmaX);
          float fDet = dot(vSigmaX, R1) * faceDirection;
          vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
          return normalize(abs(fDet) * surf_norm - vGrad);
        }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        vec3 sN = normalize(vRestN);
        vec3 sW = pow(abs(sN), vec3(4.0)); sW /= (sW.x + sW.y + sW.z + 1e-4);
        vec4 sFine = sTri(vRest, sW, uSoldierDet.y);
        vec4 sMacro = sTri(vRest, sW, 1.7);
        float sH = clamp(vRest.y / 1.78, 0.0, 1.0);
        float sDirt = uSoldierDet.z * smoothstep(0.42, 0.02, sH + (sMacro.g - 0.5) * 0.18) * (0.55 + 0.6 * sMacro.b);
        sDirt = clamp(sDirt, 0.0, 0.85);
        // Disruptive camo: large blotches + smaller spots (two extra tones over the base colour).
        float sCa = smoothstep(0.56, 0.6, sMacro.b + (sFine.g - 0.5) * 0.08);
        float sCb = smoothstep(0.62, 0.66, sMacro.g + (sFine.g - 0.5) * 0.06) * (1.0 - sCa);
        diffuseColor.rgb = mix(diffuseColor.rgb, uCamoA, sCa * uCamoK);
        diffuseColor.rgb = mix(diffuseColor.rgb, uCamoB, sCb * uCamoK);
        diffuseColor.rgb *= 0.9 + 0.18 * sMacro.b + 0.1 * (sFine.g - 0.5);
        // Cheap cavity / underside occlusion from the rest-pose normal.
        diffuseColor.rgb *= mix(0.6, 1.0, smoothstep(-0.9, 0.35, sN.y));
        diffuseColor.rgb *= 1.0 - 0.12 * uSoldierDet.x * (1.0 - sFine.r);
        // worn edges / scuffs on hard kit
        float sWear = sFine.a * (1.0 - uSoldierDet.x * 0.6) * 0.6;
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.6 + 0.02, sWear * 0.5);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.26, 0.21, 0.15), sDirt * 0.6);
        float sHeight = (sFine.r * uSoldierDet.x + (sFine.g - 0.5) * 0.35) * 0.0035;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor * (0.9 + 0.2 * sMacro.g) + sDirt * 0.25 - sWear * 0.15, 0.06, 1.0);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        normal = sPerturb(-vViewPosition, normal, vec2(dFdx(sHeight), dFdy(sHeight)) * (uSoldierDet.w > 0.5 ? 0.3 : 1.0) * 60.0 * 0.02, faceDirection);`);
  };
  m.customProgramCacheKey = () => 'soldier';
  return m;
}

export class CharacterTemplate {
  /**
   * @param gltf      clip source (Mixamo-named rig with the full clip set)
   * @param meshGltf  optional different Mixamo-convention body; clips are retargeted onto it
   */
  constructor(gltf, gunModels, meshGltf = null) {
    this.gltf = gltf;
    this.gunModels = gunModels;
    const g = (meshGltf || gltf).scene;
    this.scene = g;
    this.textured = false;
    g.traverse((o) => { if (o.isMesh && o.material?.map) this.textured = true; });
    let clips = gltf.animations;
    if (meshGltf && meshGltf !== gltf) clips = retargetClips(clips, gltf.scene, g);
    this.clips = new Map(clips.map((c) => [c.name, c]));
    if (meshGltf) mergeSkinnedByMaterial(g);
    g.updateMatrixWorld(true);
    // Measure standing height from the skeleton (head top) rather than the mesh bounds, which include
    // T-pose sockets / straps.
    const bb = new THREE.Box3().setFromObject(g);
    let headTop = null;
    g.traverse((o) => { if (!headTop && o.isBone && boneKey(o.name) === 'HeadTop_End') headTop = o; });
    const topY = headTop ? headTop.getWorldPosition(new THREE.Vector3()).y : bb.max.y;
    this.height = topY - bb.min.y;
    this.scale = 1.8 / this.height;
    this.yOffset = -bb.min.y * this.scale;
    this.armRadius = this._measureArmRadius(g);
    this.materials = {};
    if (this.textured) this._teamTexturedMaterials(g);
    else this._bakeRestAttribute(g);
    for (const team of this.textured ? [] : ['friendly', 'enemy']) {
      const set = {};
      g.traverse((o) => {
        if (!o.isMesh) return;
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          if (set[m.name]) continue;
          const look = PALETTES[team][m.name] || PALETTES.common[m.name] || [[0.1, 0.1, 0.1], 0.7, 0, 0.3, 25, 0.5];
          const camo = /Clothes|Fabric/.test(m.name) ? CAMO[team] : null;
          set[m.name] = soldierMaterial(m, look, camo);
        }
      });
      const tc = TEAM_COLORS[team];
      set.__band = new THREE.MeshStandardMaterial({ color: tc.clone().multiplyScalar(0.55), emissive: tc, emissiveIntensity: 0.18, roughness: 0.7 });
      set.__band.userData.noUnify = true;
      this.materials[team] = set;
    }
    const pick = (...names) => names.map((n) => this.clips.get(n)).find(Boolean);
    const full = {
      idle: pick('aim_idle', 'idle'), walk: pick('aim_walk', 'walk'), run: pick('aim_run', 'run'), sprint: pick('aim_sprint', 'sprint', 'aim_run'),
      crouchIdle: pick('aim_crouch_idle', 'crouch_idle'), crouchWalk: pick('aim_crouch_walk', 'crouch_walk'), jump: pick('jump_loop', 'aim_idle'),
    };
    this.lower = {};
    for (const [k, c] of Object.entries(full)) this.lower[k] = splitClip(c, false);
    this.upper = {
      aim: splitClip(pick('aim_idle'), true),
      aimCrouch: splitClip(pick('aim_crouch_idle', 'aim_idle'), true),
      reload: splitClip(pick('reload'), true),
      throw: splitClip(pick('throw'), true),
    };
    // Additive flinch: the hit clip relative to its first frame, layered on the aim pose.
    // (clone first: the GLTF loader shares keyframe arrays between clips, and makeClipAdditive edits in place)
    const hitUp = splitClip(pick('hit'), true).clone();
    this.hitAdd = THREE.AnimationUtils.makeClipAdditive(hitUp, 0);
    this.death = pick('death');
    this.downed = pick('downed', 'aim_crouch_idle');
    // Forward crumple: knees from the crouch, arms from mid-way through the death clip.
    this.toppleLo = splitClip(pick('aim_crouch_idle', 'crouch_idle'), false);
    this.toppleUp = splitClip(this.death, true);
    // Gait table: natural ground speed of each in-place clip (planted-foot travel, measured offline from
    // the clips) and the phase where the left foot is furthest forward, so blended clips stay in step.
    const G = { walk: [1.2, 0.02], run: [4.8, 0.03], sprint: [6.2, 0.05], crouchWalk: [0.8, 0] };
    this.gait = {};
    for (const [k, [speed, offset]] of Object.entries(G)) { const dur = full[k].duration; this.gait[k] = { speed, dur, stride: speed * dur, offset }; }
  }

  /**
   * Authored PBR kit: keep the textures, one material set per side. Friendly keep the green / tan
   * scheme; the enemy kit is re-dyed darker and cooler so silhouettes read apart at range. Both get a
   * team armband (see Character._addArmbands).
   */
  _teamTexturedMaterials(g) {
    const srcMats = new Map();
    g.traverse((o) => { if (o.isMesh) for (const m of Array.isArray(o.material) ? o.material : [o.material]) srcMats.set(m.name || m.uuid, m); });
    for (const team of ['friendly', 'enemy']) {
      const set = {};
      for (const [name, m] of srcMats) {
        const c = m.clone();
        c.userData.character = true;
        c.envMapIntensity = 0.85;
        c.side = THREE.FrontSide;
        if (c.roughness !== undefined && !c.roughnessMap) c.roughness = Math.max(0.55, c.roughness);
        if (team === 'enemy' && !/Eye|Head$|Skin|Flesh/i.test(name)) c.color.setRGB(0.5, 0.52, 0.56, THREE.LinearSRGBColorSpace);
        set[name] = c;
      }
      const tc = TEAM_COLORS[team];
      set.__band = new THREE.MeshStandardMaterial({ color: tc.clone().multiplyScalar(0.55), emissive: tc, emissiveIntensity: 0.18, roughness: 0.7 });
      set.__band.userData.noUnify = true;
      this.materials[team] = set;
    }
  }

  /** Upper-arm sleeve radius (metres, 90th percentile) so armbands sit on the cloth for any body. */
  _measureArmRadius(g) {
    const bones = findBones(g);
    if (!bones.lArm || !bones.lFore) return 0.06;
    g.updateMatrixWorld(true);
    const a = bones.lArm.getWorldPosition(new THREE.Vector3()), f = bones.lFore.getWorldPosition(new THREE.Vector3());
    const seg = new THREE.Line3(a, f), v = new THREE.Vector3(), cp = new THREE.Vector3(), ds = [];
    g.traverse((o) => {
      if (!o.isSkinnedMesh) return;
      o.skeleton.update();
      const si = o.geometry.attributes.skinIndex, sw = o.geometry.attributes.skinWeight, n = o.geometry.attributes.position.count;
      for (let i = 0; i < n; i++) {
        if (o.skeleton.bones[si.getX(i)] !== bones.lArm || sw.getX(i) < 0.6) continue;
        o.getVertexPosition(i, v).applyMatrix4(o.matrixWorld);
        const t = seg.closestPointToPointParameter(v, true);
        if (t < 0.2 || t > 0.45) continue;
        ds.push(seg.closestPointToPoint(v, true, cp).distanceTo(v));
      }
    });
    if (ds.length < 8) return 0.06;
    ds.sort((x, y) => x - y);
    return ds[(ds.length * 0.9) | 0] * this.scale + 0.004;
  }

  /** Rest-pose (bind) object-space positions in metres, feet at y=0, for triplanar detail. */
  _bakeRestAttribute(scene) {
    const v = new THREE.Vector3();
    scene.traverse((o) => {
      if (!o.isSkinnedMesh || o.geometry.attributes.aRest) return;
      const pos = o.geometry.attributes.position, n = pos.count;
      const arr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        o.getVertexPosition(i, v);
        v.applyMatrix4(o.matrixWorld).multiplyScalar(this.scale);
        arr[i * 3] = v.x; arr[i * 3 + 1] = v.y + this.yOffset; arr[i * 3 + 2] = v.z;
      }
      o.geometry.setAttribute('aRest', new THREE.BufferAttribute(arr, 3));
      // Smooth rest-pose normals for the triplanar weights (no derivative-of-derivative in the shader).
      const tmp = new THREE.BufferGeometry();
      tmp.setAttribute('position', new THREE.BufferAttribute(arr, 3));
      if (o.geometry.index) tmp.setIndex(o.geometry.index);
      tmp.computeVertexNormals();
      o.geometry.setAttribute('aRestN', tmp.attributes.normal);
    });
  }

  instance(team) {
    return new Character(this, team);
  }
}

// ----------------------------------------------------------------------------------------------
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3(), _v6 = new THREE.Vector3(), _v7 = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion(), _q4 = new THREE.Quaternion();
const _e1 = new THREE.Euler(0, 0, 0, 'YXZ'), _e2 = new THREE.Euler();
const V3 = () => new THREE.Vector3(), Q = () => new THREE.Quaternion();
const _ik = { a: V3(), b: V3(), c: V3(), t: V3(), ac: V3(), ab: V3(), acN: V3(), abN: V3(), bcN: V3(), atN: V3(), ax0: V3(), ax1: V3(), tmp: V3(), qa: Q(), qb: Q(), r0: Q(), r1: Q(), r2: Q() };
const UP = new THREE.Vector3(0, 1, 0);
const wrapPi = (a) => ((a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
const GAIT_KEYS = ['walk', 'run', 'sprint', 'crouchWalk'];

export class Character {
  constructor(tpl, team) {
    this.tpl = tpl;
    this.team = team;
    this.root = new THREE.Group();
    this.root.rotation.order = 'YXZ';
    // Pivot at the feet: used for whole-body topples on death.
    this.pivot = new THREE.Group();
    this.root.add(this.pivot);
    const model = SkeletonUtils.clone(tpl.scene);
    model.scale.setScalar(tpl.scale);
    model.position.y = tpl.yOffset;
    model.rotation.y = Math.PI; // glTF faces +Z; game yaw 0 looks toward -Z
    this.model = model;
    this.pivot.add(model);
    const side = team === 0 ? 'friendly' : 'enemy';
    const mats = tpl.materials[side];
    model.traverse((o) => {
      if (!o.isMesh) return;
      o.material = Array.isArray(o.material) ? o.material.map((m) => mats[m.name || m.uuid] || m) : (mats[o.material.name || o.material.uuid] || o.material);
      o.castShadow = true;
      o.receiveShadow = true;
      if (o.isSkinnedMesh) {
        // Generous static bounds so off-screen bots are culled (incl. their shadow pass) without
        // re-skinning the bounds every frame.
        // (skin the bounds from the bind pose — the skeleton must be evaluated first)
        model.updateMatrixWorld(true);
        o.skeleton.update();
        o.computeBoundingSphere();
        o.boundingSphere.radius *= 2.2; // covers lying corpses / extended limbs
        o.frustumCulled = true;
      }
    });
    this.bones = findBones(model);
    this._addArmbands(mats.__band);

    // ---- animation layers ----
    this.mixer = new THREE.AnimationMixer(model);
    this.lowerActions = {};
    for (const [k, c] of Object.entries(tpl.lower)) {
      const a = this.mixer.clipAction(c);
      a.play(); a.setEffectiveWeight(k === 'idle' ? 1 : 0);
      if (GAIT_KEYS.includes(k)) a.timeScale = 0; // driven by the gait phase
      this.lowerActions[k] = a;
    }
    this.upperActions = {};
    for (const [k, c] of Object.entries(tpl.upper)) {
      const a = this.mixer.clipAction(c);
      a.play(); a.setEffectiveWeight(k === 'aim' ? 1 : 0);
      if (k === 'reload' || k === 'throw') a.timeScale = 0;
      this.upperActions[k] = a;
    }
    this.hitAction = this.mixer.clipAction(tpl.hitAdd);
    this.hitAction.blendMode = THREE.AdditiveAnimationBlendMode;
    this.hitAction.setLoop(THREE.LoopOnce, 1); this.hitAction.clampWhenFinished = true;
    this.hitAction.setEffectiveWeight(0);
    this.deathAction = this.mixer.clipAction(tpl.death);
    this.deathAction.setLoop(THREE.LoopOnce, 1); this.deathAction.clampWhenFinished = true;
    this.downedAction = this.mixer.clipAction(tpl.downed);
    this.toppleLoAction = this.mixer.clipAction(tpl.toppleLo);
    this.toppleUpAction = this.mixer.clipAction(tpl.toppleUp);
    this.toppleUpAction.setLoop(THREE.LoopOnce, 1); this.toppleUpAction.clampWhenFinished = true;

    this.gaitPhase = Math.random();
    this.speedS = 0;
    this.bodyYaw = 0;
    this.yawRate = 0;
    this.twist = 0;
    this.lean = 0;
    this.fwdLean = 0;
    this.prevSpeed = 0;
    this.hitJerk = 0;
    this.hitAxis = new THREE.Vector3(1, 0, 0);
    this.fireKick = 0;
    this.kickRoll = 0;
    this.oneShot = null; // { name, t, dur, rate }
    this.oneShotW = 0;
    this.deadTime = 0;
    this.dying = null;
    this.lastHit = null;
    this.weaponObj = null;
    this.weaponId = null;
    this.muzzleObj = null;
    this.gripLocal = new THREE.Vector3(); // support grip in wrap space
    this.handRelPos = new THREE.Vector3(); this.handRelQ = new THREE.Quaternion(); // gun relative to palm
    this._lodAcc = 0;
    this._animated = false;
    this._hbFrame = -1;
    this._hb = null;
    this._frame = 0;
  }

  _addArmbands(mat) {
    const geo = new THREE.CylinderGeometry(1, 1, 1, 14, 1, true);
    for (const [arm, fore] of [['lArm', 'lFore'], ['rArm', 'rFore']]) {
      const a = this.bones[arm], f = this.bones[fore];
      if (!a || !f) continue;
      // Work in bone-local space: band axis along the upper arm, 30% toward the elbow.
      const dir = f.position.clone();
      const band = new THREE.Mesh(geo, mat);
      band.quaternion.setFromUnitVectors(UP, dir.clone().normalize());
      band.position.copy(dir).multiplyScalar(0.3);
      band.castShadow = false;
      a.add(band);
      this[arm + 'Band'] = band;
    }
    // Size bands in metres once the world scale is known.
    this.model.updateMatrixWorld(true);
    for (const arm of ['lArm', 'rArm']) {
      const band = this[arm + 'Band'];
      if (!band) continue;
      const ws = this.bones[arm].getWorldScale(_v1).x;
      const r = this.tpl.armRadius;
      band.scale.set(r / ws, 0.06 / ws, r / ws);
    }
  }

  // ---------------- weapon in hand ----------------
  attachWeapon(bot) {
    const id = bot.weapon.id;
    if (this.weaponId === id && this.weaponObj) { this._resetWeaponParent(); return; }
    if (this.weaponObj) this.weaponObj.parent?.remove(this.weaponObj);
    this.weaponObj = null; this.muzzleObj = null;
    this.weaponId = id;
    const src = this.tpl.gunModels.src[bot.weapon.stats.model];
    if (!src || !this.bones.rHand) return;
    const gun = src.clone(true);
    gun.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
    const spare = gun.getObjectByName('SpareMagazine'); if (spare) spare.visible = false;
    // Steel-tide rifles are authored ~1.75 units long; 0.47 gives real-world length.
    const s = 0.47;
    const wrap = new THREE.Group();
    wrap.add(gun);
    gun.scale.setScalar(s);
    const pose = POSES[bot.weapon.stats.pose] || POSES.m4a1;
    const gp = pose.primary, sp = pose.support;
    gun.position.set(-gp[0] * s, -gp[1] * s, -gp[2] * s); // primary grip at the wrap origin
    this.gripLocal.set((sp[0] - gp[0]) * s, (sp[1] - gp[1]) * s, (sp[2] - gp[2]) * s);
    this.weaponObj = wrap;
    this.muzzleObj = gun.getObjectByName('MuzzleDeviceTip') || gun.getObjectByName('MuzzleSocket') || null;
    if (!this.muzzleObj) {
      gun.updateMatrixWorld(true);
      const bb = new THREE.Box3().setFromObject(gun);
      const m = new THREE.Object3D(); m.position.set(0, 0.03 / s, bb.min.z / s); gun.add(m); this.muzzleObj = m;
    }
    this.root.add(wrap);
    this._resetWeaponParent();
  }

  _resetWeaponParent() {
    const w = this.weaponObj;
    if (!w) return;
    if (w.parent !== this.root) { w.parent?.remove(w); this.root.add(w); }
    w.visible = true;
    this.drop = null;
  }

  muzzleWorld(bot, target = new THREE.Vector3()) {
    if (!this.muzzleObj || !this.weaponObj?.visible) return null;
    this.muzzleObj.updateWorldMatrix(true, false);
    return target.setFromMatrixPosition(this.muzzleObj.matrixWorld);
  }

  // ---------------- events ----------------
  onSpawn(bot) {
    this.deadTime = 0;
    this.dying = null;
    this.mixer.stopAllAction();
    for (const [k, a] of Object.entries(this.lowerActions)) { a.reset().play(); a.setEffectiveWeight(k === 'idle' ? 1 : 0); if (GAIT_KEYS.includes(k)) a.timeScale = 0; }
    for (const [k, a] of Object.entries(this.upperActions)) { a.reset().play(); a.setEffectiveWeight(k === 'aim' ? 1 : 0); if (k === 'reload' || k === 'throw') a.timeScale = 0; }
    this.hitAction.stop(); this.hitAction.setEffectiveWeight(0);
    this.oneShot = null; this.oneShotW = 0;
    this.hitJerk = 0; this.fireKick = 0;
    this.bodyYaw = bot ? bot.yaw : 0;
    this.twist = 0; this.lean = 0; this.fwdLean = 0; this.yawRate = 0;
    this.speedS = 0;
    this.root.visible = true;
    this.root.rotation.set(0, this.bodyYaw, 0);
    this.pivot.position.set(0, 0, 0);
    this.pivot.quaternion.identity();
    this.model.position.set(0, this.tpl.yOffset, 0);
    this._lodAcc = 1;
    this._resetWeaponParent();
  }

  onFire() {
    this.fireKick = 1;
    this.kickRoll = (Math.random() * 2 - 1);
  }

  onHit(bot, info) {
    this.lastHit = info || null;
    this.hitJerk = Math.min(1.3, this.hitJerk + 0.9);
    if (info?.dir) {
      // Flinch away from the shooter: tilt about the axis perpendicular to the bullet.
      _v1.set(info.dir.x, 0, info.dir.z);
      if (_v1.lengthSq() > 1e-6) this.hitAxis.crossVectors(UP, _v1.normalize()).normalize();
    }
    if (bot?.alive !== false) { this.hitAction.reset(); this.hitAction.play(); }
  }

  onThrow() { this.playUpper('throw', 1.15); }

  playUpper(name, rate = 1) {
    const a = this.upperActions[name];
    if (!a) return;
    this.oneShot = { name, t: 0, dur: a.getClip().duration, rate };
  }

  // ---------------- per frame ----------------
  update(dt, bot) {
    const root = this.root;
    this._frame++;
    root.position.copy(bot.position);
    if (!bot.alive) { this._updateDead(dt, bot); return; }
    root.position.y += bot.jumpY || 0;

    // --- Body yaw (legs follow movement, upper body twists toward the aim) ---
    const v = bot.velocity;
    const speed = Math.hypot(v.x, v.z);
    this.speedS = damp(this.speedS, speed, 14, dt);
    const sp = this.speedS;
    const aimYaw = bot.yaw;
    let moveYaw = sp > 0.25 ? Math.atan2(-v.x, -v.z) : aimYaw;
    let rel = wrapPi(moveYaw - aimYaw);
    // Backpedal when moving away from the aim; hysteresis avoids flip-flopping at pure strafes.
    const thr = (this.backward ? 95 : 115) * DEG;
    this.backward = sp > 0.25 && Math.abs(rel) > thr;
    if (this.backward) { moveYaw += Math.PI; rel = wrapPi(moveYaw - aimYaw); }
    const targetBody = sp > 0.25 ? moveYaw : this._idleBodyYaw(aimYaw);
    const dy = wrapPi(targetBody - this.bodyYaw);
    const turn = dy * Math.min(1, dt * (sp > 0.25 ? 9 : 6));
    this.bodyYaw = wrapPi(this.bodyYaw + turn);
    this.yawRate = damp(this.yawRate, turn / Math.max(dt, 1e-4), 8, dt);
    this.twist = damp(this.twist, clamp(wrapPi(aimYaw - this.bodyYaw), -100 * DEG, 100 * DEG), 16, dt);
    // Lean into turns and with acceleration (small, speed-scaled).
    const accel = (sp - this.prevSpeed) / Math.max(dt, 1e-4);
    this.prevSpeed = sp;
    this.lean = damp(this.lean, clamp(this.yawRate * sp * 0.035, -0.2, 0.2), 6, dt);
    this.fwdLean = damp(this.fwdLean, clamp(accel * 0.012 + sp * 0.012 * (this.backward ? -0.5 : 1), -0.08, 0.14), 5, dt);
    root.rotation.set(-this.fwdLean, this.bodyYaw, this.lean);

    this.hitJerk = Math.max(0, this.hitJerk - dt * 4.5);
    this.fireKick = Math.max(0, this.fireKick - dt * 12);

    // --- LOD: distant / off-screen bots animate at a reduced rate ---
    this._lodAcc += dt;
    if (this._lodAcc < this._lodInterval(bot)) { this._afterPose(bot, false); return; }
    const adt = Math.min(this._lodAcc, 0.25);
    this._lodAcc = 0;
    this._animate(adt, bot, sp);
    this._afterPose(bot, true);
  }

  _idleBodyYaw(aimYaw) {
    // Standing still the feet only re-plant when the aim drifts far from them (no constant pivoting).
    const d = wrapPi(aimYaw - this.bodyYaw);
    if (Math.abs(d) > 60 * DEG || this._turningInPlace) {
      this._turningInPlace = Math.abs(d) > 8 * DEG;
      return aimYaw;
    }
    return this.bodyYaw;
  }

  _lodInterval(bot) {
    const cam = bot.game?.renderer?.camera;
    if (!cam) return 0;
    const dx = bot.position.x - cam.position.x, dy = bot.position.y - cam.position.y, dz = bot.position.z - cam.position.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < 30 * 30) {
      // Behind the camera but near: still reasonably smooth (shadows / quick turns).
      return 0;
    }
    cam.getWorldDirection(_v7);
    const d = Math.sqrt(d2);
    const facing = (dx * _v7.x + dy * _v7.y + dz * _v7.z) / d;
    if (facing < 0.25) return 1 / 8; // off-screen
    if (d > 70) return 1 / 12;
    if (d > 40) return 1 / 20;
    return 0;
  }

  _animate(dt, bot, sp) {
    const tpl = this.tpl, gait = tpl.gait;
    // Turning on the spot: shuffle the feet (drive the walk cycle from the turn rate) instead of
    // pivoting on planted soles.
    if (sp < 0.3) sp = Math.max(sp, clamp(Math.abs(this.yawRate) * 0.32 - 0.15, 0, 1.1));
    const c = clamp(bot.crouch, 0, 1);
    const air = clamp((bot.jumpY || 0) / 0.18, 0, 1);

    // --- Lower body weights by speed (standing: idle → walk → run → sprint; crouched: idle → walk) ---
    const W = this._w || (this._w = { idle: 0, walk: 0, run: 0, sprint: 0, crouchIdle: 0, crouchWalk: 0, jump: 0 });
    for (const k in W) W[k] = 0;
    const vw = gait.walk.speed, vr = gait.run.speed, vs = gait.sprint.speed, vc = gait.crouchWalk.speed;
    const st = 1 - c;
    if (sp < 0.15) W.idle = st;
    else if (sp < vw) { const k = clamp((sp - 0.15) / (vw * 0.6), 0, 1); W.idle = st * (1 - k); W.walk = st * k; }
    else if (sp < vr) { const k = (sp - vw) / (vr - vw); W.walk = st * (1 - k); W.run = st * k; }
    else if (sp < vs) { const k = (sp - vr) / (vs - vr); W.run = st * (1 - k); W.sprint = st * k; }
    else W.sprint = st;
    const kc = clamp((sp - 0.1) / (vc * 0.5), 0, 1);
    W.crouchIdle = c * (1 - kc); W.crouchWalk = c * kc;
    if (air > 0) { for (const k in W) W[k] *= 1 - air; W.jump = air; }

    // --- Shared gait phase, advanced by distance travelled ---
    let wsum = 0, stride = 0;
    for (const k of GAIT_KEYS) { wsum += W[k]; stride += W[k] * gait[k].stride; }
    if (wsum > 1e-3) {
      stride /= wsum;
      this.gaitPhase += (sp * dt / Math.max(0.3, stride)) * (this.backward ? -1 : 1);
      this.gaitPhase -= Math.floor(this.gaitPhase);
    }
    for (const k in this.lowerActions) {
      const a = this.lowerActions[k];
      a.setEffectiveWeight(W[k]);
      if (gait[k]) { const p = this.gaitPhase + gait[k].offset; a.time = (p - Math.floor(p)) * gait[k].dur; }
    }

    // --- Upper body: aim stance + one-shots (reload / throw) ---
    const w = bot.weapon;
    if (w.state === 'reload' && !this._reloading) {
      this._reloading = true;
      const dur = tpl.upper.reload.duration;
      this.playUpper('reload', dur / Math.max(0.6, w.stateDur || dur));
    }
    if (w.state !== 'reload') {
      if (this._reloading && this.oneShot?.name === 'reload') this.oneShot.t = Math.max(this.oneShot.t, this.oneShot.dur - 0.2); // cancelled: blend out
      this._reloading = false;
    }
    let osw = 0;
    for (const k of ['reload', 'throw']) this.upperActions[k].setEffectiveWeight(0);
    if (this.oneShot) {
      const o = this.oneShot;
      o.t += dt * o.rate;
      if (o.t >= o.dur) this.oneShot = null;
      else {
        const a = this.upperActions[o.name];
        a.time = o.t;
        osw = Math.min(1, o.t / 0.15, (o.dur - o.t) / 0.25);
        a.setEffectiveWeight(osw);
      }
    }
    this.oneShotW = osw;
    this.upperActions.aim.setEffectiveWeight((1 - c) * (1 - osw));
    this.upperActions.aimCrouch.setEffectiveWeight(c * (1 - osw));
    this.hitAction.setEffectiveWeight(clamp(this.hitJerk, 0, 1) * 0.8);
    this.mixer.update(dt);
    this._animated = true;
  }

  /** Procedural layer applied on top of the sampled pose, then weapon + IK + matrices. */
  _afterPose(bot, fresh) {
    const root = this.root, b = this.bones;
    if (fresh) {
      root.updateMatrixWorld(true);
      const pitch = clamp(bot.pitch, -70 * DEG, 70 * DEG);
      const aimYaw = bot.yaw;
      // Aim right axis (world) for pitching the chest.
      _v5.set(Math.cos(aimYaw), 0, -Math.sin(aimYaw));
      const chain = [b.spine, b.spine1, b.spine2];
      const share = [0.3, 0.33, 0.37];
      for (let i = 0; i < 3; i++) {
        const bone = chain[i];
        if (!bone) continue;
        bone.parent.getWorldQuaternion(_q1);
        _q2.copy(_q1).invert();
        // world-space rotation for this bone's share: twist about up, then pitch about aim right,
        // plus recoil (pitch back) and a directional flinch on the upper chest.
        let p = pitch * share[i];
        if (i === 2) p += this.fireKick * 0.05;
        _q3.setFromAxisAngle(UP, this.twist * share[i]);
        _q4.setFromAxisAngle(_v5, p);
        _q3.premultiply(_q4);
        if (i >= 1 && this.hitJerk > 0) { _q4.setFromAxisAngle(this.hitAxis, this.hitJerk * 0.16 * (i === 2 ? 1.2 : 0.8)); _q3.premultiply(_q4); }
        if (i === 2 && this.fireKick > 0) { _q4.setFromAxisAngle(UP, this.kickRoll * this.fireKick * 0.03); _q3.premultiply(_q4); }
        // local' = inv(parentWorld) * R * parentWorld * local
        _q4.copy(_q2).multiply(_q3).multiply(_q1);
        bone.quaternion.premultiply(_q4);
        bone.updateMatrixWorld(true);
      }
      this._placeWeapon(bot, pitch, aimYaw);
      root.updateMatrixWorld(true);
    } else {
      root.updateMatrixWorld(true);
    }
  }

  _placeWeapon(bot, pitch, aimYaw) {
    const b = this.bones, wrap = this.weaponObj;
    if (!wrap || !b.rHand) return;
    const root = this.root;
    // Palm = between wrist and middle-finger knuckle.
    b.rHand.getWorldPosition(_v1);
    if (b.rMid) { b.rMid.getWorldPosition(_v2); _v1.lerp(_v2, 0.5); }
    // Aim-driven orientation (+ a little muzzle climb on fire).
    _e1.set(pitch + this.fireKick * 0.06, aimYaw + this.kickRoll * this.fireKick * 0.015, 0, 'YXZ');
    _q1.setFromEuler(_e1);
    const osw = this.oneShotW;
    if (osw > 0.001) {
      // During reload / throw the gun rides the hand with the offset captured while aiming.
      b.rHand.getWorldQuaternion(_q2);
      _q3.copy(_q2).multiply(this.handRelQ);
      _v3.copy(this.handRelPos).applyQuaternion(_q2).add(_v1);
      _q1.slerp(_q3, osw);
      _v1.lerp(_v3, osw);
    } else {
      // Remember gun-in-palm offset for one-shots.
      b.rHand.getWorldQuaternion(_q2);
      _q3.copy(_q2).invert();
      this.handRelQ.copy(_q3).multiply(_q1);
      this.handRelPos.set(0, 0, 0);
    }
    // Recoil push back along the barrel.
    _v2.set(0, 0, 1).applyQuaternion(_q1).multiplyScalar(this.fireKick * 0.045);
    _v1.add(_v2);
    // World → root local.
    root.getWorldQuaternion(_q2).invert();
    wrap.quaternion.copy(_q2).multiply(_q1);
    wrap.position.copy(_v1);
    root.worldToLocal(wrap.position);
    wrap.updateMatrixWorld(true);

    // Left hand onto the support grip (IK), faded out during one-shots.
    const ikW = 1 - osw;
    if (ikW > 0.01 && b.lArm && b.lFore && b.lHand) {
      _v4.copy(this.gripLocal).applyMatrix4(wrap.matrixWorld); // support grip, world
      // Hand bone is the wrist: offset the target back by the wrist→palm vector.
      if (b.lMid) { b.lHand.getWorldPosition(_v1); b.lMid.getWorldPosition(_v2); _v4.addScaledVector(_v2.sub(_v1), -0.5); }
      _v4.y -= 0.02;
      this._twoBoneIK(b.lArm, b.lFore, b.lHand, _v4, ikW);
    }
  }

  /** Analytic two-bone IK (after D. Holden), blended by weight. Allocation-free. */
  _twoBoneIK(A, B, C, target, weight) {
    const a = A.getWorldPosition(_ik.a), b = B.getWorldPosition(_ik.b), c = C.getWorldPosition(_ik.c);
    const t = _ik.t.copy(c).lerp(target, weight);
    const lab = b.distanceTo(a), lcb = c.distanceTo(b);
    const lat = clamp(t.distanceTo(a), 0.01, (lab + lcb) * 0.999);
    const ac = _ik.ac.subVectors(c, a), ab = _ik.ab.subVectors(b, a);
    const acN = _ik.acN.copy(ac).normalize(), abN = _ik.abN.copy(ab).normalize();
    const bcN = _ik.bcN.subVectors(c, b).normalize(), atN = _ik.atN.subVectors(t, a).normalize();
    const ac_ab_0 = Math.acos(clamp(acN.dot(abN), -1, 1));
    const ba_bc_0 = Math.acos(clamp(-abN.dot(bcN), -1, 1));
    const ac_at_0 = Math.acos(clamp(acN.dot(atN), -1, 1));
    const ac_ab_1 = Math.acos(clamp((lcb * lcb - lab * lab - lat * lat) / (-2 * lab * lat), -1, 1));
    const ba_bc_1 = Math.acos(clamp((lat * lat - lab * lab - lcb * lcb) / (-2 * lab * lcb), -1, 1));
    const axis0 = _ik.ax0.crossVectors(ac, ab);
    if (axis0.lengthSq() < 1e-12) return;
    axis0.normalize();
    const axis1 = _ik.ax1.crossVectors(ac, atN);
    const aInv = A.getWorldQuaternion(_ik.qa).invert(), bInv = B.getWorldQuaternion(_ik.qb).invert();
    _ik.r0.setFromAxisAngle(_ik.tmp.copy(axis0).applyQuaternion(aInv), ac_ab_1 - ac_ab_0);
    _ik.r1.setFromAxisAngle(_ik.tmp.copy(axis0).applyQuaternion(bInv), ba_bc_1 - ba_bc_0);
    if (axis1.lengthSq() > 1e-12) _ik.r2.setFromAxisAngle(_ik.tmp.copy(axis1).normalize().applyQuaternion(aInv), ac_at_0);
    else _ik.r2.identity();
    A.quaternion.multiply(_ik.r0).multiply(_ik.r2);
    B.quaternion.multiply(_ik.r1);
    A.updateMatrixWorld(true);
  }

  // ---------------- death ----------------
  _startDeath(bot) {
    const hit = this.lastHit;
    const dir = _v1.set(0, 0, 0);
    if (hit?.dir) dir.set(hit.dir.x, 0, hit.dir.z);
    if (dir.lengthSq() < 1e-6) dir.set(Math.sin(this.bodyYaw), 0, Math.cos(this.bodyYaw)); // fall backward
    dir.normalize();
    const explosive = hit?.type === 'grenade' || hit?.type === 'explosion';
    const shotgun = hit?.weapon && /m870|shotgun/i.test(hit.weapon);
    const headshot = !!hit?.headshot;
    // Clip falls backward: its "push" direction is the body's back.
    const backYaw = Math.atan2(dir.x, dir.z); // yaw whose backward vector == dir
    const off = wrapPi(backYaw - this.bodyYaw);
    const phys = bot.game?.physics;
    const clear = (yaw, dist) => {
      if (!phys) return true;
      _v2.set(bot.position.x, bot.position.y + 0.5, bot.position.z);
      _v3.set(Math.sin(yaw), 0, Math.cos(yaw));
      return !phys.raycast(_v2, _v3, dist, G.WORLD);
    };
    // Pushed backward / sideways → the authored backward fall, yawed (≤100°) to go with the hit.
    // Pushed forward (shot from behind) → knees buckle and the body pitches onto its front.
    let mode = Math.abs(off) > 105 * DEG ? 'topple' : 'clip';
    if (this.forceDeathMode) mode = this.forceDeathMode; // debug / tests
    const d = {
      mode, t: 0, fadeW: 0, rate: headshot ? 1.35 : explosive ? 1.2 : 0.88 + Math.random() * 0.25,
      fromYaw: this.bodyYaw, toYaw: this.bodyYaw, dir: dir.clone(), angle: 0, angVel: 0, landed: false,
      // Knockback: a short stagger-slide, bigger for buckshot / blasts.
      slide: explosive ? 2.4 : shotgun ? 0.9 : headshot ? 0.12 : 0.25 + Math.random() * 0.25, slid: 0, maxSlide: 0,
      groundY: bot.position.y, lift: 0, origin: bot.position.clone(),
    };
    if (mode === 'clip') {
      const target = this.bodyYaw + clamp(off, -100 * DEG, 100 * DEG);
      if (clear(target, 1.9)) d.toYaw = target;
      else if (clear(this.bodyYaw, 1.9)) d.toYaw = this.bodyYaw; // wall behind the hit line: fall straight back
      else mode = d.mode = 'topple'; // back to a wall: crumple forward instead
    }
    if (mode === 'topple') {
      // Forward along the body (biased toward the hit), avoiding walls.
      const fwdYaw = this.bodyYaw + Math.PI;
      let yaw = fwdYaw + clamp(wrapPi(Math.atan2(dir.x, dir.z) - fwdYaw), -0.9, 0.9);
      for (const t of [0, 0.5, -0.5, 1.0, -1.0]) if (clear(yaw + t, 1.6)) { yaw += t; break; }
      d.fallYaw = yaw; // world yaw of fall direction (vector (sin, 0, cos))
      d.angVel = explosive ? 2.5 : 0.5 + Math.random() * 0.4;
      d.kneel = explosive ? 0.05 : 0.2 + Math.random() * 0.15; // time spent buckling before the topple
      d.forward = true;
    }
    // Knockback slide distance, clipped by walls.
    if (phys) {
      _v2.set(bot.position.x, bot.position.y + 0.4, bot.position.z);
      const h = phys.raycast(_v2, d.dir, d.slide + 0.6, G.WORLD);
      d.maxSlide = h ? Math.max(0, h.distance - 0.6) : d.slide;
    } else d.maxSlide = d.slide;
    d.slideV = Math.sqrt(2 * 7 * Math.min(d.slide, d.maxSlide)); // decelerate at 7 m/s²
    this.dying = d;

    // Animation: cross-fade every layer into the death pose (weights scaled from where they are, so
    // each bone's total stays 1 — no bind-pose blending).
    this.oneShot = null;
    d.w0 = new Map();
    for (const a of [...Object.values(this.lowerActions), ...Object.values(this.upperActions)]) { d.w0.set(a, a.getEffectiveWeight()); a.timeScale = 0; }
    if (mode === 'clip') { this.deathAction.reset(); this.deathAction.timeScale = d.rate; this.deathAction.play(); this.deathAction.setEffectiveWeight(0); }
    else if (!d.forward) { this.downedAction.reset(); this.downedAction.timeScale = 1; this.downedAction.play(); this.downedAction.setEffectiveWeight(0); d.poses = [this.downedAction]; }
    else {
      const lo = this.toppleLoAction, up = this.toppleUpAction;
      lo.reset(); lo.play(); lo.time = 0.4; lo.timeScale = 0; lo.setEffectiveWeight(0);
      up.reset(); up.play(); up.time = up.getClip().duration * 0.3; up.timeScale = 0; up.setEffectiveWeight(0); // arms flung, spine still neutral
      d.poses = [lo, up];
    }
    this.hitAction.setEffectiveWeight(0);

    // Weapon falls free.
    if (this.weaponObj) {
      const w = this.weaponObj;
      w.updateMatrixWorld(true);
      w.getWorldPosition(_v2); w.getWorldQuaternion(_q1);
      this.root.parent?.add(w);
      w.position.copy(_v2); w.quaternion.copy(_q1);
      this.drop = {
        vel: new THREE.Vector3(d.dir.x * 1.4 + (Math.random() - 0.5), 1.2 + Math.random(), d.dir.z * 1.4 + (Math.random() - 0.5)),
        spin: new THREE.Vector3((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 10),
        ground: bot.position.y + 0.035, rest: false,
      };
    }
  }

  _updateDead(dt, bot) {
    if (this.deadTime === 0) this._startDeath(bot);
    this.deadTime += dt;
    const d = this.dying, root = this.root;
    d.t += dt;
    // Knockback slide.
    if (d.slideV > 0) {
      const step = Math.min(d.slideV * dt, d.maxSlide - d.slid);
      d.slid += Math.max(0, step);
      d.slideV = Math.max(0, d.slideV - 7 * dt);
    }
    root.position.set(d.origin.x + d.dir.x * d.slid, d.groundY, d.origin.z + d.dir.z * d.slid);

    // Blend all live layers out, the death layer in.
    d.fadeW = Math.min(1, d.fadeW + dt / (d.mode === 'clip' ? 0.12 : 0.18));
    const fw = d.fadeW;
    if (!d.frozen) {
      for (const [a, w0] of d.w0) a.setEffectiveWeight(w0 * (1 - fw));
      if (fw >= 1) {
        for (const a of d.w0.keys()) a.stop();
        this.hitAction.stop();
        d.frozen = true;
      }
    }
    if (d.mode === 'clip') {
      this.deathAction.setEffectiveWeight(fw);
      const k = clamp(d.t / 0.35, 0, 1);
      this.bodyYaw = d.fromYaw + wrapPi(d.toYaw - d.fromYaw) * (1 - Math.pow(1 - k, 3));
      root.rotation.set(0, this.bodyYaw, 0);
      this.mixer.update(dt);
    } else {
      // Knees buckle into a slump, then the whole body topples about the feet along the hit.
      for (const a of d.poses) a.setEffectiveWeight(fw);
      this.mixer.update(dt);
      root.rotation.set(0, this.bodyYaw, 0);
      if (d.t > d.kneel && !d.landed) {
        d.angVel += (3.2 + 9 * Math.sin(d.angle)) * dt; // gravity torque grows as it tips
        d.angle += d.angVel * dt;
        if (d.angle >= Math.PI / 2 - 0.08) { d.angle = Math.PI / 2 - 0.08; d.angVel *= -0.18; if (Math.abs(d.angVel) < 0.2) d.landed = true; }
      }
      // Axis perpendicular to the fall direction, in root-local space.
      const local = d.fallYaw - this.bodyYaw;
      _v2.set(Math.sin(local), 0, Math.cos(local));
      _v3.crossVectors(UP, _v2).normalize();
      this.pivot.quaternion.setFromAxisAngle(_v3, d.angle);
    }
    this.pivot.position.y = d.lift;
    root.updateMatrixWorld(true);
    // Settle: keep the lowest body point just on the ground (bones are joint centres: add flesh).
    const sinkStart = Character.CORPSE_TIME;
    if (this.deadTime < sinkStart) this._groundCorpse(d, dt);
    else {
      // Late sink below the floor, then hide.
      this.pivot.position.y = d.lift - (this.deadTime - sinkStart) * 0.16;
    }
    root.visible = this.deadTime < sinkStart + 2.5;
    this._updateDrop(dt);
  }

  _groundCorpse(d, dt) {
    const b = this.bones;
    let minY = Infinity;
    for (const k of ['hips', 'spine2', 'head', 'lLeg', 'rLeg', 'lFoot', 'rFoot']) {
      const bone = b[k];
      if (!bone) continue;
      _v4.setFromMatrixPosition(bone.matrixWorld);
      const r = k === 'head' || k === 'hips' || k === 'spine2' ? 0.12 : 0.055;
      minY = Math.min(minY, _v4.y - r);
    }
    const err = minY - d.groundY;
    // Never let the body pass through the floor; once it has come to rest, ease the lowest point
    // down onto it (the authored clip / topple can leave it hovering a few cm).
    const settled = d.mode === 'clip' ? d.t * d.rate > this.tpl.death.duration * 0.8 : d.landed;
    if (err < 0) d.lift -= err;
    else if (settled && d.lift > 0) d.lift -= Math.min(err, d.lift, dt * 0.8);
    this.pivot.position.y = d.lift;
  }

  _updateDrop(dt) {
    const dr = this.drop, w = this.weaponObj;
    if (!dr || !w) return;
    if (this.deadTime > Character.CORPSE_TIME + 2.5) { w.visible = false; return; }
    if (!dr.rest) {
      dr.vel.y -= 9.8 * dt;
      w.position.addScaledVector(dr.vel, dt);
      _q1.setFromEuler(_e2.set(dr.spin.x * dt, dr.spin.y * dt, dr.spin.z * dt));
      w.quaternion.multiply(_q1);
      if (w.position.y <= dr.ground) {
        w.position.y = dr.ground;
        if (Math.abs(dr.vel.y) > 1.2) { dr.vel.y *= -0.25; dr.vel.x *= 0.5; dr.vel.z *= 0.5; dr.spin.multiplyScalar(0.4); }
        else { dr.rest = true; dr.settle = 0; }
      }
    } else if (dr.settle < 1) {
      // Lay it on its side: keep heading, roll flat.
      dr.settle = Math.min(1, dr.settle + dt * 5);
      _v2.set(0, 0, -1).applyQuaternion(w.quaternion); _v2.y = 0;
      if (_v2.lengthSq() < 1e-4) _v2.set(0, 0, -1);
      const yaw = Math.atan2(-_v2.x, -_v2.z);
      _q1.setFromEuler(_e1.set(0, yaw, Math.PI / 2, 'YXZ'));
      w.quaternion.slerp(_q1, dr.settle);
    }
    if (this.deadTime > Character.CORPSE_TIME) w.position.y = dr.ground - (this.deadTime - Character.CORPSE_TIME) * 0.06;
  }

  // ---------------- hitboxes ----------------
  /** Bone-driven capsule hitboxes in world space (pooled; refreshed once per frame). */
  hitboxes(bot) {
    const b = this.bones;
    if (!b.head) return [];
    if (this._hbFrame === this._frame && this._hb) return this._hb;
    this._hbFrame = this._frame;
    if (!this._hb) {
      const mk = (part, r, mult) => ({ part, a: new THREE.Vector3(), b: new THREE.Vector3(), r, mult });
      this._hb = [
        mk('head', 0.13, 1.5), mk('torso', 0.21, 1), mk('torso', 0.19, 1),
        mk('legs', 0.095, 0.85), mk('legs', 0.075, 0.85), mk('legs', 0.095, 0.85), mk('legs', 0.075, 0.85),
        mk('arms', 0.06, 0.85), mk('arms', 0.05, 0.85), mk('arms', 0.06, 0.85), mk('arms', 0.05, 0.85),
        mk('legs', 0.06, 0.85), mk('legs', 0.06, 0.85),
      ];
    }
    const P = (bone, out) => out.setFromMatrixPosition(bone.matrixWorld);
    const hb = this._hb;
    const head = P(b.head, _v1), neck = P(b.neck, _v2), sp2 = P(b.spine2, _v3), hips = P(b.hips, _v4);
    // Head: skull base → just under the crown (capsule radius reaches the top of the helmet).
    if (b.headTop) P(b.headTop, _v5); else _v5.copy(head).y += 0.22;
    hb[0].a.copy(head).lerp(_v5, 0.15);
    hb[0].b.copy(head).lerp(_v5, 0.72);
    // Torso: pelvis → chest, chest → base of neck.
    hb[1].a.copy(hips).y += 0.02; hb[1].b.copy(sp2);
    hb[2].a.copy(sp2); hb[2].b.copy(neck).lerp(sp2, 0.25);
    const limb = (i, x, y) => { P(b[x], hb[i].a); P(b[y], hb[i].b); };
    limb(3, 'lUp', 'lLeg'); limb(4, 'lLeg', 'lFoot'); limb(5, 'rUp', 'rLeg'); limb(6, 'rLeg', 'rFoot');
    limb(7, 'lArm', 'lFore'); limb(8, 'lFore', 'lHand'); limb(9, 'rArm', 'rFore'); limb(10, 'rFore', 'rHand');
    // Forearm capsules run on through the palm.
    if (b.lMid) P(b.lMid, hb[8].b); if (b.rMid) P(b.rMid, hb[10].b);
    if (b.lToe && b.rToe) { limb(11, 'lFoot', 'lToe'); limb(12, 'rFoot', 'rToe'); hb.length = 13; } else hb.length = 11;
    return hb;
  }

  /** Dev aid: draw the hitbox capsules (wireframe) attached to the scene. */
  debugHitboxes(scene, bot) {
    if (!this._dbg) {
      this._dbg = new THREE.Group();
      const mat = new THREE.MeshBasicMaterial({ color: 0xff00ff, wireframe: true, depthTest: false, transparent: true, opacity: 0.6 });
      for (let i = 0; i < 13; i++) this._dbg.add(new THREE.Mesh(new THREE.CapsuleGeometry(1, 1, 4, 8), mat));
      scene.add(this._dbg);
    }
    const hb = this.hitboxes(bot);
    hb.forEach((h, i) => {
      const m = this._dbg.children[i];
      const len = h.a.distanceTo(h.b);
      m.position.copy(h.a).add(h.b).multiplyScalar(0.5);
      m.quaternion.setFromUnitVectors(UP, _v1.subVectors(h.b, h.a).normalize());
      m.geometry.dispose();
      m.geometry = new THREE.CapsuleGeometry(h.r, Math.max(0.001, len), 4, 8);
    });
  }
}

Character.CORPSE_TIME = 7;
