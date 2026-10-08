import * as THREE from 'three';
import { grimeTex } from '../../render/ProcTex.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { FP_IDS, parseFP } from './FPRig.js';

/**
 * Weapon model library: loads the authored GLBs, unifies their materials into one consistent
 * PBR "gunmetal / polymer / wood" look, and builds procedural attachments (suppressors, muzzle
 * devices, grips, drum, bipod, laser) that use the same materials so everything matches.
 */

// Grip anchors (WeaponRoot-local metres) — fitted per platform by Operation Steel Tide (MIT),
// see csharp/FirstPersonArmPoseCatalog.cs in AetherRadar/operation-steel-tide.
export const POSES = {
  p226: { kind: 'sidearm', primary: [0.0, -0.03017, 0.23701], support: [-0.09566, -0.04028, 0.23902] },
  m1911: { kind: 'sidearm', primary: [-0.01132, -0.03, 0.245], support: [-0.10717, -0.04, 0.24] },
  mp5a5: { kind: 'compact', primary: [0.0, -0.09769, -0.10293], support: [-0.04143, 0.03383, -0.38662] },
  m4a1: { kind: 'rifle', primary: [0.0, -0.15, -0.05], support: [0.0, 0.0, -0.58] },
  ak74: { kind: 'rifle', primary: [0.0, -0.0731, -0.12176], support: [-0.00107, 0.00898, -0.53758] },
  scarl: { kind: 'rifle', primary: [-0.008427, -0.162496, -0.155166], support: [-0.009328, 0.102748, -0.6419] },
  m24: { kind: 'long', primary: [-0.00537, -0.09765, 0.04146], support: [-0.02067, 0.055, -0.56] },
  vss: { kind: 'rifle', primary: [-0.0102, -0.05022, -0.12157], support: [-0.0193, 0.05102, -0.59912] },
  awm: { kind: 'long', primary: [0.0, -0.06961, -0.06117], support: [-0.00981, 0.13367, -0.65377] },
  shotgun: { kind: 'rifle', primary: [0.0, -0.22, 0.05], support: [0.0, -0.33, -0.5] },
};

// Reload phase timings (fraction of clip) — same source (FirstPersonReloadProfileCatalog.cs).
export const RELOAD_PHASES = {
  rifle: { reach: 0.12, stow: 0.42, acquire: 0.53, seat: 0.77, action: 0.91 },
  long: { reach: 0.12, stow: 0.41, acquire: 0.52, seat: 0.76, action: 0.92 },
  sidearm: { reach: 0.18, stow: 0.43, acquire: 0.54, seat: 0.78, action: 0.985 },
};

/**
 * Per-platform first-person presentation (AAA-style framing on top of the ported grip math).
 * scale: WeaponRoot scale. hipAnchor: where the bore line above the firing grip sits in view-camera space at hip
 * (every platform is placed by that point, so framing is consistent whatever the model origin);
 * hip overrides with an explicit WeaponRoot position. hipRot: [pitch, yaw, roll]
 * (yaw > 0 converges the muzzle toward the crosshair, roll < 0 cants the left side toward the eye).
 * primary/support override the POSES grips (WeaponRoot-local).
 */
export const VM_TUNE = {
  default: { scale: 0.68, hipAnchor: [0.21, -0.12, -0.4], hipRot: [0.03, 0.08, -0.15], opticScale: 0.72,
    reloadPos: [-0.06, 0.06, -0.03], reloadRot: [-0.08, 0.18, -0.35] },
  m4a1: { primary: [0.0, -0.17, 0.215], opticScale: 1, supOffset: [0, 0.018, 0.035] },
  // AK irons: the model's rear leaf sits only ~1.5 cm above the dust cover, which then fills the sight
  // picture; ride the eye a touch above the notch and clip the cover nearest the cheek (adsNear).
  ak74: { scale: 0.82, opticScale: 0.62, ironRelief: 0.34, ironRear: [0, 0.084, -0.53], ironFront: [0, 0.09, -1.08], adsNear: 0.11 },
  scarl: { hipOffset: [0, -0.025, -0.04] },
  mp5a5: { opticScale: 0.62, hipOffset: [-0.03, 0.025, -0.02] },
  // Fixed-scope precision platforms: the authored scope glass defines the optical axis. Their
  // source magazines/bolts are authored in a generic rest frame; seat them on the receivers.
  vss: { integratedScope: true, muzzle: [0, 0.05, -1.26], magOffset: [0, 0.175, -0.03], chargingOffset: [0, 0, -0.04] },
  m24: { integratedScope: true, muzzle: [0, 0.08, -1.42], magOffset: [0, 0.125, 0], chargingOffset: [0, 0, -0.12], primary: [-0.005, -0.08, -0.07] },
  awm: { integratedScope: true, muzzle: [0, 0.165, -1.68], magOffset: [0, 0.19, 0], chargingOffset: [0, 0.02, -0.1], primary: [0, -0.05, -0.15] },
  shotgun: { reloadPos: [-0.05, 0.07, -0.02], reloadRot: [0.1, 0.12, 0.42], scale: 0.6, hipOffset: [0.03, -0.09, 0], ironRear: [0, 0.15, -0.05], ironFront: [0, 0.07, -1.17], ironRelief: 0.3 },
  p226: { reloadPos: [-0.02, 0.03, 0], reloadRot: [0.12, 0.08, 0.22], scale: 0.85, hipAnchor: [0.09, -0.08, -0.46], hipRot: [0.08, 0.1, -0.15], muzzle: [0, 0.09, -0.08], ironRear: [0, 0.128, 0.3], ironFront: [0, 0.128, -0.05] },
  m1911: { reloadPos: [-0.02, 0.03, 0], reloadRot: [0.12, 0.08, 0.22], scale: 0.85, hipAnchor: [0.09, -0.08, -0.46], hipRot: [0.08, 0.1, -0.15], muzzle: [0, 0.09, -0.08], ironRear: [0, 0.13, 0.3], ironFront: [0, 0.13, -0.05] },
};
export const vmTune = (key) => ({ ...VM_TUNE.default, ...(VM_TUNE[key] || {}) });

let _grime = null;
const grime = () => (_grime ||= grimeTex(256, 77));

/**
 * Shared first-person "look" patch (the viewmodel counterpart of Materials.applyUnify — that pass works
 * in world space, which is meaningless for a camera-space viewmodel, so this one runs in object space):
 *  - albedo normalised into a common PBR band and saturation pulled to the palette,
 *  - roughness remapped into [rmin, 1] with object-space triplanar breakup (fingerprints / handling),
 *  - edge-ish wear (bright worn metal) driven by the same noise,
 * so the authored-texture guns (M4, AK), the flat-shaded steel-tide guns, optics and arms all read at
 * one fidelity. Idempotent; chains any existing onBeforeCompile.
 */
export function applyGunLook(m, opts = {}) {
  if (!m || m.userData.gunLook || !(m.isMeshStandardMaterial || m.isMeshPhysicalMaterial)) return m;
  const g = grime();
  const wear = opts.wear ?? 0.5, sat = opts.sat ?? 0.88, rmin = opts.rmin ?? 0.28, lumMax = opts.lumMax ?? 0.55;
  const micro = opts.micro ?? 1;
  // How much of the (warm golden-hour) IBL hue survives on diffuse / specular. Wood & cloth keep more.
  const keepD = opts.keepDiffuse ?? 0.45, keepS = opts.keepSpec ?? 0.3;
  m.userData.gunLook = true;
  if (m.normalMap && m.normalScale) {
    const k = THREE.MathUtils.clamp(Math.abs(m.normalScale.x), 0.6, 1.25);
    m.normalScale.set(k * Math.sign(m.normalScale.x || 1), k * Math.sign(m.normalScale.y || 1));
  }
  const prev = m.onBeforeCompile;
  const prevKey = m.customProgramCacheKey?.bind(m);
  m.onBeforeCompile = (sh, r) => {
    prev?.call(m, sh, r);
    sh.uniforms.gunGrime = { value: g };
    sh.uniforms.gunLook = { value: new THREE.Vector4(wear, sat, rmin, lumMax) };
    sh.uniforms.gunMicro = { value: micro };
    sh.uniforms.gunKeep = { value: new THREE.Vector2(keepD, keepS) };
    sh.uniforms.gunTint = { value: new THREE.Color(...(opts.tint || [1, 1, 1])) };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vObjPos; varying vec3 vObjN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObjPos = position; vObjN = normal;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D gunGrime; uniform vec4 gunLook; uniform float gunMicro; uniform vec2 gunKeep; uniform vec3 gunTint; varying vec3 vObjPos; varying vec3 vObjN;\n' +
        'float tri(vec3 p, vec3 n, float s){ vec3 w = abs(n); w /= (w.x+w.y+w.z+1e-4); return texture2D(gunGrime, p.yz*s).r*w.x + texture2D(gunGrime, p.xz*s).r*w.y + texture2D(gunGrime, p.xy*s).r*w.z; }')
      .replace('#include <map_fragment>', `#include <map_fragment>
        float gA = tri(vObjPos, vObjN, 6.0);
        float gB = tri(vObjPos, vObjN, 23.0);
        {
          float l = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
          diffuseColor.rgb = mix(vec3(l), diffuseColor.rgb, gunLook.y) * gunTint;
          diffuseColor.rgb *= min(1.0, gunLook.w / max(l, 1e-3));
          diffuseColor.rgb = max(diffuseColor.rgb, vec3(0.018));
          diffuseColor.rgb *= mix(1.0, 0.9 + 0.2 * gA, gunMicro);
        }
        float wearMask = smoothstep(0.62, 0.8, gB) * gunLook.x;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor * mix(1.0, 0.75 + 0.5 * gA, gunMicro) - wearMask * 0.25, gunLook.z, 1.0);`)
      // Golden-hour IBL turns grey steel copper; keep its brightness but only a little of its hue so
      // finishes still read black / gunmetal / FDE (the direct sun keeps the scene's warmth).
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        {
          const vec3 LW = vec3(0.2126, 0.7152, 0.0722);
          reflectedLight.indirectSpecular = mix(vec3(dot(reflectedLight.indirectSpecular, LW)), reflectedLight.indirectSpecular, gunKeep.y);
          reflectedLight.indirectDiffuse = mix(vec3(dot(reflectedLight.indirectDiffuse, LW)), reflectedLight.indirectDiffuse, gunKeep.x);
          reflectedLight.directSpecular = mix(vec3(dot(reflectedLight.directSpecular, LW)), reflectedLight.directSpecular, 0.6);
        }`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        float metalWear = wearMask * step(0.3, metalnessFactor);
        // Finished steel (parkerized / anodized / cerakote) behaves mostly like a dark dielectric
        // coating; only worn edges are bare metal.
        metalnessFactor = clamp(min(metalnessFactor, 0.55) + metalWear * 0.4, 0.0, 1.0);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.42, 0.44), metalWear * 0.35);`);
  };
  m.customProgramCacheKey = () => (prevKey ? prevKey() : '') + '|gunlook3';
  m.needsUpdate = true;
  return m;
}

/** Gun material: palette colour + the shared first-person look. */
export function gunMaterial(color, metalness, roughness, opts = {}) {
  const m = new THREE.MeshStandardMaterial({ color, metalness, roughness, envMapIntensity: opts.env ?? 1.0 });
  return applyGunLook(m, { wear: opts.wear ?? 0.5 });
}

const LIB = {
  steel: () => gunMaterial(0x2b2d30, 0.85, 0.42),
  darkSteel: () => gunMaterial(0x1c1d20, 0.8, 0.5),
  brightSteel: () => gunMaterial(0x6e7076, 1.0, 0.3, { wear: 0.2 }),
  polymer: () => gunMaterial(0x17181a, 0.0, 0.62, { wear: 0.15 }),
  polymerGrey: () => gunMaterial(0x3a3c3f, 0.0, 0.6, { wear: 0.15 }),
  tan: () => gunMaterial(0x8a7a5c, 0.0, 0.62, { wear: 0.2 }),
  od: () => gunMaterial(0x3f4535, 0.05, 0.6, { wear: 0.25 }),
  wood: () => applyGunLook(new THREE.MeshStandardMaterial({ color: 0x5a3a22, metalness: 0, roughness: 0.5 }), { wear: 0.1, keepDiffuse: 0.85, sat: 0.95 }),
  brass: () => gunMaterial(0xb08a45, 1.0, 0.32, { wear: 0.05 }),
  glass: () => new THREE.MeshPhysicalMaterial({ color: 0x0d1a24, metalness: 0, roughness: 0.04, clearcoat: 1, envMapIntensity: 2.2 }),
  rubber: () => gunMaterial(0x111112, 0.0, 0.85, { wear: 0.05 }),
};
const matCache = {};
export const M = (k) => (matCache[k] ||= LIB[k]());

/** Map an authored material name to the shared gun material palette. */
function unifyMaterial(mat, modelKey) {
  const n = (mat.name || '').toLowerCase();
  // Keep authored PBR textures (M4 / AK) but clamp their response so they match the palette.
  if (mat.map || mat.normalMap || mat.aoMap) {
    mat.envMapIntensity = 1.0;
    if (n.includes('wood')) mat.roughness = Math.max(mat.roughness, 0.45);
    // Authored PBR (M4 / AK): same normalisation, lighter procedural wear (they carry their own).
    applyGunLook(mat, { wear: modelKey === 'shotgun' ? 0.45 : 0.25, micro: 0.6, rmin: n.includes('wood') ? 0.42 : 0.3, keepDiffuse: n.includes('wood') ? 0.9 : 0.45, tint: n.includes('wood') ? [1.25, 0.92, 0.66] : undefined, sat: n.includes('wood') ? 1.2 : 0.88, lumMax: n.includes('wood') ? 0.5 : 0.55 });
    return mat;
  }
  if (n.includes('glass')) return M('glass');
  if (n.includes('brass') || n.includes('cartridge') || n.includes('bullet')) return M('brass');
  if (n.includes('wood')) return M('wood');
  if (n.includes('green')) return M('od');
  if (n.includes('black') || n === 'primary' || n.includes('polymer') || n.includes('rubber')) return M('polymer');
  if (n.includes('grey') || n.includes('gray') || n === 'secondary') return M('polymerGrey');
  if (n.includes('light') || n.includes('highlight')) return M('brightSteel');
  if (n.includes('dark')) return M('darkSteel');
  if (n.includes('metal') || n.includes('steel') || n.includes('action')) return M('steel');
  if (modelKey === 'shotgun') return mat;
  return M('steel');
}

export class GunModels {
  constructor(assets) {
    this.assets = assets;
    this.src = {};
  }

  async load() {
    // Per-weapon first-person rigs (gun + posed gloved arms, tools/blender, docs/FP_FRAMING.md) replace the
    // static gun + rigidly mounted arms for the models they cover.
    this.fp = {};
    // Only request rigs listed in models/fp/manifest.json (missing manifest = none shipped yet, no 404s).
    let ids = [];
    try { const r = await fetch('./assets/models/fp/manifest.json'); if (r.ok) ids = (await r.json()).ids || []; } catch { /* none */ }
    await Promise.all(ids.filter((k) => FP_IDS.includes(k)).map(async (k) => {
      const g = await this.assets.model('fp_' + k, `models/fp/${k}.glb`);
      const fp = g && parseFP(g, k);
      if (fp?.gun) { this.fp[k] = fp; this.src[k] = fp.gun; }
    }));
    const keys = ['m4a1', 'ak47', 'scarl', 'mp5a5', 'vss', 'm24', 'awm', 'p226', 'm1911', 'shotgun', 'optics'].filter((k) => !this.fp[k]);
    await Promise.all([
      ...keys.map(async (k) => { const g = await this.assets.model('gun_' + k, `models/weapons/${k}.glb`); if (g) this.src[k] = g.scene; }),
      this.assets.model('arms_rifle', 'models/weapons/smg45_rifle_arms.glb').then((g) => (this.armsRifle = g)),
      this.assets.model('arms_pistol', 'models/weapons/smg45_pistol_service_arms.glb').then((g) => (this.armsPistol = g)),
      this.assets.model('arms_reload', 'models/weapons/animated_reload_arms.glb').then((g) => (this.armsReload = g)),
    ]);
    // Normalise the shotgun (third-party model, different axes/scale) into the shared contract:
    // muzzle toward −Z, ~1.75 units long (same Godot-space scale as the steel-tide rifles).
    if (this.src.shotgun && !this.fp.shotgun) this.src.shotgun = this.normaliseShotgun(this.src.shotgun);
    // Arms share the look (no metal wear; cloth / leather roughness floor).
    for (const a of [this.armsRifle, this.armsPistol, this.armsReload, ...Object.values(this.fp).map((f) => ({ scene: f.root, skinnedOnly: true }))]) {
      a?.scene.traverse((o) => {
        if (!o.isMesh || (a.skinnedOnly && !o.isSkinnedMesh)) return;
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) applyGunLook(m, { wear: 0, micro: 0.5, rmin: 0.5, sat: 0.85, lumMax: 0.45, keepDiffuse: 0.7 });
      });
    }
    for (const [k, s] of Object.entries(this.src)) {
      s.traverse((o) => {
        if (o.isMesh) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          if (mats.some((m) => /glass/i.test(m.name || ''))) o.userData.glass = true;
          o.material = Array.isArray(o.material) ? o.material.map((m) => unifyMaterial(m, k)) : unifyMaterial(o.material, k);
          o.castShadow = false;
          o.receiveShadow = false;
          o.frustumCulled = false;
        }
      });
    }
  }

  normaliseShotgun(scene) {
    const wrap = new THREE.Group();
    wrap.name = 'ShotgunRoot';
    scene.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(scene);
    const size = bb.getSize(new THREE.Vector3());
    // Longest axis is the barrel.
    const inner = new THREE.Group();
    inner.add(scene);
    if (size.x >= size.y && size.x >= size.z) inner.rotation.y = Math.PI / 2;
    else if (size.y >= size.x && size.y >= size.z) inner.rotation.x = Math.PI / 2;
    wrap.add(inner);
    wrap.updateMatrixWorld(true);
    let bb2 = new THREE.Box3().setFromObject(wrap);
    const len = bb2.getSize(new THREE.Vector3()).z;
    const s = 1.75 / len;
    inner.scale.setScalar(s);
    wrap.updateMatrixWorld(true);
    bb2 = new THREE.Box3().setFromObject(wrap);
    // Determine which end is the muzzle: the stock end is taller. Sample heights near each end.
    const c = bb2.getCenter(new THREE.Vector3());
    inner.position.sub(c);
    wrap.updateMatrixWorld(true);
    // The source asset (verified visually) has its stock toward −Z after the long-axis rotation;
    // its raked pistol grip and butt pad make that unambiguous, so flip it deterministically.
    inner.rotation.y += Math.PI;
    wrap.updateMatrixWorld(true);
    bb2 = new THREE.Box3().setFromObject(wrap);
    const c2 = bb2.getCenter(new THREE.Vector3());
    inner.position.sub(c2);
    // Place so the receiver/grip region sits near the M4 contract: centre ~ z −0.35, top at y ~0.12.
    wrap.updateMatrixWorld(true);
    bb2 = new THREE.Box3().setFromObject(wrap);
    inner.position.y += 0.12 - bb2.max.y;
    inner.position.z += -0.38;
    const muzzle = new THREE.Object3D();
    muzzle.name = 'MuzzleSocket';
    wrap.updateMatrixWorld(true);
    bb2 = new THREE.Box3().setFromObject(wrap);
    // Bore exit / ejection port measured on the normalised mesh.
    muzzle.position.set(0, -0.15, bb2.min.z - 0.01);
    wrap.add(muzzle);
    const eject = new THREE.Object3D(); eject.name = 'EjectionPort'; eject.position.set(0.06, -0.13, -0.2); wrap.add(eject);
    // The source texture is a saturated sci-fi livery; re-grade it to gunmetal so it sits with the
    // rest of the arsenal (keeps the authored wear / panel detail in luminance).
    scene.traverse((o) => {
      if (!o.isMesh) return;
      const m = o.material;
      m.transparent = false; m.opacity = 1; m.alphaTest = 0;
      m.metalness = 0.55; m.roughness = 0.5;
      m.onBeforeCompile = (sh) => {
        sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
          { float l = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
            diffuseColor.rgb = mix(vec3(l), diffuseColor.rgb, 0.12) * vec3(0.78, 0.8, 0.84); }`);
      };
      m.customProgramCacheKey = () => 'sgregrade';
    });
    return wrap;
  }

  // ---------------- procedural attachments ----------------
  static suppressor(len = 0.3, r = 0.034) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 24, 1), M('darkSteel'));
    body.rotation.x = Math.PI / 2; body.position.z = -len / 2;
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.92, r, 0.012, 24), M('steel'));
    cap.rotation.x = Math.PI / 2; cap.position.z = -len;
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.04, r * 1.04, 0.02, 24), M('steel'));
    ring.rotation.x = Math.PI / 2; ring.position.z = -0.03;
    g.add(body, cap, ring);
    const tip = new THREE.Object3D(); tip.name = 'tip'; tip.position.z = -len - 0.006; g.add(tip);
    return g;
  }

  static muzzleDevice(type, r = 0.02) {
    const g = new THREE.Group();
    const len = type === 'compensator' ? 0.09 : type === 'brake' ? 0.11 : 0.08;
    const body = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.05, len, 16), M(type === 'brake' ? 'steel' : 'darkSteel'));
    body.rotation.x = Math.PI / 2; body.position.z = -len / 2;
    g.add(body);
    // Ports / prongs.
    const n = type === 'flashhider' ? 4 : 3;
    for (let i = 0; i < n; i++) {
      const slot = new THREE.Mesh(new THREE.BoxGeometry(type === 'brake' ? r * 2.3 : 0.006, type === 'brake' ? 0.008 : r * 2.2, len * 0.22), M('polymer'));
      slot.position.z = -len * (0.25 + i * 0.22);
      if (type === 'flashhider') { slot.rotation.z = (i / n) * Math.PI; slot.position.z = -len * 0.75; }
      g.add(slot);
    }
    const tip = new THREE.Object3D(); tip.name = 'tip'; tip.position.z = -len - 0.004; g.add(tip);
    return g;
  }

  static vgrip() {
    const g = new THREE.Group();
    const geo = new THREE.CylinderGeometry(0.022, 0.026, 0.13, 14);
    const m = new THREE.Mesh(geo, M('polymer')); m.position.y = -0.075;
    const clamp = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.025, 0.06), M('darkSteel')); clamp.position.y = -0.01;
    g.add(m, clamp);
    return g;
  }

  static agrip() {
    const g = new THREE.Group();
    const shape = new THREE.Shape();
    shape.moveTo(0, 0); shape.lineTo(0.12, 0); shape.lineTo(0.03, -0.05); shape.lineTo(-0.01, -0.05); shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.035, bevelEnabled: true, bevelSize: 0.005, bevelThickness: 0.005, bevelSegments: 2 });
    geo.translate(-0.05, 0, -0.0175);
    const m = new THREE.Mesh(geo, M('polymer'));
    m.rotation.y = Math.PI / 2;
    g.add(m);
    return g;
  }

  static bipod() {
    const g = new THREE.Group();
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.03, 0.05), M('darkSteel'));
    g.add(base);
    for (const s of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.24, 8), M('steel'));
      leg.rotation.x = Math.PI / 2 - 0.12;
      leg.rotation.z = s * 0.12;
      leg.position.set(s * 0.018, -0.02, -0.12);
      g.add(leg);
    }
    return g;
  }

  static laser() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.03, 0.08), M('polymer'));
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.008, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 0.2, 0.15) }));
    lens.position.set(0.006, 0, -0.0405); lens.rotation.y = Math.PI;
    g.add(body, lens);
    const emitter = new THREE.Object3D(); emitter.name = 'emitter'; emitter.position.set(0.006, 0, -0.042); g.add(emitter);
    return g;
  }

  static drum() {
    // RPK-style 75-round drum.
    const g = new THREE.Group();
    const d = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.105, 0.075, 28), M('darkSteel'));
    d.rotation.z = Math.PI / 2;
    d.position.set(0, -0.2, 0.0);
    const neck = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.12, 0.07), M('darkSteel'));
    neck.position.set(0, -0.06, 0.0);
    const rib = new THREE.Mesh(new THREE.TorusGeometry(0.105, 0.006, 6, 28), M('steel'));
    rib.rotation.y = Math.PI / 2; rib.position.set(0.038, -0.2, 0);
    const rib2 = rib.clone(); rib2.position.x = -0.038;
    g.add(d, neck, rib, rib2);
    return g;
  }

  /** Ghost-ring rear + ramped front post with a glowing bead (shotgun irons). Returns { rear, front }. */
  static shotgunSights(rearPos, frontPos) {
    const rear = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.017, 0.0055, 8, 24), M('darkSteel'));
    rear.add(ring);
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.026, 0.05), M('darkSteel'));
    base.position.y = -0.03; rear.add(base);
    for (const sx of [-1, 1]) {
      const wing = new THREE.Mesh(new THREE.BoxGeometry(0.007, 0.05, 0.04), M('darkSteel'));
      wing.position.set(sx * 0.028, -0.006, 0); rear.add(wing);
    }
    rear.position.set(...rearPos);
    const front = new THREE.Group();
    const h = 0.065;
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.009, h, 0.03), M('darkSteel'));
    post.position.y = -h / 2; front.add(post);
    const ramp = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.02, 0.07), M('darkSteel'));
    ramp.position.y = -h + 0.006; front.add(ramp);
    const bead = new THREE.Mesh(new THREE.SphereGeometry(0.0075, 12, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(2.6, 1.3, 0.25), toneMapped: false }));
    bead.position.y = 0.001; front.add(bead);
    front.position.set(...frontPos);
    return { rear, front };
  }

  static extMag(mag) {
    // Lengthen magazine visually by 35% (keeps authored look).
    mag.scale.y *= 1.35;
  }
}
