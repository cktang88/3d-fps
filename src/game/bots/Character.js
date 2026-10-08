import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { damp, clamp, DEG } from '../../core/MathUtil.js';

const UPPER = /Spine|Neck|Head|Shoulder|Arm|Hand|Thumb|Index|Middle|Ring|Pinky/;

/** Split a clip into upper-body or lower-body tracks (by bone name). */
function splitClip(clip, upper) {
  const tracks = clip.tracks.filter((t) => {
    const bone = t.name.split('.')[0];
    const isUpper = UPPER.test(bone);
    if (bone.includes('Hips')) return !upper; // hips belong to locomotion
    return upper ? isUpper : !isUpper;
  });
  return new THREE.AnimationClip(clip.name + (upper ? '_up' : '_lo'), clip.duration, tracks);
}

/**
 * Shared soldier template (Bamen military soldier, CC-BY 4.0, with retargeted Quaternius CC0 clips).
 * Each bot gets a SkeletonUtils clone with two animation layers:
 *   lower body: idle / walk / run / crouch locomotion (played forward or reversed for backpedal)
 *   upper body: aim / shoot / reload / throw / hit
 * The chest is twisted toward the aim direction so legs can follow movement while the gun tracks targets.
 */
export class CharacterTemplate {
  constructor(gltf, gunModels) {
    this.gltf = gltf;
    this.gunModels = gunModels;
    this.clips = new Map(gltf.animations.map((c) => [c.name, c]));
    const g = gltf.scene;
    g.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(g);
    this.height = bb.max.y - bb.min.y;
    this.scale = 1.78 / this.height;
    this.yOffset = -bb.min.y * this.scale;
    g.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        o.frustumCulled = false;
        if (o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) { m.envMapIntensity = 0.9; if (m.roughness !== undefined) m.roughness = Math.max(0.45, m.roughness); }
        }
      }
    });
    const pick = (...names) => names.map((n) => this.clips.get(n)).find(Boolean);
    this.lower = {
      idle: splitClip(pick('aim_idle', 'idle'), false),
      walk: splitClip(pick('aim_walk', 'walk'), false),
      run: splitClip(pick('aim_run', 'run'), false),
      crouchIdle: splitClip(pick('aim_crouch_idle', 'crouch_idle'), false),
      crouchWalk: splitClip(pick('aim_crouch_walk', 'crouch_walk'), false),
    };
    this.upper = {
      aim: splitClip(pick('aim_idle'), true),
      aimCrouch: splitClip(pick('aim_crouch_idle', 'aim_idle'), true),
      reload: splitClip(pick('reload'), true),
      throw: splitClip(pick('throw'), true),
      hit: splitClip(pick('hit'), true),
      shoot: splitClip(pick('shoot', 'aim_idle'), true),
    };
    this.death = pick('death');
    this.jump = pick('jump_loop');
  }

  instance(team) {
    return new Character(this, team);
  }
}

const BONES = {
  hips: 'mixamorigHips', spine: 'mixamorigSpine', spine1: 'mixamorigSpine1', spine2: 'mixamorigSpine2', neck: 'mixamorigNeck', head: 'mixamorigHead',
  lArm: 'mixamorigLeftArm', lFore: 'mixamorigLeftForeArm', lHand: 'mixamorigLeftHand',
  rArm: 'mixamorigRightArm', rFore: 'mixamorigRightForeArm', rHand: 'mixamorigRightHand',
  lUp: 'mixamorigLeftUpLeg', lLeg: 'mixamorigLeftLeg', lFoot: 'mixamorigLeftFoot',
  rUp: 'mixamorigRightUpLeg', rLeg: 'mixamorigRightLeg', rFoot: 'mixamorigRightFoot',
};

export class Character {
  constructor(tpl, team) {
    this.tpl = tpl;
    this.root = new THREE.Group();
    const model = SkeletonUtils.clone(tpl.gltf.scene);
    model.scale.setScalar(tpl.scale);
    model.position.y = tpl.yOffset;
    this.model = model;
    this.root.add(model);
    // Team tint: subtle armband / clothing tint so teams read at distance.
    const tint = team === 0 ? new THREE.Color(0.85, 0.92, 1.05) : new THREE.Color(1.08, 0.92, 0.82);
    model.traverse((o) => {
      if (o.isMesh) {
        o.material = Array.isArray(o.material) ? o.material.map((m) => m.clone()) : o.material.clone();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) if (/Clothes|Fabric|Armor/i.test(m.name)) m.color.multiply(tint);
      }
    });
    this.bones = {};
    model.traverse((o) => {
      if (o.isBone) for (const [k, n] of Object.entries(BONES)) if (o.name === n || o.name.endsWith(n)) this.bones[k] = o;
    });
    this.mixer = new THREE.AnimationMixer(model);
    this.lowerActions = {};
    for (const [k, c] of Object.entries(tpl.lower)) {
      const a = this.mixer.clipAction(c);
      a.play(); a.setEffectiveWeight(k === 'idle' ? 1 : 0);
      this.lowerActions[k] = a;
    }
    this.upperActions = {};
    for (const [k, c] of Object.entries(tpl.upper)) {
      const a = this.mixer.clipAction(c);
      if (k === 'aim' || k === 'aimCrouch') { a.play(); a.setEffectiveWeight(k === 'aim' ? 1 : 0); }
      else { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = false; }
      this.upperActions[k] = a;
    }
    this.deathAction = tpl.death ? this.mixer.clipAction(tpl.death) : null;
    if (this.deathAction) { this.deathAction.setLoop(THREE.LoopOnce, 1); this.deathAction.clampWhenFinished = true; }
    this.bodyYaw = 0;
    this.twist = 0;
    this.hitJerk = 0;
    this.fireKick = 0;
    this.deadTime = 0;
    this.weaponObj = null;
    this.weaponId = null;
    this._tmp = new THREE.Vector3();
  }

  // ---------------- weapon in hand ----------------
  attachWeapon(bot) {
    const id = bot.weapon.id;
    if (this.weaponId === id) return;
    if (this.weaponObj) this.weaponObj.parent?.remove(this.weaponObj);
    this.weaponId = id;
    const src = this.tpl.gunModels.src[bot.weapon.stats.model];
    if (!src || !this.bones.rHand) return;
    const gun = src.clone(true);
    gun.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
    const spare = gun.getObjectByName('SpareMagazine'); if (spare) spare.visible = false;
    // Guns are authored ~2x real size in "Godot-space"; scale to real length.
    const s = 0.47;
    const wrap = new THREE.Group();
    wrap.add(gun);
    gun.scale.setScalar(s);
    // Grip anchor near origin: offset so the pistol grip sits in the palm.
    const pose = bot.weapon.stats.pose;
    const grips = { p226: [0, -0.03, 0.237], m1911: [0, -0.03, 0.245], ak74: [0, -0.073, -0.122], scarl: [0, -0.16, -0.155], mp5a5: [0, -0.098, -0.103], vss: [0, -0.05, -0.12], m24: [0, -0.098, 0.041], awm: [0, -0.07, -0.06] };
    const gp = grips[pose] || [0, -0.15, -0.05];
    gun.position.set(-gp[0] * s, -gp[1] * s, -gp[2] * s);
    this.weaponObj = wrap;
    // Find the muzzle.
    this.muzzleObj = gun.getObjectByName('MuzzleDeviceTip') || gun.getObjectByName('MuzzleSocket') || null;
    if (!this.muzzleObj) {
      const bb = new THREE.Box3().setFromObject(gun);
      const m = new THREE.Object3D(); m.position.set(0, 0.06 / s, bb.min.z / s); gun.add(m); this.muzzleObj = m;
    }
    // Hand-space orientation is solved each frame (see update) so the barrel follows the aim direction.
    this.root.add(wrap);
  }

  muzzleWorld() {
    if (!this.muzzleObj) return null;
    return this.muzzleObj.getWorldPosition(new THREE.Vector3());
  }

  // ---------------- events ----------------
  onSpawn() {
    this.deadTime = 0;
    this.mixer.stopAllAction();
    for (const [k, a] of Object.entries(this.lowerActions)) { a.reset().play(); a.setEffectiveWeight(k === 'idle' ? 1 : 0); }
    this.upperActions.aim.reset().play(); this.upperActions.aim.setEffectiveWeight(1);
    this.upperActions.aimCrouch.reset().play(); this.upperActions.aimCrouch.setEffectiveWeight(0);
    this.root.visible = true;
    this.model.position.y = this.tpl.yOffset;
    if (this.weaponObj) this.weaponObj.visible = true;
  }

  onFire() { this.fireKick = 1; }

  onHit(info) {
    this.hitJerk = 1;
    this.hitDir = info?.dir ? info.dir.clone() : null;
  }

  playUpper(name, fade = 0.15) {
    const a = this.upperActions[name];
    if (!a) return;
    a.reset();
    a.setEffectiveWeight(1);
    a.fadeIn(fade);
    a.play();
    a.timeScale = 1;
  }

  // ---------------- per frame ----------------
  update(dt, bot) {
    const root = this.root;
    root.position.copy(bot.position);
    root.position.y += bot.jumpY || 0;
    if (!bot.alive) {
      if (this.deadTime === 0) {
        // Death: full-body clip, drop weapon pose.
        for (const a of Object.values(this.lowerActions)) a.fadeOut(0.1);
        for (const a of Object.values(this.upperActions)) a.fadeOut(0.1);
        if (this.deathAction) { this.deathAction.reset(); this.deathAction.setEffectiveWeight(1); this.deathAction.play(); }
      }
      this.deadTime += dt;
      this.mixer.update(dt);
      if (this.weaponObj) this.weaponObj.visible = this.deadTime < 0.25;
      // Sink after a while.
      if (this.deadTime > 6) this.model.position.y = this.tpl.yOffset - (this.deadTime - 6) * 0.3;
      root.visible = this.deadTime < 9;
      return;
    }

    // --- Locomotion layer ---
    const v = bot.velocity;
    const speed = Math.hypot(v.x, v.z);
    const aimYaw = bot.yaw;
    let moveYaw = speed > 0.3 ? Math.atan2(-v.x, -v.z) : aimYaw;
    let rel = ((moveYaw - aimYaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    let backward = false;
    if (Math.abs(rel) > 100 * DEG) { backward = true; moveYaw += Math.PI; rel = ((moveYaw - aimYaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI; }
    const targetBody = speed > 0.3 ? moveYaw : aimYaw;
    let dy = ((targetBody - this.bodyYaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    this.bodyYaw += dy * Math.min(1, dt * 10);
    // Twist the upper body toward the aim.
    let tw = ((aimYaw - this.bodyYaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    tw = clamp(tw, -95 * DEG, 95 * DEG);
    this.twist = damp(this.twist, tw, 14, dt);
    root.rotation.y = this.bodyYaw;

    const crouch = bot.crouch > 0.5;
    const weights = { idle: 0, walk: 0, run: 0, crouchIdle: 0, crouchWalk: 0 };
    if (crouch) { if (speed > 0.3) weights.crouchWalk = 1; else weights.crouchIdle = 1; }
    else if (speed < 0.3) weights.idle = 1;
    else if (speed < 3.2) { const k = clamp((speed - 0.3) / 1.4, 0, 1); weights.idle = 1 - k; weights.walk = k; }
    else { const k = clamp((speed - 3.2) / 1.2, 0, 1); weights.walk = 1 - k; weights.run = k; }
    for (const [k, a] of Object.entries(this.lowerActions)) {
      const w = damp(a.getEffectiveWeight(), weights[k], 10, dt);
      a.setEffectiveWeight(w);
      a.timeScale = backward ? -1 : 1;
      if (k === 'walk') a.timeScale *= clamp(speed / 1.6, 0.6, 1.6);
      if (k === 'run') a.timeScale *= clamp(speed / 4.4, 0.7, 1.4);
    }
    // Upper layer: aim stance vs crouched aim; reload/throw one-shots.
    const w = bot.weapon;
    if (w.state === 'reload' && !this._reloading) { this._reloading = true; this.playUpper('reload'); this.upperActions.reload.timeScale = this.tpl.upper.reload.duration / Math.max(0.5, w.stateDur); }
    if (w.state !== 'reload') this._reloading = false;
    const oneShot = ['reload', 'throw', 'hit'].some((k) => this.upperActions[k].isRunning());
    this.upperActions.aim.setEffectiveWeight(damp(this.upperActions.aim.getEffectiveWeight(), oneShot ? 0 : crouch ? 0 : 1, 10, dt));
    this.upperActions.aimCrouch.setEffectiveWeight(damp(this.upperActions.aimCrouch.getEffectiveWeight(), oneShot ? 0 : crouch ? 1 : 0, 10, dt));
    this.mixer.update(dt);

    // --- Procedural overrides after animation: spine twist + pitch, hit jerk, fire kick ---
    this.hitJerk = Math.max(0, this.hitJerk - dt * 5);
    this.fireKick = Math.max(0, this.fireKick - dt * 14);
    const b = this.bones;
    const pitch = clamp(bot.pitch, -60 * DEG, 60 * DEG);
    const q = new THREE.Quaternion();
    const per = [b.spine, b.spine1, b.spine2].filter(Boolean);
    for (const bone of per) {
      // Twist around world up mapped into bone space, pitch around body right.
      const parentQ = bone.parent.getWorldQuaternion(new THREE.Quaternion());
      const inv = parentQ.clone().invert();
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(inv);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.bodyYaw + this.twist)).applyQuaternion(inv);
      q.setFromAxisAngle(up, this.twist / per.length);
      bone.quaternion.premultiply(q);
      q.setFromAxisAngle(right, (-pitch - this.fireKick * 0.04 - this.hitJerk * 0.25) / per.length);
      bone.quaternion.premultiply(q);
      bone.updateMatrixWorld(true);
    }

    // --- Weapon: held at the right hand, barrel along the aim direction ---
    if (this.weaponObj && b.rHand) {
      b.rHand.updateMatrixWorld(true);
      const handPos = b.rHand.getWorldPosition(new THREE.Vector3());
      const wq = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, aimYaw, 0, 'YXZ'));
      // Convert to root-local.
      const rootInvQ = root.getWorldQuaternion(new THREE.Quaternion()).invert();
      this.weaponObj.quaternion.copy(rootInvQ).multiply(wq);
      this.weaponObj.position.copy(root.worldToLocal(handPos.clone()));
      // Small kick back on fire.
      const back = new THREE.Vector3(0, 0, 1).applyQuaternion(this.weaponObj.quaternion).multiplyScalar(this.fireKick * 0.04);
      this.weaponObj.position.add(back);
    }
  }

  /** Bone-driven capsule hitboxes in world space. */
  hitboxes(bot) {
    const b = this.bones;
    const P = (bone) => bone.getWorldPosition(new THREE.Vector3());
    if (!b.head) return [];
    const head = P(b.head), neck = P(b.neck), sp2 = P(b.spine2), hips = P(b.hips);
    const out = [
      { part: 'head', a: neck.clone().lerp(head, 0.6), b: head.clone().add(new THREE.Vector3(0, 0.12, 0)), r: 0.12, mult: 1.5 },
      { part: 'torso', a: hips.clone().add(new THREE.Vector3(0, 0.1, 0)), b: sp2.clone().lerp(neck, 0.6), r: 0.2, mult: 1 },
    ];
    const limb = (x, y, r, part = 'legs') => { if (b[x] && b[y]) out.push({ part, a: P(b[x]), b: P(b[y]), r, mult: 0.85 }); };
    limb('lUp', 'lLeg', 0.1); limb('lLeg', 'lFoot', 0.075); limb('rUp', 'rLeg', 0.1); limb('rLeg', 'rFoot', 0.075);
    limb('lArm', 'lFore', 0.065, 'arms'); limb('lFore', 'lHand', 0.055, 'arms'); limb('rArm', 'rFore', 0.065, 'arms'); limb('rFore', 'rHand', 0.055, 'arms');
    return out;
  }
}
