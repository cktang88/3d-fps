import * as THREE from 'three';
import { GunModels, POSES, RELOAD_PHASES, M, vmTune } from './GunModels.js';
import { Spring, Spring3, damp, clamp, DEG, smoothstep, easeInOutSine, rand } from '../../core/MathUtil.js';
import { muzzleFlashAtlas, muzzleSideTex, reticleTex, glowTex } from '../../render/ProcTex.js';

const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);
const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _v = new THREE.Vector3(), _q = new THREE.Quaternion();

function find(root, name) {
  let r = null;
  root.traverse((o) => { if (!r && o.name === name) r = o; });
  return r;
}
function findAny(root, names) { for (const n of names) { const f = find(root, n); if (f) return f; } return null; }

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
    this.vmSun = new THREE.DirectionalLight(0xfff0dc, 2.2);
    this.vmSun.position.set(0.4, 1, 0.3);
    this.vmHemi = new THREE.HemisphereLight(0xbcc8d6, 0x4a4036, 0.35);
    this.vmFill = new THREE.PointLight(0xffb070, 0, 3, 2); // muzzle flash light on the gun
    this.viewCam.add(this.vmFill);
    this.vmFill.position.set(0.2, -0.1, -0.9);
    s.add(this.vmSun, this.vmHemi);
  }

  _buildFlash() {
    const atlas = muzzleFlashAtlas();
    const side = muzzleSideTex();
    const mk = (tex, w, h) => new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({
      map: tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, toneMapped: false,
      color: new THREE.Color(3.2, 2.6, 2.0), side: THREE.DoubleSide,
    }));
    this.flash = new THREE.Group();
    const front = mk(atlas, 0.16, 0.16);
    front.material.map = atlas;
    front.geometry.attributes.uv.array.forEach((v, i, a) => (a[i] = v * 0.5));
    this.flashFront = front;
    const s1 = mk(side, 0.3, 0.12); s1.position.z = -0.14; s1.rotation.y = Math.PI / 2;
    const s2 = s1.clone(); s2.rotation.x = Math.PI / 2;
    this.flash.add(front, s1, s2);
    this.flash.visible = false;
    this.flash.renderOrder = 20;
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
          // ACES-ish quick tonemap so the HDR RT matches the main image roughly.
          col = col / (col + vec3(0.6)) * 1.25;
          col = pow(col, vec3(1.0/2.2));
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
    beamGeo.translate(0, -0.5, 0); beamGeo.rotateX(-Math.PI / 2); // along −z
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
    const tune = vmTune(poseKey);
    const basePose = POSES[poseKey] || POSES.m4a1;
    const pose = { ...basePose, primary: tune.primary || basePose.primary, support: tune.support || basePose.support };
    const sidearm = pose.kind === 'sidearm';
    const root = new THREE.Group();
    root.name = 'WeaponRoot';
    const scale = tune.scale;
    root.scale.setScalar(scale);
    const gun = src.clone(true);
    root.add(gun);
    root.updateMatrixWorld(true);

    const rig = { root, gun, weapon, pose, poseKey, sidearm, scale, kind: pose.kind, stats: s, tune };
    rig.magazine = find(gun, 'Magazine');
    rig.spare = find(gun, 'SpareMagazine');
    if (rig.spare) rig.spare.visible = false;
    rig.charging = find(gun, 'ChargingHandle');
    rig.magHome = rig.magazine ? { p: rig.magazine.position.clone(), q: rig.magazine.quaternion.clone() } : null;
    rig.spareHome = rig.spare ? { p: rig.spare.position.clone(), q: rig.spare.quaternion.clone() } : null;
    rig.chargingHome = rig.charging ? rig.charging.position.clone() : null;
    rig.magGrip = rig.magazine ? findAny(rig.magazine, ['MagazineGripSocket', 'MagazineGrip']) : null;
    rig.spareGrip = rig.spare ? findAny(rig.spare, ['SpareMagazineGrip', 'MagazineGripSocket']) : null;

    // ---- Attachments ----
    const att = s.att;
    const authoredSup = find(gun, 'Suppressor'), authoredMuzzleDev = find(gun, 'MuzzleDevice');
    const authoredForegrip = find(gun, 'Foregrip'), authoredOptic = find(gun, 'OpticMount');
    const rear = findAny(gun, ['RearIronSight']), front = findAny(gun, ['FrontIronSight']);
    let muzzleTip = findAny(gun, ['MuzzleDeviceTip', 'MuzzleSocket']);
    if (!muzzleTip) {
      // Compute from bounds: front-most point at barrel height.
      const bb = new THREE.Box3().setFromObject(gun);
      muzzleTip = new THREE.Object3D();
      muzzleTip.position.set(0, 0.06, bb.min.z + 0.02);
      gun.add(muzzleTip);
    }
    if (authoredSup) authoredSup.visible = att.muzzle === 'suppressor';
    if (authoredMuzzleDev) authoredMuzzleDev.visible = !att.muzzle || att.muzzle !== 'suppressor';
    if (authoredForegrip) authoredForegrip.visible = att.underbarrel === 'vgrip';
    if (authoredOptic) authoredOptic.visible = false;
    let tip = muzzleTip;
    if (att.muzzle === 'suppressor') {
      if (authoredSup) tip = find(authoredSup, 'SuppressorTip') || tip;
      else {
        const sup = GunModels.suppressor(sidearm ? 0.2 : 0.32, sidearm ? 0.026 : 0.036);
        sup.position.copy(muzzleTip.position);
        muzzleTip.parent.add(sup);
        tip = find(sup, 'tip');
      }
    } else if (att.muzzle && !(authoredMuzzleDev && att.muzzle === 'flashhider')) {
      const md = GunModels.muzzleDevice(att.muzzle, sidearm ? 0.016 : 0.022);
      md.position.copy(muzzleTip.position);
      muzzleTip.parent.add(md);
      if (authoredMuzzleDev) authoredMuzzleDev.visible = false;
      tip = find(md, 'tip');
    }
    rig.muzzle = tip;
    // Under-barrel.
    const support = V(pose.support);
    if (att.underbarrel === 'vgrip' && !authoredForegrip) {
      const vg = GunModels.vgrip(); vg.position.copy(support).add(new THREE.Vector3(0, -0.05, 0.02)); gun.add(vg);
    } else if (att.underbarrel === 'agrip') {
      const ag = GunModels.agrip(); ag.position.copy(support).add(new THREE.Vector3(0, -0.06, 0.06)); gun.add(ag);
    } else if (att.underbarrel === 'bipod') {
      const bp = GunModels.bipod(); bp.position.copy(support).add(new THREE.Vector3(0, -0.06, -0.12)); gun.add(bp);
    }
    if (att.laser) {
      const lz = GunModels.laser(); lz.position.copy(support).add(new THREE.Vector3(0.05, 0.02, -0.04)); gun.add(lz);
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

    // Optic.
    gun.updateMatrixWorld(true);
    rig.aim = this._mountOptic(rig, gun, att.optic, authoredOptic, rear, front);

    // Ejection port.
    rig.eject = findAny(gun, ['EjectionPort', 'ChargingHandleSocket']) || (() => { const o = new THREE.Object3D(); o.position.set(0.05, 0.07, -0.25); gun.add(o); return o; })();

    // ---- Static arms ----
    const armsSrc = sidearm ? this.models.armsPistol : this.models.armsRifle;
    if (armsSrc) {
      const arms = armsSrc.scene.clone(true);
      arms.traverse((o) => { if (o.isMesh) { o.frustumCulled = false; o.material.envMapIntensity = 0.9; } });
      root.add(arms);
      rig.arms = arms;
      rig.leftArm = find(arms, 'LeftArm');
      rig.rightArm = find(arms, 'RightArm');
      this._alignStaticArms(rig);
    }
    // Hip / ADS positions (WeaponRoot in view-camera space).
    rig.hip = V(tune.hip);
    rig.hipRot = new THREE.Euler(tune.hipRot[0], tune.hipRot[1], tune.hipRot[2]);
    const a = rig.aim.point;
    if (sidearm) rig.ads = new THREE.Vector3(-a.x * scale, -a.y * scale, -0.5);
    else rig.ads = new THREE.Vector3(-a.x * scale, -a.y * scale, rig.aim.scope ? -0.36 - a.z * scale : -0.52 - a.z * scale * 0.3);
    rig.phases = RELOAD_PHASES[sidearm ? 'sidearm' : pose.kind === 'long' ? 'long' : 'rifle'];
    rig.clipStem = { m4a1: 'm4a1', ak74: 'ak74', scarl: 'scarl', mp5a5: 'mp5a5', vss: 'vss', m24: 'm24', awm: 'awm', p226: 'p226', m1911: 'm1911' }[poseKey];
    return rig;
  }

  _mountOptic(rig, gun, opticId, authoredOptic, rear, front) {
    const s = rig.stats;
    if (opticId && opticId !== 'irons' && rear) rear.visible = false;
    if (opticId && opticId !== 'irons' && front && rig.poseKey !== 'ak74') front.visible = false;
    if (!opticId || opticId === 'irons') {
      // Iron sight line: top of rear sight (or receiver top near rear).
      let y;
      if (rear) { const bb = new THREE.Box3().setFromObject(rear); y = bb.max.y - 0.006; }
      else if (rig.poseKey === 'ak74') y = 0.075 / 0.82 * 0.82;
      else {
        const bb = new THREE.Box3().setFromObject(gun);
        y = rig.sidearm ? bb.max.y - 0.005 : bb.max.y - 0.01;
      }
      if (rig.poseKey === 'ak74') y = 0.075;
      if (rig.poseKey === 'm4a1' && !rear) y = 0.205;
      const z = rear ? new THREE.Box3().setFromObject(rear).getCenter(new THREE.Vector3()).z : 0;
      return { point: new THREE.Vector3(0, y, z), type: 'irons' };
    }
    const optics = this.models.src.optics;
    const nodeName = opticId === 'reddot' ? 'MicroOptic' : opticId === 'holo' ? 'HoloOptic' : 'ScopeOptic';
    const prefix = opticId === 'reddot' ? 'Micro' : opticId === 'holo' ? 'Holo' : 'Scope';
    const srcNode = find(optics, nodeName);
    const optic = srcNode.clone(true);
    optic.position.set(0, 0, 0); optic.rotation.set(0, 0, 0);
    // Rail position: authored socket or receiver top.
    const railSock = findAny(gun, ['OpticRailSocket', 'OpticRailContact']);
    let mount;
    if (railSock) mount = railSock.getWorldPosition(new THREE.Vector3()).applyMatrix4(_m.copy(rig.root.matrixWorld).invert());
    else if (rig.poseKey === 'm4a1') mount = new THREE.Vector3(0, 0.167 - 0.07, -0.25);
    else {
      const bb = new THREE.Box3().setFromObject(gun);
      mount = new THREE.Vector3(0, bb.max.y - 0.01, rig.sidearm ? 0.2 : -0.25);
    }
    // Rail contact offsets (steel-tide constants): micro 0.070, holo 0.092, scope 0.084.
    const contact = { reddot: 0.07, holo: 0.092, acog: 0.084, sniper: 0.084 }[opticId];
    optic.position.copy(mount).add(new THREE.Vector3(0, contact, 0));
    if (opticId === 'sniper') optic.scale.set(1.3, 1.3, 1.5);
    if (rig.sidearm) optic.scale.multiplyScalar(0.75);
    gun.add(optic);
    optic.updateMatrixWorld(true);
    const reticleAnchor = find(optic, prefix + 'ReticleAnchor');
    const frontAp = find(optic, prefix + 'FrontApertureAnchor');
    const rearAp = find(optic, prefix + 'RearApertureAnchor');
    const toRoot = (o) => o.getWorldPosition(new THREE.Vector3()).applyMatrix4(_m.copy(rig.root.matrixWorld).invert());
    const point = toRoot(reticleAnchor);
    const info = { point, type: opticId, frontAp, rearAp, optic, scope: opticId === 'acog' };
    if (opticId === 'reddot' || opticId === 'holo') {
      const tex = reticleTex(opticId === 'reddot' ? 'dot' : 'holo', '#ff2a1a');
      const ret = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
        map: tex, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
        color: new THREE.Color(2.5, 2.5, 2.5),
      }));
      ret.renderOrder = 30;
      ret.frustumCulled = false;
      this.viewCam.add(ret); // positioned in camera space each frame (collimated reticle)
      ret.visible = false;
      info.reticle = ret;
      info.reticleSize = opticId === 'reddot' ? 0.0042 : 0.012;
      // Lens glass tint.
      const lensR = opticId === 'reddot' ? 0.016 : 0.024;
      const lens = new THREE.Mesh(new THREE.CircleGeometry(lensR, 24), new THREE.MeshPhysicalMaterial({
        color: 0x6688aa, metalness: 0, roughness: 0.02, transparent: true, opacity: 0.12, envMapIntensity: 2,
      }));
      lens.position.copy(frontAp.position);
      frontAp.parent.add(lens);
    } else if (opticId === 'acog') {
      // Picture-in-picture lens at the rear aperture.
      const lens = new THREE.Mesh(new THREE.CircleGeometry(0.019, 40), this.scopeLensMat);
      lens.position.copy(rearAp.position).add(new THREE.Vector3(0, 0, -0.004));
      rearAp.parent.add(lens);
      info.lens = lens;
      info.lensRadius = 0.019;
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
    const presScale = rig.poseKey === 'scarl' ? 0.8 : rig.poseKey === 'awm' ? 0.75 : sidearm ? 0.64 : 0.72;
    const pres = new THREE.Matrix4().makeRotationY(Math.PI);
    if (sidearm) pres.premultiply(new THREE.Matrix4().makeRotationX(0.3));
    const basis = pres.multiply(new THREE.Matrix4().makeRotationFromQuaternion(q).invert());
    basis.scale(new THREE.Vector3().setScalar(presScale / rig.scale));
    const origin = V(rig.pose.primary).sub(pos.clone().applyMatrix4(basis));
    basis.setPosition(origin);
    basis.decompose(arms.position, arms.quaternion, arms.scale);
  }

  // ------------------------------------------------------------------ switching
  setWeapon(weapon) {
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
    const s = rig.stats;
    const k = s.kick * (1 - this.adsBlend * 0.45);
    this.kickPos.impulse(rand(-0.03, 0.03) * k, rand(0.02, 0.05) * k, 0.5 * k * (rig.sidearm ? 0.6 : 1));
    this.kickRot.impulse(1.6 * k * (rig.sidearm ? 2.2 : 1), rand(-0.6, 0.6) * k, rand(-1.4, 1.4) * k);
    if (!s.suppressed) {
      this.flashT = 0.045;
      this.flashFront.rotation.z = Math.random() * Math.PI * 2;
      const f = (Math.random() * 4) | 0;
      const uv = this.flashFront.geometry.attributes.uv;
      const ox = (f % 2) * 0.5, oy = Math.floor(f / 2) * 0.5;
      uv.setXY(0, ox, oy); uv.setXY(1, ox + 0.5, oy); uv.setXY(2, ox, oy + 0.5); uv.setXY(3, ox + 0.5, oy + 0.5);
      uv.needsUpdate = true;
      const sc = (rig.sidearm ? 0.7 : 1) * (0.8 + Math.random() * 0.5) * (s.flash ?? 1) * (s.pellets > 1 ? 1.5 : 1);
      this.flash.scale.setScalar(sc / rig.scale);
    }
    // Slide / bolt carrier cycles.
    if (rig.charging && (rig.sidearm || s.closedBolt)) this.slideT = 0.06;
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
    if (rig.leftArm) rig.leftArm.visible = true;
    if (rig.magazine && rig.magHome) { rig.magazine.position.copy(rig.magHome.p); rig.magazine.quaternion.copy(rig.magHome.q); rig.magazine.visible = true; }
    if (rig.spare) rig.spare.visible = false;
  }

  // ------------------------------------------------------------------ update
  /**
   * ctx: { weapon, player, mouse:{x,y}, dt, adsT, sprint, reloadProgress, reloadType, fpcam, aimDir }
   */
  update(dt, ctx) {
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
    this.swayPos.target.y += -p.velocity.y * 0.002;
    this.swayRot.update(dt); this.swayPos.update(dt);
    this.kickPos.update(dt); this.kickRot.update(dt);
    this.landY.update(dt);

    // Bob (figure-8), synced with camera bob phase.
    const ph = ctx.fpcam.bobPhase, ba = ctx.fpcam.bobAmount * (1 - adsE * 0.9);
    const sprintA = 1 + this.sprintBlend * 1.4;
    const bobX = Math.sin(ph) * 0.012 * ba * sprintA;
    const bobY = -Math.abs(Math.cos(ph)) * 0.01 * ba * sprintA;
    const bobRot = Math.sin(ph) * 0.02 * ba * sprintA;
    // Idle breathing.
    const breath = Math.sin(this.time * 1.6) * 0.0015 * (1 - adsE * 0.7);
    const breathR = Math.sin(this.time * 0.8) * 0.004 * (1 - adsE * 0.8);

    // ---- Root pose ----
    const pos = new THREE.Vector3().copy(rig.hip).lerp(rig.ads, adsE);
    const rot = new THREE.Euler(rig.hipRot.x * (1 - adsE), rig.hipRot.y * (1 - adsE), rig.hipRot.z * (1 - adsE));
    // Sprint pose: lower, tilt, canted (CoD/Apex style).
    const sb = smoothstep(this.sprintBlend);
    if (rig.sidearm) { pos.add(new THREE.Vector3(-0.04, -0.12, 0.05).multiplyScalar(sb)); rot.x += -0.55 * sb; rot.z += 0.15 * sb; }
    else { pos.add(new THREE.Vector3(-0.05, -0.08, 0.08).multiplyScalar(sb)); rot.x += -0.12 * sb; rot.y += 0.55 * sb; rot.z += 0.35 * sb; }
    // Tactical sprint: weapon lifted higher.
    if (p.tacSprint) { rot.x += -0.25 * sb; pos.y += 0.04 * sb; }
    // Slide / mantle: lower and roll.
    pos.y -= 0.05 * this.slideBlend + 0.18 * this.mantleBlend;
    rot.z += 0.22 * this.slideBlend + 0.25 * this.mantleBlend;
    rot.x -= 0.5 * this.mantleBlend;
    // Reload offset: bring gun in & roll toward the support hand.
    const rb = smoothstep(this.reloadBlend);
    if (rig.sidearm) { pos.add(new THREE.Vector3(-0.02, 0.0, 0.03).multiplyScalar(rb)); rot.z += 0.05 * rb; }
    else { pos.add(new THREE.Vector3(-0.04, 0.02, 0.05).multiplyScalar(rb)); rot.z += 0.22 * rb; rot.x += 0.06 * rb; }
    // Shotgun shell loading roll.
    if (s.tube && reloading) { rot.z += 0.35 * rb; rot.x += 0.12 * rb; }
    // Bolt/pump cycle.
    if (w.state === 'bolt') {
      const t = clamp(w.stateTime / w.stateDur, 0, 1);
      const k = Math.sin(t * Math.PI);
      rot.z += 0.18 * k; rot.x += 0.06 * k; pos.y -= 0.02 * k;
      if (rig.charging) rig.charging.position.z = rig.chargingHome.z + Math.sin(clamp((t - 0.15) / 0.7, 0, 1) * Math.PI) * 0.12;
      this.adsHoldDuringBolt = true;
    }
    if (w.state === 'pump') {
      const t = clamp(w.stateTime / w.stateDur, 0, 1);
      const k = Math.sin(t * Math.PI);
      pos.z += 0.03 * k; rot.x += 0.05 * k;
      if (rig.leftArm) rig.leftArm.position.z = rig.leftArmHome.z + k * 0.12;
    } else if (rig.leftArm && w.state !== 'reload') rig.leftArm.position.lerp(rig.leftArmHome, 1 - Math.exp(-20 * dt));
    // Equip: rise from below.
    const eq = smoothstep(this.equipT);
    pos.y -= (1 - eq) * 0.35; rot.x -= (1 - eq) * 0.9; rot.z += (1 - eq) * 0.3;
    // Inspect: rotate to show the right side then the left.
    if (this.inspectT > 0) {
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
    pos.add(new THREE.Vector3(this.kickPos.x.x, this.kickPos.x.y, this.kickPos.x.z).multiplyScalar(0.03 * (1 - adsE * 0.5)));
    rot.x += this.swayRot.x.x + this.kickRot.x.x * 0.02 + breathR;
    rot.y += this.swayRot.x.y + this.kickRot.x.y * 0.02;
    rot.z += this.swayRot.x.z + this.kickRot.x.z * 0.02 + bobRot;
    // Lean also rolls the gun slightly extra.
    rot.z += -p.lean * 0.05;
    rig.root.position.copy(pos);
    rig.root.rotation.copy(rot);

    // Slide / bolt carrier.
    if (rig.charging && w.state !== 'bolt') {
      this.slideT = Math.max(0, (this.slideT || 0) - dt);
      const lockBack = rig.sidearm && w.ammo === 0 && w.state !== 'reload';
      const travel = rig.sidearm ? 0.07 : 0.1;
      const k = lockBack ? 1 : this.slideT > 0 ? Math.sin((1 - this.slideT / 0.06) * Math.PI) : 0;
      rig.charging.position.z = rig.chargingHome.z + k * travel;
    }

    // ---- Reload arms ----
    this._updateReload(rig, w, dt);

    // ---- Muzzle flash ----
    this.flashT -= dt;
    this.flash.visible = this.flashT > 0 && !this.hidden;
    if (this.flash.visible) {
      rig.root.updateMatrixWorld(true);
      const mp = rig.muzzle.getWorldPosition(_v);
      this.flash.position.copy(mp.applyMatrix4(_m.copy(rig.root.matrixWorld).invert()));
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

  _updateReload(rig, w, dt) {
    const reloading = w.state === 'reload' && !rig.stats.tube;
    if (!reloading) {
      if (this.reloading) this.endReload(rig);
      return;
    }
    const empty = w.reloadType === 'empty';
    const progress = clamp(w.stateTime / w.stateDur, 0, 1);
    if (!this.reloading) this.startReload(rig, w.reloadType);
    const clipName = rig.clipStem ? `reload_${rig.clipStem}_${empty ? 'empty' : 'tactical'}` : null;
    const clip = clipName && this.reloadClips?.get(clipName);
    if (!clip) { this._proceduralReload(rig, progress); return; }
    // Show animated support arm, hide static left arm.
    this.reloadArms.visible = true;
    if (rig.leftArm) rig.leftArm.visible = false;
    this.reloadMeshes.long.visible = !rig.sidearm;
    this.reloadMeshes.side.visible = rig.sidearm;
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
    // Magazine follows the support hand between reach→stow (old mag) and acquire→seat (new mag).
    const ph = rig.phases;
    const hand = rig.sidearm ? this.leftPalm : this.leftGripAnchor;
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

  // Fallback (shotgun/no-clip weapons): support arm dips to the magazine/port.
  _proceduralReload(rig, progress) {
    if (!rig.leftArm) return;
    const k = Math.sin(progress * Math.PI);
    rig.leftArm.position.copy(rig.leftArmHome).add(new THREE.Vector3(0.02, -0.12 * k, 0.25 * k));
  }

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
      const anchor = find(a.optic, (a.type === 'reddot' ? 'Micro' : 'Holo') + 'ReticleAnchor');
      const frontAp = a.frontAp;
      const camInv = _m.copy(this.viewCam.matrixWorld).invert();
      const anc = anchor.getWorldPosition(new THREE.Vector3()).applyMatrix4(camInv);
      const fa = frontAp.getWorldPosition(new THREE.Vector3()).applyMatrix4(camInv);
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(rig.root.getWorldQuaternion(new THREE.Quaternion())).applyQuaternion(this.viewCam.getWorldQuaternion(new THREE.Quaternion()).invert()).normalize();
      const far = anc.clone().addScaledVector(fwd, 200);
      const dir = far.clone().normalize();
      const denom = dir.dot(fwd);
      const t = fa.dot(fwd) / denom;
      const hit = dir.multiplyScalar(t);
      const off = hit.clone().sub(fa);
      const lensR = (a.type === 'reddot' ? 0.016 : 0.024) * rig.scale;
      const inside = off.length() < lensR * 0.95;
      a.reticle.position.copy(hit);
      a.reticle.quaternion.copy(rig.root.quaternion);
      const sz = a.reticleSize * Math.abs(hit.z) / 0.5;
      a.reticle.scale.setScalar(sz);
      a.reticle.visible = inside && w.adsT > 0.35 && !this.hidden;
      a.reticle.material.opacity = clamp((w.adsT - 0.35) * 3, 0, 1);
    }
    if (a.lens) {
      // Picture-in-picture scope render.
      const g = this.game;
      const active = w.adsT > 0.05;
      a.lens.visible = true;
      this.scopeLensMat.uniforms.fade.value = clamp(w.adsT * 1.6, 0.15, 1);
      if (active && !this.hidden) {
        const cam = g.renderer.camera;
        const zoom = rig.stats.zoomLevel;
        // Lens angular radius on screen (view camera).
        const camInv = _m.copy(this.viewCam.matrixWorld).invert();
        const lp = a.lens.getWorldPosition(new THREE.Vector3()).applyMatrix4(camInv);
        const r = a.lensRadius * rig.scale;
        const Rs = (r / Math.abs(lp.z)) / Math.tan((this.viewCam.fov * DEG) / 2);
        const tanHalf = Rs * Math.tan((cam.fov * DEG) / 2) / zoom;
        this.scopeCam.fov = 2 * Math.atan(Math.max(1e-4, tanHalf)) / DEG;
        this.scopeCam.position.copy(cam.position);
        // Weapon-axis aim: camera orientation * (viewmodel root rotation relative to camera).
        this.scopeCam.quaternion.copy(cam.quaternion).multiply(rig.root.quaternion);
        this.scopeCam.updateProjectionMatrix();
        this.scopeCam.updateMatrixWorld();
        const r2 = g.renderer.renderer;
        const prevTarget = r2.getRenderTarget();
        r2.setRenderTarget(this.scopeRT);
        r2.render(g.renderer.scene, this.scopeCam);
        r2.setRenderTarget(prevTarget);
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
    this._lightTimer = (this._lightTimer || 0) - dt;
    if (this._lightTimer <= 0) {
      this._lightTimer = 0.1;
      const eye = g.renderer.camera.position;
      const sunHit = g.physics.raycast(eye.clone(), lvl.sunDir.clone(), 150, 1);
      this._sunTarget = sunHit ? 0.12 : 1;
      this._indoor = lvl.isIndoors(eye) ? 1 : 0;
    }
    this._sunK = damp(this._sunK ?? 1, this._sunTarget ?? 1, 6, dt);
    this._indoorK = damp(this._indoorK ?? 0, this._indoor ?? 0, 4, dt);
    // Sun direction relative to camera so lighting on the gun matches the world.
    const camQ = g.renderer.camera.quaternion.clone().invert();
    this.vmSun.position.copy(lvl.sunDir).applyQuaternion(camQ).multiplyScalar(5);
    this.vmSun.intensity = 3.0 * this._sunK;
    this.viewScene.environmentIntensity = 0.9 * (1 - this._indoorK * 0.65);
    this.vmHemi.intensity = 0.3 * (1 - this._indoorK * 0.5);
    this.vmHemi.position.set(0, 1, 0).applyQuaternion(camQ);
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
