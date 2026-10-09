import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

/**
 * Per-weapon first-person rigs authored offline (tools/blender/build_rig.py, docs/FP_FRAMING.md):
 * public/assets/models/fp/<id>.glb = gun (Gun_<id>, canonical contract nodes) + gloved arms skinned to
 * one armature (FPRig) whose rest pose is the authored hold, posed per gun with an automatic
 * intersection solver. Everything is in the gun's frame at FP_K x real scale (muzzle -Z, +Y up).
 *
 * At runtime the right hand rides the gun rigidly; the left arm is re-solved with a two-bone IK when the
 * support hand has to leave its grip (pump, magazine swaps, shell loading).
 */
export const FP_K = 2;
export const FP_IDS = ['m4a1', 'ak47', 'scarl', 'mp5a5', 'vss', 'm24', 'awm', 'shotgun', 'p226', 'm1911'];

/**
 * Presentation tuning for FP rigs (replaces the steel-tide VM_TUNE entries for these models, whose
 * numbers were tied to the old meshes). Coordinates are WeaponRoot-local (gun frame, K-space).
 * ironRear / ironFront: iron sight line (rear notch / aperture centre, front post tip).
 */
export const FP_TUNE = {
  // Reload carry (procedural paths: pistols, shotgun shell loading): DOWN and inboard, muzzle low, 15-25 deg cant
  // so the support hand works in the lower part of the frame (rifles use the reshaped template clip).
  default: { opticScale: 0.82, reloadPos: [-0.025, -0.05, -0.01], reloadRot: [-0.08, 0.08, -0.3] },
  // Measured on the FP models (tools/blender/measure_sights.py, WeaponRoot-local = gun frame, K-space).
  // M4A1 (Firewarden model): BUIS aperture centre / front post tip (rear-view renders), flat-top rail ahead of the BUIS.
  m4a1: { ironRear: [0, 0.2498, 0.255], ironFront: [0, 0.2404, -0.505], rail: [0, 0.1786, 0.06], gunTint: 0.42 },
  // AK: notch bottom of the rear leaf / post tip inside the front sight ears (zoomed side renders); the dust
  // cover top sits 1.5 mm (K-space) under this line, as on the real rifle.
  // Empty reloads: 'rack' (charging handle, rackRoll = cant while racking, deg) or 'release' (bolt catch, default).
  ak47: { ironRear: [0, 0.1005, -0.645], ironFront: [0, 0.1005, -1.375], rail: [0, 0.0956, -0.492], emptyAction: 'rack', rackRoll: 14, boltTravel: 0.13 },
  scarl: { ironRear: [0, 0.2655, 0.2311], ironFront: [0, 0.2777, -0.514], rail: [0, 0.1879, -0.058], emptyAction: 'rack', rackRoll: -24, boltTravel: 0.12, boltHand: [-0.06, -0.06, 0.08] },
  // MP5: diopter drum aperture centre / front post tip inside the hood.
  mp5a5: { ironRear: [0, 0.238, 0.0978], ironFront: [0, 0.254, -0.5722], rail: [0, 0.2286, -0.21], emptyAction: 'rack', rackRoll: -24, boltTravel: 0.12, boltHand: [-0.05, -0.06, 0.08] },
  // Remington: ghost ring on the receiver + the authored bead.
  shotgun: { reloadPos: [-0.03, -0.05, 0.0], reloadRot: [-0.08, 0.1, 0.4], ironRear: [0, 0.16, 0.0], ironFront: [0, 0.157, -0.984], rail: [0, 0.1314, 0.0], pumpStroke: 0.16,
    shellPort: [0.0, -0.02, 0.05], shellBelt: [0.1, -0.5, 0.25] },
  p226: { reloadPos: [-0.02, -0.045, 0.0], reloadRot: [-0.05, 0.06, 0.3], ironRear: [0, 0.1352, 0.1435], ironFront: [0, 0.1359, -0.1692], rail: [0, 0.131, 0.04] },
  m1911: { reloadPos: [-0.02, -0.045, 0.0], reloadRot: [-0.05, 0.06, 0.3], ironRear: [0, 0.1297, 0.1299], ironFront: [0, 0.1287, -0.1954], rail: [0, 0.1281, 0.045] },
  // Fixed-scope precision platforms: the authored scope glass defines the optical axis.
  vss: { integratedScope: true },
  m24: { integratedScope: true },
  awm: { integratedScope: true },
};

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _m = new THREE.Matrix4();

/** Split a loaded FP glTF into its gun subtree, metadata and markers. */
export function parseFP(gltf, id) {
  const scene = gltf.scene;
  const root = scene.getObjectByName('FP_' + id) || scene;
  let meta = {};
  try { meta = JSON.parse(root.userData.fp || '{}'); } catch { /* keep defaults */ }
  const gun = root.getObjectByName('Gun_' + id);
  scene.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const marker = (n) => { const o = root.getObjectByName(n); return o ? o.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv) : null; };
  return { gltf, scene, root, gun, meta, gripR: marker('GripR'), gripL: marker('GripL'), vgripMount: marker('VGripMount') };
}

/** Analytic two-bone arm IK on the FPRig skeleton (shoulder fixed, elbow keeps its authored bend plane). */
class ArmIK {
  constructor(armRoot, side) {
    const g = (n) => armRoot.getObjectByName(n);
    this.up = g(`UpArm_${side}`);
    this.fo = g(`Forearm_${side}`);
    this.end = g(`BoneTwist_01${side}_end`) || g(`BoneTwist_01.${side}_end`);
    this.ctrl = g(`IK_Hand_Cntrl_${side}`);
    this.hand = g(`Hand_${side}`);
    this.ok = !!(this.up && this.fo && this.end && this.ctrl && this.hand);
    if (!this.ok) return;
    this.rest = [this.up, this.fo, this.ctrl].map((b) => ({ b, p: b.position.clone(), q: b.quaternion.clone() }));
  }

  reset() { if (this.ok) for (const r of this.rest) { r.b.position.copy(r.p); r.b.quaternion.copy(r.q); } }

  _setWorldQuat(bone, qWorld) {
    bone.parent.getWorldQuaternion(_q2).invert();
    bone.quaternion.copy(_q2.multiply(qWorld));
    bone.updateMatrixWorld(true);
  }

  /**
   * Place the hand control at a world transform and re-solve upper arm + forearm so the wrist meets it.
   * pos/quat: world space. Call reset() first each frame (solve() does).
   * pole (optional, world space): point the elbow bends toward, blended over the authored bend plane by poleK
   * (keeps the elbow / upper arm hanging below the frame when the hand travels far from its grip).
   */
  solve(pos, quat, pole = null, poleK = 0) {
    if (!this.ok) return;
    this.reset();
    const top = this.up.parent;
    top.updateMatrixWorld(true);
    const S = this.up.getWorldPosition(new THREE.Vector3());
    const E0 = this.fo.getWorldPosition(new THREE.Vector3());
    const W0 = this.end.getWorldPosition(new THREE.Vector3());
    // Hand control to the target.
    _m.copy(this.ctrl.parent.matrixWorld).invert();
    const lp = pos.clone().applyMatrix4(_m);
    this.ctrl.position.copy(lp);
    this.ctrl.parent.getWorldQuaternion(_q).invert();
    this.ctrl.quaternion.copy(_q.multiply(quat));
    this.ctrl.updateMatrixWorld(true);
    // Wrist target = where the hand's root now is (hand bone head coincides with the wrist at rest).
    const W = this.hand.getWorldPosition(new THREE.Vector3());
    const a = E0.distanceTo(S), b = W0.distanceTo(E0);
    const SW = W.clone().sub(S);
    const d = THREE.MathUtils.clamp(SW.length(), Math.abs(a - b) + 1e-4, a + b - 1e-4);
    const x = SW.normalize();
    // Bend direction: authored elbow offset from the shoulder->wrist line, carried to the new line.
    const u0 = E0.clone().sub(S); const x0 = W0.clone().sub(S).normalize();
    u0.addScaledVector(x0, -u0.dot(x0));
    const rot = new THREE.Quaternion().setFromUnitVectors(x0, x);
    const u = u0.applyQuaternion(rot); u.addScaledVector(x, -u.dot(x)).normalize();
    if (pole && poleK > 0) {
      const up = pole.clone().sub(S); up.addScaledVector(x, -up.dot(x));
      if (up.lengthSq() > 1e-8) { u.lerp(up.normalize(), poleK); u.addScaledVector(x, -u.dot(x)).normalize(); }
    }
    const cosA = (a * a + d * d - b * b) / (2 * a * d);
    const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
    const E = S.clone().addScaledVector(x, a * cosA).addScaledVector(u, a * sinA);
    // Upper arm: swing authored elbow direction onto the solved one.
    const dq1 = new THREE.Quaternion().setFromUnitVectors(E0.clone().sub(S).normalize(), E.clone().sub(S).normalize());
    this._setWorldQuat(this.up, dq1.multiply(this.up.getWorldQuaternion(new THREE.Quaternion())));
    // Forearm: swing current wrist onto the target.
    const E1 = this.fo.getWorldPosition(new THREE.Vector3());
    const W1 = this.end.getWorldPosition(new THREE.Vector3());
    const dq2 = new THREE.Quaternion().setFromUnitVectors(W1.sub(E1).normalize(), W.clone().sub(E1).normalize());
    this._setWorldQuat(this.fo, dq2.multiply(this.fo.getWorldQuaternion(new THREE.Quaternion())));
  }
}

/** One instance of an FP rig's arms (cloned per weapon rig). */
export class FPArms {
  /** variant: name of an authored one-frame pose clip (e.g. 'grip_vgrip') applied over the rest hold. */
  constructor(fp, variant = null) {
    const clone = SkeletonUtils.clone(fp.scene);
    const root = clone.getObjectByName(fp.root.name) || clone;
    const gun = root.getObjectByName(fp.gun?.name || '__none__');
    if (gun) gun.parent.remove(gun); // the rig builds its own gun from GunModels.src
    this.object = root;
    root.position.set(0, 0, 0); root.quaternion.identity(); root.scale.setScalar(1);
    root.traverse((o) => {
      if (o.isMesh) { o.frustumCulled = false; o.castShadow = false; o.receiveShadow = false; }
    });
    this.mesh = null;
    root.traverse((o) => { if (o.isSkinnedMesh) this.mesh = o; });
    const clip = variant && fp.gltf.animations?.find((c) => c.name === variant);
    if (clip) {
      // First keyframe of each track straight onto the bones (no mixer: the pose must persist).
      for (const t of clip.tracks) {
        const dot = t.name.lastIndexOf('.');
        const node = root.getObjectByName(t.name.slice(0, dot)), prop = t.name.slice(dot + 1);
        if (node && node[prop]?.fromArray) node[prop].fromArray(t.values, 0);
      }
      root.updateMatrixWorld(true);
    }
    this.variant = clip ? variant : null;
    // Variant corrective morph (contact fix baked by build_rig.py), e.g. 'vgrip_fix' for 'grip_vgrip'.
    if (this.variant && this.mesh?.morphTargetDictionary) {
      const k = this.mesh.morphTargetDictionary[this.variant.replace('grip_', '') + '_fix'];
      if (k !== undefined) { this.mesh.morphTargetInfluences = this.mesh.morphTargetInfluences.slice(); this.mesh.morphTargetInfluences[k] = 1; }
    }
    this.ik = { L: new ArmIK(root, 'L'), R: new ArmIK(root, 'R') };
    this.homeL = null;
    // Finger chains (ccransh rig): index .005-.007, middle .009-.011, ring .013-.015, pinky .017-.019, thumb .021-.022.
    // Curl is mostly about each bone's local z (negative = curl in).
    this.fingers = {};
    for (const side of ['L', 'R']) {
      const g = (i) => root.getObjectByName(`Bone_${side}.${String(i).padStart(3, '0')}`);
      const chain = (a) => [g(a), g(a + 1), g(a + 2)].filter(Boolean).map((b) => ({ b, q: b.quaternion.clone() }));
      this.fingers[side] = { index: chain(5), others: [...chain(9), ...chain(13), ...chain(17)], thumb: chain(21) };
    }
  }

  /**
   * Finger layer over the authored hold (radians): index > 0 lifts the index finger straight (trigger discipline),
   * curl > 0 closes the other fingers (grabbing a magazine), < 0 opens them; thumb > 0 closes the thumb.
   */
  setFingers(side, index = 0, curl = 0, thumb = 0) {
    const f = this.fingers[side]; if (!f) return;
    const key = `${index.toFixed(3)},${curl.toFixed(3)},${thumb.toFixed(3)}`;
    if (f.key === key) return; f.key = key;
    const apply = (list, w) => list.forEach((e, i) => e.b.quaternion.copy(e.q).multiply(_q.setFromAxisAngle(_v.set(0, 0, 1), w[i % w.length])));
    apply(f.index, [index * 0.9, index * 0.35, index * 0.8]);
    apply(f.others, [-curl * 0.8, -curl, -curl * 0.7]);
    apply(f.thumb, [-thumb, -thumb * 0.8]);
  }

  /** Cache the left hand control's authored transform in WeaponRoot space. */
  captureHome(weaponRoot) {
    const ik = this.ik.L; if (!ik.ok) return;
    ik.reset();
    weaponRoot.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(weaponRoot.matrixWorld).invert();
    const m = new THREE.Matrix4().multiplyMatrices(inv, ik.ctrl.matrixWorld);
    this.homeL = { p: new THREE.Vector3(), q: new THREE.Quaternion(), s: new THREE.Vector3() };
    m.decompose(this.homeL.p, this.homeL.q, this.homeL.s);
  }

  /** Left hand at home + offset (WeaponRoot space) with optional extra rotation; null = authored pose. */
  setLeft(weaponRoot, offset, rotQ = null, poleWorld = null, poleK = 0) {
    const ik = this.ik.L; if (!ik.ok) return;
    if (!offset && !rotQ && !(poleWorld && poleK > 0)) { ik.reset(); return; }
    if (!this.homeL) this.captureHome(weaponRoot);
    weaponRoot.updateMatrixWorld(true);
    const p = this.homeL.p.clone(); if (offset) p.add(offset);
    const q = this.homeL.q.clone(); if (rotQ) q.premultiply(rotQ);
    p.applyMatrix4(weaponRoot.matrixWorld);
    q.premultiply(weaponRoot.getWorldQuaternion(_q));
    ik.solve(p, q, poleWorld, poleK);
  }

  /**
   * Left hand control to an absolute WeaponRoot-space transform. poleWorld (optional): world-space point the
   * elbow bends toward, blended over the authored bend plane by poleK.
   */
  setLeftAbs(weaponRoot, p, q, poleWorld = null, poleK = 0) {
    const ik = this.ik.L; if (!ik.ok) return;
    weaponRoot.updateMatrixWorld(true);
    ik.solve(p.clone().applyMatrix4(weaponRoot.matrixWorld), q.clone().premultiply(weaponRoot.getWorldQuaternion(_q)), poleWorld, poleK);
  }

  get leftHand() { return this.ik.L.hand; }
}
