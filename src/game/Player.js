import * as THREE from 'three';
import { G, groups } from '../core/Physics.js';
import { clamp, damp, DEG, Spring, smoothstep, easeOutCubic } from '../core/MathUtil.js';

// Movement tuning (see docs/DESIGN.md). Units: metres, seconds.
export const MOVE = {
  walk: 4.6,
  slowWalk: 2.3,
  sprint: 6.8,
  tacSprint: 8.2,
  tacSprintDuration: 4,
  tacSprintRecharge: 6,
  crouch: 2.0,
  groundAccel: 10,
  groundFriction: 6,
  stopSpeed: 2.5,
  airAccel: 1.5,
  airWishCap: 0.9,
  gravity: 20,
  jumpHeight: 1.05,
  slideBoost: 8.5,
  slideFriction: 1.2,
  slideMinSpeed: 3,
  slideCooldown: 1.2,
  radius: 0.35,
  standHeight: 1.8,
  crouchHeight: 1.2,
  slideHeight: 1.0,
  eyeStand: 1.65,
  eyeCrouch: 1.1,
  eyeSlide: 0.9,
  stepHeight: 0.45,
  vaultMax: 1.28, // obstacles up to this height can be vaulted (if there's a drop behind)
  leanAngle: 12 * DEG,
  leanOffset: 0.35,
};

const UP = new THREE.Vector3(0, 1, 0), DOWN = new THREE.Vector3(0, -1, 0);
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _fwd = new THREE.Vector3(), _right = new THREE.Vector3();
const _uf = new THREE.Vector3(), _ur = new THREE.Vector3(), _wish = new THREE.Vector3(), _vh = new THREE.Vector3(), _eye = new THREE.Vector3(), _ld = new THREE.Vector3(), _sl = new THREE.Vector3(), _sa = new THREE.Vector3(), _GRAV = new THREE.Vector3(0, -MOVE.gravity, 0);

export class Player {
  constructor(game) {
    this.game = game;
    const phys = game.physics;
    this.phys = phys;
    this.R = phys.R;
    this.team = 0;
    this.name = 'You';
    this.isPlayer = true;
    this.maxHealth = 100;
    this.health = 100;
    this.alive = true;
    this.lastDamageTime = -99;
    this.spawnProtect = 0;

    this.position = new THREE.Vector3(); // feet
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.height = MOVE.standHeight;
    this.eyeHeight = new Spring(220, 1, MOVE.eyeStand);
    this.grounded = false;
    this.wasGrounded = false;
    this.airTime = 0;
    this.lastGroundedTime = 0;
    this.crouching = false;
    this.sliding = false;
    this.slideTimer = 0;
    this.slideCooldown = 0;
    this.sprinting = false;
    this.tacSprint = false;
    this.tacSprintTime = MOVE.tacSprintDuration;
    this.lastSprintTap = -1;
    this.jumpChain = 0;
    this.lastJumpTime = -99;
    this.lean = 0; // -1..1
    this.leanSmoothed = 0;
    this.mantle = null; // active mantle/vault motion
    this.stepDist = 0;
    this.stepOffset = 0; // visual eye offset that smooths step-ups (m, <= 0)
    this.fallSpeed = 0;
    this.moveIntent = new THREE.Vector2();
    this.noise = 0; // how loud the player is for AI hearing (m radius)
    this.time = 0;

    const R = this.R;
    const hh = (MOVE.standHeight - 2 * MOVE.radius) / 2;
    // Parentless collider moved directly by the KCC (no rigid body => no step latency).
    this.collider = phys.world.createCollider(
      R.ColliderDesc.capsule(hh, MOVE.radius).setTranslation(0, 5, 0).setCollisionGroups(groups(G.PLAYER, G.WORLD)));
    phys.tag(this.collider, { actor: this });
    this.kcc = phys.world.createCharacterController(0.02);
    this.kcc.setUp({ x: 0, y: 1, z: 0 });
    this.kcc.setMaxSlopeClimbAngle(50 * DEG);
    this.kcc.setMinSlopeSlideAngle(55 * DEG);
    this.kcc.enableAutostep(MOVE.stepHeight, 0.15, false);
    this.kcc.enableSnapToGround(0.35);
    this.kcc.setApplyImpulsesToDynamicBodies(true);
    this.kcc.setCharacterMass(80);
    this.standShape = new R.Capsule(hh, MOVE.radius);

    this.events = { onLand: null, onStep: null, onJump: null, onMantle: null, onSlide: null };
  }

  get eyePosition() {
    return _v.copy(this.position).setY(this.position.y + this.eyeHeight.x);
  }

  spawn(pos, yaw) {
    this.position.copy(pos);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw; this.pitch = 0;
    this.health = this.maxHealth;
    this.alive = true;
    this.crouching = this.sliding = false;
    this.mantle = null;
    this.stepOffset = 0; this.lean = 0; this.tacSprint = false; this.sprinting = false; this.slideCooldown = 0;
    this.setHeight(MOVE.standHeight);
    this.eyeHeight.x = this.eyeHeight.target = MOVE.eyeStand;
    this.spawnProtect = 1.5;
    this.tacSprintTime = MOVE.tacSprintDuration;
    this._syncBody();
  }

  setHeight(h) {
    if (!Number.isFinite(h)) {
      if (!this._nanHReported) { this._nanHReported = true; console.error('Player height non-finite; ignored', new Error().stack); }
      return;
    }
    if (Math.abs(h - this.height) < 1e-3) return;
    this.height = h;
    this.collider.setHalfHeight(Math.max(0.05, (h - 2 * MOVE.radius) / 2));
    this._syncBody();
  }

  _syncBody() {
    const p = this.position, v = this.velocity;
    // A non-finite translation makes Rapier's broad phase spin forever (seen as a hard page hang).
    // Recover to the last good position and report the source once.
    // Also catch absurd-but-finite values (e.g. 1e30) that blow up the broad phase the same way.
    if (!(Math.abs(p.x) < 1e4 && Math.abs(p.y) < 1e4 && Math.abs(p.z) < 1e4)) {
      if (!this._nanReported) { this._nanReported = true; console.error('Player position non-finite; restored', new Error().stack); }
      if (this._goodPos) p.copy(this._goodPos); else p.set(0, 0, 0);
      v.set(0, 0, 0);
    } else (this._goodPos ||= p.clone()).copy(p);
    if (!(Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z))) v.set(0, 0, 0);
    if (!Number.isFinite(this.height)) this.height = MOVE.standHeight;
    this.collider.setTranslation({ x: p.x, y: p.y + this.height / 2, z: p.z });
  }

  canStand() {
    const hh = (MOVE.standHeight - 2 * MOVE.radius) / 2;
    const c = { x: this.position.x, y: this.position.y + MOVE.standHeight / 2 + 0.02, z: this.position.z };
    let blocked = false;
    this.phys.world.intersectionsWithShape(c, { x: 0, y: 0, z: 0, w: 1 }, this.standShape, () => { blocked = true; return false; },
      undefined, groups(0xffff, G.WORLD), this.collider);
    return !blocked;
  }

  forward(out = _fwd) { return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)); }
  right(out = _right) { return out.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw)); }

  look(dx, dy, sens) {
    // Source-style: degrees per count = sens * 0.022.
    this.yaw -= dx * sens * 0.022 * DEG;
    this.pitch -= dy * sens * 0.022 * DEG;
    this.pitch = clamp(this.pitch, -89 * DEG, 89 * DEG);
  }

  /** Main movement tick. `cmd` comes from input (or a replay/bot). */
  update(dt, cmd, weapon) {
    this.time += dt;
    if (!this.alive) return;
    if (this.spawnProtect > 0) this.spawnProtect -= dt;
    this.slideCooldown = Math.max(0, this.slideCooldown - dt);

    if (this.mantle) { this._updateMantle(dt); return; }

    const fwd = this.forward(_uf), right = this.right(_ur);
    const wish = _wish.set(0, 0, 0)
      .addScaledVector(fwd, cmd.moveY)
      .addScaledVector(right, cmd.moveX);
    if (wish.lengthSq() > 1) wish.normalize();
    this.moveIntent.set(cmd.moveX, cmd.moveY);

    // --- Sprint / tactical sprint (double tap) ---
    const movingForward = cmd.moveY > 0.5;
    if (cmd.sprintPressed) {
      if (this.time - this.lastSprintTap < 0.3 && this.tacSprintTime > 0.5) this.tacSprint = true;
      this.lastSprintTap = this.time;
    }
    const wantSprint = cmd.sprint && movingForward && !cmd.aim && !this.crouching && !weapon?.blocksSprint();
    if (!wantSprint) this.tacSprint = false;
    this.sprinting = wantSprint && (this.grounded || this.sprinting);
    if (this.tacSprint && this.sprinting) {
      this.tacSprintTime -= dt;
      if (this.tacSprintTime <= 0) this.tacSprint = false;
    } else {
      this.tacSprintTime = Math.min(MOVE.tacSprintDuration, this.tacSprintTime + dt * (MOVE.tacSprintDuration / MOVE.tacSprintRecharge));
    }

    // --- Crouch / slide ---
    const horizSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    // Slide: crouch while sprinting (tolerant of a 1-frame ground flicker / sprint-state lag).
    const slideReady = (this.sprinting || (cmd.sprint && movingForward && !this.crouching))
      && (this.grounded || this.time - this.lastGroundedTime < 0.12)
      && horizSpeed > MOVE.sprint * 0.75 * (weapon?.mobility() ?? 1) && this.slideCooldown <= 0;
    if (cmd.crouchPressed && slideReady) {
      this._startSlide(fwd);
    } else if (cmd.crouchPressed && !this.sliding) {
      if (this.crouching) { if (this.canStand()) this.crouching = false; }
      else this.crouching = true;
    }
    if (cmd.crouchHeld === false && this.game.settings.holdCrouch && this.crouching && !this.sliding && this.canStand()) {
      this.crouching = false;
    }
    if (cmd.sprint && this.crouching && movingForward && !this.sliding && this.canStand()) this.crouching = false;

    // --- Jump / vault / mantle ---
    const coyote = this.time - this.lastGroundedTime < 0.15;
    if (cmd.jumpPressed) {
      if (this.tryMantle(true)) return;
      if (this.sliding) {
        this._endSlide();
        this._jump(1.0);
      } else if (this.grounded || coyote) {
        if (this.crouching) { if (this.canStand()) this.crouching = false; }
        else this._jump();
      }
    } else if (!this.grounded && cmd.jumpHeld && movingForward && this.velocity.y < 2) {
      // Auto-mantle while airborne and holding jump toward a ledge (Apex / Titanfall feel).
      if (this.tryMantle(false)) return;
    }

    // --- Velocity integration (Quake/Source style) ---
    const weaponMob = weapon?.mobility() ?? 1;
    let maxSpeed;
    if (this.sliding) maxSpeed = 0;
    else if (this.crouching) maxSpeed = MOVE.crouch;
    else if (this.sprinting) maxSpeed = this.tacSprint ? MOVE.tacSprint : MOVE.sprint;
    else if (cmd.walk) maxSpeed = MOVE.slowWalk;
    else maxSpeed = MOVE.walk;
    maxSpeed *= weaponMob;
    if (cmd.aim && !this.sprinting) maxSpeed *= weapon?.adsMoveMult() ?? 0.55;
    // Moving backwards/strafing is a bit slower than forward.
    if (cmd.moveY < -0.1) maxSpeed *= 0.85;

    const vh = _vh.set(this.velocity.x, 0, this.velocity.z);
    if (this.grounded) {
      if (this.sliding) {
        this._updateSlide(dt, vh);
      } else {
        this._friction(vh, MOVE.groundFriction, dt);
        this._accelerate(vh, wish, maxSpeed, MOVE.groundAccel, dt);
      }
    } else {
      // Air: limited wish speed but normal accel lets players adjust trajectory slightly.
      const wishSpeed = Math.min(maxSpeed, MOVE.airWishCap);
      this._accelerate(vh, wish, wishSpeed, MOVE.airAccel * 8, dt, maxSpeed);
    }
    this.velocity.x = vh.x; this.velocity.z = vh.z;
    // Gravity in two half-steps around the move (exact parabola => true 1.05 m jump at any frame rate).
    this.velocity.y -= MOVE.gravity * dt * 0.5;

    // --- Height (crouch / slide) ---
    const targetH = this.sliding ? MOVE.slideHeight : this.crouching ? MOVE.crouchHeight : MOVE.standHeight;
    if (targetH !== this.height) this.setHeight(targetH);
    this.eyeHeight.target = this.sliding ? MOVE.eyeSlide : this.crouching ? MOVE.eyeCrouch : MOVE.eyeStand;
    this.eyeHeight.update(dt);

    // --- Lean (Q/E) with wall check ---
    let leanT = (cmd.leanRight ? 1 : 0) - (cmd.leanLeft ? 1 : 0);
    if (this.sprinting || this.sliding) leanT = 0;
    if (leanT !== 0) {
      const eye = _eye.copy(this.position).setY(this.position.y + this.eyeHeight.x);
      const dir = this.right(_ld).multiplyScalar(Math.sign(leanT));
      const hit = this.phys.raycast(eye, dir, MOVE.leanOffset + 0.25, G.WORLD);
      if (hit) leanT *= clamp((hit.distance - 0.25) / MOVE.leanOffset, 0, 1);
    }
    this.lean = damp(this.lean, leanT, 10, dt);

    this.stepOffset = damp(this.stepOffset, 0, 16, dt);
    this._move(dt);
    if (!this.grounded) this.velocity.y -= MOVE.gravity * dt * 0.5;
    this._footsteps(dt);

    // Noise radius for AI hearing.
    const sp = Math.hypot(this.velocity.x, this.velocity.z);
    this.noise = !this.grounded ? 4 : this.sprinting ? 20 : cmd.walk || this.crouching ? 0 : sp > 1 ? 8 : 0;
  }

  _accelerate(vh, wishDir, wishSpeed, accel, dt, capSpeed = wishSpeed) {
    if (wishDir.lengthSq() < 1e-6) return;
    const dir = _w.copy(wishDir).normalize();
    const cur = vh.dot(dir);
    const add = wishSpeed - cur;
    if (add <= 0) return;
    const accelSpeed = Math.min(accel * Math.max(capSpeed, wishSpeed) * dt, add);
    vh.addScaledVector(dir, accelSpeed);
  }

  _friction(vh, friction, dt) {
    const speed = vh.length();
    if (speed < 0.01) { vh.set(0, 0, 0); return; }
    const drop = Math.max(speed, MOVE.stopSpeed) * friction * dt;
    vh.multiplyScalar(Math.max(speed - drop, 0) / speed);
  }

  _jump(mult = 1) {
    // Anti bunny-hop: repeated jumps lose height.
    if (this.time - this.lastJumpTime < 1) this.jumpChain = Math.min(this.jumpChain + 1, 3);
    else this.jumpChain = 0;
    const h = MOVE.jumpHeight * Math.max(0.6, Math.pow(0.85, this.jumpChain)) * mult;
    this.velocity.y = Math.sqrt(2 * MOVE.gravity * h);
    this.grounded = false;
    this.lastJumpTime = this.time;
    this.lastGroundedTime = -99;
    this.events.onJump?.();
  }

  _startSlide(fwd) {
    this.sliding = true;
    this.crouching = true;
    this.slideTimer = 0;
    const vh = new THREE.Vector3(this.velocity.x, 0, this.velocity.z);
    const dir = vh.lengthSq() > 0.1 ? vh.clone().normalize() : fwd.clone();
    const speed = Math.max(vh.length(), MOVE.slideBoost);
    this.velocity.x = dir.x * speed; this.velocity.z = dir.z * speed;
    this.slideDir = dir;
    this.events.onSlide?.();
  }

  _updateSlide(dt, vh) {
    this.slideTimer += dt;
    // Slope gravity: ground normal from a short downward ray.
    const hit = this.phys.raycast(_sl.copy(this.position).setY(this.position.y + 0.3), DOWN, 0.8, G.WORLD);
    if (hit) {
      const n = hit.normal;
      const slopeAccel = _sa.copy(_GRAV).projectOnPlane(n);
      slopeAccel.y = 0;
      vh.addScaledVector(slopeAccel, dt);
    }
    const speed = vh.length();
    const fr = this.slideTimer > 0.6 ? MOVE.slideFriction * 2.5 : MOVE.slideFriction;
    if (speed > 0) vh.multiplyScalar(Math.max(speed - fr * Math.max(speed, 2) * dt * 0.5, 0) / speed);
    if (vh.length() < MOVE.slideMinSpeed || this.slideTimer > 1.4) this._endSlide();
  }

  _endSlide() {
    this.sliding = false;
    this.slideCooldown = MOVE.slideCooldown;
  }

  _move(dt) {
    const desired = { x: this.velocity.x * dt, y: this.velocity.y * dt, z: this.velocity.z * dt };
    this.kcc.computeColliderMovement(this.collider, desired, this.R.QueryFilterFlags.EXCLUDE_SENSORS,
      groups(0xffff, G.WORLD));
    const mv = this.kcc.computedMovement();
    const m = { x: mv.x, y: mv.y, z: mv.z };
    this.wasGrounded = this.grounded;
    this.grounded = this.kcc.computedGrounded();

    // Manual step-up (Rapier's autostep is unreliable with capsules on box stairs):
    // if a grounded move was blocked horizontally, retry as up -> across -> down.
    const wantH = Math.hypot(desired.x, desired.z);
    if ((this.grounded || this.wasGrounded) && this.velocity.y <= 0.5 && wantH > 1e-4 && Math.hypot(m.x, m.z) < wantH * 0.8) {
      const st = this._tryStep(desired, m);
      if (st) { m.x = st.x; m.y = st.y; m.z = st.z; this.grounded = true; }
    }

    this.position.x += m.x; this.position.y += m.y; this.position.z += m.z;
    this._syncBody();

    // Velocity correction from collisions: if we were blocked, absorb it.
    if (dt > 0) {
      const ax = m.x / dt, az = m.z / dt;
      if (Math.abs(ax) < Math.abs(this.velocity.x) - 0.01) this.velocity.x = ax;
      if (Math.abs(az) < Math.abs(this.velocity.z) - 0.01) this.velocity.z = az;
      if (this.velocity.y > 0 && m.y < desired.y * 0.5) this.velocity.y = 0; // ceiling
    }

    if (this.grounded) {
      if (!this.wasGrounded) {
        const fall = -this.velocity.y;
        this.events.onLand?.(fall, this.airTime);
        if (fall > 11) this.takeDamage(Math.round((fall - 11) * 9), null, { type: 'fall' });
      }
      this.velocity.y = Math.max(this.velocity.y, -2);
      this.lastGroundedTime = this.time;
      this.airTime = 0;
    } else {
      this.airTime += dt;
    }
    if (this.position.y < -50) this.takeDamage(1000, null, { type: 'fall' });
  }

  /** Up/across/down step probe. Returns the total displacement or null if it doesn't help. */
  _tryStep(desired, base) {
    const filter = groups(0xffff, G.WORLD), flags = this.R.QueryFilterFlags.EXCLUDE_SENSORS;
    const k = this.kcc, c = this.collider;
    const p0 = this.position, cy = p0.y + this.height / 2;
    // Up.
    k.computeColliderMovement(c, { x: 0, y: MOVE.stepHeight, z: 0 }, flags, filter);
    const up = k.computedMovement().y;
    if (up < 0.05) { this._syncBody(); return null; }
    // Across (at least a few cm so slow walking still finds the tread).
    const wantH = Math.hypot(desired.x, desired.z);
    const sc = Math.max(1, 0.04 / wantH);
    c.setTranslation({ x: p0.x, y: cy + up, z: p0.z });
    k.computeColliderMovement(c, { x: desired.x * sc, y: 0, z: desired.z * sc }, flags, filter);
    const a = k.computedMovement();
    const ax = a.x / sc, az = a.z / sc;
    if (!Number.isFinite(ax) || !Number.isFinite(az)) { this._syncBody(); return null; }
    if (Math.hypot(ax, az) <= Math.hypot(base.x, base.z) + 1e-3) { this._syncBody(); return null; }
    // Down.
    c.setTranslation({ x: p0.x + ax, y: cy + up, z: p0.z + az });
    k.computeColliderMovement(c, { x: 0, y: -(up + 0.1), z: 0 }, flags, filter);
    const d = k.computedMovement().y;
    const grounded = k.computedGrounded();
    this._syncBody();
    const rise = up + d;
    if (!grounded || rise < 0.02 || rise > MOVE.stepHeight + 0.01) return null;
    // Must land on a walkable tread.
    _w.set(p0.x + ax, p0.y + rise + 0.1, p0.z + az);
    const gh = this.phys.raycast(_w, DOWN, 0.4, G.WORLD);
    if (gh && gh.normal.y < 0.7) return null;
    this.velocity.y = Math.min(this.velocity.y, 0);
    this.stepOffset -= rise; // camera smooths the pop
    return { x: ax, y: rise, z: az };
  }

  _footsteps(dt) {
    if (!this.grounded || this.sliding) return;
    const sp = Math.hypot(this.velocity.x, this.velocity.z);
    if (sp < 0.5) { this.stepDist = Math.min(this.stepDist, 1.0); return; }
    this.stepDist += sp * dt;
    const stride = this.sprinting ? 2.0 : this.crouching ? 1.1 : 1.6;
    if (this.stepDist >= stride) {
      this.stepDist = 0;
      const hit = this.phys.raycast(_sl.copy(this.position).setY(this.position.y + 0.2), DOWN, 0.6, G.WORLD);
      const surface = hit?.data?.surface ?? 'concrete';
      const vol = this.sprinting ? 0.9 : this.crouching ? 0.25 : 0.55;
      this.events.onStep?.(surface, vol);
    }
  }

  // ---------------- Mantle / vault ----------------
  /**
   * Probes the geometry in front of the player:
   *  1) a forward ray at knee/chest height must hit a wall close by,
   *  2) a downward ray just past the wall finds the ledge top,
   *  3) a capsule overlap checks there's room to stand on top,
   *  4) a second downward ray further on decides vault (thin obstacle) vs mantle (onto it).
   */
  tryMantle(fromJumpPress) {
    const fwd = this.forward(new THREE.Vector3());
    const R = 0.7;
    let wallDist = Infinity;
    for (const h of [0.55, 0.95, 1.4]) {
      const o = this.position.clone().setY(this.position.y + h);
      const hit = this.phys.raycast(o, fwd, R + MOVE.radius, G.WORLD);
      if (hit && Math.abs(hit.normal.y) < 0.4) { wallDist = Math.min(wallDist, hit.distance); }
    }
    if (wallDist === Infinity) return false;

    const probeFwd = wallDist + 0.3;
    const top = this.position.clone().addScaledVector(fwd, probeFwd).setY(this.position.y + 2.5);
    const down = new THREE.Vector3(0, -1, 0);
    const topHit = this.phys.raycast(top, down, 2.5, G.WORLD);
    if (!topHit || topHit.normal.y < 0.7) return false;
    const ledge = topHit.point.y - this.position.y;
    if (ledge < 0.45 || ledge > 2.25) return false;
    // A jump-press at low ledges should just jump if the player is already airborne high enough.
    if (!fromJumpPress && ledge < 0.9) return false;

    // Headroom above ledge (crouch height at least).
    const clear = (p, h) => {
      const hh = Math.max(0.05, (h - 2 * MOVE.radius) / 2);
      const shape = new this.R.Capsule(hh, MOVE.radius - 0.02);
      let blocked = false;
      this.phys.world.intersectionsWithShape({ x: p.x, y: p.y + h / 2 + 0.05, z: p.z }, { x: 0, y: 0, z: 0, w: 1 }, shape,
        () => { blocked = true; return false; }, undefined, groups(0xffff, G.WORLD), this.collider);
      return !blocked;
    };
    const ledgePos = topHit.point.clone().addScaledVector(fwd, 0.25);
    if (!clear(ledgePos, MOVE.crouchHeight)) return false;

    // Vault: thin obstacle with floor on the far side at about our level.
    let type = ledge > MOVE.vaultMax ? 'mantle' : 'climb';
    let endPos = ledgePos.clone();
    if (ledge <= MOVE.vaultMax) {
      const far = this.position.clone().addScaledVector(fwd, wallDist + 1.15).setY(topHit.point.y + 0.2);
      const farHit = this.phys.raycast(far, down, ledge + 1.5, G.WORLD);
      if (farHit && farHit.point.y < topHit.point.y - 0.3) {
        const land = this.position.clone().addScaledVector(fwd, wallDist + 1.25);
        land.y = farHit.point.y;
        if (clear(land, MOVE.standHeight)) { type = 'vault'; endPos = land; }
      }
    }
    const standRoom = clear(endPos, MOVE.standHeight);
    const hv = Math.hypot(this.velocity.x, this.velocity.z);
    // Vaults scale with approach speed so a sprint vault stays fluid; mantles scale with height.
    const travel = Math.hypot(endPos.x - this.position.x, endPos.z - this.position.z);
    const duration = type === 'vault' ? clamp(travel / Math.max(hv * 0.95, 4.2), 0.34, 0.52)
      : type === 'climb' ? 0.36 + ledge * 0.06 : 0.5 + (ledge - 1.15) * 0.18;
    this.mantle = {
      type, t: 0, duration,
      start: this.position.clone(),
      peak: new THREE.Vector3(this.position.x + (endPos.x - this.position.x) * 0.5, topHit.point.y + 0.08, this.position.z + (endPos.z - this.position.z) * 0.5),
      ledgeY: topHit.point.y,
      end: endPos,
      exitSpeed: type === 'vault' ? Math.max(hv * 0.92, 3.6) : Math.min(hv * 0.6, 3),
      fwd,
      crouchAfter: !standRoom,
    };
    this.sliding = false;
    this.velocity.set(0, 0, 0);
    this.events.onMantle?.(type, ledge);
    return true;
  }

  _updateMantle(dt) {
    const m = this.mantle;
    m.t += dt / m.duration;
    const t = Math.min(m.t, 1);
    if (m.type === 'vault') {
      // Up and over in an arc: horizontal linear, vertical bump peaking above ledge.
      const hor = smoothstep(t);
      const p = m.start.clone().lerp(m.end, hor);
      const arc = Math.sin(Math.PI * Math.min(t * 1.15, 1));
      const base = THREE.MathUtils.lerp(m.start.y, m.end.y, hor);
      p.y = Math.max(base, base + arc * (m.ledgeY + 0.15 - Math.min(m.start.y, m.end.y)) * (t < 0.5 ? 1 : 1));
      if (t < 0.55) p.y = Math.max(p.y, THREE.MathUtils.lerp(m.start.y, m.ledgeY + 0.12, easeOutCubic(t / 0.55)));
      this.position.copy(p);
    } else {
      // Rise first (ease-out), then forward.
      const rise = easeOutCubic(Math.min(t / 0.65, 1));
      const fwdT = smoothstep(clamp((t - 0.4) / 0.6, 0, 1));
      this.position.set(
        THREE.MathUtils.lerp(m.start.x, m.end.x, fwdT),
        THREE.MathUtils.lerp(m.start.y, m.end.y, rise),
        THREE.MathUtils.lerp(m.start.z, m.end.z, fwdT),
      );
    }
    this.eyeHeight.target = m.type === 'mantle' ? MOVE.eyeCrouch : MOVE.eyeStand - 0.2;
    this.eyeHeight.update(dt);
    if (m.crouchAfter || m.type === 'mantle') this.setHeight(MOVE.crouchHeight);
    this._syncBody();
    if (m.t >= 1) {
      this.mantle = null;
      this.crouching = m.crouchAfter;
      if (!this.crouching) this.setHeight(MOVE.standHeight);
      this.velocity.copy(m.fwd).multiplyScalar(m.exitSpeed);
      this.velocity.y = -1;
      this.grounded = true;
      this.lastGroundedTime = this.time;
      this.events.onLand?.(2.5, 0.2);
    }
  }

  // ---------------- Combat ----------------
  takeDamage(amount, attacker, info = {}) {
    if (!this.alive) return 0;
    if (this.spawnProtect > 0 && info.type !== 'fall') return 0;
    if (this.game.settings.godMode && info.type !== 'fall') return 0;
    this.health -= amount;
    this.lastDamageTime = this.time;
    this.game.onPlayerDamaged?.(amount, attacker, info);
    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
      this.game.onActorKilled(this, attacker, info);
    }
    return amount;
  }

  regen(dt) {
    if (!this.alive) return;
    if (this.time - this.lastDamageTime > 4 && this.health < this.maxHealth) {
      this.health = Math.min(this.maxHealth, this.health + 25 * dt);
    }
  }

  // Hitboxes for bot bullets: head sphere + body capsule (+ legs).
  getHitboxes() {
    const p = this.position, h = this.height;
    const eye = this.eyeHeight.x;
    return [
      { part: 'head', a: new THREE.Vector3(p.x, p.y + eye - 0.02, p.z), b: new THREE.Vector3(p.x, p.y + eye + 0.12, p.z), r: 0.13, mult: 1.5 },
      { part: 'torso', a: new THREE.Vector3(p.x, p.y + h * 0.5, p.z), b: new THREE.Vector3(p.x, p.y + eye - 0.25, p.z), r: 0.24, mult: 1 },
      { part: 'legs', a: new THREE.Vector3(p.x, p.y + 0.1, p.z), b: new THREE.Vector3(p.x, p.y + h * 0.5, p.z), r: 0.2, mult: 0.85 },
    ];
  }

  get center() { return new THREE.Vector3(this.position.x, this.position.y + this.height * 0.6, this.position.z); }
  get head() { return new THREE.Vector3(this.position.x, this.position.y + this.eyeHeight.x + 0.05, this.position.z); }
}
