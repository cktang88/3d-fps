import * as THREE from 'three';
import { Spring, Spring3, damp, DEG, noise1, clamp } from '../core/MathUtil.js';
import { MOVE } from './Player.js';
import { sampleCurve, CAM_CURVES } from './CamCurves.js';

/**
 * Additive camera layers on top of the player's true view angles:
 *  - visual recoil kick (spring), trauma-based Perlin shake, head bob, landing dip,
 *    lean / slide roll, sprint & ADS FOV.
 */
export class FPCamera {
  constructor(camera, viewCamera, settings) {
    this.camera = camera;
    this.viewCamera = viewCamera;
    this.settings = settings;
    this.kick = new Spring3(300, 0.55); // x=pitch, y=yaw, z=roll (radians)
    this.dip = new Spring(120, 0.6);
    this.trauma = 0;
    this.time = 0;
    this.bobPhase = 0;
    this.bobAmount = 0;
    this.roll = 0;
    this.fovCurrent = settings.fov;
    this.zoom = 1;
    this.euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this.shakeOffset = new THREE.Vector3();
    // Mocap-derived head motion layers (CamCurves): landing, slide, mantle.
    this.landCurve = null; // { t, amp }
    this.slideT = -1; this.slideExitT = -1; this.slideSide = 1;
    this.curve = [0, 0, 0, 0, 0, 0]; // dx, dy, dz, pitch, yaw, roll (camera space, already scaled)
  }

  addTrauma(t) { this.trauma = Math.min(1, this.trauma + t); }

  addKick(pitch, yaw, roll) { this.kick.impulse(pitch, yaw, roll); }

  land(fallSpeed) {
    this.dip.impulse(-Math.min(fallSpeed * 0.05, 0.7));
    // Baked landing absorb (NinjaJump_Land): knees take it, head dips and nods, then recovers.
    if (fallSpeed > 2.5) this.landCurve = { t: 0, amp: clamp((fallSpeed - 2.5) / 7, 0.18, 1) };
    if (fallSpeed > 6) this.addTrauma(Math.min(0.4, (fallSpeed - 6) * 0.05));
  }

  /** Evaluate the baked head curves for the current movement state into this.curve. */
  _updateCurves(dt, player) {
    const c = this.curve.fill(0);
    const k = this.settings.reduceMotion ? 0.35 : 1;
    const add = (v, pos, rot, w = 1) => {
      c[0] += v[0] * pos * w; c[1] += v[1] * pos * w; c[2] += v[2] * pos * w;
      c[3] += v[3] * rot * w; c[4] += v[4] * rot * 0.5 * w; c[5] += v[5] * rot * w;
    };
    // Mantle / vault: ClimbUp_1m driven by the move's own progress (pull-up arc, look at the ledge).
    if (player.mantle) add(sampleCurve('ClimbUp_1m', Math.min(1, player.mantle.t)), 0.3 * k, 0.17 * k);
    // Slide: Slide_Start → Slide_Loop (eye height itself is handled by the capsule), then Slide_Exit.
    if (player.sliding) {
      if (this.slideT < 0) { this.slideT = 0; this.slideSide = (player.moveIntent?.x ?? 0) >= 0 ? 1 : -1; }
      this.slideT += dt;
      this.slideExitT = -1;
    } else if (this.slideT >= 0) { this.slideT = -1; this.slideExitT = 0; }
    const ss = CAM_CURVES.Slide_Start;
    const slidePose = (w) => {
      const st = sampleCurve('Slide_Start', Math.min(1, Math.max(this.slideT, 0) / ss.dur), { detrend: false });
      const v = [st[0], 0, st[2], st[3], st[4] * this.slideSide, st[5] * this.slideSide];
      if (this.slideT > ss.dur) { const lp = sampleCurve('Slide_Loop', (this.slideT - ss.dur) / CAM_CURVES.Slide_Loop.dur, { detrend: false, loop: true }); for (let j = 0; j < 6; j++) v[j] += lp[j]; }
      add(v, 0.1 * k, 0.14 * k, w);
    };
    if (this.slideT >= 0) slidePose(1);
    if (this.slideExitT >= 0) {
      // Ease the held slide pose out while the exit curve plays (detrended so it ends neutral).
      this.slideExitT += dt;
      const ue = this.slideExitT / CAM_CURVES.Slide_Exit.dur;
      if (ue >= 1) this.slideExitT = -1;
      else {
        const hold = 1 - ue * ue * (3 - 2 * ue);
        const save = this.slideT; this.slideT = 99; slidePose(hold); this.slideT = save;
        const ex = sampleCurve('Slide_Exit', ue);
        add([ex[0], 0, ex[2], ex[3], ex[4] * this.slideSide, ex[5] * this.slideSide], 0.08 * k, 0.1 * k);
      }
    }
    // Landing absorb.
    if (this.landCurve) {
      const L = this.landCurve;
      L.t += dt;
      const u = L.t / CAM_CURVES.NinjaJump_Land.dur;
      if (u >= 1 || player.mantle || player.sliding) this.landCurve = null;
      else add(sampleCurve('NinjaJump_Land', u), 0.22 * L.amp * k, 0.28 * L.amp * k);
    }
  }

  // hfov (deg) -> vertical fov (deg) for current aspect.
  vfov(hfov, aspect) {
    return 2 * Math.atan(Math.tan((hfov * DEG) / 2) / aspect) / DEG;
  }

  update(dt, player, weapon) {
    this.time += dt;
    const s = this.settings;
    const kick = this.kick.update(dt);
    this.dip.update(dt);
    this.trauma = Math.max(0, this.trauma - dt * 1.5);

    // Head bob from horizontal speed, synced to footstep cadence.
    const sp = player.grounded && !player.sliding ? Math.hypot(player.velocity.x, player.velocity.z) : 0;
    const aiming = weapon?.adsT ?? 0;
    const target = clamp(sp / MOVE.walk, 0, 1.6) * (1 - aiming * 0.85) * (s.reduceMotion ? 0.3 : 1);
    this.bobAmount = damp(this.bobAmount, target, 8, dt);
    const stride = player.sprinting ? 2.0 : player.crouching ? 1.1 : 1.6;
    this.bobPhase += (sp / stride) * Math.PI * dt;
    const amp = player.sprinting ? 2.0 : 1;
    const bobY = Math.abs(Math.sin(this.bobPhase)) * 0.022 * this.bobAmount * amp - 0.01 * this.bobAmount;
    const bobX = Math.cos(this.bobPhase) * 0.012 * this.bobAmount * amp;
    const bobRoll = Math.cos(this.bobPhase) * 0.004 * this.bobAmount * amp;

    // Shake: noise * trauma^2.
    const sh = this.trauma * this.trauma * (s.reduceMotion ? 0.4 : 1);
    const t = this.time * 22;
    const shP = noise1(t) * 2.5 * DEG * sh, shY = noise1(t + 100) * 2.5 * DEG * sh, shR = noise1(t + 200) * 2.5 * DEG * sh;

    // Roll: lean + slide + strafe tilt.
    const right = player.right(this._right || (this._right = new THREE.Vector3()));
    const lateral = player.velocity.dot(right);
    let rollT = -player.lean * MOVE.leanAngle - clamp(lateral / 6, -1, 1) * 0.6 * DEG;
    if (player.sliding) rollT += 4 * DEG * (player.moveIntent.x >= 0 ? -1 : 1);
    if (!player.alive) rollT = 22 * DEG; // death cam: slump to the side
    this.roll = damp(this.roll, rollT, 9, dt);

    // Mocap head layers (scaled well below the source so they read as weight, never nausea).
    this._updateCurves(dt, player);
    const cv = this.curve;

    // Position.
    const eye = (this._eye || (this._eye = new THREE.Vector3())).copy(player.position);
    eye.y += player.eyeHeight.x + this.dip.x * 0.1 + bobY + (player.stepOffset || 0);
    eye.addScaledVector(right, player.lean * MOVE.leanOffset + bobX);
    // When leaning, the head also drops a little.
    eye.y -= Math.abs(player.lean) * 0.08;
    // Curve translation in view space (yaw only, so a nod never swings the eye sideways).
    const fwd = (this._fwd || (this._fwd = new THREE.Vector3())).set(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
    eye.addScaledVector(right, cv[0]).addScaledVector(fwd, -cv[2]);
    eye.y += cv[1];
    this.camera.position.copy(eye);

    this.euler.set(
      player.pitch + kick.x + shP + cv[3],
      player.yaw + kick.y + shY + cv[4],
      this.roll + kick.z + shR + bobRoll + cv[5],
    );
    this.camera.quaternion.setFromEuler(this.euler);

    // FOV: sprint widens, ADS zooms. zoom = optic magnification.
    let hfov = s.fov;
    if (player.sprinting) hfov += player.tacSprint ? 8 : 5;
    if (player.sliding) hfov += 4;
    const z = weapon ? 1 + (weapon.zoom() - 1) * (weapon.adsT ?? 0) : 1;
    const vf = this.vfov(hfov, this.camera.aspect);
    const targetFov = 2 * Math.atan(Math.tan((vf * DEG) / 2) / z) / DEG;
    this.fovCurrent = damp(this.fovCurrent, targetFov, 18, dt);
    if (Math.abs(this.camera.fov - this.fovCurrent) > 0.01) {
      this.camera.fov = this.fovCurrent;
      this.camera.updateProjectionMatrix();
    }
    this.zoom = z;
    // Viewmodel camera FOV is independent (fixed, slightly narrower when aiming).
    const vmFov = s.viewmodelFov - (weapon?.adsT ?? 0) * (weapon?.vmAdsFovDrop ?? 10);
    if (Math.abs(this.viewCamera.fov - vmFov) > 0.01) {
      this.viewCamera.fov = vmFov;
      this.viewCamera.updateProjectionMatrix();
    }
  }
}
