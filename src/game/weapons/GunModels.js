import * as THREE from 'three';
import { grimeTex } from '../../render/ProcTex.js';

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
  shotgun: { kind: 'rifle', primary: [0.0, -0.12, -0.02], support: [0.0, -0.03, -0.62] },
};

// Reload phase timings (fraction of clip) — same source (FirstPersonReloadProfileCatalog.cs).
export const RELOAD_PHASES = {
  rifle: { reach: 0.12, stow: 0.42, acquire: 0.53, seat: 0.77, action: 0.91 },
  long: { reach: 0.12, stow: 0.41, acquire: 0.52, seat: 0.76, action: 0.92 },
  sidearm: { reach: 0.18, stow: 0.43, acquire: 0.54, seat: 0.78, action: 0.985 },
};

export const HIP_POS = {
  rifle: [0.31, -0.27, -0.62], m4a1: [0.34, -0.3, -0.68], ak74: [0.3, -0.2, -0.62],
  long: [0.3, -0.29, -0.66], sidearm: [0.38, -0.18, -0.55], compact: [0.31, -0.27, -0.62], shotgun: [0.31, -0.25, -0.62],
};

/**
 * Per-platform first-person presentation (our own AAA-style framing on top of the ported grip math).
 * scale: WeaponRoot scale. hip: WeaponRoot position in view-camera space. hipRot: [pitch, yaw, roll]
 * (yaw > 0 converges the muzzle toward the crosshair). primary/support override the POSES grips.
 * adsZ: eye relief (distance from the eye to the sight's rear reference) when aiming.
 */
export const VM_TUNE = {
  default: { scale: 0.68, hip: [0.31, -0.27, -0.62], hipRot: [0.018, 0.045, -0.018], adsZ: 0.5 },
  m4a1: { hip: [0.34, -0.3, -0.68] },
  ak74: { scale: 0.82, hip: [0.3, -0.2, -0.62] },
  scarl: {},
  mp5a5: {},
  vss: {},
  m24: { hip: [0.3, -0.29, -0.66] },
  awm: { hip: [0.3, -0.29, -0.66] },
  shotgun: { hip: [0.31, -0.25, -0.62] },
  p226: { hip: [0.38, -0.18, -0.55] },
  m1911: { hip: [0.38, -0.18, -0.55] },
};
export const vmTune = (key) => ({ ...VM_TUNE.default, ...(VM_TUNE[key] || {}) });

let _grime = null;
const grime = () => (_grime ||= grimeTex(256, 77));

/** Gun material with object-space triplanar micro-variation (wear, fingerprints, roughness breakup). */
export function gunMaterial(color, metalness, roughness, opts = {}) {
  const m = new THREE.MeshStandardMaterial({ color, metalness, roughness, envMapIntensity: opts.env ?? 1.0 });
  const g = grime();
  m.onBeforeCompile = (sh) => {
    sh.uniforms.gunGrime = { value: g };
    sh.uniforms.wearAmt = { value: opts.wear ?? 0.5 };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vObjPos; varying vec3 vObjN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObjPos = position; vObjN = normal;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D gunGrime; uniform float wearAmt; varying vec3 vObjPos; varying vec3 vObjN;\n' +
        'float tri(vec3 p, vec3 n, float s){ vec3 w = abs(n); w /= (w.x+w.y+w.z+1e-4); return texture2D(gunGrime, p.yz*s).r*w.x + texture2D(gunGrime, p.xz*s).r*w.y + texture2D(gunGrime, p.xy*s).r*w.z; }')
      .replace('#include <map_fragment>', `#include <map_fragment>
        float gA = tri(vObjPos, vObjN, 6.0);
        float gB = tri(vObjPos, vObjN, 23.0);
        diffuseColor.rgb *= 0.9 + 0.2 * gA;
        float wearMask = smoothstep(0.62, 0.8, gB) * wearAmt;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor * (0.75 + 0.5 * gA) - wearMask * 0.25, 0.08, 1.0);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        metalnessFactor = clamp(metalnessFactor + wearMask * 0.4, 0.0, 1.0);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.42, 0.44), wearMask * 0.35);`);
  };
  m.customProgramCacheKey = () => 'gunmat';
  return m;
}

const LIB = {
  steel: () => gunMaterial(0x2b2d30, 0.85, 0.42),
  darkSteel: () => gunMaterial(0x1c1d20, 0.8, 0.5),
  brightSteel: () => gunMaterial(0x6e7076, 1.0, 0.3, { wear: 0.2 }),
  polymer: () => gunMaterial(0x17181a, 0.0, 0.62, { wear: 0.15 }),
  polymerGrey: () => gunMaterial(0x3a3c3f, 0.0, 0.6, { wear: 0.15 }),
  tan: () => gunMaterial(0x8a7a5c, 0.0, 0.62, { wear: 0.2 }),
  od: () => gunMaterial(0x3f4535, 0.05, 0.6, { wear: 0.25 }),
  wood: () => gunMaterial(0x5a3a22, 0.0, 0.5, { wear: 0.1 }),
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
  if (mat.map || mat.normalMap) {
    mat.envMapIntensity = 1.0;
    if (n.includes('wood')) mat.roughness = Math.max(mat.roughness, 0.45);
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
    const keys = ['m4a1', 'ak47', 'scarl', 'mp5a5', 'vss', 'm24', 'awm', 'p226', 'm1911', 'shotgun', 'optics'];
    await Promise.all([
      ...keys.map(async (k) => { const g = await this.assets.model('gun_' + k, `models/weapons/${k}.glb`); if (g) this.src[k] = g.scene; }),
      this.assets.model('arms_rifle', 'models/weapons/smg45_rifle_arms.glb').then((g) => (this.armsRifle = g)),
      this.assets.model('arms_pistol', 'models/weapons/smg45_pistol_service_arms.glb').then((g) => (this.armsPistol = g)),
      this.assets.model('arms_reload', 'models/weapons/animated_reload_arms.glb').then((g) => (this.armsReload = g)),
    ]);
    // Normalise the shotgun (third-party model, different axes/scale) into the shared contract:
    // muzzle toward −Z, ~1.75 units long (same Godot-space scale as the steel-tide rifles).
    if (this.src.shotgun) this.src.shotgun = this.normaliseShotgun(this.src.shotgun);
    for (const [k, s] of Object.entries(this.src)) {
      s.traverse((o) => {
        if (o.isMesh) {
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
    muzzle.position.set(0, bb2.max.y - 0.07, bb2.min.z);
    wrap.add(muzzle);
    const eject = new THREE.Object3D(); eject.name = 'EjectionPort'; eject.position.set(0.05, 0.02, -0.3); wrap.add(eject);
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

  static extMag(mag) {
    // Lengthen magazine visually by 35% (keeps authored look).
    mag.scale.y *= 1.35;
  }
}
