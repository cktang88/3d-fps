import * as THREE from 'three';
import { GunModels, POSES, RELOAD_PHASES, M, vmTune, VM_TUNE } from './GunModels.js';
import { FPArms, FP_K, FP_TUNE } from './FPRig.js';
import { composeDelta } from './FPAnims.js';
import { RIFLE_TAC, rifleEmptyKeys, SEAT_E, TPL_SEAT, BOLT_PHASE, PISTOL_TAC, PISTOL_EMPTY, PISTOL_PHASE, INSPECT_RIFLE, INSPECT_PISTOL, sampleKeys, phase } from './ReloadChoreo.js';
import { Spring, Spring3, damp, clamp, DEG, smoothstep, easeInOutSine, rand } from '../../core/MathUtil.js';
import { muzzleFlashAtlas, muzzleSideTex, reticleTex, glowTex } from '../../render/ProcTex.js';
import { PlayerBody } from '../PlayerBody.js';

const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);
const PROBE_LAYER = 4; // render layer for the viewmodel light probe
// Overhand-throw hand path (UAL2 "OverhandThrow", CC0): throwing hand relative to the head at 20 Hz,
// mirrored onto the left hand and converted to view space (x right, y up, z back).
const THROW_PATH = [[-0.339,-0.578,0.211],[-0.445,-0.481,0.277],[-0.469,-0.292,0.412],[-0.36,-0.084,0.508],[-0.236,0.084,0.494],
  [-0.413,0.282,0.032],[-0.397,0.274,-0.295],[-0.031,-0.406,-0.402],[-0.064,-0.544,-0.289],[-0.108,-0.584,-0.226]];
const THROW_WIND = 4; // index where the wind-up holds while cooking
const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _k = new Array(6), _e = new THREE.Euler(), _pv = new THREE.Vector3(), _pole = new THREE.Vector3();
// Support-arm elbow pole (view-camera space): when the hand travels far from its grip (magazine pouch, belt) the
// elbow hangs down and out instead of flaring up into the left edge of the frame.
const ELBOW_POLE_L = [-0.5, -0.85, 0.15];

function find(root, name) {
  let r = null;
  root.traverse((o) => { if (!r && o.name === name) r = o; });
  return r;
}
function findAny(root, names) { for (const n of names) { const f = find(root, n); if (f) return f; } return null; }

/** Lowest visible gun surface (root-local y) within a z slab around `z` near the centre line. */
function undersideAt(gun, root, z, half) {
  return scanAt(gun, root, z, half, (v, acc) => (Math.abs(v.x) < 0.05 ? Math.min(acc, v.y) : acc), Infinity, -0.1);
}
/** Right-most gun surface (root-local x) within a z slab. */
function sideAt(gun, root, z, half) {
  return scanAt(gun, root, z, half, (v, acc) => Math.max(acc, v.x), -Infinity, 0.03);
}
function scanAt(gun, root, z, half, fn, init, fallback) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const m = new THREE.Matrix4(), v = new THREE.Vector3();
  let acc = init;
  gun.traverse((o) => {
    if (!o.isMesh || !o.visible || o.userData.glass) return;
    let vis = true; for (let p = o; p && p !== gun; p = p.parent) if (!p.visible) vis = false;
    if (!vis || /Magazine|Spare/i.test(o.parent?.name || '') || /Magazine/i.test(o.name)) return;
    m.multiplyMatrices(inv, o.matrixWorld);
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      if (Math.abs(v.z - z) < half) acc = fn(v, acc);
    }
  });
  return Number.isFinite(acc) ? acc : fallback;
}

/**
 * Cube render target → world-space SH (L0 + L1 only), like LightProbeGenerator.fromCubeRenderTarget
 * but with per-texel luminance clamping so the sun disc / flash sprites don't swamp the ambient term.
 */
async function captureSH(renderer, rt, out, clampLum = 6) {
  const W = rt.width, data = new Uint16Array(W * W * 4);
  const acc = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const coord = new THREE.Vector3(), px = 2 / W, h = THREE.DataUtils.fromHalfFloat;
  let total = 0;
  for (let f = 0; f < 6; f++) {
    await renderer.readRenderTargetPixelsAsync(rt, 0, 0, W, W, data, f);
    for (let i = 0; i < data.length; i += 4) {
      let r = h(data[i]), g = h(data[i + 1]), b = h(data[i + 2]);
      if (!(r >= 0 && g >= 0 && b >= 0)) continue;
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (l > clampLum) { const k = clampLum / l; r *= k; g *= k; b *= k; }
      const pi = i / 4, col = -(1 - ((pi % W) + 0.5) * px), row = 1 - (Math.floor(pi / W) + 0.5) * px;
      switch (f) {
        case 0: coord.set(1, row, -col); break;
        case 1: coord.set(-1, row, col); break;
        case 2: coord.set(col, 1, -row); break;
        case 3: coord.set(col, -1, row); break;
        case 4: coord.set(col, row, 1); break;
        default: coord.set(-col, row, -1);
      }
      const l2 = coord.lengthSq(), wgt = 4 / (Math.sqrt(l2) * l2);
      total += wgt;
      coord.normalize();
      // Basis (as SphericalHarmonics3.getBasisAt): 0.282095, 0.488603·y, 0.488603·z, 0.488603·x
      const b0 = 0.282095 * wgt, b1 = 0.488603 * coord.y * wgt, b2 = 0.488603 * coord.z * wgt, b3 = 0.488603 * coord.x * wgt;
      acc[0].x += b0 * r; acc[0].y += b0 * g; acc[0].z += b0 * b;
      acc[1].x += b1 * r; acc[1].y += b1 * g; acc[1].z += b1 * b;
      acc[2].x += b2 * r; acc[2].y += b2 * g; acc[2].z += b2 * b;
      acc[3].x += b3 * r; acc[3].y += b3 * g; acc[3].z += b3 * b;
    }
  }
  const sh = out || new THREE.SphericalHarmonics3();
  const norm = (4 * Math.PI) / Math.max(1e-6, total);
  for (let j = 0; j < 9; j++) sh.coefficients[j].set(0, 0, 0);
  for (let j = 0; j < 4; j++) sh.coefficients[j].copy(acc[j]).multiplyScalar(norm);
  return sh;
}

/** Matrix of `node` expressed in `root`'s local space. */
function relMatrix(node, root, out = new THREE.Matrix4()) {
  root.updateMatrixWorld(true);
  return out.copy(root.matrixWorld).invert().multiply(node.matrixWorld);
}

/**
 * First-person weapon presentation.
 * WeaponRoot (in view-camera space) holds the gun at identity, authored static arms mounted on the
 * firing grip and (during reloads) the authored animated support arm with the magazine following
 * the hand. All extra motion (sway, bob, kick, ADS, sprint, equip, inspect, melee) is procedural
 * spring animation layered on the root.
 */
export class ViewModel {
  constructor(game, models) {
    this.game = game;
    this.models = models;
    this.viewScene = game.renderer.viewScene;
    this.viewCam = game.renderer.viewCamera;
    this.holder = new THREE.Group(); // receives procedural offsets
    this.viewCam.add(this.holder);
    this.rigs = new Map();
    this.rig = null;

    // Springs.
    this.swayPos = new Spring3(90, 0.7);
    this.swayRot = new Spring3(110, 0.65);
    this.kickPos = new Spring3(260, 0.6);
    this.kickRot = new Spring3(240, 0.55);
    this.landY = new Spring(140, 0.55);
    // Pistol muzzle flip (deg) / push (cm) about the firing grip: stiff and under-damped so each shot snaps up and
    // returns fast (a wrist flip, not a float).
    this.flipR = new Spring3(420, 0.52);
    this.flipP = new Spring3(520, 0.6);
    this.adsBlend = 0;
    this.sprintBlend = 0;
    this.reloadBlend = 0;
    this.equipT = 1;
    this.inspectT = 0;
    this.meleeT = 0;
    this.bobT = 0;
    this.slideBlend = 0;
    this.time = 0;
    this.flashT = 0;
    this.mantleBlend = 0;
    this.hidden = false;

    this._buildFlash();
    this._buildLighting();
    this._buildAnimatedArms();
    this._buildScopeRT();
    this.laserDot = this._buildLaserDot();
  }

  // ------------------------------------------------------------------ setup
  _buildLighting() {
    const s = this.viewScene;
    const q = this.game.settings?.quality ?? 2;
    this.lightQ = q;
    // Key: the real sun (direction/colour from the level), with a tight shadow map covering only the
    // viewmodel so hands shadow the gun and the gun shadows the hands (Medium+).
    this.vmSun = new THREE.DirectionalLight(0xfff0dc, 2.2);
    this.vmSun.position.set(0.4, 1, 0.3);
    this.vmSunTarget = new THREE.Object3D();
    this.vmSunTarget.position.set(0.15, -0.22, -0.55);
    this.vmSun.target = this.vmSunTarget;
    // Built on every quality (render owner): presets / adaptive quality / the benchmark toggle it at runtime
    // (applyFeatures), and a Low boot can be raised later without rebuilding the lighting rig.
    {
      this.vmSun.castShadow = q >= 1;
      const sh = this.vmSun.shadow;
      sh.mapSize.setScalar(q >= 2 ? 1024 : 512);
      Object.assign(sh.camera, { left: -0.75, right: 0.75, top: 0.75, bottom: -0.75, near: 0.05, far: 4 });
      sh.camera.updateProjectionMatrix();
      sh.bias = -0.0004; sh.normalBias = 0.012; sh.radius = 2.5;
      this._shadowRT = new THREE.WebGLRenderTarget(1, 1);
    }
    // Ambient: hemisphere until the local light probe has data, then the probe takes over.
    this.vmHemi = new THREE.HemisphereLight(0xbcc8d6, 0x4a4036, 0.35);
    this.vmProbe = new THREE.LightProbe(undefined, 0);
    // Rim: grazing back-light from upper-left-front so silhouettes separate from dark backgrounds.
    this.vmRim = new THREE.DirectionalLight(0xbcd2ff, 0);
    this.vmRim.position.set(-0.9, 0.7, -1.1);
    // Mirrors of the nearest bright scene lights (fires, lamps, explosions) — fixed count, no recompiles.
    this.vmLocal = [0, 1].map(() => { const l = new THREE.PointLight(0xffffff, 0, 0, 2); s.add(l); return l; });
    // Small emissive accents (red-dot / laser spill onto the housing).
    this.vmAccent = new THREE.PointLight(0xff2a1a, 0, 0.25, 2);
    this.vmFill = new THREE.PointLight(0xffb070, 0, 3, 2); // muzzle flash light on the gun
    this.viewCam.add(this.vmFill, this.vmAccent);
    this.vmFill.position.set(0.2, -0.1, -0.9);
    s.add(this.vmSun, this.vmSunTarget, this.vmHemi, this.vmProbe, this.vmRim);
    // Local light probe (Medium+): a 32 px cube rendered one face per frame at the eye, read back
    // asynchronously into L0/L1 spherical harmonics (world space; rotated into view space per frame).
    {
      this.probeRT = new THREE.WebGLCubeRenderTarget(32, { type: THREE.HalfFloatType, generateMipmaps: false });
      this.probeCams = [];
      // Same face set-up as THREE.CubeCamera (WebGL coordinate system, negative fov flip).
      const dirs = [[1, 0, 0, 0, 1, 0], [-1, 0, 0, 0, 1, 0], [0, 1, 0, 0, 0, -1], [0, -1, 0, 0, 0, 1], [0, 0, 1, 0, 1, 0], [0, 0, -1, 0, 1, 0]];
      for (const d of dirs) {
        const c = new THREE.PerspectiveCamera(-90, 1, 0.1, 30);
        c.up.set(d[3], d[4], d[5]); c.userData.dir = new THREE.Vector3(d[0], d[1], d[2]);
        c.layers.set(PROBE_LAYER); // static level + sky + lights only (tagged lazily, see _tagProbeLayer)
        this.probeCams.push(c);
      }
      this.probeFace = 0;
      this.probeInterval = q >= 2 ? 0.25 : 0.5;
      this.probeEvery = q >= 2 ? 2 : q >= 1 ? 4 : 0; // render one cube face every Nth frame (0 = probe off)
      this._probeTick = 0;
      this.probeTimer = 0;
      this.shTarget = null; // world-space SH from the last readback
      this.shWorld = new THREE.SphericalHarmonics3();
      this.probeLum = 0; this.probeLumRef = 0.05;
    }
    this._lightCache = []; this._lightScanT = 0; this._occ = new Map();
  }

  _buildFlash() {
    const atlas = muzzleFlashAtlas();
    const side = muzzleSideTex();
    const mat = (tex, c) => new THREE.MeshBasicMaterial({
      map: tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, toneMapped: false,
      color: c, side: THREE.DoubleSide, fog: false,
    });
    this.flash = new THREE.Group();
    // Front star: a camera-facing card a touch ahead of the crown so the device never occludes it.
    const front = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.36), mat(atlas, new THREE.Color(3.4, 2.7, 2.0)));
    front.geometry.attributes.uv.array.forEach((v, i, arr) => (arr[i] = v * 0.5));
    front.position.z = -0.025;
    this.flashFront = front;
    // Side cones: three cards rotated about the bore, each starting at the crown and extending forward.
    const coneGeo = new THREE.PlaneGeometry(0.42, 0.2);
    coneGeo.translate(0.21, 0, 0); coneGeo.rotateY(Math.PI / 2); // +x → −z (down range)
    this.flashCones = [];
    for (let i = 0; i < 3; i++) {
      const c = new THREE.Mesh(coneGeo, mat(side, new THREE.Color(2.6, 1.9, 1.3)));
      c.rotation.z = (i / 3) * Math.PI;
      this.flash.add(c); this.flashCones.push(c);
    }
    this.flash.add(front);
    this.flash.traverse((o) => { o.renderOrder = 20; o.frustumCulled = false; });
    this.flash.visible = false;
  }

  _buildAnimatedArms() {
    const g = this.models.armsReload;
    if (!g) return;
    this.reloadArms = g.scene;
    this.reloadArms.visible = false;
    this.reloadArms.traverse((o) => {
      if (o.isMesh) { o.frustumCulled = false; o.castShadow = false; }
    });
    this.reloadClips = new Map(g.animations.map((c) => [c.name, c]));
    this.reloadMixer = new THREE.AnimationMixer(this.reloadArms);
    this.reloadMeshes = {
      long: find(this.reloadArms, 'LongGunReloadForearmsMesh'),
      side: find(this.reloadArms, 'SidearmReloadForearmsMesh'),
      full: find(this.reloadArms, 'FullReloadArmsAuditMesh'),
    };
    if (this.reloadMeshes.full) this.reloadMeshes.full.visible = false;
    this.reloadGrip = find(this.reloadArms, 'RightGripFrame');
    this.leftGripAnchor = find(this.reloadArms, 'LeftGripAnchorFrame');
    this.leftPalm = find(this.reloadArms, 'LeftPalmFrame');
    this.leftSideMagAnchor = find(this.reloadArms, 'LeftSidearmMagazineAnchorFrame');
    // The clip also carries a right forearm; the static rig's right arm already holds the grip, so
    // the animated one is collapsed (its open sleeve otherwise swings into view when the gun tilts).
    this.reloadRightArmBone = find(this.reloadArms, 'R_arm_024');
    // Clip names are in the form reload_<stem>_<empty|tactical>.
  }

  _buildScopeRT() {
    this.scopeRT = new THREE.WebGLRenderTarget(512, 512, { type: THREE.HalfFloatType, samples: 0 });
    this.scopeCam = new THREE.PerspectiveCamera(10, 1, 0.1, 900);
    this.scopeLensMat = new THREE.ShaderMaterial({
      uniforms: { map: { value: this.scopeRT.texture }, reticle: { value: reticleTex('chevron', '#ff3a20') }, fade: { value: 1 }, exposure: { value: 1 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform sampler2D map; uniform sampler2D reticle; uniform float fade; uniform float exposure; varying vec2 vUv;
        void main(){
          vec2 c = vUv - 0.5; float r = length(c) * 2.0;
          vec3 col = texture2D(map, vUv).rgb * exposure;
          // The RT is linear HDR like the view pass it is composited into; post (tonemap/grade)
          // runs on the final image, so no tonemap/gamma here (that double-encoded and washed it out).
          vec4 ret = texture2D(reticle, (vUv - 0.5) * 1.6 + 0.5);
          col = mix(col, ret.rgb * 1.4, ret.a);
          // Black crosshair lines.
          float line = (abs(c.x) < 0.0025 && c.y < -0.08) || (abs(c.y) < 0.0025 && abs(c.x) > 0.12) ? 1.0 : 0.0;
          col = mix(col, vec3(0.0), line);
          float vig = smoothstep(1.0, 0.72, r);
          col *= vig;
          if (r > 1.0) discard;
          gl_FragColor = vec4(mix(vec3(0.0), col, fade), 1.0);
        }`,
    });
  }

  _buildLaserDot() {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.06, 0.06), new THREE.MeshBasicMaterial({
      map: glowTex(), color: new THREE.Color(6, 0.3, 0.2), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }));
    m.visible = false;
    this.game.renderer.scene.add(m);
    const beamGeo = new THREE.CylinderGeometry(0.0012, 0.0012, 1, 4, 1, true);
    beamGeo.translate(0, 0.5, 0); beamGeo.rotateX(-Math.PI / 2); // y∈[0,1] → z∈[−1,0]: down range
    this.beam = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 0.1, 0.08), transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    this.beam.visible = false;
    return m;
  }

  // ------------------------------------------------------------------ rig build
  /** Build (or fetch cached) rig for weapon id + loadout. */
  getRig(weapon) {
    const key = weapon.id + JSON.stringify(weapon.loadout);
    if (this.rigs.has(key)) return this.rigs.get(key);
    const rig = this._buildRig(weapon);
    this.rigs.set(key, rig);
    return rig;
  }

  _buildRig(weapon) {
    const s = weapon.stats;
    const modelKey = s.model;
    const src = this.models.src[modelKey];
    const poseKey = s.pose;
    // Authored FP rig (gun + posed arms): its own tune; the steel-tide VM_TUNE numbers belong to the old meshes.
    const fp = this.models.fp?.[modelKey];
    const tune = fp ? { ...VM_TUNE.default, ...FP_TUNE.default, ...(FP_TUNE[modelKey] || {}), scale: 1 / FP_K } : vmTune(poseKey);
    const basePose = POSES[poseKey] || POSES.m4a1;
    const pose = { ...basePose, primary: tune.primary || basePose.primary, support: tune.support || basePose.support };
    if (fp?.gripR) { pose.primary = fp.gripR.toArray(); pose.support = (fp.gripL || fp.gripR).toArray(); }
    const sidearm = pose.kind === 'sidearm';
    const root = new THREE.Group();
    root.name = 'WeaponRoot';
    const scale = tune.scale;
    root.scale.setScalar(scale);
    // FP rigs: wrap so `gun` is an identity frame (attachments below are placed in WeaponRoot coordinates,
    // while M4/AK carry a uniform scale on their own root node).
    const gun = fp ? new THREE.Group().add(src.clone(true)) : src.clone(true);
    root.add(gun);
    root.updateMatrixWorld(true);

    const rig = { root, gun, weapon, pose, poseKey, sidearm, scale, kind: pose.kind, stats: s, tune };
    rig.magazine = find(gun, 'Magazine');
    rig.spare = find(gun, 'SpareMagazine');
    if (rig.spare) rig.spare.visible = false;
    rig.charging = find(gun, 'ChargingHandle');
    if (tune.magOffset) for (const m of [rig.magazine, rig.spare]) m?.position.add(V(tune.magOffset));
    if (tune.chargingOffset && rig.charging) rig.charging.position.add(V(tune.chargingOffset));
    rig.magHome = rig.magazine ? { p: rig.magazine.position.clone(), q: rig.magazine.quaternion.clone() } : null;
    rig.spareHome = rig.spare ? { p: rig.spare.position.clone(), q: rig.spare.quaternion.clone() } : null;
    // Bolt-action: hang the bolt on a pivot on the bore axis so the handle can lift, run back and
    // lock down (the authored handle node sits out at the knob).
    if (rig.charging && s.modes[0] === 'bolt') {
      const pivot = new THREE.Group(); pivot.name = 'BoltPivot';
      pivot.position.set(0, rig.charging.position.y - 0.01, rig.charging.position.z);
      rig.charging.parent.add(pivot);
      rig.charging.position.sub(pivot.position);
      pivot.add(rig.charging);
      rig.boltPivot = pivot; rig.boltHome = pivot.position.clone();
    }
    rig.chargingHome = rig.charging ? rig.charging.position.clone() : null;
    rig.magGrip = rig.magazine ? findAny(rig.magazine, ['MagazineGripSocket', 'MagazineGrip']) : null;
    rig.spareGrip = rig.spare ? findAny(rig.spare, ['SpareMagazineGrip', 'MagazineGripSocket']) : null;

    // ---- Attachments ----
    const att = s.att;
    // Authored attachment nodes count only when they carry geometry (the AK ships empty markers).
    const hasMesh = (o) => { let r = false; o?.traverse((c) => { if (c.isMesh) r = true; }); return r; };
    const authored = (n) => { const o = find(gun, n); return hasMesh(o) ? o : null; };
    const authoredSup = authored('Suppressor'), authoredMuzzleDev = authored('MuzzleDevice');
    const authoredForegrip = authored('Foregrip'), authoredOptic = authored('OpticMount');
    const rear = findAny(gun, ['RearIronSight']), front = findAny(gun, ['FrontIronSight']);
    let muzzleTip = findAny(gun, ['MuzzleDeviceTip', 'MuzzleSocket']);
    if (!muzzleTip) {
      // Compute from bounds: front-most point at barrel height.
      const bb = new THREE.Box3().setFromObject(gun);
      muzzleTip = new THREE.Object3D();
      muzzleTip.position.set(0, 0.06, bb.min.z + 0.02);
      gun.add(muzzleTip);
    }
    if (authoredSup) { authoredSup.visible = att.muzzle === 'suppressor'; if (tune.supOffset) authoredSup.position.add(V(tune.supOffset)); }
    if (authoredMuzzleDev) authoredMuzzleDev.visible = !att.muzzle || att.muzzle !== 'suppressor';
    if (authoredForegrip) authoredForegrip.visible = att.underbarrel === 'vgrip';
    if (authoredOptic) authoredOptic.visible = false;
    if (tune.muzzle) muzzleTip.position.copy(V(tune.muzzle)).applyMatrix4(new THREE.Matrix4().copy(muzzleTip.parent.matrixWorld).invert().multiply(root.matrixWorld));
    gun.updateMatrixWorld(true);
    rig.boreY = tune.boreY ?? muzzleTip.getWorldPosition(new THREE.Vector3()).applyMatrix4(new THREE.Matrix4().copy(root.matrixWorld).invert()).y;
    let tip = muzzleTip;
    if (att.muzzle === 'suppressor') {
      if (authoredSup) tip = find(authoredSup, 'SuppressorTip') || tip;
      else {
        const sup = GunModels.suppressor(sidearm ? 0.2 : 0.32, sidearm ? 0.026 : 0.036);
        sup.scale.setScalar(sidearm ? 1 : (tune.opticScale ?? 0.72) / 0.72);
        sup.position.copy(muzzleTip.position);
        muzzleTip.parent.add(sup);
        tip = find(sup, 'tip');
      }
    } else if (att.muzzle && !(authoredMuzzleDev && att.muzzle === 'flashhider')) {
      const md = GunModels.muzzleDevice(att.muzzle, sidearm ? 0.016 : 0.022);
      md.scale.setScalar(sidearm ? 1 : (tune.opticScale ?? 0.72) / 0.72);
      md.position.copy(muzzleTip.position);
      muzzleTip.parent.add(md);
      if (authoredMuzzleDev) authoredMuzzleDev.visible = false;
      tip = find(md, 'tip');
    }
    rig.muzzle = tip;
    // Under-barrel.
    const support = V(pose.support);
    // Attachments are modelled at the steel-tide (~1.7x) scale; the M4 asset is larger, AK/MP5 smaller.
    const attScale = (tune.opticScale ?? 0.72) / 0.72;
    const under = undersideAt(gun, root, support.z, 0.05);
    const sideX = sideAt(gun, root, support.z - 0.04, 0.05);
    if (att.underbarrel === 'vgrip' && fp?.vgripMount) {
      // FP rigs: the support hand was authored around a grip at this exact mount (pose clip grip_vgrip).
      if (authoredForegrip) authoredForegrip.visible = false;
      const vg = GunModels.vgrip(); vg.scale.setScalar(attScale); vg.position.copy(fp.vgripMount); gun.add(vg);
    } else if (att.underbarrel === 'vgrip' && !authoredForegrip) {
      const vg = GunModels.vgrip(); vg.scale.setScalar(attScale); vg.position.set(support.x, under + 0.004, support.z + 0.02); gun.add(vg);
    } else if (att.underbarrel === 'agrip') {
      const ag = GunModels.agrip(); ag.scale.setScalar(attScale); ag.position.set(support.x, under + 0.004, support.z + 0.04); gun.add(ag);
    } else if (att.underbarrel === 'bipod') {
      const bz = support.z - 0.16 * attScale;
      const bp = GunModels.bipod(); bp.scale.setScalar(attScale); bp.position.set(0, undersideAt(gun, root, bz, 0.05) - 0.012, bz); gun.add(bp);
    }
    // Support hand rides the grip it is given: on a vertical grip the palm wraps the grip itself.
    if (att.underbarrel === 'vgrip' && fp?.vgripMount) pose.support = fp.vgripMount.toArray();
    else if (att.underbarrel === 'vgrip') {
      const gy = authoredForegrip ? find(gun, 'Foregrip').position.y + 0.03 : under - 0.05 * attScale;
      pose.support = [support.x, Math.min(support.y, gy), support.z];
    } else if (att.underbarrel === 'agrip') pose.support = [support.x, Math.min(support.y, under - 0.02 * attScale), support.z];
    if (att.laser) {
      const lz = GunModels.laser(); lz.scale.setScalar(attScale);
      lz.position.set(sideX + 0.018 * attScale, (support.y + under) / 2 + 0.01, support.z - 0.06); gun.add(lz);
      rig.laser = find(lz, 'emitter');
    }
    if (s.drum && rig.magazine) {
      rig.magazine.traverse((o) => { if (o.isMesh) o.visible = false; });
      const drum = GunModels.drum(); rig.magazine.add(drum);
      if (rig.spare) { rig.spare.traverse((o) => { if (o.isMesh) o.visible = false; }); rig.spare.add(GunModels.drum()); }
    }
    if (s.rpkScale) {
      // Heavier barrel: extend handguard region visually with a longer barrel sleeve.
      const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.22, 12), M('darkSteel'));
      sleeve.rotation.x = Math.PI / 2;
      sleeve.position.copy(muzzleTip.position).add(new THREE.Vector3(0, 0, -0.11));
      muzzleTip.parent.add(sleeve);
      if (!att.muzzle) { const t2 = new THREE.Object3D(); t2.position.copy(muzzleTip.position).add(new THREE.Vector3(0, 0, -0.22)); muzzleTip.parent.add(t2); rig.muzzle = t2; }
    }
    if (att.magazine === 'extmag' && rig.magazine && !s.drum) {
      rig.magazine.children.forEach((c) => { if (c.isMesh) c.scale.y *= 1.3; });
      rig.spare?.children.forEach((c) => { if (c.isMesh) c.scale.y *= 1.3; });
    }

    // Shotgun: authored model has no sights; add a ghost ring + bead (rear hides under an optic).
    if (poseKey === 'shotgun' && tune.ironRear) {
      const sg = GunModels.shotgunSights(tune.ironRear, tune.ironFront);
      gun.add(sg.rear, sg.front);
      sg.rear.visible = !att.optic || att.optic === 'irons';
    }
    // Optic.
    gun.updateMatrixWorld(true);
    rig.aim = this._mountOptic(rig, gun, att.optic, authoredOptic, rear, front);

    // Ejection port.
    rig.eject = findAny(gun, ['EjectionPort', 'ChargingHandleSocket']) || (() => { const o = new THREE.Object3D(); o.position.set(0.05, 0.07, -0.25); gun.add(o); return o; })();

    // ---- Static arms ----
    const armsSrc = sidearm ? this.models.armsPistol : this.models.armsRifle;
    if (fp) {
      // Skinned arms posed onto this exact gun offline (contact-solved); the support arm is IK-driven.
      rig.fp = new FPArms(fp, att.underbarrel === 'vgrip' && fp.vgripMount ? 'grip_vgrip' : null);
      rig.fp.object.traverse((o) => { if (o.isMesh) o.material.envMapIntensity = 0.9; });
      root.add(rig.fp.object);
      rig.pump = find(gun, 'Pump');
      rig.pumpHome = rig.pump ? rig.pump.position.clone() : null;
    } else if (armsSrc) {
      const arms = armsSrc.scene.clone(true);
      arms.traverse((o) => { if (o.isMesh) { o.frustumCulled = false; o.material.envMapIntensity = 0.9; } });
      root.add(arms);
      rig.arms = arms;
      rig.leftArm = find(arms, 'LeftArm');
      rig.rightArm = find(arms, 'RightArm');
      this._alignStaticArms(rig);
    }
    // Hip / ADS positions (WeaponRoot in view-camera space).
    rig.hipRot = new THREE.Euler(tune.hipRot[0], tune.hipRot[1], tune.hipRot[2]);
    // Hip: place the weapon so its bore line at the firing grip lands on a shared view-space anchor
    // (consistent framing across platforms regardless of where each model's origin is).
    const boreAnchor = new THREE.Vector3(0, rig.boreY, pose.primary[2]).multiplyScalar(scale);
    rig.hip = tune.hip ? V(tune.hip) : V(tune.hipAnchor).sub(boreAnchor.applyEuler(rig.hipRot)).add(V(tune.hipOffset || [0, 0, 0]));
    if (fp?.meta.hip) {
      // Authored hip framing (docs/FP_FRAMING.md): camera-space (x right, y fwd, z up, metres) of the bore
      // point above the grip, plus pitch / yaw / roll in degrees.
      const h = fp.meta.hip, D = Math.PI / 180;
      rig.hipRot = new THREE.Euler(h.rot[0] * D, h.rot[1] * D, h.rot[2] * D, 'YXZ');
      const b = new THREE.Vector3(h.boreRef[0], h.boreRef[2], -h.boreRef[1]).applyEuler(rig.hipRot);
      rig.hip = new THREE.Vector3(h.pos[0], h.pos[2], -h.pos[1]).sub(b).add(V(tune.hipOffset || [0, 0, 0]));
      rig.hipRot = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().setFromEuler(rig.hipRot));
    }
    // ADS: rotate so the sight axis (rear → front) runs exactly along the view axis, then put the
    // rear sight reference on the axis at the platform's eye relief.
    const a = rig.aim;
    const axis = a.front.clone().sub(a.point).normalize();
    const qAds = new THREE.Quaternion().setFromUnitVectors(axis, new THREE.Vector3(0, 0, -1));
    // Sight line relative to the bore (root -Z): the collimated reticle and the scope camera look along it.
    rig.sightQ = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), axis);
    rig.adsRot = new THREE.Euler().setFromQuaternion(qAds);
    const relief = a.overlay ? 0.3 : a.lens ? (tune.scopeRelief ?? 0.12) : a.reticle ? (tune.dotRelief ?? 0.3) : (tune.ironRelief ?? 0.26);
    rig.ads = a.point.clone().multiplyScalar(scale).applyQuaternion(qAds).negate().add(new THREE.Vector3(0, 0, -relief));
    rig.phases = RELOAD_PHASES[sidearm ? 'sidearm' : pose.kind === 'long' ? 'long' : 'rifle'];
    rig.clipStem = { m4a1: 'm4a1', ak74: 'ak74', scarl: 'scarl', mp5a5: 'mp5a5', vss: 'vss', m24: 'm24', awm: 'awm', p226: 'p226', m1911: 'm1911' }[poseKey];
    return rig;
  }

  _mountOptic(rig, gun, opticId, authoredOptic, rear, front) {
    const toRoot = (o) => o.getWorldPosition(new THREE.Vector3()).applyMatrix4(_m.copy(rig.root.matrixWorld).invert());
    const rootInv = new THREE.Matrix4().copy(rig.root.matrixWorld).invert();
    // ---- Integrated (fixed) scopes: VSS / M24 / AWM carry their own glass; derive the optical axis from it.
    if (rig.tune.integratedScope) {
      const verts = [];
      gun.traverse((o) => {
        if (!o.isMesh || !o.userData.glass) return;
        const pos = o.geometry.attributes.position; const mm = new THREE.Matrix4().multiplyMatrices(rootInv, o.matrixWorld);
        for (let i = 0; i < pos.count; i++) verts.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mm));
        o.visible = false; // replaced by our lens / overlay below
      });
      if (verts.length) {
        let maxZ = -Infinity, minZ = Infinity;
        for (const v of verts) { maxZ = Math.max(maxZ, v.z); minZ = Math.min(minZ, v.z); }
        const ring = (zz) => { const bb = new THREE.Box3(); for (const v of verts) if (Math.abs(v.z - zz) < 0.012) bb.expandByPoint(v); return bb; };
        const rb = ring(maxZ), fb = ring(minZ);
        const rearC = rb.getCenter(new THREE.Vector3()), frontC = fb.getCenter(new THREE.Vector3());
        const rearR = Math.min(rb.max.x - rb.min.x, rb.max.y - rb.min.y) / 2;
        const info = { point: rearC.clone(), front: frontC, type: opticId, scope: opticId === 'acog', integrated: true };
        const lensParent = new THREE.Group(); gun.add(lensParent);
        // gun is identity inside root, so root-space == gun-space here.
        if (opticId === 'sniper') {
          const lens = new THREE.Mesh(new THREE.CircleGeometry(rearR, 32), M('glass'));
          lens.position.copy(rearC); lensParent.add(lens);
          info.overlay = true;
        } else {
          const lens = new THREE.Mesh(new THREE.CircleGeometry(rearR * 0.96, 40), this.scopeLensMat);
          lens.position.copy(rearC).add(new THREE.Vector3(0, 0, -0.002)); lensParent.add(lens);
          info.lens = lens; info.lensRadius = rearR * 0.96; info.scope = true;
        }
        return info;
      }
    }
    const railAdapter = find(gun, 'OpticRailAdapterGeometry');
    if (railAdapter) railAdapter.visible = !!opticId && opticId !== 'irons';
    if (opticId && opticId !== 'irons' && rear) {
      rear.visible = false;
      // M4: the flip-up rear sight's loose leaves sit right under the eye at ADS; stow them too.
      for (const n of ['M4A1Body_05_Switch1', 'M4A1Body_06_Switch2']) { const o = find(gun, n); if (o) o.visible = false; }
    }
    if (opticId && opticId !== 'irons' && front && rig.poseKey !== 'ak74') front.visible = false;
    if (!opticId || opticId === 'irons') {
      // Iron sight line: through the rear notch/aperture and the front post tip, so ADS can align
      // the actual sight picture with the eye (front post sits exactly in the rear notch).
      const t = rig.tune;
      let rp, fp;
      if (t.ironRear) rp = V(t.ironRear);
      else if (rear) { const bb = new THREE.Box3().setFromObject(rear).applyMatrix4(rootInv); rp = new THREE.Vector3(bb.getCenter(_v).x, bb.max.y - (t.notch ?? 0.012), bb.getCenter(_v).z); }
      if (t.ironFront) fp = V(t.ironFront);
      else if (front) { const bb = new THREE.Box3().setFromObject(front).applyMatrix4(rootInv); fp = new THREE.Vector3(bb.getCenter(_v).x, bb.max.y - 0.004, bb.getCenter(_v).z); }
      if (!rp) {
        const bb = new THREE.Box3().setFromObject(gun).applyMatrix4(rootInv);
        rp = new THREE.Vector3(0, bb.max.y - 0.01, rig.sidearm ? 0.3 : 0);
      }
      if (!fp) fp = rp.clone().add(new THREE.Vector3(0, 0, -0.3));
      return { point: rp, front: fp, type: 'irons' };
    }
    const optics = this.models.src.optics;
    const realSniper = opticId === 'sniper' && !!find(optics, 'SniperOptic'); // dedicated riflescope model
    const nodeName = opticId === 'reddot' ? 'MicroOptic' : opticId === 'holo' ? 'HoloOptic' : realSniper ? 'SniperOptic' : 'ScopeOptic';
    const prefix = opticId === 'reddot' ? 'Micro' : opticId === 'holo' ? 'Holo' : realSniper ? 'Sniper' : 'Scope';
    const srcNode = find(optics, nodeName);
    const optic = srcNode.clone(true);
    optic.position.set(0, 0, 0); optic.rotation.set(0, 0, 0);
    // Rail position: authored socket, tuned rail, or receiver top.
    const railSock = findAny(gun, ['OpticRailSocket', 'OpticRailContact']);
    let mount;
    if (rig.tune.rail) mount = V(rig.tune.rail);
    else if (railSock) mount = toRoot(railSock);
    else if (rig.poseKey === 'm4a1') mount = new THREE.Vector3(0, 0.167 - 0.07, -0.25);
    else {
      const bb = new THREE.Box3().setFromObject(gun).applyMatrix4(rootInv);
      mount = new THREE.Vector3(0, bb.max.y - 0.01, rig.sidearm ? 0.2 : -0.25);
    }
    // Rail contact offsets (steel-tide constants): micro 0.070, holo 0.092, scope 0.084.
    const contact = { reddot: 0.07, holo: 0.092, acog: 0.084, sniper: 0.084 }[opticId];
    const osc = rig.sidearm ? 0.6 : rig.tune.opticScale;
    optic.position.copy(mount).add(new THREE.Vector3(0, contact * osc, 0));
    if (opticId === 'sniper' && !realSniper) optic.scale.set(1.3, 1.3, 1.5);
    optic.scale.multiplyScalar(osc);
    gun.add(optic);
    gun.updateMatrixWorld(true);
    const reticleAnchor = find(optic, prefix + 'ReticleAnchor');
    const frontAp = find(optic, prefix + 'FrontApertureAnchor');
    const rearAp = find(optic, prefix + 'RearApertureAnchor');
    const point = toRoot(reticleAnchor);
    const info = { point, front: toRoot(frontAp), type: opticId, frontAp, rearAp, optic, scope: opticId === 'acog' };
    if (opticId === 'reddot' || opticId === 'holo') {
      const tex = reticleTex(opticId === 'reddot' ? 'dot' : 'holo', '#ff2a1a');
      const ret = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
        // Normal blend with an HDR tint: stays a saturated, glowing red even over bright skies / walls
        // (additive washes out to white there).
        map: tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
        color: new THREE.Color(2.6, 0.55, 0.45),
      }));
      ret.renderOrder = 30;
      ret.frustumCulled = false;
      this.viewCam.add(ret); // positioned in camera space each frame (collimated reticle)
      ret.visible = false;
      info.reticle = ret;
      info.reticleAnchor = reticleAnchor;
      // Angular size of the reticle (radians, full width of the texture quad).
      info.reticleAngle = opticId === 'reddot' ? 0.028 : 0.075;
      info.lensR = (opticId === 'reddot' ? 0.022 : 0.04) * osc;
      // Lens glass tint.
      const lens = new THREE.Mesh(new THREE.CircleGeometry(info.lensR * 0.8, 24), new THREE.MeshPhysicalMaterial({
        color: 0x6688aa, metalness: 0, roughness: 0.02, transparent: true, opacity: 0.12, envMapIntensity: 2, depthWrite: false,
      }));
      lens.position.copy(frontAp.position);
      frontAp.parent.add(lens);
    } else if (opticId === 'acog') {
      // Picture-in-picture lens at the rear aperture.
      const r = (srcNode.userData.lensRadius ?? 0.034) * osc; // fills the eyepiece bore
      const lens = new THREE.Mesh(new THREE.CircleGeometry(r, 48), this.scopeLensMat);
      lens.position.copy(rearAp.position).add(new THREE.Vector3(0, 0, -0.006));
      rearAp.parent.add(lens);
      info.lens = lens;
      info.lensRadius = r * (opticId === 'sniper' ? 1.3 : 1);
    } else if (opticId === 'sniper') {
      const lens = new THREE.Mesh(new THREE.CircleGeometry(0.02, 24), M('glass'));
      lens.position.copy(rearAp.position);
      rearAp.parent.add(lens);
      info.overlay = true;
    }
    return info;
  }

  /** Port of AlignAuthoredArmsToWeapon: rigid mount of authored arm pose onto the firing grip. */
  _alignStaticArms(rig) {
    const arms = rig.arms;
    const right = find(arms, 'RightArm'), left = find(arms, 'LeftArm');
    right.position.set(0, 0, 0); left.position.set(0, 0, 0);
    arms.position.set(0, 0, 0); arms.quaternion.identity(); arms.scale.setScalar(1);
    arms.updateMatrixWorld(true);
    const gripFrame = find(arms, 'RightGripFrame');
    const gripInArms = relMatrix(gripFrame, arms);
    const presScale = rig.sidearm ? 0.64 : 0.72;
    const inherited = rig.scale;
    const pres = new THREE.Matrix4().makeRotationY(Math.PI);
    if (rig.sidearm) pres.premultiply(new THREE.Matrix4().makeRotationX(0.3));
    const target = pres.clone().scale(new THREE.Vector3().setScalar(presScale / inherited)).setPosition(V(rig.pose.primary));
    const armsM = target.multiply(gripInArms.clone().invert());
    armsM.decompose(arms.position, arms.quaternion, arms.scale);
    arms.updateMatrixWorld(true);
    // Support arm translation onto the support grip.
    const supportInArms = V(rig.pose.support).applyMatrix4(arms.matrix.clone().invert());
    const leftGrip = find(arms, 'LeftGripFrame');
    const lgInArms = new THREE.Vector3().setFromMatrixPosition(relMatrix(leftGrip, arms));
    left.position.add(supportInArms.sub(lgInArms));
    rig.leftArmHome = left.position.clone();
  }

  /** Port of AlignAnimatedReloadArmsToWeapon. */
  _alignReloadArms(rig) {
    const arms = this.reloadArms;
    arms.position.set(0, 0, 0); arms.quaternion.identity(); arms.scale.setScalar(1);
    arms.updateMatrixWorld(true);
    // WeaponRoot node inside the GLB carries the 0.015 cm→m scale; measure grip relative to gltf scene.
    const grip = relMatrix(this.reloadGrip, arms);
    const pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    grip.decompose(pos, q, sc);
    const sidearm = rig.sidearm;
    // FP rigs show real-size guns (the steel-tide set was ~1.36x), so the donor clip is scaled to match.
    const presScale = (rig.poseKey === 'scarl' ? 0.8 : rig.poseKey === 'awm' ? 0.75 : sidearm ? 0.64 : 0.72) * (rig.fp ? rig.tune.donorScale ?? 0.74 : 1);
    const pres = new THREE.Matrix4().makeRotationY(Math.PI);
    if (sidearm) pres.premultiply(new THREE.Matrix4().makeRotationX(0.3));
    const basis = pres.multiply(new THREE.Matrix4().makeRotationFromQuaternion(q).invert());
    basis.scale(new THREE.Vector3().setScalar(presScale / rig.scale));
    const origin = V(rig.pose.primary).sub(pos.clone().applyMatrix4(basis));
    basis.setPosition(origin);
    basis.decompose(arms.position, arms.quaternion, arms.scale);
  }

  // ------------------------------------------------------------------ switching
  /**
   * Holster (lower-out) the current weapon, then call `onDone` (the caller swaps weapons there and
   * the new one plays its draw via setWeapon → equip). `holstering` is true while it is pending.
   */
  holster(onDone, dur = 0.17) {
    if (!this.rig) { onDone(); return; }
    this._holster = { t: 0, dur, onDone };
  }

  get holstering() { return !!this._holster; }

  setWeapon(weapon) {
    this._holster = null; this.holsterK = 0;
    const rig = this.getRig(weapon);
    if (this.rig === rig) return;
    if (this.rig) {
      this.holder.remove(this.rig.root);
      if (this.rig.aim.reticle) this.rig.aim.reticle.visible = false;
    }
    this.rig = rig;
    this.holder.add(rig.root);
    rig.root.add(this.flash);
    rig.root.add(this.beam);
    if (this.reloadArms) {
      rig.root.add(this.reloadArms);
      this.reloadArms.visible = false;
    }
    this.equipT = 0;
    this.endReload(rig);
  }

  invalidate(weaponId) {
    for (const [k, r] of this.rigs) if (k.startsWith(weaponId)) {
      if (r.aim.reticle) this.viewCam.remove(r.aim.reticle);
      this.rigs.delete(k);
      if (this.rig === r) { this.holder.remove(r.root); this.rig = null; }
    }
  }

  // ------------------------------------------------------------------ events
  onFire(shot) {
    const rig = this.rig; if (!rig) return;
    this.fireClipT = 0; // authored fire kick (template clips)
    const s = rig.stats;
    const k = s.kick * (1 - this.adsBlend * 0.45);
    this.kickPos.impulse(rand(-0.03, 0.03) * k, rand(0.02, 0.05) * k, 0.5 * k * (rig.sidearm ? 0.6 : 1));
    // Visual muzzle flip only (the real aim change is shot.pitch/yaw, applied by Game via AimRecoil). The gun
    // jumps the way this shot pushes the aim (+yaw = left), so a rightward-drifting rifle visibly kicks right.
    const tot = Math.abs(shot?.pitch || 0) + Math.abs(shot?.yaw || 0);
    const side = tot > 0 ? shot.yaw / tot : 0;
    this.kickRot.impulse(1.6 * k * (rig.sidearm ? 2.2 : 1), (side * 0.9 + rand(-0.4, 0.4)) * k, rand(-1.4, 1.4) * k);
    if (!s.suppressed) {
      this.flashT = 0.05;
      this.flashSpin = Math.random() * Math.PI * 2;
      this.flashLen = 0.75 + Math.random() * 0.5;
      const f = (Math.random() * 4) | 0;
      const uv = this.flashFront.geometry.attributes.uv;
      const ox = (f % 2) * 0.5, oy = Math.floor(f / 2) * 0.5;
      uv.setXY(0, ox, oy); uv.setXY(1, ox + 0.5, oy); uv.setXY(2, ox, oy + 0.5); uv.setXY(3, ox + 0.5, oy + 0.5);
      uv.needsUpdate = true;
      // Flash hiders still flash visibly in first person (they trim the fireball, not remove it).
      const fl = Math.max(0.55, Math.min(1.5, s.flash ?? 1));
      const sc = (rig.sidearm ? 0.75 : 1) * (0.85 + Math.random() * 0.35) * fl * (s.pellets > 1 ? 1.35 : 1);
      this.flash.scale.setScalar(sc / rig.scale);
    }
    if (rig.sidearm) {
      // Snappy flip: ~7 deg (P226) / ~10 deg (M1911) at the hip, about half aimed, a little roll into the wrist and a
      // yaw that follows the shot's push; the push back sells the slide mass.
      const kp = (s.kick ?? 1) * (1 - this.adsBlend * 0.55);
      this.flipR.impulse(240 * kp, (side * 30 + rand(-15, 15)) * kp, rand(-20, 60) * kp);
      this.flipP.impulse(rand(-4, 4) * kp, 9 * kp, 42 * kp);
    }
    // Slide / bolt carrier cycles (pistol slides run longer so every shot reads: fast back, slower return).
    if (rig.charging && (rig.sidearm || s.closedBolt)) this.slideT = rig.sidearm ? 0.11 : 0.06;
  }

  startReload(rig = this.rig, type) {
    if (!rig) return;
    this.reloading = { type, t: 0 };
    rig.grabbed = null;
  }

  endReload(rig = this.rig) {
    this.reloading = null;
    if (!rig) return;
    if (this.reloadArms) this.reloadArms.visible = false;
    if (rig?.fp) { rig.fp.setLeft(rig.root, null); rig.fpA0 = null; }
    if (rig.leftArm) rig.leftArm.visible = true;
    if (rig.magazine && rig.magHome) { rig.magazine.position.copy(rig.magHome.p); rig.magazine.quaternion.copy(rig.magHome.q); rig.magazine.visible = true; }
    if (rig.spare) rig.spare.visible = false;
  }

  // ------------------------------------------------------------------ update
  /**
   * ctx: { weapon, player, mouse:{x,y}, dt, adsT, sprint, reloadProgress, reloadType, fpcam, aimDir }
   */
  update(dt, ctx) {
    // Full-body awareness (legs/torso under the camera + full player shadow), Medium quality and up.
    if (!this.body && this.game.charTemplate && (this.game.settings?.quality ?? 2) >= 1) {
      try { this.body = new PlayerBody(this.game); } catch (e) { console.warn('player body:', e.message); this.body = false; }
    }
    if (this.body) this.body.update(dt);
    const rig = this.rig;
    if (!rig) return;
    this.time += dt;
    const w = ctx.weapon, p = ctx.player;
    const s = rig.stats;

    // Blends.
    this.adsBlend = w.adsT;
    const adsE = easeInOutSine(this.adsBlend);
    this.sprintBlend = damp(this.sprintBlend, p.sprinting && w.state !== 'reload' ? 1 : 0, 10, dt);
    this.slideBlend = damp(this.slideBlend, p.sliding ? 1 : 0, 10, dt);
    this.mantleBlend = damp(this.mantleBlend, p.mantle ? 1 : 0, 12, dt);
    this.equipT = Math.min(1, this.equipT + dt / Math.max(0.2, s.equip));
    if (this._holster) {
      const hs = this._holster;
      hs.t += dt;
      this.holsterK = Math.min(1, hs.t / hs.dur);
      if (hs.t >= hs.dur) { this._holster = null; hs.onDone(); this.holsterK = 0; if (this.rig !== rig) return; }
    }
    const reloading = w.state === 'reload';
    this.reloadBlend = damp(this.reloadBlend, reloading ? 1 : 0, 9, dt);
    this.inspectT = w.state === 'inspect' ? Math.min(1, w.stateTime / w.stateDur) : 0;
    this.meleeT = w.state === 'melee' ? w.stateTime / w.stateDur : 0;

    // Sway from mouse movement (lagging the camera), reduced in ADS.
    const swayK = (1 - adsE * 0.8) * (s.sway ? 1.3 : 1);
    const mx = clamp(ctx.mouse.x, -40, 40), my = clamp(ctx.mouse.y, -40, 40);
    this.swayRot.target.set(clamp(-my * 0.0016, -0.08, 0.08) * swayK, clamp(-mx * 0.0016, -0.1, 0.1) * swayK, clamp(-mx * 0.0012, -0.08, 0.08) * swayK);
    this.swayPos.target.set(clamp(-mx * 0.0004, -0.03, 0.03) * swayK, clamp(my * 0.0003, -0.02, 0.02) * swayK, 0);
    // Movement lag/tilt.
    const right = p.right(new THREE.Vector3()), fwd = p.forward(new THREE.Vector3());
    const lat = p.velocity.dot(right), lon = p.velocity.dot(fwd);
    this.swayRot.target.z += -lat * 0.006 * (1 - adsE * 0.7);
    this.swayPos.target.x += -lat * 0.0018 * (1 - adsE);
    this.swayPos.target.z += -lon * 0.0016 * (1 - adsE);
    // Vertical velocity lag only in the air: a grounded player carries a constant -2 m/s ground-stick velocity, which
    // lifted every sight picture 4 mm off the eye line.
    if (!p.grounded) this.swayPos.target.y += -p.velocity.y * 0.002;
    this.swayRot.update(dt); this.swayPos.update(dt);
    this.kickPos.update(dt); this.kickRot.update(dt);
    this.flipR.update(dt); this.flipP.update(dt);
    this.landY.update(dt);

    // Authored animation set (FP rifle-family rigs): replaces procedural bob / breathing / sprint carry /
    // equip / holster / reload offsets below with the retargeted template clips (applied after the pose).
    const tpl = rig.fp && !rig.sidearm && this.models.tplAnims && !window.__vmProcAnims ? this.models.tplAnims : null;
    const tplReload = tpl && !s.tube;
    // Bob (figure-8), synced with camera bob phase.
    const ph = ctx.fpcam.bobPhase, ba = ctx.fpcam.bobAmount * (1 - adsE * 0.9) * (tpl ? 0 : 1);
    const sprintA = 1 + this.sprintBlend * 1.4;
    const bobX = Math.sin(ph) * 0.012 * ba * sprintA;
    const bobY = -Math.abs(Math.cos(ph)) * 0.01 * ba * sprintA;
    const bobRot = Math.sin(ph) * 0.02 * ba * sprintA;
    // Idle breathing.
    const breath = tpl ? 0 : Math.sin(this.time * 1.6) * 0.0015 * (1 - adsE * 0.7);
    const breathR = tpl ? 0 : Math.sin(this.time * 0.8) * 0.004 * (1 - adsE * 0.8);

    // Near plane pushes out while aiming so the stock / receiver right under the cheek never
    // fills the bottom of the sight picture (it is physically there, but reads as clutter).
    const near = 0.01 + ((rig.aim.type === 'irons' && rig.tune.adsNear) || 0.06) * adsE - 0.01 * adsE;
    if (Math.abs(this.viewCam.near - near) > 1e-4) { this.viewCam.near = near; this.viewCam.updateProjectionMatrix(); }

    // ---- Root pose ----
    // hipPush (FP_TUNE): scales the hip pose about the eye. The gun keeps its place on screen but sits further out,
    // so it reads smaller (framing is purely angular, docs/FP_FRAMING.md).
    const push = window.__vmHipPush ?? rig.tune.hipPush ?? 1;
    const pos = new THREE.Vector3().copy(rig.hip).multiplyScalar(push).lerp(rig.ads, adsE);
    const rot = new THREE.Euler(
      rig.hipRot.x + (rig.adsRot.x - rig.hipRot.x) * adsE,
      rig.hipRot.y + (rig.adsRot.y - rig.hipRot.y) * adsE,
      rig.hipRot.z + (rig.adsRot.z - rig.hipRot.z) * adsE);
    // Sprint pose: lower, tilt, canted (CoD/Apex style).
    const sb = smoothstep(this.sprintBlend);
    if (tpl) { /* Run clip carries the sprint pose */ } else if (rig.sidearm) { pos.add(new THREE.Vector3(-0.04, -0.12, 0.05).multiplyScalar(sb)); rot.x += -0.55 * sb; rot.z += 0.15 * sb; }
    else { pos.add(new THREE.Vector3(-0.05, -0.08, 0.08).multiplyScalar(sb)); rot.x += -0.12 * sb; rot.y += 0.55 * sb; rot.z += 0.35 * sb; }
    // Tactical sprint: weapon lifted higher.
    if (p.tacSprint) { rot.x += -0.25 * sb * (tpl ? 0.4 : 1); pos.y += 0.04 * sb; }
    // Slide / mantle: lower and roll.
    pos.y -= 0.05 * this.slideBlend + 0.18 * this.mantleBlend;
    rot.z += 0.22 * this.slideBlend + 0.25 * this.mantleBlend;
    rot.x -= 0.5 * this.mantleBlend;
    // Reload offset: bring gun in & roll toward the support hand.
    const rb = smoothstep(this.reloadBlend) * (tplReload || (rig.fp && rig.sidearm && !window.__vmProcAnims) ? 0 : 1);
    {
      const rp = rig.tune.reloadPos, rr = rig.tune.reloadRot;
      pos.x += rp[0] * rb; pos.y += rp[1] * rb; pos.z += rp[2] * rb;
      rot.x += rr[0] * rb; rot.y += rr[1] * rb; rot.z += rr[2] * rb;
    }
    // Bolt/pump cycle.
    if (w.state === 'bolt') {
      // Bolt cycle: lift (0–.18) → run back (.18–.45) → drive home (.45–.7) → lock down (.7–.85).
      const t = clamp(w.stateTime / w.stateDur, 0, 1);
      const k = Math.sin(t * Math.PI);
      rot.z += 0.22 * k; rot.x += 0.07 * k; rot.y -= 0.05 * k; pos.y -= 0.025 * k; pos.x -= 0.015 * k;
      if (rig.boltPivot) {
        const lift = smoothstep(clamp(t / 0.18, 0, 1)) * (1 - smoothstep(clamp((t - 0.7) / 0.15, 0, 1)));
        const back = smoothstep(clamp((t - 0.18) / 0.27, 0, 1)) * (1 - smoothstep(clamp((t - 0.45) / 0.25, 0, 1)));
        rig.boltPivot.rotation.z = 1.05 * lift;
        rig.boltPivot.position.z = rig.boltHome.z + 0.16 * back;
      }
    } else if (rig.boltPivot && (rig.boltPivot.rotation.z !== 0 || rig.boltPivot.position.z !== rig.boltHome.z)) {
      rig.boltPivot.rotation.z = 0; rig.boltPivot.position.copy(rig.boltHome);
    }
    // Pump / shell loading: drive the support arm in WeaponRoot space.
    const leftTarget = this._supportArmOffset(rig, w, dt, reloading);
    if (rig.leftArm && leftTarget) rig.leftArm.position.copy(rig.leftArmHome).add(leftTarget);
    else if (rig.leftArm && w.state !== 'reload') rig.leftArm.position.lerp(rig.leftArmHome, 1 - Math.exp(-20 * dt));
    if (rig.fp && !(w.state === 'reload' && !s.tube)) {
      // Support hand: IK to its grip + choreography offset (WeaponRoot space); the pump rides with it.
      rig.fpLeft = rig.fpLeft || new THREE.Vector3();
      rig.fpLeft.lerp(leftTarget || _v.set(0, 0, 0), leftTarget ? 1 : 1 - Math.exp(-20 * dt));
      const hp = this._hipPole(rig);
      rig.fp.setLeft(rig.root, rig.fpLeft.lengthSq() > 1e-8 ? rig.fpLeft : null, null, hp && hp.pole, hp ? hp.k : 0);
      if (rig.pump) rig.pump.position.z = rig.pumpHome.z + (w.state === 'pump' ? Math.max(0, rig.fpLeft.z) : 0);
    }
    if (w.state === 'pump') {
      const t = clamp(w.stateTime / w.stateDur, 0, 1);
      const k = Math.sin(t * Math.PI);
      pos.z += 0.025 * k; rot.x += 0.05 * k; rot.z += 0.04 * k;
    }
    this._applyThrowHand(rig);
    // Holster: drop and roll out of frame (ease-in, so it leaves with intent).
    if (this.holsterK > 0 && !tpl) {
      const k = this.holsterK * this.holsterK;
      pos.y -= 0.3 * k; pos.x += 0.05 * k; pos.z += 0.04 * k;
      rot.x -= 0.75 * k; rot.z += 0.4 * k; rot.y += 0.15 * k;
    }
    // Grenade: wind up while cooking (game.cook), release + follow-through on throw.
    this._updateThrow(dt);
    if (this.throwK > 0) {
      const k = smoothstep(this.throwK);
      pos.y -= 0.13 * k; pos.x += 0.06 * k; pos.z += 0.05 * k;
      rot.x -= 0.32 * k; rot.z -= 0.25 * k; rot.y -= 0.1 * k;
    }
    // Equip: swing up from the hip with weight — fast rise, slight overshoot, then settle.
    if (!tpl) {
      const e = this.equipT;
      const rise = 1 - Math.pow(1 - e, 3);
      const settle = Math.sin(e * Math.PI * 2.2) * Math.pow(1 - e, 1.5);
      pos.y -= (1 - rise) * 0.32; pos.x += (1 - rise) * 0.06; pos.z += (1 - rise) * 0.05;
      rot.x -= (1 - rise) * 0.85 - settle * 0.05; rot.z += (1 - rise) * 0.45 + settle * 0.04; rot.y += (1 - rise) * 0.2;
    }
    // ADS in/out travels on a slight arc (dip + roll into the shoulder) instead of a straight lerp.
    { const arc = Math.sin(adsE * Math.PI); pos.y -= arc * 0.012; rot.z += arc * 0.05 * (rig.sidearm ? 0.5 : 1); }
    // Inspect: rotate to show the right side then the left.
    if (this.inspectT > 0 && !rig.fp) { // FP rigs: authored keys below (INSPECT_*)
      const t = this.inspectT;
      const a = Math.sin(Math.min(1, t * 2.2) * Math.PI / 2) * (1 - smoothstep(clamp((t - 0.8) / 0.2, 0, 1)));
      const flip = smoothstep(clamp((t - 0.4) / 0.25, 0, 1));
      rot.y += (0.9 - flip * 1.6) * a; rot.z += (0.5 - flip * 0.2) * a; rot.x += 0.25 * a;
      pos.add(new THREE.Vector3(-0.12, 0.06, 0.08).multiplyScalar(a));
    }
    // Melee: stock thrust.
    if (this.meleeT > 0) {
      const t = this.meleeT;
      const k = t < 0.35 ? smoothstep(t / 0.35) : 1 - smoothstep((t - 0.35) / 0.65);
      pos.add(new THREE.Vector3(-0.18, 0.08, -0.25).multiplyScalar(k)); rot.y += 0.9 * k; rot.z -= 0.7 * k;
    }
    // Landing dip + springs.
    pos.y += ctx.fpcam.dip.x * 0.025 + bobY + breath;
    pos.x += bobX;
    pos.add(this.swayPos.x);
    const kk = tpl ? 0.45 : 1; // authored fire clip carries most of the kick
    pos.add(new THREE.Vector3(this.kickPos.x.x, this.kickPos.x.y, this.kickPos.x.z).multiplyScalar(0.03 * (1 - adsE * 0.5) * kk));
    rot.x += this.swayRot.x.x + this.kickRot.x.x * 0.02 * kk + breathR;
    rot.y += this.swayRot.x.y + this.kickRot.x.y * 0.02 * kk;
    rot.z += this.swayRot.x.z + this.kickRot.x.z * 0.02 * kk + bobRot;
    // Lean also rolls the gun slightly extra.
    rot.z += -p.lean * 0.05;
    rig.root.position.copy(pos);
    rig.root.rotation.copy(rot);
    if (tpl) this._applyTemplate(rig, tpl, w, ctx, dt, adsE, sb, tplReload);
    // Sprint carry: the template Run loop (pivoting about the grip) plus a per-class carry offset so the rifle stays
    // in the lower right, canted, instead of leaving the frame (FP_TUNE sprintAdj: cm / deg, as ReloadChoreo keys).
    if (tpl && sb > 0.001) {
      const adj = window.__vmRunAdj || rig.tune.sprintAdj;
      if (adj) { const k = sb * (1 - adsE); for (let i = 0; i < 6; i++) _k[i] = adj[i] * k; this._pivotDelta(rig, _k); }
    }
    // Inspect (FP rigs): authored keys; an interrupted inspect (fire / aim / sprint) fades out instead of popping.
    if (rig.fp) {
      const insp = w.state === 'inspect';
      this.inspK = damp(this.inspK || 0, insp ? 1 : 0, insp ? 40 : 10, dt);
      if (insp) this.inspU = this.inspectT; else if (this.inspK < 1e-3) this.inspU = 0;
      if (this.inspU > 0 && this.inspK > 1e-3) {
        sampleKeys(rig.sidearm ? INSPECT_PISTOL : INSPECT_RIFLE, this.inspU, _k);
        for (let i = 0; i < 6; i++) _k[i] *= this.inspK;
        this._pivotDelta(rig, _k);
      }
    }
    // Pistol flip (springs fed by onFire).
    if (rig.sidearm && (this.flipR.x.lengthSq() + this.flipP.x.lengthSq() > 1e-6)) {
      _k[0] = this.flipP.x.x; _k[1] = this.flipP.x.y; _k[2] = this.flipP.x.z; _k[3] = this.flipR.x.x; _k[4] = this.flipR.x.y; _k[5] = this.flipR.x.z;
      this._pivotDelta(rig, _k);
    }
    // Authored reload gun pose (ReloadChoreo): rifles (template timing) and pistols, pivoting about the firing grip.
    const pistolAuth = rig.fp && rig.sidearm && !window.__vmProcAnims; // authored pistol reload (A/B: __vmProcAnims)
    if (w.state === 'reload' && rig.fp && !s.tube && (tplReload || pistolAuth)) {
      const u = clamp(w.stateTime / w.stateDur, 0, 1), empty = w.reloadType === 'empty';
      const keys = rig.sidearm ? (empty ? PISTOL_EMPTY : PISTOL_TAC)
        : empty && this._emptyAction(rig) ? (rig._emptyKeys ||= rifleEmptyKeys(this._emptyAction(rig), rig.tune.rackRoll ?? 12)) : RIFLE_TAC;
      this._pivotDelta(rig, sampleKeys(keys, u, _k));
    }

    // Slide / bolt carrier.
    if (rig.charging && w.state !== 'bolt') {
      this.slideT = Math.max(0, (this.slideT || 0) - dt);
      const lockBack = rig.sidearm && w.ammo === 0 && w.state !== 'reload';
      const travel = rig.sidearm ? 0.07 : 0.1;
      const T = rig.sidearm ? 0.11 : 0.06, u = 1 - this.slideT / T;
      const k = lockBack ? 1 : this.slideT <= 0 ? 0 : rig.sidearm ? (u < 0.3 ? smoothstep(u / 0.3) : 1 - smoothstep((u - 0.3) / 0.7)) : Math.sin(u * Math.PI);
      rig.charging.position.z = rig.chargingHome.z + k * travel;
    }

    // Fixed-scope rifles: the bolt knob sits right beside the eyepiece and reads as a huge blob in
    // the sight picture; tuck it while fully aimed (it is back for the bolt cycle).
    if (rig.tune.integratedScope && rig.charging) rig.charging.visible = !(w.adsT > 0.8 && w.state !== 'bolt');

    // ---- Reload arms ----
    this._fingerL = null;
    this._updateReload(rig, w, dt);
    // ---- Fingers: trigger finger indexed along the frame while sprinting / reloading / inspecting / switching;
    // the support hand closes on a carried magazine and opens for the palm slap.
    if (rig.fp?.setFingers) {
      const idx = Math.max(sb * (1 - adsE), reloading && !s.tube ? smoothstep(this.reloadBlend) : 0, this.inspK || 0, this.holsterK || 0, 1 - smoothstep(clamp(this.equipT * 1.4, 0, 1)));
      this._idxK = damp(this._idxK ?? 0, idx, 14, dt);
      rig.fp.setFingers('R', 0.55 * this._idxK);
      const fl = this._fingerL;
      this._flC = damp(this._flC ?? 0, fl ? fl.curl : 0, 16, dt); this._flT = damp(this._flT ?? 0, fl ? fl.thumb : 0, 16, dt);
      rig.fp.setFingers('L', -this._flC * 0.6, this._flC, this._flT);
    }

    // ---- Muzzle flash ----
    this.flashT -= dt;
    this.flash.visible = this.flashT > 0 && !this.hidden;
    if (this.flash.visible) {
      rig.root.updateMatrixWorld(true);
      const mp = rig.muzzle.getWorldPosition(_v);
      this.flash.position.copy(mp.applyMatrix4(_m.copy(rig.root.matrixWorld).invert()));
      // Bloom out then collapse over the ~3 frames it lives; star always faces the eye.
      const life = clamp(this.flashT / 0.05, 0, 1);
      const k = Math.sin(Math.min(1, (1 - life) * 1.6 + 0.25) * Math.PI) * 0.6 + 0.4;
      this.flashFront.scale.setScalar(k);
      for (const c of this.flashCones) c.scale.set(1, k, this.flashLen * (0.7 + 0.3 * k));
      this.flash.rotation.z = this.flashSpin;
      _q.copy(rig.root.getWorldQuaternion(new THREE.Quaternion())).multiply(_q2.setFromEuler(this.flash.rotation)).invert();
      this.flashFront.quaternion.copy(_q).multiply(this.viewCam.getWorldQuaternion(_q2));
      this.flashFront.rotateZ(this.flashSpin);
      this.vmFill.intensity = 6;
    } else this.vmFill.intensity = 0;

    // ---- Optic reticle / scope ----
    this._updateOptic(rig, ctx, dt);

    // ---- Laser ----
    this._updateLaser(rig, w, ctx);

    // Hide viewmodel when overlay scope is fully up.
    this.hidden = !!(rig.aim.overlay && w.adsT > 0.92);
    rig.root.visible = !this.hidden;

    // Lighting: match world sun exposure at the eye (shadowed => dim).
    this._updateLighting(ctx, dt);
  }

  /**
   * Authored clip layer (camera-space deltas from the template base pose, composed onto the procedural pose):
   * idle / walk / run loops (+ aimed variants by ADS), fire, reload, equip, holster.
   */
  _applyTemplate(rig, A, w, ctx, dt, adsE, sb, tplReload) {
    const T = (this._tplT ||= { a: { p: new THREE.Vector3(), q: new THREE.Quaternion() }, b: { p: new THREE.Vector3(), q: new THREE.Quaternion() }, acc: { p: new THREE.Vector3(), q: new THREE.Quaternion() } });
    const acc = T.acc; acc.p.set(0, 0, 0); acc.q.identity();
    const blend = (hip, aim, t, k) => {
      A.gun(hip, t, T.a, k);
      if (aim && adsE > 0) { A.gun(aim, t, T.b, k); T.a.p.lerp(T.b.p, adsE); T.a.q.slerp(T.b.q, adsE); }
      composeDelta(T.a, acc, acc);
    };
    const TAU = Math.PI * 2;
    const stride = ((ctx.fpcam.bobPhase % TAU) + TAU) % TAU / TAU;
    const move = clamp(ctx.fpcam.bobAmount ?? 0, 0, 1);
    blend('Idle', 'IdleAimed', this.time, 1);
    if (move > 0.01) blend('Walk', 'WalkAimed', A.at('Walk', stride), move * (1 - sb));
    if (sb > 0.001) blend('Run', null, A.at('Run', stride), sb * (1 - adsE));
    this.fireClipT = (this.fireClipT ?? 99) + dt;
    if (this.fireClipT < A.dur('Fire')) blend('Fire', 'FireAimed', this.fireClipT, 1);
    if (this.equipT < 1) blend('Equip', null, A.at('Equip', this.equipT), 1);
    if (this.holsterK > 0) blend('Holster', null, A.at('Holster', this.holsterK), 1);
    // root := acc * root (camera space)
    rig.root.position.applyQuaternion(acc.q).add(acc.p);
    rig.root.quaternion.premultiply(acc.q);
  }

  /** Template reload: magazine + support hand follow the retargeted tracks (re-anchored to this gun). */
  _tplReload(rig, A, progress) {
    const R = (this._tplR ||= { h: { dg: new THREE.Vector3(), dw: new THREE.Vector3(), w: 0, dq: new THREE.Quaternion() }, m: { p: new THREE.Vector3(), q: new THREE.Quaternion() } });
    const t = A.at('Reload', progress);
    if (!rig.fp.homeL) rig.fp.captureHome(rig.root);
    const K = 1 / rig.scale;
    rig.root.updateMatrixWorld(true);
    // Magazine well (root space) = magazine home.
    const par = rig.magazine.parent;
    const parM = _m.copy(rig.root.matrixWorld).invert().multiply(par.matrixWorld);
    const well = rig.magHome.p.clone().applyMatrix4(parM);
    A.mag(t, R.m);
    const magRoot = well.clone().addScaledVector(R.m.p, K);
    rig.magazine.position.copy(magRoot.applyMatrix4(parM.clone().invert()));
    rig.magazine.quaternion.copy(R.m.q).multiply(rig.magHome.q);
    rig.magazine.visible = true;
    if (rig.spare) rig.spare.visible = false;
    A.handL(t, R.h);
    const pg = rig.fp.homeL.p.clone().addScaledVector(R.h.dg, K);
    const pw = well.clone().addScaledVector(R.h.dw, K);
    const p = pg.lerp(pw, R.h.w);
    const q = R.h.dq.clone().multiply(rig.fp.homeL.q);
    return { p, q };
  }

  /** Empty-reload bolt action for this rifle: 'release' (bolt catch), 'rack' (charging handle) or null. */
  _emptyAction(rig) {
    if (rig.tune.emptyAction !== undefined) return rig.tune.emptyAction;
    return rig.charging ? 'release' : null;
  }

  /** root := T(pivot + off) R T(-pivot) * root, with k = [x, y, z (cm), pitch, yaw, roll (deg)], pivot = firing grip. */
  _pivotDelta(rig, k) {
    const q = _q.setFromEuler(_e.set(k[3] * DEG, k[4] * DEG, k[5] * DEG, 'YXZ'));
    const piv = _pv.fromArray(rig.pose.primary).multiplyScalar(rig.scale).applyQuaternion(rig.root.quaternion).add(rig.root.position);
    rig.root.position.sub(piv).applyQuaternion(q).add(piv).add(_v.set(k[0] / 100, k[1] / 100, k[2] / 100));
    rig.root.quaternion.premultiply(q);
  }

  /**
   * Hip elbow pole (FP_TUNE hipPole: [x, y, z] view-camera space + weight): drops the support elbow under the gun so
   * the forearm rises steeply from the bottom edge (Sandstorm / BF framing) instead of reaching in straight from the
   * bottom-left corner. Returns { pole (world), k } or null.
   */
  _hipPole(rig) {
    const hp = window.__vmHipPole || rig.tune.hipPole;
    if (!hp || !(hp[3] > 0)) return null;
    this.viewCam.updateMatrixWorld(true);
    return { pole: this.viewCam.localToWorld(new THREE.Vector3(hp[0], hp[1], hp[2])), k: hp[3] };
  }

  /** Support hand IK to a WeaponRoot-space target, with the elbow pole blended in as the hand leaves its grip. */
  _solveLeft(rig, p, q) {
    const home = rig.fp.homeL.p;
    const k = smoothstep(clamp((p.distanceTo(home) - 0.06) / 0.2, 0, 1));
    this.viewCam.updateMatrixWorld(true);
    const far = this.viewCam.localToWorld(_pole.fromArray(ELBOW_POLE_L));
    const hip = this._hipPole(rig);
    if (hip) { rig.fp.setLeftAbs(rig.root, p, q, hip.pole.lerp(far, k), hip.k + (1 - hip.k) * k); return; }
    rig.fp.setLeftAbs(rig.root, p, q, k > 0 ? far : null, k);
  }

  /**
   * Rifle reload: template support-hand / magazine tracks (FPAnims), compressed on an empty reload so the bolt action
   * fits after the seat: the hand reaches the bolt catch (release) or the charging handle (rack), works it, and
   * returns to the handguard.
   */
  _rifleReload(rig, A, u, empty) {
    const act = empty ? this._emptyAction(rig) : null;
    const tplU = act ? Math.min(u * TPL_SEAT / SEAT_E, TPL_SEAT) : u;
    const h = this._tplReload(rig, A, tplU);
    let { p, q } = h;
    // Carrying a magazine: fingers close round it (template weight 1 = at the magazine well / pouch).
    const carry = this._tplR.h.w;
    this._fingerL = { curl: 0.35 * carry, thumb: 0.3 * carry };
    const ch = rig.charging, travel = rig.tune.boltTravel ?? 0.1;
    if (act) {
      const ph = BOLT_PHASE[act];
      const reach = phase(u, ph.reach), pull = phase(u, ph.pull), snap = phase(u, ph.snap), back = phase(u, ph.back);
      rig.root.updateMatrixWorld(true);
      const toRoot = _m.copy(rig.root.matrixWorld).invert();
      // Bolt work point (root space): charging handle (rack) or the bolt catch above the magazine well (release).
      const base = act === 'rack' && ch
        ? ch.parent.localToWorld(_v.copy(rig.chargingHome)).applyMatrix4(toRoot)
        : rig.magHome.p.clone().applyMatrix4(_m2.copy(toRoot).multiply(rig.magazine.parent.matrixWorld));
      const off = rig.tune.boltHand || (act === 'rack' ? [0.02, -0.12, 0.1] : [-0.06, -0.02, 0.12]);
      const B = new THREE.Vector3(base.x + off[0], base.y + off[1], base.z + off[2]);
      if (act === 'rack') B.z += travel * pull * (1 - snap * 0.2); else B.y += 0.025 * Math.sin(pull * Math.PI);
      p = p.clone().lerp(B, reach).lerp(rig.fp.homeL.p, back);
      q = q.clone().slerp(rig.fp.homeL.q, back);
      if (ch) {
        // Bolt locked open on the empty gun until released / racked; the rack carries it back with the hand.
        const k = act === 'rack' ? Math.max(pull, 0) * (1 - snap) : 1 - snap;
        ch.position.z = rig.chargingHome.z + travel * k;
      }
      // Rack: fist round the handle; release: flat palm for the slap.
      const work = reach * (1 - back);
      this._fingerL = { curl: act === 'rack' ? 0.45 * work + 0.35 * carry * (1 - reach) : -0.35 * work + 0.35 * carry * (1 - reach), thumb: 0.3 * work };
    }
    this._solveLeft(rig, p, q);
  }

  /** Magazine geometry in WeaponRoot space: well (pivot = top centre), unit axis down the magazine, length. */
  _magGeo(rig) {
    const mag = rig.magazine;
    mag.position.copy(rig.magHome.p); mag.quaternion.copy(rig.magHome.q);
    rig.root.updateMatrixWorld(true);
    const toRoot = _m.copy(rig.root.matrixWorld).invert();
    const well = mag.getWorldPosition(new THREE.Vector3()).applyMatrix4(toRoot);
    const bb = new THREE.Box3();
    mag.traverse((o) => { if (o.isMesh && o.visible) { o.geometry.computeBoundingBox(); bb.union(o.geometry.boundingBox.clone().applyMatrix4(_m2.copy(toRoot).multiply(o.matrixWorld))); } });
    const bottom = new THREE.Vector3((bb.min.x + bb.max.x) / 2, bb.min.y, (bb.min.z + bb.max.z) / 2);
    const axis = bottom.clone().sub(well); const len = axis.length(); axis.normalize();
    const parM = _m2.copy(toRoot).multiply(mag.parent.matrixWorld).clone();
    return { well, axis, len, parInv: parM.clone().invert() };
  }

  /**
   * Pistol reload (procedural): the magazine drops free, the support hand fetches a new one from the belt, inserts it
   * along the grip axis with a palm slap, and (empty) the slide is released from lock-back.
   */
  _pistolReload(rig, u, empty) {
    if (!rig.fp.homeL) rig.fp.captureHome(rig.root);
    const g = (rig.magGeo ||= this._magGeo(rig));
    const P = PISTOL_PHASE, mag = rig.magazine, home = rig.fp.homeL;
    const setMag = (pRoot) => { mag.position.copy(pRoot).applyMatrix4(g.parInv); mag.quaternion.copy(rig.magHome.q); };
    const palm = V(rig.tune.palmOff || [0.0, -0.05, 0.11]); // hand control relative to the magazine base
    const magBase = (pTop) => pTop.clone().addScaledVector(g.axis, g.len).add(palm);
    const inLen = g.len * 1.15; // insertion starts with the magazine this far below the well
    const below = g.well.clone().addScaledVector(g.axis, inLen);
    const belt = home.p.clone().add(V(rig.tune.beltOff || [-0.14, -0.6, 0.32]));
    let hp, magP = null, magVis = true;
    if (u < P.drop[0]) magP = g.well;
    else if (u < P.drop[1]) {
      const s = (u - P.drop[0]) / (P.drop[1] - P.drop[0]);
      magP = g.well.clone().addScaledVector(g.axis, g.len * 0.35 * Math.min(1, s * 3) + 1.4 * s * s).add(_v.set(-0.04 * s, 0, 0));
    } else if (u < P.bring[0]) magVis = false;
    if (u < P.fetch[0]) hp = home.p.clone();
    else if (u < P.fetch[1]) hp = home.p.clone().lerp(belt, phase(u, P.fetch));
    else if (u < P.bring[1]) { hp = belt.clone().lerp(magBase(below), phase(u, P.bring)); magP = hp.clone().sub(palm).addScaledVector(g.axis, -g.len); }
    else if (u < P.insert[1]) { magP = below.clone().lerp(g.well, phase(u, P.insert)); hp = magBase(magP); }
    else if (u < P.slap[1]) { magP = g.well; hp = magBase(g.well).addScaledVector(g.axis, -0.025 * Math.sin(phase(u, P.slap) * Math.PI)); }
    else { magP = g.well; hp = magBase(g.well).lerp(home.p, phase(u, P.home)); }
    mag.visible = magVis && !!magP;
    if (magP) setMag(magP);
    // Palm turns up under the magazine while away from the grip.
    const away = phase(u, [P.fetch[0], P.fetch[0] + 0.08]) * (1 - phase(u, P.home));
    const q = home.q.clone().premultiply(_q2.setFromAxisAngle(_v.set(0, 0, 1), (rig.tune.palmRoll ?? 1.4) * away));
    this._solveLeft(rig, hp, q);
    const slap = phase(u, [P.insert[0] + 0.04, P.slap[0]]) * (1 - phase(u, P.home));
    this._fingerL = { curl: 0.4 * away * (1 - slap) - 0.45 * slap, thumb: 0.3 * away };
    if (rig.charging) rig.charging.position.z = rig.chargingHome.z + (empty ? 0.07 * (1 - phase(u, P.slide)) : 0);
  }

  _updateReload(rig, w, dt) {
    const reloading = w.state === 'reload' && !rig.stats.tube;
    if (!reloading) {
      if (this.reloading) this.endReload(rig);
      return;
    }
    const empty = w.reloadType === 'empty';
    const progress = clamp(w.stateTime / w.stateDur, 0, 1);
    if (!this.reloading) this.startReload(rig, w.reloadType);
    if (rig.fp && !rig.sidearm && this.models.tplAnims && rig.magazine && !window.__vmProcAnims) {
      this._rifleReload(rig, this.models.tplAnims, progress, empty);
      return;
    }
    if (rig.fp && rig.sidearm && rig.magazine && !window.__vmProcAnims) { this._pistolReload(rig, progress, empty); return; }
    const clipName = rig.clipStem ? `reload_${rig.clipStem}_${empty ? 'empty' : 'tactical'}` : null;
    const clip = clipName && this.reloadClips?.get(clipName);
    if (!clip) { this._proceduralReload(rig, progress); return; }
    // Show animated support arm, hide static left arm.
    this.reloadArms.visible = !rig.fp; // FP rigs: the clip only drives the IK target of our own hand
    if (rig.leftArm) rig.leftArm.visible = false;
    // The cropped (forearm-only) mesh reads better with our closer camera for every platform: the
    // long-gun mesh's upper-arm sleeve swings into frame during the mag swap.
    this.reloadMeshes.long.visible = false;
    this.reloadMeshes.side.visible = true;
    if (this.reloadRightArmBone) this.reloadRightArmBone.scale.setScalar(1);
    this._alignReloadArms(rig);
    const action = this.reloadMixer.clipAction(clip);
    if (this._curClip !== clip) {
      this.reloadMixer.stopAllAction();
      action.reset().play();
      action.paused = true;
      this._curClip = clip;
    }
    action.time = progress * clip.duration;
    this.reloadMixer.update(0);
    this.reloadArms.updateMatrixWorld(true);
    // The authored clips swing the support hand far below the receiver (framed for a lower camera).
    // Compress the hand's excursion around the magazine well so the whole mag swap stays on screen.
    if (rig.magazine && rig.magHome) {
      const hand0 = rig.sidearm ? this.leftPalm : this.leftGripAnchor;
      const rootInv = _m2.copy(rig.root.matrixWorld).invert();
      const hp = hand0.getWorldPosition(new THREE.Vector3()).applyMatrix4(rootInv);
      const well = rig.magazine.parent === rig.root ? rig.magHome.p.clone()
        : rig.magHome.p.clone().applyMatrix4(_m.copy(rig.root.matrixWorld).invert().multiply(rig.magazine.parent.matrixWorld));
      const k = rig.tune.reloadReach ?? 0.5;
      this.reloadArms.position.addScaledVector(hp.sub(well), -(1 - k));
    }
    if (this.reloadRightArmBone) this.reloadRightArmBone.scale.setScalar(1e-4);
    this.reloadArms.updateMatrixWorld(true);
    // Magazine follows the support hand between reach→stow (old mag) and acquire→seat (new mag).
    const ph = rig.phases;
    if (rig.fp) this._fpReloadHand(rig);
    const hand = rig.fp ? rig.fp.leftHand : rig.sidearm ? this.leftPalm : this.leftGripAnchor;
    if (!rig.magazine) return;
    const toGun = _m.copy(rig.magazine.parent.matrixWorld).invert();
    const handPos = hand.getWorldPosition(new THREE.Vector3()).applyMatrix4(toGun);
    const handQ = hand.getWorldQuaternion(new THREE.Quaternion());
    const parentQ = rig.magazine.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
    const handLocalQ = parentQ.clone().multiply(handQ);
    const carryRemoved = progress >= ph.reach && progress < ph.stow;
    const carryNew = progress >= ph.acquire && progress < ph.seat;
    const gripOffset = (mag, grip) => (grip ? grip.position.clone().applyQuaternion(mag.quaternion).multiply(mag.scale) : new THREE.Vector3());
    if (carryRemoved) {
      if (!rig.grabbed || rig.grabbed.which !== 'old') rig.grabbed = { which: 'old', off: handLocalQ.clone().invert().multiply(rig.magHome.q) };
      rig.magazine.visible = true;
      rig.magazine.quaternion.copy(handLocalQ).multiply(rig.grabbed.off);
      rig.magazine.position.copy(handPos).sub(gripOffset(rig.magazine, rig.magGrip));
      if (rig.spare) rig.spare.visible = false;
    } else if (progress >= ph.stow && progress < ph.acquire) {
      rig.magazine.visible = false;
      if (rig.spare) rig.spare.visible = false;
    } else if (carryNew) {
      // Spare mag: blend orientation toward home as it seats.
      const target = rig.spare && rig.spareGrip ? rig.spare : rig.magazine;
      const tgrip = target === rig.spare ? rig.spareGrip : rig.magGrip;
      const seatK = smoothstep(clamp((progress - ph.acquire) / (ph.seat - ph.acquire), 0, 1));
      if (!rig.grabbed || rig.grabbed.which !== 'new') rig.grabbed = { which: 'new', off: handLocalQ.clone().invert().multiply(rig.magHome.q) };
      const qHand = handLocalQ.clone().multiply(rig.grabbed.off);
      target.visible = true;
      target.quaternion.copy(qHand).slerp(rig.magHome.q, seatK * seatK);
      const p = handPos.clone().sub(gripOffset(target, tgrip));
      target.position.copy(p).lerp(rig.magHome.p, Math.pow(seatK, 4));
      if (target === rig.spare) rig.magazine.visible = false;
    } else {
      // Before reach / after seat: magazine home in the gun.
      if (rig.spare) rig.spare.visible = false;
      rig.magazine.visible = true;
      rig.magazine.position.copy(rig.magHome.p);
      rig.magazine.quaternion.copy(rig.magHome.q);
    }
    // Empty reload: rack charging handle near the end.
    if (empty && rig.charging && progress > ph.seat) {
      const t = clamp((progress - ph.seat) / (ph.action - ph.seat), 0, 1);
      rig.charging.position.z = rig.chargingHome.z + Math.sin(t * Math.PI) * 0.1;
    }
  }

  /**
   * FP rigs: the support hand rigidly follows the reload clip's hand anchor, keeping the offset it had at
   * the start of the reload (so it leaves from and returns to its authored grip).
   */
  _fpReloadHand(rig) {
    const anchor = rig.sidearm ? this.leftPalm : this.leftGripAnchor;
    if (!anchor || !rig.fp.ik.L.ok) return;
    rig.root.updateMatrixWorld(true);
    const rootInv = _m2.copy(rig.root.matrixWorld).invert();
    const A = new THREE.Matrix4().multiplyMatrices(rootInv, anchor.matrixWorld);
    if (!rig.fpA0) {
      rig.fp.setLeft(rig.root, null);
      const H0 = new THREE.Matrix4().multiplyMatrices(rootInv, rig.fp.ik.L.ctrl.matrixWorld);
      rig.fpA0 = new THREE.Matrix4().copy(A).invert().multiply(H0); // anchor -> hand control
    }
    const T = A.multiply(rig.fpA0);
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    T.decompose(p, q, sc);
    rig.fp.setLeftAbs(rig.root, p, q);
  }

  // Fallback (shotgun/no-clip weapons): support arm dips to the magazine/port.
  _proceduralReload(rig, progress) {
    if (rig.fp) { const k = Math.sin(progress * Math.PI); rig.fp.setLeft(rig.root, new THREE.Vector3(0.02, -0.12 * k, 0.25 * k)); return; }
    if (!rig.leftArm) return;
    const k = Math.sin(progress * Math.PI);
    rig.leftArm.position.copy(rig.leftArmHome).add(new THREE.Vector3(0.02, -0.12 * k, 0.25 * k));
  }

  /** Grenade throw state machine, driven by Game.cook (non-null while the pin is pulled). */
  _updateThrow(dt) {
    const cooking = this.game.cook != null;
    if (cooking) {
      if (this.throwPhase !== 'wind') { this.throwPhase = 'wind'; this.throwU = 0; }
      this.throwU = Math.min(THROW_WIND, this.throwU + dt / 0.06); // reach the wind-up in ~0.25 s
      this.throwK = Math.min(1, (this.throwK || 0) + dt / 0.15);
    } else if (this.throwPhase === 'wind') {
      this.throwPhase = 'release'; // the frag leaves the hand this frame (Game spawns it now)
    }
    if (this.throwPhase === 'release') {
      this.throwU += dt / 0.045; // release + follow-through ~0.25 s
      if (this.throwU >= THROW_PATH.length - 1) { this.throwPhase = 'recover'; this.throwU = THROW_PATH.length - 1; }
    } else if (this.throwPhase === 'recover' || !this.throwPhase) {
      this.throwK = Math.max(0, (this.throwK || 0) - dt / 0.22);
      if (this.throwK === 0) this.throwPhase = null;
    }
  }

  /** Left hand follows the throw path (view space → WeaponRoot), blended by throwK. */
  _applyThrowHand(rig) {
    const k = this.throwK || 0;
    const showNade = this.throwPhase === 'wind' || (this.throwPhase === 'release' && this.throwU < 5.6);
    if (k <= 0 || !rig) { if (this.nade) this.nade.visible = false; return; }
    const u = Math.min(THROW_PATH.length - 1, Math.max(0, Number.isFinite(this.throwU) ? this.throwU : 0));
    const i = Math.min(THROW_PATH.length - 2, Math.floor(u)), f = u - i;
    const a = THROW_PATH[i], b = THROW_PATH[i + 1];
    if (!a || !b) { if (this.nade) this.nade.visible = false; return; }
    const vp = _v.set(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f).multiplyScalar(0.85);
    // The mocap wind-up sits behind the ear; slide the whole path forward so the cocked hand and the
    // frag read at the top-left of frame, then sweep across and down through release.
    vp.x -= 0.02; vp.y -= 0.1; vp.z -= 0.64;
    rig.root.updateMatrixWorld(true);
    const target = rig.root.worldToLocal(this.viewCam.localToWorld(vp.clone()));
    const sup = V(rig.pose.support);
    const off = target.sub(sup).multiplyScalar(smoothstep(k));
    if (rig.fp) rig.fp.setLeft(rig.root, off);
    else if (rig.leftArm) rig.leftArm.position.copy(rig.leftArmHome).add(this._rootToArms(rig, off));
    // Frag in the fingers until release.
    if (!this.nade) {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.SphereGeometry(0.036, 14, 10), M('od'));
      body.scale.set(1, 1.25, 1);
      const spoon = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.05, 0.016), M('steel'));
      spoon.position.set(0.026, 0.02, 0);
      g.add(body, spoon); g.traverse((o) => { o.frustumCulled = false; });
      this.nade = g; this.viewCam.add(g);
    }
    this.nade.visible = showNade && k > 0.3;
    this.nade.position.copy(vp).add(_v.set(0, 0.015, 0)); // in the fist, where the grip would be
  }

  /** Root-local delta → static-arms LeftArm local delta (arms carry a Y-flip and presentation scale). */
  _rootToArms(rig, v) {
    const par = rig.leftArm.parent;
    const m = relMatrix(par, rig.root, _m2);
    const lin = new THREE.Matrix3().setFromMatrix4(m).invert();
    return v.clone().applyMatrix3(lin);
  }

  /**
   * Support-hand choreography for pump guns (rack and shell-by-shell loading). Returns the LeftArm
   * offset (arms space) or null when the hand should rest on its grip.
   */
  _supportArmOffset(rig, w, dt, reloading) {
    if (!rig.fp && (!rig.leftArm || !rig.arms)) return null;
    const conv = (v) => (rig.fp ? v : this._rootToArms(rig, v));
    const sup = V(rig.pose.support);
    if (w.state === 'pump') {
      // Rack: snap back fast, drive forward a touch slower.
      const t = clamp(w.stateTime / w.stateDur, 0, 1);
      const back = t < 0.45 ? smoothstep(t / 0.45) : 1 - smoothstep((t - 0.45) / 0.45);
      this._hideShell();
      return conv(new THREE.Vector3(0, -0.01, rig.tune.pumpStroke ?? 0.17).multiplyScalar(back));
    }
    if (reloading && rig.stats.tube) {
      // Per shell: drop to the belt (0–.3), bring a shell up under the port (.3–.62), thumb it in (.62–.8), return.
      const t = clamp(w.stateTime / w.stateDur, 0, 1);
      const port = V(rig.tune.shellPort || [0.0, -0.36, -0.12]);
      const belt = V(rig.tune.shellBelt || [0.12, -0.75, 0.15]);
      let p;
      if (t < 0.3) p = sup.clone().lerp(belt, smoothstep(t / 0.3));
      else if (t < 0.62) p = belt.clone().lerp(port, smoothstep((t - 0.3) / 0.32));
      else if (t < 0.8) p = port.clone().add(new THREE.Vector3(0, 0.07, -0.05).multiplyScalar(smoothstep((t - 0.62) / 0.18)));
      else p = port.clone().add(new THREE.Vector3(0, 0.07, -0.05)).lerp(sup, smoothstep((t - 0.8) / 0.2));
      // Shell in the fingers while carried.
      const carry = t >= 0.22 && t < 0.78 && w.ammo < rig.stats.mag;
      this._showShell(rig, carry ? p.clone().add(new THREE.Vector3(0, 0.035, -0.02)) : null);
      return conv(p.sub(sup));
    }
    this._hideShell();
    return null;
  }

  _showShell(rig, posRoot) {
    if (!this.shell) {
      const g = new THREE.Group();
      const hull = new THREE.Mesh(new THREE.CylinderGeometry(0.0115, 0.0115, 0.058, 12), new THREE.MeshStandardMaterial({ color: 0x7a1d18, roughness: 0.55 }));
      const head = new THREE.Mesh(new THREE.CylinderGeometry(0.0125, 0.0125, 0.014, 12), M('brass'));
      head.position.y = -0.03;
      g.add(hull, head);
      g.rotation.x = Math.PI / 2; // lies along the bore, brass to the rear
      g.traverse((o) => { o.frustumCulled = false; });
      this.shell = g;
    }
    if (!posRoot) { this.shell.visible = false; return; }
    if (this.shell.parent !== rig.root) rig.root.add(this.shell);
    this.shell.visible = true;
    this.shell.position.copy(posRoot);
    this.shell.scale.setScalar(1.7); // 12ga hull at the guns' ~1.75x model scale
  }

  _hideShell() { if (this.shell) this.shell.visible = false; }

  shellInsert() {
    // Shotgun: quick push of the support hand to the loading port.
    const rig = this.rig;
    if (!rig?.leftArm) return;
    this._shellPush = 1;
  }

  _updateOptic(rig, ctx, dt) {
    const a = rig.aim;
    const w = ctx.weapon;
    if (a.reticle) {
      rig.root.updateMatrixWorld(true);
      // Collimated reticle: dot sits where the weapon's bore-parallel line from the anchor (to infinity)
      // crosses the front lens, seen from the eye at the view-camera origin.
      const anchor = a.reticleAnchor;
      const frontAp = a.frontAp;
      const camInv = _m.copy(this.viewCam.matrixWorld).invert();
      const anc = anchor.getWorldPosition(new THREE.Vector3()).applyMatrix4(camInv);
      const fa = frontAp.getWorldPosition(new THREE.Vector3()).applyMatrix4(camInv);
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(rig.sightQ).applyQuaternion(rig.root.getWorldQuaternion(new THREE.Quaternion())).applyQuaternion(this.viewCam.getWorldQuaternion(new THREE.Quaternion()).invert()).normalize();
      const far = anc.clone().addScaledVector(fwd, 200);
      const dir = far.clone().normalize();
      const denom = dir.dot(fwd);
      const t = fa.dot(fwd) / denom;
      const hit = dir.multiplyScalar(t);
      const off = hit.clone().sub(fa);
      const lensR = a.lensR * rig.scale;
      const inside = off.length() < lensR * 0.95;
      a.reticle.position.copy(hit);
      a.reticle.quaternion.copy(rig.root.quaternion);
      // Fixed angular size (collimated): independent of eye relief / lens distance.
      a.reticle.scale.setScalar(a.reticleAngle * hit.length());
      a.reticle.visible = inside && w.adsT > 0.35 && !this.hidden;
      a.reticle.material.opacity = clamp((w.adsT - 0.35) * 3, 0, 1);
    }
    if (a.lens) {
      // Picture-in-picture scope render.
      const g = this.game;
      const active = w.adsT > 0.05;
      a.lens.visible = true;
      this.scopeLensMat.uniforms.fade.value = clamp(w.adsT * 1.6, 0.15, 1);
      if (!(active && !this.hidden)) this._scopeFresh = false;
      if (active && !this.hidden) {
        const cam = g.renderer.camera;
        // True magnification is relative to the naked-eye (un-zoomed) view: undo the main
        // camera's own ADS zoom to recover the base FOV.
        const zoom = w.lensZoom ? w.lensZoom() : rig.stats.zoomLevel;
        const mainZoom = 1 + (w.zoom() - 1) * w.adsT;
        const tanBase = Math.tan((cam.fov * DEG) / 2) * mainZoom;
        // Lens angular radius on screen (view camera), as a fraction of the half screen height.
        const camInv = _m.copy(this.viewCam.matrixWorld).invert();
        const lp = a.lens.getWorldPosition(new THREE.Vector3()).applyMatrix4(camInv);
        const r = a.lensRadius * rig.scale;
        const Rs = (r / Math.abs(lp.z)) / Math.tan((this.viewCam.fov * DEG) / 2);
        const tanHalf = Rs * tanBase / zoom;
        this.scopeCam.fov = 2 * Math.atan(Math.max(1e-4, tanHalf)) / DEG;
        this.scopeCam.position.copy(cam.position);
        // Weapon-axis aim: camera orientation * (viewmodel root rotation relative to camera).
        this.scopeCam.quaternion.copy(cam.quaternion).multiply(rig.root.quaternion).multiply(rig.sightQ);
        this.scopeCam.updateProjectionMatrix();
        this.scopeCam.updateMatrixWorld();
        const r2 = g.renderer.renderer;
        // Perf: PiP resolution per quality (Low 256 / Med 384 / High 512 / Ultra 768); skipped on QA sim-only frames.
        // (render owner: from Renderer.features — presets, adaptive quality, benchmark; 0 = PiP off)
        const res = g.renderer.features?.pip ?? [256, 384, 512, 768][g.settings.quality] ?? 512;
        if (res > 0 && this.scopeRT.width !== res) this.scopeRT.setSize(res, res);
        const every = g.renderer.features?.pipEvery ?? ((g.settings.quality ?? 2) >= 2 ? 1 : 2);
        // Perf: on Medium and Low the PiP refreshes every 2nd frame (the lens image is small and mostly static while aiming).
        this._scopeTick = (this._scopeTick || 0) + 1;
        if (!window.__qaSkipRender && res > 0 && (every <= 1 || (this._scopeTick & 1) === 0 || !this._scopeFresh)) {
          this._scopeFresh = true;
          const prevTarget = r2.getRenderTarget();
          // Reuse this frame's shadow maps (the main pass already updated them).
          const sa = r2.shadowMap.autoUpdate;
          r2.shadowMap.autoUpdate = false;
          r2.setRenderTarget(this.scopeRT);
          r2.render(g.renderer.scene, this.scopeCam);
          r2.setRenderTarget(prevTarget);
          r2.shadowMap.autoUpdate = sa;
        }
      }
    }
  }

  _updateLaser(rig, w, ctx) {
    const on = rig.laser && w.laserOn && !this.hidden && this.sprintBlend < 0.5;
    this.beam.visible = !!on;
    this.laserDot.visible = false;
    if (!on) return;
    rig.root.updateMatrixWorld(true);
    const lp = rig.laser.getWorldPosition(new THREE.Vector3());
    const toRoot = _m.copy(rig.root.matrixWorld).invert();
    this.beam.position.copy(lp.clone().applyMatrix4(toRoot));
    this.beam.scale.set(1, 1, 2.5 / rig.scale);
    // World laser dot along the bore.
    const g = this.game;
    const cam = g.renderer.camera;
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion.clone().multiply(rig.root.quaternion)).normalize();
    const origin = cam.position.clone();
    const hit = g.physics.raycast(origin, dir, 120, 1);
    if (hit) {
      this.laserDot.visible = true;
      this.laserDot.position.copy(hit.point).addScaledVector(hit.normal, 0.01);
      this.laserDot.lookAt(hit.point.clone().add(hit.normal));
      const d = hit.distance;
      this.laserDot.scale.setScalar(0.4 + d * 0.02);
    }
  }

  _updateLighting(ctx, dt) {
    const g = this.game;
    const lvl = g.level;
    if (!lvl?.sun) return;
    const r = g.renderer.renderer, cam = g.renderer.camera;
    const camQ = cam.quaternion, camQi = camQ.clone().invert();
    const eye = cam.position;
    this._lightTimer = (this._lightTimer || 0) - dt;
    if (this._lightTimer <= 0) {
      this._lightTimer = 0.1;
      const sunHit = g.physics.raycast(eye.clone(), lvl.sunDir.clone(), 150, 1);
      this._sunTarget = sunHit ? 0.08 : 1;
      this._indoor = lvl.isIndoors(eye) ? 1 : 0;
    }
    this._sunK = damp(this._sunK ?? 1, this._sunTarget ?? 1, 6, dt);
    this._indoorK = damp(this._indoorK ?? 0, this._indoor ?? 0, 4, dt);

    if (window.__vmLegacyLight) return this._legacyLighting(camQi); // QA A/B switch

    // ---- Key (sun) in view space, tight shadow frustum around the weapon.
    const sunV = _v.copy(lvl.sunDir).applyQuaternion(camQi).normalize();
    this.vmSun.position.copy(this.vmSunTarget.position).addScaledVector(sunV, 2);
    this.vmSun.color.copy(lvl.sun.color);
    this.vmSun.intensity = Math.min(lvl.sun.intensity, 4) * 0.85 * this._sunK;
    this.vmSun.castShadow = !!this._shadowRT && this.vmShadowOn !== false && this._sunK > 0.15;

    // ---- IBL: the sky env map is world-oriented; the view scene lives in camera space.
    this.viewScene.environmentRotation.setFromQuaternion(camQi);

    // ---- Local light probe (round-robin cube faces + async SH readback).
    const skip = !!window.__qaSkipRender;
    if (this.probeRT && this.probeEvery > 0 && !skip && (this._probeTick = (this._probeTick + 1) % this.probeEvery) === 0) {
      if (!this._probeTagged) this._tagProbeLayer();
      const sm = r.shadowMap, au = sm.autoUpdate, nu = sm.needsUpdate;
      sm.autoUpdate = false; sm.needsUpdate = false;
      const prevT = r.getRenderTarget(), prevF = r.getActiveCubeFace?.() ?? 0;
      const c = this.probeCams[this.probeFace];
      c.position.copy(eye); c.lookAt(_v.copy(eye).add(c.userData.dir)); c.updateMatrixWorld();
      r.setRenderTarget(this.probeRT, this.probeFace);
      r.render(g.renderer.scene, c);
      r.setRenderTarget(prevT, prevF);
      sm.autoUpdate = au; sm.needsUpdate = nu;
      this.probeFace = (this.probeFace + 1) % 6;
      this.probeTimer -= dt;
      if (this.probeFace === 0 && this.probeTimer <= 0 && !this._probeBusy) {
        this.probeTimer = this.probeInterval;
        this._probeBusy = true;
        captureSH(r, this.probeRT, this._shBuf).then((sh) => { this.shTarget = sh; }).catch((e) => { if (!this._probeErr) { this._probeErr = true; console.warn('viewmodel probe:', e?.message ?? e); } }).finally(() => { this._probeBusy = false; });
      }
    }
    if (this.shTarget) {
      // Blend toward the latest capture over ~0.3 s, then rotate L1 into view space (L2 dropped:
      // only the low-frequency "where is the light coming from" survives a 32 px probe anyway).
      const k = 1 - Math.exp(-dt / 0.3);
      const cw = this.shWorld.coefficients, ct = this.shTarget.coefficients;
      for (let i = 0; i < 4; i++) cw[i].lerp(ct[i], k);
      const cv = this.vmProbe.sh.coefficients;
      cv[0].copy(cw[0]);
      for (let ch = 0; ch < 3; ch++) {
        // three's SH order: [1]=y, [2]=z, [3]=x.
        _v.set(cw[3].getComponent(ch), cw[1].getComponent(ch), cw[2].getComponent(ch)).applyQuaternion(camQi);
        cv[3].setComponent(ch, _v.x); cv[1].setComponent(ch, _v.y); cv[2].setComponent(ch, _v.z);
      }
      for (let i = 4; i < 9; i++) cv[i].set(0, 0, 0);
      this.probeLum = cw[0].x * 0.2126 + cw[0].y * 0.7152 + cw[0].z * 0.0722;
      this.probeLumRef = Math.max(this.probeLumRef * (1 - dt * 0.02), this.probeLum); // slow-decaying "outdoor" reference
      this.vmProbe.intensity = damp(this.vmProbe.intensity, 0.8, 3, dt);
    }
    const probeOn = this.vmProbe.intensity / 0.8;
    const dark = this.shTarget ? clamp(this.probeLum / Math.max(1e-4, this.probeLumRef), 0.2, 1) : 1 - this._indoorK * 0.65;
    // With the probe carrying diffuse ambient, the sky IBL is mostly there for reflections.
    this.viewScene.environmentIntensity = (0.9 - 0.4 * probeOn) * dark;
    this.vmHemi.intensity = 0.3 * (1 - this._indoorK * 0.5) * (1 - probeOn);
    this.vmHemi.position.set(0, 1, 0).applyQuaternion(camQi);

    // ---- Rim: cool sky-tinted back light, a touch stronger in the dark so silhouettes still read.
    this.vmRim.intensity = (0.35 + 0.35 * (1 - dark)) * (this.lightQ >= 1 ? 1 : 0.6);

    // ---- Mirror the 1–2 most significant scene lights (with flicker, colour, falloff, occlusion).
    this._mirrorLocalLights(eye, dt);

    // ---- Accents: red-dot / laser spill onto the housing.
    const rig = this.rig, w = ctx.weapon;
    let acc = 0;
    if (rig?.aim?.reticle?.visible && rig.aim.reticleAnchor) {
      rig.aim.reticleAnchor.getWorldPosition(this.vmAccent.position); this.viewCam.worldToLocal(this.vmAccent.position);
      acc = 0.015 * w.adsT;
    } else if (rig?.laser && this.beam.visible) {
      rig.laser.getWorldPosition(this.vmAccent.position); this.viewCam.worldToLocal(this.vmAccent.position);
      acc = 0.03;
    }
    this.vmAccent.intensity = acc;

    // ---- Viewmodel-only shadow map: the composer renders shadows once per frame for the world
    // scene and skips them for the view pass, so render this one light's map here.
    if (this.vmSun.castShadow && !skip && rig) {
      if (this._shadowRig !== rig) {
        this._shadowRig = rig;
        rig.root.traverse((o) => { if (o.isMesh) { const basic = o.material?.isMeshBasicMaterial || o.material?.transparent; o.castShadow = !basic; o.receiveShadow = !basic; } });
        this.reloadArms?.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      }
      const sm = r.shadowMap, au = sm.autoUpdate, nu = sm.needsUpdate, prevT = r.getRenderTarget();
      sm.autoUpdate = false; sm.needsUpdate = true;
      r.setRenderTarget(this._shadowRT);
      r.render(this.viewScene, this.viewCam);
      r.setRenderTarget(prevT);
      sm.autoUpdate = au; sm.needsUpdate = nu;
    }
  }

  /**
   * Graphics features (render owner; Renderer.features via Game.applyGraphicsFeatures): light-probe rate
   * (0 = off, the hemisphere fill takes over) and the viewmodel sun-shadow map size (0 = off).
   */
  applyFeatures(f) {
    const every = f.probe | 0;
    if (every !== this.probeEvery) {
      this.probeEvery = every;
      this._probeTick = 0;
      if (!every) { this.shTarget = null; this.vmProbe.intensity = 0; }
    }
    this.vmShadowOn = f.vmShadow > 0;
    if (f.vmShadow > 0 && this.vmSun.shadow.mapSize.x !== f.vmShadow) {
      this.vmSun.shadow.mapSize.setScalar(f.vmShadow); // three resizes the map on its next shadow render
    }
  }

  /** Pre-rig lighting (sun + hemi + fixed-orientation IBL), kept for A/B comparisons. */
  _legacyLighting(camQi) {
    const lvl = this.game.level;
    this.vmSun.position.copy(lvl.sunDir).applyQuaternion(camQi).multiplyScalar(5);
    this.vmSun.color.set(0xfff0dc); this.vmSun.intensity = 3.0 * this._sunK; this.vmSun.castShadow = false;
    this.viewScene.environmentRotation.set(0, 0, 0);
    this.viewScene.environmentIntensity = 0.9 * (1 - this._indoorK * 0.65);
    this.vmHemi.intensity = 0.3 * (1 - this._indoorK * 0.5);
    this.vmHemi.position.set(0, 1, 0).applyQuaternion(camQi);
    this.vmProbe.intensity = 0; this.vmRim.intensity = 0; this.vmAccent.intensity = 0;
    for (const l of this.vmLocal) l.intensity = 0;
  }

  /** Probe sees static level geometry, the sky and lights — not bots, props or particles. */
  _tagProbeLayer() {
    const g = this.game;
    this._probeTagged = true;
    g.renderer.scene.traverse((o) => {
      if ((o.isLight && !o.userData.lightPool) || o === g.level?.sky || (o.isMesh && /^lvl_/.test(o.name))) o.layers.enable(PROBE_LAYER);
    });
  }

  _mirrorLocalLights(eye, dt) {
    const g = this.game;
    this._lightScanT -= dt;
    if (this._lightScanT <= 0) {
      this._lightScanT = 2;
      const list = [];
      g.renderer.scene.traverse((o) => {
        // (LightPool's physical lights mirror the logical ones: skip them to avoid double lighting — perf)
        if (o.isLight && !o.userData.lightPool) o.layers.enable(PROBE_LAYER); // three filters lights by camera layers
        if ((o.isPointLight || o.isSpotLight) && !o.userData.vmIgnore) list.push(o);
      });
      this._lightCache = list;
    }
    const cands = [];
    for (const L of this._lightCache) {
      if (!L.visible || L.intensity <= 0 || !L.parent) continue;
      L.getWorldPosition(_v);
      const d2 = Math.max(0.25, _v.distanceToSquared(eye));
      if (L.distance > 0 && d2 > L.distance * L.distance) continue;
      const score = L.intensity / d2 * L.color.r + L.intensity / d2 * L.color.g;
      if (score > 0.02) cands.push({ L, score, pos: _v.clone() });
    }
    cands.sort((a, b) => b.score - a.score);
    const camInv = g.renderer.camera.matrixWorldInverse;
    for (let i = 0; i < this.vmLocal.length; i++) {
      const vl = this.vmLocal[i], c = cands[i];
      if (!c || (i > 0 && this.lightQ < 1)) { vl.intensity = damp(vl.intensity, 0, 12, dt); continue; }
      // Occlusion: re-tested at most 5x/s per source, smoothed so lights fade around corners.
      let o = this._occ.get(c.L);
      if (!o) { o = { v: 1, t: 0 }; this._occ.set(c.L, o); }
      o.t -= dt;
      if (o.t <= 0) {
        o.t = 0.2;
        const dir = c.pos.clone().sub(eye); const dist = dir.length();
        const hit = dist > 0.3 ? g.physics.raycast(eye.clone(), dir.normalize(), dist - 0.3, 1) : null;
        o.target = hit ? 0.12 : 1;
      }
      o.v = damp(o.v, o.target ?? 1, 8, dt);
      vl.position.copy(c.pos).applyMatrix4(camInv);
      vl.color.copy(c.L.color);
      vl.distance = c.L.distance; vl.decay = c.L.decay;
      vl.intensity = c.L.intensity * o.v * 0.75; // copied every frame → flickers with the source
    }
  }

  /** World-space position of the ejection port / muzzle (for shells & flashes). */
  worldPoint(obj) {
    const rig = this.rig;
    if (!rig) return null;
    rig.root.updateMatrixWorld(true);
    const p = obj.getWorldPosition(new THREE.Vector3()); // in view-camera space (camera at origin)
    const cam = this.game.renderer.camera;
    const camSpace = p.applyMatrix4(_m2.copy(this.viewCam.matrixWorld).invert());
    // Scale correction for FOV difference (approx): map view-camera space to main camera space.
    return cam.localToWorld(camSpace);
  }
}
