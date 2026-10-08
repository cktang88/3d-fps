import * as THREE from 'three';
import { Weapon } from '../weapons/Weapon.js';
import { applySpread } from '../Ballistics.js';
import { G } from '../../core/Physics.js';
import { clamp, damp, DEG, rand, randSign } from '../../core/MathUtil.js';

// Difficulty table (spec §6).
export const DIFFICULTY = {
  recruit: { reaction: [0.7, 0.15], e0: 6, eMin: 1.5, tau: 1.5, head: 0.05, recoilCtl: 0.3, turn: 180, jump: 0, label: 'Recruit' },
  regular: { reaction: [0.45, 0.1], e0: 4, eMin: 0.8, tau: 1.0, head: 0.15, recoilCtl: 0.55, turn: 300, jump: 0.05, label: 'Regular' },
  hardened: { reaction: [0.3, 0.08], e0: 3, eMin: 0.4, tau: 0.7, head: 0.3, recoilCtl: 0.75, turn: 450, jump: 0.08, label: 'Hardened' },
  veteran: { reaction: [0.22, 0.05], e0: 2, eMin: 0.25, tau: 0.5, head: 0.45, recoilCtl: 0.9, turn: 600, jump: 0.1, label: 'Veteran' },
};

const BOT_NAMES = ['Viper', 'Ghost', 'Reaper', 'Havoc', 'Nomad', 'Raven', 'Saber', 'Hunter', 'Wolf', 'Kodiak', 'Spectre', 'Bishop', 'Rook', 'Talon', 'Dagger', 'Echo', 'Frost', 'Gunner', 'Jester', 'Mako', 'Onyx', 'Phantom', 'Razor', 'Tank'];
let nameIdx = Math.floor(Math.random() * BOT_NAMES.length);

const LOADOUTS = [
  { w: 'm4', att: { optic: 'reddot', underbarrel: 'vgrip', muzzle: 'flashhider' } },
  { w: 'ak', att: { optic: 'holo', muzzle: 'brake' } },
  { w: 'mp5', att: { optic: 'reddot' } },
  { w: 'vss', att: { optic: 'reddot' } },
  { w: 'scar', att: { optic: 'acog' } },
  { w: 'rpk', att: { optic: 'holo' } },
  { w: 'm870', att: {} },
  { w: 'm24', att: { optic: 'acog' } },
  { w: 'm4', att: { optic: 'holo', muzzle: 'suppressor' } },
];

const CORPSE = { alive: false, position: new THREE.Vector3() };
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _f = new THREE.Vector3(), _e = new THREE.Vector3();

/**
 * Bot = perception + memory + utility-scored goal selection + small action FSM + aim model.
 * Movement is driven through a recast Crowd agent (path following + local avoidance) so bots
 * stay on the navmesh; the bot sets move targets or direct velocities (for strafing).
 */
export class Bot {
  constructor(game, team, difficulty = 'regular') {
    this.game = game;
    this.team = team;
    this.name = BOT_NAMES[nameIdx++ % BOT_NAMES.length];
    this.diffKey = difficulty;
    this.diff = DIFFICULTY[difficulty];
    this.ping = 20 + ((Math.random() * 60) | 0);
    this.maxHealth = 100;
    this.health = 100;
    this.alive = false;
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.aimYaw = 0; this.aimPitch = 0;
    this.crouch = 0;
    this.stats = { kills: 0, deaths: 0, assists: 0, score: 0 };
    this.memory = new Map(); // actor -> record
    this.target = null;
    this.goal = 'patrol';
    this.goalTimer = 0;
    this.thinkTimer = Math.random() * 0.5;
    this.perceiveTimer = Math.random() * 0.1;
    this.strafeTimer = 0;
    this.strafeDir = 1;
    this.aimErr = new THREE.Vector3();
    this.aimErrT = new THREE.Vector3();
    this.aimErrTimer = 0;
    this.trackTime = 0;
    this.burstCount = 0;
    this.burstPause = 0;
    this.suppression = 0;
    this.lastHitTime = -9;
    this.lastFiredTime = undefined;
    this.moveTarget = null;
    this.coverPos = null;
    this.peekTimer = 0;
    this.repathTimer = 0;
    this.stuckTimer = 0;
    this.lastPos = new THREE.Vector3();
    this.grenades = 1;
    this.jumpY = 0; this.jumpV = 0;
    this.time = 0;
    this.damageLog = new Map();
    this.pickLoadout();
  }

  pickLoadout() {
    const lo = LOADOUTS[(Math.random() * LOADOUTS.length) | 0];
    this.weapon = new Weapon(lo.w, lo.att, this);
    this.weapon.laserOn = false;
  }

  get center() { return new THREE.Vector3(this.position.x, this.position.y + 1.1 - this.crouch * 0.35 + this.jumpY, this.position.z); }
  get head() { return new THREE.Vector3(this.position.x, this.position.y + 1.62 - this.crouch * 0.5 + this.jumpY, this.position.z); }
  get eye() { return new THREE.Vector3(this.position.x, this.position.y + 1.55 - this.crouch * 0.5 + this.jumpY, this.position.z); }

  getHitboxes() { return this.model ? this.model.hitboxes(this) : []; }

  spawn(pos, yaw) {
    this.position.copy(pos);
    this.yaw = this.aimYaw = yaw;
    this.pitch = this.aimPitch = 0;
    this.health = this.maxHealth;
    this.alive = true;
    this.memory.clear();
    this.target = null;
    this.goal = 'patrol';
    this.moveTarget = null;
    this.coverPos = null;
    this.suppression = 0;
    this.crouch = 0;
    this.grenades = 1;
    this.damageLog.clear();
    if (Math.random() < 0.3) this.pickLoadout();
    this.weapon.refill();
    this.weapon.equip();
    this.spawnProtect = 1.5;
    this.velocity.set(0, 0, 0);
    this.jumpY = 0; this.jumpV = 0;
    this.trackTime = 0;
    if (this.agent) this.agent.teleport(pos);
    // Leave the previous body on the floor: swap to the spare character so the corpse can finish
    // its fall / sink while we respawn elsewhere.
    if (this.model && this.model.deadTime > 0 && this.model.root.visible && this.spareModel) {
      const corpse = this.model;
      this.model = this.spareModel;
      this.spareModel = corpse;
      this.corpse = corpse;
      if (!this.model.root.parent && corpse.root.parent) corpse.root.parent.add(this.model.root);
    }
    this.model?.onSpawn(this);
  }

  // ---------------- Perception ----------------
  perceive(dt) {
    const g = this.game;
    const eye = _e.copy(this.eye);
    const fwd = _w.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    for (const a of g.actors) {
      if (a === this || !a.alive) continue;
      if (g.mode.teams && a.team === this.team) continue;
      const toA = a.center.sub(eye);
      const dist = toA.length();
      if (dist > 90) continue;
      toA.divideScalar(dist);
      const flat = Math.hypot(toA.x, toA.z) > 1e-4 ? _f.set(toA.x, 0, toA.z).normalize() : fwd;
      const cosA = flat.dot(fwd);
      const inFov = cosA > Math.cos(55 * DEG);
      const inPeriph = cosA > Math.cos(80 * DEG) && dist < 45;
      let rec = this.memory.get(a);
      let visible = false;
      if (inFov || inPeriph || dist < 3) {
        visible = g.physics.lineOfSight(eye, a.head) || g.physics.lineOfSight(eye, a.center);
      }
      if (visible) {
        if (!rec) { rec = this._newRec(a.position); this.memory.set(a, rec); }
        if (!rec.visible) rec.vel.set(0, 0, 0), rec.lastPos.copy(a.position);
        let factor = inFov ? 1 : 0.5;
        if (a.crouching) factor *= 0.75;
        factor *= clamp(1.4 - dist / 80, 0.35, 1.4);
        if (a.lastFiredTime !== undefined && g.time - a.lastFiredTime < 0.3) factor *= 2;
        rec.seen += factor * dt;
        // Each fresh sighting rolls its own human-like reaction time (difficulty table).
        if (!rec.spotted && rec.react === undefined) rec.react = this._rollReaction();
        if (rec.seen > rec.react || dist < 3) {
          if (!rec.spotted) { rec.spotted = true; rec.spottedAt = g.time; }
        }
        rec.vel.subVectors(a.position, rec.lastPos).divideScalar(Math.max(dt, 0.05));
        if (rec.vel.length() > 12) rec.vel.set(0, 0, 0);
        rec.lastPos.copy(a.position);
        rec.lastTime = g.time;
        rec.visible = true;
      } else if (rec) {
        rec.visible = false;
        rec.seen = Math.max(0, rec.seen - dt * 0.5);
        // Out of sight for a while: re-acquiring needs a (shorter) reaction again. Pre-aiming a known
        // angle still helps — seen time only partially decays.
        if (rec.spotted && g.time - rec.lastTime > 1.2) { rec.spotted = false; rec.react = this._rollReaction() * 0.6; rec.seen = Math.min(rec.seen, rec.react * 0.4); }
      }
      // Hearing: player footsteps.
      if (a.noise && dist < a.noise) this.hear(a, a.position);
    }
    // Forget stale.
    for (const [a, rec] of this.memory) {
      if (!a.alive || g.time - rec.lastTime > 8) this.memory.delete(a);
    }
  }

  _rollReaction() {
    const [m, s] = this.diff.reaction;
    // Roughly normal (sum of uniforms), clamped to stay human.
    const n = (Math.random() + Math.random() + Math.random() - 1.5) * 1.4;
    return clamp(m + n * s, m * 0.6, m * 1.8);
  }

  _newRec(pos) {
    return { seen: 0, lastPos: pos.clone(), lastTime: this.game.time, vel: new THREE.Vector3(), visible: false, spotted: false, react: undefined };
  }

  hear(actor, pos) {
    if (!this.alive || actor === this || (this.game.mode.teams && actor.team === this.team)) return;
    let rec = this.memory.get(actor);
    if (!rec) { rec = this._newRec(pos); rec.heard = true; this.memory.set(actor, rec); }
    if (!rec.visible) { rec.lastPos.copy(pos); rec.lastTime = this.game.time; rec.heard = true; }
  }

  onDamaged(amount, attacker) {
    this.lastHitTime = this.game.time;
    this.suppression = Math.min(1, this.suppression + 0.4);
    if (attacker && attacker !== this && attacker.alive) {
      const rec = this.memory.get(attacker) || this._newRec(attacker.position);
      rec.lastPos.copy(attacker.position);
      rec.lastTime = this.game.time;
      // Being hit reveals the attacker's direction: the bot turns to look, and needs only part of a
      // reaction to engage once they're actually in view.
      if (rec.react === undefined) rec.react = this._rollReaction();
      rec.seen = Math.max(rec.seen, rec.react * 0.6);
      this.memory.set(attacker, rec);
      if (!this.target || !this.memory.get(this.target)?.visible) this.target = attacker;
    }
    this.thinkTimer = Math.min(this.thinkTimer, 0.1);
    this.aimErrTimer = 0; // flinch: re-roll aim error now (with the hit penalty)
  }

  onSuppressed(by, amt) {
    this.suppression = Math.min(1, this.suppression + amt * 0.25);
    if (by) this.hear(by, by.position);
  }

  // ---------------- Decision making ----------------
  selectTarget() {
    let best = null, bestScore = -Infinity;
    for (const [a, rec] of this.memory) {
      if (!a.alive) continue;
      const d = a.position.distanceTo(this.position);
      let s = -d * 0.05;
      if (rec.visible && rec.spotted) s += 10;
      if (this.lastAttacker === a) s += 2;
      s -= (this.game.time - rec.lastTime) * 0.5;
      if (a.health < 50) s += 1;
      if (s > bestScore) { bestScore = s; best = a; }
    }
    this.target = best;
  }

  think() {
    this.selectTarget();
    const w = this.weapon;
    const rec = this.target ? this.memory.get(this.target) : null;
    const visible = rec?.visible && rec.spotted;
    const hp = this.health / this.maxHealth;
    const scores = {
      patrol: 0.2,
      engage: visible ? 0.9 : 0,
      investigate: rec && !visible ? 0.6 : 0,
      cover: (visible || this.suppression > 0.5) && (hp < 0.5 || (w.state === 'reload' && visible)) ? 0.95 : 0,
      reload: !visible && w.ammo < w.stats.mag * 0.4 && w.reserve > 0 ? 0.7 : 0,
      grenade: rec && !visible && this.grenades > 0 && this.game.time - rec.lastTime < 3 && rec.lastPos.distanceTo(this.position) < 28 && rec.lastPos.distanceTo(this.position) > 8 ? 0.65 : 0,
    };
    if (this.diffKey === 'recruit') scores.cover *= 0.5;
    // Hysteresis.
    if (scores[this.goal] !== undefined) scores[this.goal] += 0.1;
    let best = 'patrol', bs = -1;
    for (const k in scores) if (scores[k] > bs) { bs = scores[k]; best = k; }
    if (best !== this.goal) this.setGoal(best);
  }

  setGoal(goal) {
    this.goal = goal;
    this.goalTimer = 0;
    if (goal === 'cover') this.coverPos = this.findCover();
    if (goal === 'patrol') this.moveTarget = null;
    if (goal === 'grenade') this.throwGrenade();
  }

  findCover() {
    const g = this.game, threat = this.target ? this.memory.get(this.target)?.lastPos : null;
    if (!threat || !g.nav) return null;
    const threatEye = threat.clone().setY(threat.y + 1.5);
    let best = null, bestS = -Infinity;
    for (let i = 0; i < 14; i++) {
      const p = g.nav.randomPointAround(this.position, 12);
      if (!p) continue;
      const chest = p.clone().setY(p.y + 1.0);
      if (g.physics.lineOfSight(threatEye, chest)) continue; // exposed
      const d = p.distanceTo(this.position);
      const dt = p.distanceTo(threat);
      let s = -d * 0.4 - Math.abs(dt - 18) * 0.15;
      // Prefer spots where standing up gives a peek (head visible) – good for peek & shoot.
      if (g.physics.lineOfSight(threatEye, p.clone().setY(p.y + 1.6))) s += 3;
      if (s > bestS) { bestS = s; best = p; }
    }
    return best;
  }

  throwGrenade() {
    const rec = this.target && this.memory.get(this.target);
    if (!rec || this.grenades <= 0) return;
    this.grenades--;
    const from = this.eye;
    const to = rec.lastPos.clone();
    this.model?.onThrow?.(this);
    this.game.throwGrenade(this, from, to);
  }

  // ---------------- Update ----------------
  update(dt) {
    this.time += dt;
    if (this.corpse) { this.corpse.update(dt, CORPSE); if (!this.corpse.root.visible) this.corpse = null; }
    if (!this.spareModel && this.model) {
      // Second body for corpse hand-off (built once, off the hot path of the first death).
      this.spareModel = this.model.tpl.instance(this.team);
      this.spareModel.root.visible = false;
      this.model.root.parent?.add(this.spareModel.root);
      this.spareModel.root.traverse((o) => { if (o.isMesh) for (const m of Array.isArray(o.material) ? o.material : [o.material]) this.game.materials?.applyIndoor?.(m); });
    }
    if (!this.alive) { this.model?.update(dt, this); return; }
    if (this.spawnProtect > 0) this.spawnProtect -= dt;
    this.suppression = Math.max(0, this.suppression - dt * 0.4);

    this.perceiveTimer -= dt;
    if (this.perceiveTimer <= 0) { this.perceive(0.1 - this.perceiveTimer); this.perceiveTimer = 0.1; }
    this.thinkTimer -= dt;
    if (this.thinkTimer <= 0) { this.think(); this.thinkTimer = 0.4 + Math.random() * 0.2; }
    this.goalTimer += dt;

    const g = this.game;
    const rec = this.target ? this.memory.get(this.target) : null;
    const visible = !!(rec?.visible && rec.spotted && this.target.alive);
    let wantFire = false, wantAim = false, crouchT = 0;
    let lookAt = null;

    // ---- Movement intent per goal ----
    let desiredVel = null; // direct velocity (strafe) when set
    const runSpeed = 4.4 * this.weapon.stats.mobility;
    switch (this.goal) {
      case 'patrol': {
        if (!this.moveTarget || this.position.distanceTo(this.moveTarget) < 2 || this.goalTimer > 25) {
          this.moveTarget = g.nav?.randomPatrolPoint(this) ?? null;
          this.goalTimer = 0;
        }
        break;
      }
      case 'investigate': {
        if (rec) {
          const predicted = rec.lastPos.clone().addScaledVector(rec.vel, Math.min(1.5, g.time - rec.lastTime));
          this.moveTarget = predicted;
          lookAt = rec.lastPos.clone().setY(rec.lastPos.y + 1.4);
          if (this.position.distanceTo(rec.lastPos) < 2.5) this.memory.delete(this.target);
        }
        break;
      }
      case 'engage': {
        if (!rec) break;
        const dist = this.target.position.distanceTo(this.position);
        lookAt = null;
        wantAim = dist > 12 || this.weapon.stats.cls === 'Sniper Rifle';
        // Close distance with short-range weapons, back off with long-range ones.
        const ideal = this.weapon.stats.range[0] * 0.8;
        // Strafe like a person: commit to a direction for ~0.7–1.8 s, sometimes plant and shoot, and
        // brake (plant the outside foot) for a beat before reversing.
        this.strafeTimer -= dt;
        if (this.strafeTimer <= 0) {
          const hold = Math.random() < 0.25;
          this.strafeHold = hold;
          this.strafeTimer = hold ? rand(0.4, 1.0) : rand(0.7, 1.8);
          const flip = !hold && Math.random() < 0.6;
          if (flip) { this.strafeDir = -this.strafeDir; this.brakeTimer = 0.14; }
          this.crouchPeek = Math.random() < 0.3 && this.diffKey !== 'recruit';
          if (Math.random() < this.diff.jump && this.jumpY === 0 && !hold) this.jumpV = 5.5;
        }
        if (this.brakeTimer > 0) this.brakeTimer -= dt;
        const toT = _v.subVectors(this.target.position, this.position).setY(0).normalize();
        const side = new THREE.Vector3(-toT.z, 0, toT.x).multiplyScalar(this.strafeDir);
        const approach = dist > ideal * 1.4 ? 0.7 : dist < ideal * 0.5 ? -0.5 : 0;
        const lateral = this.strafeHold || this.brakeTimer > 0 ? 0 : wantAim ? 1.8 : 3.0;
        desiredVel = side.multiplyScalar(lateral).addScaledVector(toT, approach * runSpeed * (this.brakeTimer > 0 ? 0.3 : 1));
        if (this.crouchPeek && wantAim) { desiredVel.multiplyScalar(0.3); crouchT = 1; }
        break;
      }
      case 'cover': {
        if (this.coverPos) {
          this.moveTarget = this.coverPos;
          if (this.position.distanceTo(this.coverPos) < 1.2) {
            crouchT = 1;
            desiredVel = new THREE.Vector3();
            const w = this.weapon;
            if (w.ammo < w.stats.mag && w.state === 'idle') w.reload();
            // Peek after reloading / healing a bit.
            this.peekTimer += dt;
            if (this.peekTimer > 2.5 && w.state !== 'reload') { crouchT = 0; if (this.peekTimer > 4) { this.peekTimer = 0; this.setGoal('engage'); } }
          }
        } else this.setGoal(visible ? 'engage' : 'patrol');
        if (this.goalTimer > 8) this.setGoal('patrol');
        break;
      }
      case 'reload': {
        if (this.weapon.state === 'idle') this.weapon.reload();
        if (this.weapon.state !== 'reload' && this.goalTimer > 0.5) this.setGoal('patrol');
        break;
      }
      case 'grenade': {
        if (this.goalTimer > 0.6) this.setGoal('investigate');
        break;
      }
    }

    // ---- Aim ----
    if (visible) {
      this.trackTime += dt;
      const tgtPt = this._aimPoint(rec);
      lookAt = tgtPt;
      // Aim error tightens exponentially while tracking.
      this.aimErrTimer -= dt;
      if (this.aimErrTimer <= 0) {
        this.aimErrTimer = 0.3;
        let e = this.diff.e0 * Math.exp(-this.trackTime / this.diff.tau) + this.diff.eMin;
        const tSpeed = Math.hypot(this.target.velocity?.x ?? 0, this.target.velocity?.z ?? 0);
        if (tSpeed > 3) e *= 1.5;
        if (desiredVel && desiredVel.lengthSq() > 1) e *= 1.4;
        if (g.time - this.lastHitTime < 0.4) e *= 1.3;
        e *= 1 + this.suppression;
        const dist = tgtPt.distanceTo(this.eye);
        const r = Math.tan(e * DEG) * dist;
        // Early in a track the error sits on a ring (shots go wide, not randomly through centre mass);
        // it fills in as the bot settles. Vertical error is smaller (humans track height well).
        const settle = Math.exp(-this.trackTime / this.diff.tau);
        const mag = r * (settle * 0.6 + (1 - settle * 0.6) * Math.sqrt(Math.random()));
        this.aimErrT.set(rand(-1, 1), rand(-0.55, 0.55), rand(-1, 1)).normalize().multiplyScalar(mag);
      }
      // Error drifts smoothly toward its new target (no snapping between offsets).
      this.aimErr.lerp(this.aimErrT, 1 - Math.exp(-dt * 7));
      lookAt = tgtPt.add(this.aimErr);
      // Fire when aim is close enough.
      const dir = lookAt.clone().sub(this.eye).normalize();
      const fy = Math.atan2(-dir.x, -dir.z), fp = Math.asin(clamp(dir.y, -1, 1));
      const yawErr = Math.abs(((fy - this.aimYaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      const pitchErr = Math.abs(fp - this.aimPitch);
      const dist = this.target.position.distanceTo(this.position);
      const tol = Math.max(2.5 * DEG, Math.atan(0.6 / dist));
      if (yawErr < tol && pitchErr < tol && this.trackTime > 0.05) {
        // Burst discipline at range.
        if (dist > 30 && this.weapon.mode === 'auto') {
          if (this.burstPause > 0) this.burstPause -= dt;
          else {
            wantFire = true;
            if (this.weapon.lastShotTime === this.weapon.time) this.burstCount++;
            if (this.burstCount > 3 + ((Math.random() * 4) | 0)) { this.burstCount = 0; this.burstPause = 0.25 + Math.random() * 0.25; }
          }
        } else wantFire = true;
      }
    } else {
      this.trackTime = 0;
      this.aimErrTimer = 0;
    }
    if (!lookAt) {
      // Look along movement direction or toward last-known threat.
      const v = this.agent ? this.agent.velocity() : { x: 0, z: 0 };
      if (Math.hypot(v.x, v.z) > 0.5) lookAt = this.eye.add(new THREE.Vector3(v.x, 0, v.z).normalize().multiplyScalar(5));
    }
    if (lookAt) {
      const dir = lookAt.clone().sub(this.eye);
      const ty = Math.atan2(-dir.x, -dir.z);
      const tp = Math.atan2(dir.y, Math.hypot(dir.x, dir.z));
      const maxTurn = this.diff.turn * DEG * dt;
      let dy = ((ty - this.aimYaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      // Smooth spring-like approach capped by turn rate.
      const step = clamp(dy * Math.min(1, dt * 12), -maxTurn, maxTurn);
      this.aimYaw += step;
      this.aimPitch += clamp((tp - this.aimPitch) * Math.min(1, dt * 12), -maxTurn, maxTurn);
    }
    this.yaw = this.aimYaw;
    this.pitch = this.aimPitch;

    // ---- Weapon ----
    const w = this.weapon;
    const winput = {
      fire: wantFire, firePressed: wantFire && (w.mode !== 'auto' ? (this.time - (this._lastPress ?? 0) > 60 / w.stats.rpm + 0.08 + Math.random() * 0.12) : true),
      aim: wantAim, sprinting: false, reloadPressed: false, canFire: this.spawnProtect <= 0 || true,
    };
    if (winput.firePressed) this._lastPress = this.time;
    if (w.ammo === 0 && w.state === 'idle') w.reload();
    if (!visible && w.ammo < w.stats.mag * 0.25 && w.state === 'idle') w.reload();
    const shots = w.update(dt, winput);
    for (const s of shots) this._shoot(s);

    // ---- Move ----
    this.crouch = damp(this.crouch, crouchT, 8, dt);
    if (this.agent) {
      let maxSpeed = this.goal === 'engage' ? 3.2 : this.goal === 'cover' ? 5.2 : runSpeed;
      if (this.crouch > 0.5) maxSpeed = Math.min(maxSpeed, 1.5); // crouch-walk pace
      if (Math.abs(this.agent.maxSpeed - maxSpeed) > 0.1) this.agent.updateParameters({ maxSpeed });
      if (desiredVel) {
        this.agent.requestMoveVelocity({ x: desiredVel.x, y: 0, z: desiredVel.z });
        this._velMode = true;
      } else if (this.moveTarget) {
        this.repathTimer -= dt;
        if (this._velMode || this.repathTimer <= 0 || !this._lastTarget || this._lastTarget.distanceTo(this.moveTarget) > 1) {
          const t = g.nav.closest(this.moveTarget);
          if (t) this.agent.requestMoveTarget(t);
          this._lastTarget = this.moveTarget.clone();
          this.repathTimer = 1.5;
          this._velMode = false;
        }
      } else if (!this._velMode) {
        this.agent.requestMoveVelocity({ x: 0, y: 0, z: 0 });
        this._velMode = true;
      }
      const p = this.agent.position();
      this.position.set(p.x, p.y, p.z);
      // Animation follows the agent's own (smoothed) velocity — position deltas are noisy under avoidance.
      const av = this.agent.velocity();
      const k = 1 - Math.exp(-12 * dt);
      this.velocity.x += (av.x - this.velocity.x) * k;
      this.velocity.y = 0;
      this.velocity.z += (av.z - this.velocity.z) * k;
      // Stuck detection for patrol.
      if (this.goal === 'patrol' && this.moveTarget) {
        if (this.position.distanceTo(this.lastPos) < 0.05) { this.stuckTimer += dt; if (this.stuckTimer > 2) { this.moveTarget = null; this.stuckTimer = 0; } }
        else this.stuckTimer = 0;
        this.lastPos.copy(this.position);
      }
    }
    // Simple jump arc (visual + hitbox).
    if (this.jumpV !== 0 || this.jumpY > 0) {
      this.jumpV -= 20 * dt;
      this.jumpY += this.jumpV * dt;
      if (this.jumpY <= 0) { this.jumpY = 0; this.jumpV = 0; }
    }
    // Footsteps (audible to player).
    const sp = Math.hypot(this.velocity.x, this.velocity.z);
    if (sp > 0.6 && this.jumpY === 0) {
      this._step = (this._step || 0) + sp * dt;
      if (this._step > 1.7) {
        this._step = 0;
        const d = this.position.distanceTo(g.player.position);
        if (d < 30) g.audio.footstep(this.position.clone().setY(this.position.y + 0.1), g.level.surfaceAt?.(this.position) ?? 'concrete', sp > 4 ? 0.9 : 0.5);
      }
    }
    this.model?.update(dt, this);
  }

  _aimPoint(rec) {
    const t = this.target;
    // Pick head or chest per shot window.
    if (this._aimPart === undefined || Math.random() < 0.02) this._aimPart = Math.random() < this.diff.head ? 'head' : 'chest';
    const p = this._aimPart === 'head' ? t.head : t.center;
    // Lead moving target a bit (veterans better).
    const lead = this.diffKey === 'veteran' ? 0.06 : this.diffKey === 'hardened' ? 0.04 : 0.02;
    if (t.velocity) p.addScaledVector(t.velocity, lead);
    return p;
  }

  _shoot(shot) {
    const g = this.game;
    const w = this.weapon;
    this.lastFiredTime = g.time;
    const eye = this.eye;
    const muzzle = this.model?.muzzleWorld(this) ?? eye;
    const aimDir = new THREE.Vector3(
      -Math.sin(this.aimYaw) * Math.cos(this.aimPitch), Math.sin(this.aimPitch), -Math.cos(this.aimYaw) * Math.cos(this.aimPitch));
    // Recoil the bot fails to control drifts aim upward.
    this.aimPitch += shot.pitch * (1 - this.diff.recoilCtl);
    this.aimYaw += shot.yaw * (1 - this.diff.recoilCtl);
    const spread = w.currentSpread(Math.hypot(this.velocity.x, this.velocity.z) / 4.6, this.jumpY > 0, this.crouch > 0.5);
    const pellets = shot.pellets;
    for (let i = 0; i < pellets; i++) {
      const d = applySpread(aimDir, pellets > 1 ? w.stats.pelletSpread * (1 - w.adsT * 0.3) : spread * 0.7);
      g.ballistics.fire(this, eye, d, w.stats, { tracer: i === 0 && Math.random() < 0.5, pellet: pellets > 1, tracerFrom: muzzle });
    }
    g.effects.muzzleFlash(muzzle, aimDir, w.stats.pellets > 1 ? 1.4 : 1, w.stats.suppressed);
    g.audio.gunshot(w.stats.sound, muzzle);
    g.alertBots(this, w.stats.suppressed ? 15 : 70);
    this.model?.onFire(this);
  }

  takeDamage(amount, attacker, info = {}) {
    if (!this.alive) return 0;
    if (this.spawnProtect > 0) return 0;
    this.health -= amount;
    if (attacker) this.damageLog.set(attacker, (this.damageLog.get(attacker) || 0) + amount);
    this.lastAttacker = attacker;
    this.onDamaged(amount, attacker);
    this.model?.onHit(this, info);
    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
      if (this.agent) this.agent.requestMoveVelocity({ x: 0, y: 0, z: 0 });
      this.game.onActorKilled(this, attacker, info);
    }
    return amount;
  }

  get crouching() { return this.crouch > 0.5; }
}
