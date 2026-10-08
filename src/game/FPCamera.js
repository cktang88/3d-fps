import * as THREE from 'three';
import { Spring, Spring3, damp, DEG, noise1, clamp } from '../core/MathUtil.js';
import { MOVE } from './Player.js';

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
  }

  addTrauma(t) { this.trauma = Math.min(1, this.trauma + t); }

  addKick(pitch, yaw, roll) { this.kick.impulse(pitch, yaw, roll); }

  land(fallSpeed) {
    this.dip.impulse(-Math.min(fallSpeed * 0.12, 1.6));
    if (fallSpeed > 6) this.addTrauma(Math.min(0.4, (fallSpeed - 6) * 0.05));
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
    const right = player.right(new THREE.Vector3());
    const lateral = player.velocity.dot(right);
    let rollT = -player.lean * MOVE.leanAngle - clamp(lateral / 6, -1, 1) * 0.6 * DEG;
    if (player.sliding) rollT += 4 * DEG * (player.moveIntent.x >= 0 ? -1 : 1);
    if (player.mantle) rollT += Math.sin(player.mantle.t * Math.PI) * 3 * DEG;
    this.roll = damp(this.roll, rollT, 9, dt);

    // Position.
    const eye = player.position.clone();
    eye.y += player.eyeHeight.x + this.dip.x * 0.1 + bobY;
    eye.addScaledVector(right, player.lean * MOVE.leanOffset + bobX);
    // When leaning, the head also drops a little.
    eye.y -= Math.abs(player.lean) * 0.08;
    this.camera.position.copy(eye);

    let mantlePitch = 0;
    if (player.mantle) mantlePitch = -Math.sin(Math.min(player.mantle.t, 1) * Math.PI) * 6 * DEG;
    this.euler.set(
      player.pitch + kick.x + shP + mantlePitch,
      player.yaw + kick.y + shY,
      this.roll + kick.z + shR + bobRoll,
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
