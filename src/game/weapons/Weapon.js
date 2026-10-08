import { computeStats } from './WeaponDefs.js';
import { clamp, DEG } from '../../core/MathUtil.js';

/**
 * Weapon gameplay logic shared by the player and bots.
 * States: idle | equip | reload | bolt | pump | melee | inspect
 * Handles fire modes (auto / semi / burst / pump / bolt), tac vs empty reload (+1 in chamber),
 * shell-by-shell shotgun loading (interruptible), ADS blend, sprint-to-fire lockout,
 * spread bloom and fixed recoil patterns.
 */
export class Weapon {
  constructor(id, loadout = {}, owner = null) {
    this.id = id;
    this.owner = owner;
    this.loadout = { ...loadout };
    this.setLoadout(this.loadout, true);
    this.state = 'idle';
    this.stateTime = 0;
    this.stateDur = 0;
    this.cooldown = 0;
    this.burstLeft = 0;
    this.triggerHeld = false;
    this.adsT = 0; // 0 hip -> 1 fully aimed
    this.sprintT = 0;
    this.sprintLock = 0;
    this.spread = 0; // additive bloom (deg)
    this.shotIndex = 0;
    this.lastShotTime = -9;
    this.time = 0;
    this.reloadType = null;
    this.reloadCommitted = false;
    this.listeners = {};
    this.vmAdsFovDrop = 10;
    this.chambered = true;
    this.laserOn = true;
    this.zoomIndex = 1;
    this.inspectT = 0;
  }

  setLoadout(loadout, fill = false) {
    this.loadout = { ...loadout };
    const prevMag = this.stats?.mag;
    this.stats = computeStats(this.id, this.loadout);
    this.modeIndex ??= 0;
    this.modeIndex = Math.min(this.modeIndex, this.stats.modes.length - 1);
    if (fill || prevMag === undefined) {
      this.ammo = this.stats.mag;
      this.reserve = this.stats.reserve;
    } else {
      this.ammo = Math.min(this.ammo, this.stats.mag + (this.stats.closedBolt ? 1 : 0));
    }
  }

  on(evt, fn) { (this.listeners[evt] ||= []).push(fn); }
  emit(evt, ...a) { this.listeners[evt]?.forEach((f) => f(...a)); }

  get mode() { return this.stats.modes[this.modeIndex]; }
  get busy() { return this.state !== 'idle'; }

  cycleMode() {
    if (this.stats.modes.length < 2) return false;
    this.modeIndex = (this.modeIndex + 1) % this.stats.modes.length;
    this.burstLeft = 0;
    this.emit('modeChange', this.mode);
    return true;
  }

  /**
   * Main-camera magnification at full ADS. Picture-in-picture scopes (ACOG-style) only zoom the
   * world slightly — the magnified image lives in the lens (see lensZoom) — while overlay scopes
   * and open sights zoom the whole view.
   */
  zoom() {
    const s = this.stats;
    if (s.scope && !s.overlay) return Math.min(1.3, s.zoomLevel);
    if (s.variable) return s.variable[this.zoomIndex] ?? s.zoomLevel;
    return s.zoomLevel;
  }

  /** Magnification seen through a picture-in-picture lens. */
  lensZoom() { return this.stats.zoomLevel; }

  toggleZoom() {
    if (!this.stats.variable) return;
    this.zoomIndex = (this.zoomIndex + 1) % this.stats.variable.length;
  }

  mobility() { return this.stats.mobility; }
  adsMoveMult() { return this.stats.adsMove ?? 0.55; }
  blocksSprint() { return this.state === 'reload' && !this.stats.tube ? false : false; }

  equip() {
    this._setState('equip', this.stats.equip);
    this.burstLeft = 0;
    this.adsT = 0;
    this.emit('equip');
  }

  _setState(s, dur = 0) {
    this.state = s;
    this.stateTime = 0;
    this.stateDur = dur;
  }

  canReload() {
    if (this.reserve <= 0) return false;
    const full = this.stats.mag + (this.stats.closedBolt && this.ammo > 0 ? 1 : 0);
    if (this.ammo >= full) return false;
    return this.state === 'idle' || this.state === 'inspect';
  }

  reload() {
    if (!this.canReload()) return false;
    this.burstLeft = 0;
    if (this.stats.tube) {
      this.reloadType = 'shell';
      this._setState('reload', this.stats.shellReload + 0.25); // first includes raise
      this.reloadStage = 'start';
      this.emit('reloadStart', 'shell');
      return true;
    }
    const empty = this.ammo === 0;
    this.reloadType = empty ? 'empty' : 'tac';
    this.reloadCommitted = false;
    this._setState('reload', empty ? this.stats.emptyReload : this.stats.tacReload);
    this.emit('reloadStart', this.reloadType);
    return true;
  }

  cancelReload() {
    if (this.state !== 'reload') return;
    if (this.stats.tube) { this._setState('idle'); this.emit('reloadEnd', 'cancel'); return; }
    // Cancelling before 80% commit keeps the old count (CoD reload cancel).
    if (!this.reloadCommitted) { this._setState('idle'); this.emit('reloadEnd', 'cancel'); }
  }

  inspect() {
    if (this.state !== 'idle') return;
    this._setState('inspect', 3.2);
    this.emit('inspect');
  }

  /**
   * Per frame update.
   * input: { fire (held), firePressed, aim, sprinting, reloadPressed, canFire }
   * Returns array of shots fired this frame: [{ spreadDeg, recoil: [p, y] }]
   */
  update(dt, input) {
    this.time += dt;
    this.stateTime += dt;
    // Cooldown may go negative within a frame so sustained fire carries the remainder (rpm is
    // frame-rate independent); it is re-clamped to 0 whenever the trigger isn't driving fire.
    this.cooldown -= dt;
    const s = this.stats;
    const shots = [];

    // ADS blend (hold), blocked while sprinting / equipping / sprint-reload for non-tube.
    const wantAds = input.aim && !input.sprinting && this.state !== 'equip' && this.state !== 'melee' && !input.mantling;
    const adsRate = 1 / Math.max(0.05, s.ads);
    this.adsT = clamp(this.adsT + (wantAds ? adsRate : -adsRate * 1.3) * dt, 0, 1);

    // Sprint pose + lockout.
    this.sprintT = clamp(this.sprintT + (input.sprinting ? 5 : -1 / Math.max(0.05, s.sprintToFire)) * dt, 0, 1);
    if (input.sprinting) this.sprintLock = s.sprintToFire;
    else this.sprintLock = Math.max(0, this.sprintLock - dt);

    // Spread recovery.
    this.spread = Math.max(0, this.spread - s.spreadRecovery * dt);
    // Recoil pattern index recovers after a pause.
    const interval = 60 / s.rpm;
    if (this.time - this.lastShotTime > Math.max(0.25, interval * 1.5) / s.recoveryMul) this.shotIndex = Math.max(0, this.shotIndex - dt * 20);

    // ---- State machine ----
    switch (this.state) {
      case 'equip':
        if (this.stateTime >= this.stateDur) this._setState('idle');
        break;
      case 'inspect':
        if (this.stateTime >= this.stateDur || input.fire || input.aim || input.sprinting) this._setState('idle');
        break;
      case 'melee':
        if (this.stateTime >= this.stateDur) this._setState('idle');
        break;
      case 'bolt':
      case 'pump':
        if (this.stateTime >= this.stateDur) { this._setState('idle'); this.chambered = true; }
        break;
      case 'reload':
        this._updateReload(input);
        break;
    }

    // Auto reload on empty trigger pull.
    if (this.state === 'idle' && this.ammo === 0 && input.firePressed && this.reserve > 0) {
      this.emit('dry');
      this.reload();
    } else if (this.state === 'idle' && this.ammo === 0 && input.firePressed) {
      this.emit('dry');
    }

    // ---- Firing ----
    const canShoot = (this.state === 'idle' || (this.state === 'reload' && s.tube && this.ammo > 0 && input.firePressed))
      && this.sprintLock <= 0 && !input.sprinting && input.canFire !== false && this.ammo > 0;
    if (this.state === 'reload' && s.tube && canShoot) { this._setState('idle'); this.emit('reloadEnd', 'cancel'); }

    const mode = this.mode;
    let want = false;
    if (mode === 'auto') want = input.fire;
    else if (mode === 'burst') {
      if (input.firePressed && this.burstLeft === 0 && this.cooldown <= 0) this.burstLeft = s.burst;
      want = this.burstLeft > 0;
    } else want = input.firePressed;

    let fired = 0;
    while (canShoot && want && this.cooldown <= 0 && this.ammo > 0 && fired < 4) {
      const shot = this._fire();
      shots.push(shot);
      fired++;
      // Carry at most one interval of leftover time (no banking across idle frames).
      const carry = Math.max(this.cooldown, -dt);
      if (mode === 'burst') {
        this.burstLeft--;
        this.cooldown = carry + (this.burstLeft > 0 ? 60 / s.burstRpm : s.burstDelay + 60 / s.burstRpm);
      } else {
        this.cooldown = (mode === 'auto' ? carry : 0) + 60 / s.rpm;
      }
      if (mode === 'bolt' && this.ammo > 0) { this.chambered = false; this._setState('bolt', s.boltTime); this.emit('bolt'); }
      if (mode === 'pump' && this.ammo > 0) { this.chambered = false; this._setState('pump', 60 / s.rpm); this.emit('pump'); }
      // Only sustained modes may fire several rounds in one long frame.
      if (!(mode === 'auto' || (mode === 'burst' && this.burstLeft > 0))) break;
      want = mode === 'auto' ? input.fire : this.burstLeft > 0;
    }
    if (!fired && this.burstLeft > 0 && (this.ammo === 0 || !canShoot)) this.burstLeft = 0;
    if (!fired && !(want && canShoot)) this.cooldown = Math.max(0, this.cooldown);

    if (input.reloadPressed) this.reload();
    return shots;
  }

  _updateReload(input) {
    const s = this.stats;
    if (input.sprinting && s.tube) { /* shotgun keeps loading while sprinting */ }
    if (this.reloadType === 'shell') {
      if (this.stateTime >= this.stateDur) {
        if (this.ammo < s.mag && this.reserve > 0) {
          this.ammo++; this.reserve--;
          this.emit('shellIn');
        }
        if (this.ammo >= s.mag || this.reserve <= 0) {
          // Rack if we started empty.
          if (!this.chambered) { this._setState('pump', s.rackTime + 0.15); this.emit('pump'); }
          else { this._setState('idle'); this.emit('reloadEnd', 'done'); }
        } else {
          this._setState('reload', s.shellReload);
          this.emit('shellStart');
        }
      }
      return;
    }
    const t = this.stateTime / this.stateDur;
    if (!this.reloadCommitted && t >= 0.8) {
      this.reloadCommitted = true;
      const plusOne = this.reloadType === 'tac' && s.closedBolt ? 1 : 0;
      const need = s.mag + plusOne - this.ammo;
      const take = Math.min(need, this.reserve);
      this.ammo += take; this.reserve -= take;
      this.emit('reloadCommit');
    }
    if (this.stateTime >= this.stateDur) {
      this._setState('idle');
      this.chambered = true;
      this.emit('reloadEnd', 'done');
    }
  }

  currentSpread(moveFactor, airborne, crouched) {
    const s = this.stats;
    const hip = s.hipSpread + Math.min(s.spreadMax, this.spread) + moveFactor * 0.6 * 2.2 + (airborne ? 3 : 0);
    const ads = s.adsSpread + Math.min(s.spreadMax, this.spread) * 0.25 + moveFactor * 0.15 + (airborne ? 1.5 : 0);
    let sp = hip + (ads - hip) * Math.min(1, this.adsT / 0.6);
    if (crouched) sp *= 0.8;
    if (s.beam && this.laserOn && this.adsT < 0.5) sp *= 0.85;
    return sp;
  }

  _fire() {
    const s = this.stats;
    this.ammo--;
    this.lastShotTime = this.time;
    const idx = Math.min(Math.floor(this.shotIndex), s.recoil.length - 1);
    const [rp, ry] = s.recoil[idx];
    this.shotIndex += 1;
    const adsRecoil = 1 - this.adsT * 0.3;
    const pitch = rp * s.vRecoilMul * adsRecoil * DEG;
    const yaw = (ry + (Math.random() * 2 - 1) * s.hJitter) * s.hRecoilMul * adsRecoil * DEG;
    const spreadBefore = this.spread;
    this.spread = Math.min(s.spreadMax, this.spread + s.spreadPerShot);
    this.inspectT = 0;
    const shot = { pitch, yaw, spreadBloom: spreadBefore, index: idx, pellets: s.pellets || 1 };
    this.emit('fire', shot);
    if (this.ammo === 0) this.emit('empty');
    return shot;
  }

  melee() {
    if (this.state === 'melee' || this.state === 'equip') return false;
    if (this.state === 'reload') this.cancelReload();
    this._setState('melee', 0.55);
    this.adsT = 0;
    this.emit('melee');
    return true;
  }

  refill() {
    this.ammo = this.stats.mag;
    this.reserve = this.stats.reserve;
  }
}
