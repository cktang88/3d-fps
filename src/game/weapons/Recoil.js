// Player aim recoil: turns per-shot recoil (Weapon._fire -> shot.pitch/yaw) into real aim movement.
//  - Each kick is eased in over ~60 ms (KICK_RATE) instead of teleporting the view between frames.
//  - Nothing returns while the string continues: the shooter pulls down (mouse) to stay on target.
//  - When the trigger pauses, only part of the string's *uncompensated* climb settles back (rc.recS for a
//    single shot, sliding to rc.recL for 10+ shot strings; Insurgency / Tarkov style). Whatever the shooter
//    already pulled down is not "returned" a second time, so compensating never overshoots below the target.
// Pure logic (no THREE / DOM) so tools/spray_sim.mjs can drive it headless.

const KICK_RATE = 38; // 1/s, ~95% of a kick lands within 80 ms
const RETURN_RATE = 10; // 1/s, settle-back speed (scaled by stats.recoveryMul)

export class AimRecoil {
  constructor() { this.reset(); }

  reset() {
    this.pendP = 0; this.pendY = 0; // kick not yet applied to the view
    this.accP = 0; this.accY = 0; // uncompensated climb of the current string
    this.retP = 0; this.retY = 0; // settle-back still to apply
    this.n = 0; // shots in the current string
  }

  /** Register a shot (radians, +pitch = up, +yaw = left). */
  add(pitch, yaw) {
    this.pendP += pitch; this.pendY += yaw;
    this.accP += pitch; this.accY += yaw;
    this.n++;
  }

  /** Player mouse movement this frame (radians). Pulling against the recoil uses up the recoverable part. */
  look(dP, dY) {
    if (dP < 0) {
      if (this.accP > 0) this.accP = Math.max(0, this.accP + dP);
      if (this.retP > 0) this.retP = Math.max(0, this.retP + dP);
    }
    if (dY * this.accY < 0) this.accY = Math.sign(this.accY) * Math.max(0, Math.abs(this.accY) - Math.abs(dY));
    if (dY * this.retY < 0) this.retY = Math.sign(this.retY) * Math.max(0, Math.abs(this.retY) - Math.abs(dY));
  }

  /** Fraction of a string's climb that settles back by itself, by string length. */
  static settleFrac(rc, n) {
    // A single deliberate tap returns to the natural point of aim (real shooters do; slow taps shouldn't walk
    // the group up). Bursts and strings keep the partial settle, so sustained fire still needs pull-down.
    if (n <= 1) return 1;
    const t = Math.min(1, Math.max(0, (n - 1) / 9));
    return rc.recS + (rc.recL - rc.recS) * t;
  }

  /** Per-frame: returns the aim change {dp, dy} (radians) to add to the view. */
  update(dt, w) {
    const s = w.stats;
    let dp = 0, dy = 0;
    // Ease pending kick in.
    if (this.pendP || this.pendY) {
      const a = 1 - Math.exp(-KICK_RATE * dt);
      const kp = this.pendP * a, ky = this.pendY * a;
      dp += kp; dy += ky; this.pendP -= kp; this.pendY -= ky;
      if (Math.abs(this.pendP) < 1e-6 && Math.abs(this.pendY) < 1e-6) { dp += this.pendP; dy += this.pendY; this.pendP = this.pendY = 0; }
    }
    // String ended (trigger paused a little longer than the cyclic interval)?
    const interval = 60 / (s.modes.includes('burst') && w.mode === 'burst' ? Math.max(s.rpm, s.burstRpm || 0) : s.rpm);
    if (this.n > 0 && w.time - w.lastShotTime > Math.min(0.3, Math.max(0.12, interval * 1.2))) {
      const f = Math.min(1, AimRecoil.settleFrac(s.rc, this.n) * Math.sqrt(s.recoveryMul ?? 1));
      this.retP += this.accP * f; this.retY += this.accY * f;
      this.accP = this.accY = 0; this.n = 0;
    }
    // Settle back.
    if (this.retP || this.retY) {
      const b = 1 - Math.exp(-RETURN_RATE * (s.recoveryMul ?? 1) * dt);
      const rp = this.retP * b, ry = this.retY * b;
      dp -= rp; dy -= ry; this.retP -= rp; this.retY -= ry;
      if (Math.abs(this.retP) < 1e-5 && Math.abs(this.retY) < 1e-5) { this.retP = this.retY = 0; }
    }
    return { dp, dy };
  }
}
