import * as THREE from 'three';

/**
 * WebAudio engine. Supports loaded samples (with random pitch/variants) and a layered
 * procedural synthesiser used for guns / foley when no sample exists. Gun sounds follow the
 * classic 3-layer design: mechanical transient + low "punch" + noise "crack", plus an
 * environment tail via a convolution reverb. Distant shots get low-passed and delayed.
 */
export class Audio {
  constructor() {
    this.ctx = null;
    this.buffers = new Map();
    this.listener = { pos: new THREE.Vector3(), fwd: new THREE.Vector3(0, 0, -1), up: new THREE.Vector3(0, 1, 0) };
    this.volume = 0.8;
    this._noise = null;
  }

  init() {
    if (this.ctx) return;
    const ctx = (this.ctx = new (window.AudioContext || window.webkitAudioContext)());
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    // Gentle bus compression keeps gunfire punchy without clipping.
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14; this.comp.knee.value = 10; this.comp.ratio.value = 4;
    this.comp.attack.value = 0.003; this.comp.release.value = 0.15;
    // Master low-pass: used for explosion concussion / near-death muffling.
    this.muffleLP = ctx.createBiquadFilter();
    this.muffleLP.type = 'lowpass'; this.muffleLP.frequency.value = 20000; this.muffleLP.Q.value = 0.5;
    this.master.connect(this.muffleLP).connect(this.comp).connect(ctx.destination);
    this._muffle = 0; this._muffleTarget = 0; this._ring = null;
    this.sfx = ctx.createGain(); this.sfx.connect(this.master);
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this._impulse(2.2, 2.8);
    this.reverbGain = ctx.createGain(); this.reverbGain.gain.value = 0.45;
    this.reverb.connect(this.reverbGain).connect(this.master);
    this._noise = this._noiseBuffer(2);
    this.ambient();
  }

  /**
   * Muffle the whole mix (0..1). `hold` keeps a transient muffle (explosions) for that many seconds.
   * Called every frame with the persistent level (low health).
   */
  setMuffle(level, dt = 0) {
    if (!this.ctx) return;
    this._muffleHold = Math.max(0, (this._muffleHold || 0) - dt);
    const transient = this._muffleHold > 0 ? this._muffleShock : (this._muffleShock = Math.max(0, (this._muffleShock || 0) - dt * 0.6));
    const m = Math.max(level, transient || 0);
    if (Math.abs(m - this._muffle) < 0.005) return;
    this._muffle = m;
    const f = 20000 * Math.pow(350 / 20000, Math.min(1, m));
    this.muffleLP.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.05);
  }

  /** Concussion: muffle + tinnitus ring, scaled by intensity 0..1. */
  concussion(k) {
    if (!this.ctx || k <= 0.05) return;
    this._muffleShock = Math.max(this._muffleShock || 0, Math.min(0.95, k));
    this._muffleHold = 0.35 + k * 0.6;
    if (k > 0.35) {
      const ctx = this.ctx, t = ctx.currentTime;
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = 3900 + Math.random() * 400;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.05 * k, t + 0.08);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.5 + k * 1.8);
      o.connect(g).connect(this.comp); o.start(t); o.stop(t + 3.6);
    }
  }

  setVolume(v) { this.volume = v; if (this.master) this.master.gain.value = v; }

  resume() { this.ctx?.state === 'suspended' && this.ctx.resume(); }

  _noiseBuffer(sec) {
    const b = this.ctx.createBuffer(1, this.ctx.sampleRate * sec, this.ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }

  _impulse(sec, decay) {
    const ctx = this.ctx, len = ctx.sampleRate * sec;
    const b = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // Early reflections cluster + diffuse tail.
        const er = i < ctx.sampleRate * 0.08 && Math.random() < 0.004 ? 2 : 1;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * er;
      }
    }
    return b;
  }

  async load(name, url) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(res.status);
      const arr = await res.arrayBuffer();
      const ctx = this.ctx || new OfflineAudioContext(2, 44100, 44100);
      const buf = await ctx.decodeAudioData(arr);
      if (!this.buffers.has(name)) this.buffers.set(name, []);
      this.buffers.get(name).push(buf);
    } catch (e) {
      console.warn('audio load failed', name, url, e);
    }
  }

  has(name) { return this.buffers.has(name); }

  updateListener(camera) {
    if (!this.ctx) return;
    camera.getWorldPosition(this.listener.pos);
    camera.getWorldDirection(this.listener.fwd);
    const L = this.ctx.listener, p = this.listener.pos, f = this.listener.fwd;
    if (L.positionX) {
      const t = this.ctx.currentTime;
      L.positionX.setValueAtTime(p.x, t); L.positionY.setValueAtTime(p.y, t); L.positionZ.setValueAtTime(p.z, t);
      L.forwardX.setValueAtTime(f.x, t); L.forwardY.setValueAtTime(f.y, t); L.forwardZ.setValueAtTime(f.z, t);
      L.upX.setValueAtTime(0, t); L.upY.setValueAtTime(1, t); L.upZ.setValueAtTime(0, t);
    } else {
      L.setPosition(p.x, p.y, p.z);
      L.setOrientation(f.x, f.y, f.z, 0, 1, 0);
    }
  }

  // Output node chain for a sound at a world position (null => 2D / first person).
  _out(pos, gain = 1, opts = {}) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.value = gain;
    let node = g;
    if (pos) {
      const dist = pos.distanceTo(this.listener.pos);
      const pan = ctx.createPanner();
      pan.panningModel = 'HRTF';
      pan.distanceModel = 'inverse';
      pan.refDistance = opts.ref ?? 4;
      pan.rolloffFactor = opts.rolloff ?? 1.1;
      pan.maxDistance = 400;
      pan.positionX.value = pos.x; pan.positionY.value = pos.y; pan.positionZ.value = pos.z;
      // Air absorption: far sounds lose highs.
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = THREE.MathUtils.clamp(18000 - dist * 160, 900, 18000);
      g.connect(lp).connect(pan);
      node = pan;
      const delay = dist / 343;
      if (delay > 0.02) {
        const d = ctx.createDelay(2);
        d.delayTime.value = Math.min(delay, 1.9);
        pan.connect(d);
        node = d;
      }
    }
    node.connect(this.sfx);
    if (opts.reverb !== 0) {
      const rs = ctx.createGain();
      rs.gain.value = opts.reverb ?? 0.35;
      node.connect(rs).connect(this.reverb);
    }
    return g;
  }

  play(name, { pos = null, volume = 1, pitch = 1, pitchVar = 0.06, reverb, ref, rolloff, when = 0 } = {}) {
    if (!this.ctx) return null;
    const list = this.buffers.get(name);
    if (!list) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = list[(Math.random() * list.length) | 0];
    src.playbackRate.value = pitch * (1 + (Math.random() * 2 - 1) * pitchVar);
    src.connect(this._out(pos, volume, { reverb, ref, rolloff }));
    src.start(this.ctx.currentTime + when);
    return src;
  }

  _noiseSrc(t, dur) {
    const s = this.ctx.createBufferSource();
    s.buffer = this._noise;
    s.start(t, Math.random() * 1.5, dur + 0.05);
    return s;
  }

  _env(gainNode, t, a, peak, d, curve = 'exp') {
    const g = gainNode.gain;
    g.setValueAtTime(0.0001, t);
    g.linearRampToValueAtTime(peak, t + a);
    if (curve === 'exp') g.exponentialRampToValueAtTime(0.0001, t + a + d);
    else g.linearRampToValueAtTime(0, t + a + d);
  }

  /**
   * Procedural gunshot. profile: { punch (Hz), crack (Hz), body, tail, mech, suppressed, volume }
   */
  gunshot(profile, pos = null) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime + 0.001;
    const sup = profile.suppressed;
    const out = this._out(pos, (profile.volume ?? 1) * (sup ? 0.35 : 1), {
      reverb: sup ? 0.12 : 0.5, ref: sup ? 2 : 6, rolloff: sup ? 1.6 : 0.9,
    });
    const v = 1 + (Math.random() - 0.5) * 0.08;

    // 1) Transient snap.
    const n1 = this._noiseSrc(t, 0.03);
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = sup ? 1800 : 3000;
    const g1 = ctx.createGain(); this._env(g1, t, 0.0005, sup ? 0.5 : 1.2, 0.025);
    n1.connect(hp).connect(g1).connect(out);

    // 2) Low punch: pitch-dropping sine + sub.
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime((profile.punch ?? 140) * 2.2 * v, t);
    o.frequency.exponentialRampToValueAtTime((profile.punch ?? 140) * 0.45, t + 0.12);
    const g2 = ctx.createGain(); this._env(g2, t, 0.002, (profile.body ?? 1) * (sup ? 0.6 : 1.4), 0.16);
    o.connect(g2).connect(out); o.start(t); o.stop(t + 0.3);

    // 3) Noise crack / body.
    const n3 = this._noiseSrc(t, 0.4);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
    bp.frequency.setValueAtTime((profile.crack ?? 1400) * v, t);
    bp.frequency.exponentialRampToValueAtTime((profile.crack ?? 1400) * 0.35, t + 0.25);
    bp.Q.value = 0.7;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = sup ? 2200 : 12000;
    const g3 = ctx.createGain(); this._env(g3, t, 0.001, sup ? 0.6 : 1.6, (profile.tail ?? 0.25) * (sup ? 0.5 : 1));
    n3.connect(bp).connect(lp).connect(g3).connect(out);

    // 4) Mechanical action clack (bolt / slide), always heard locally.
    if (!pos && profile.mech !== 0) {
      const tm = t + (profile.mechDelay ?? 0.035);
      const n4 = this._noiseSrc(tm, 0.05);
      const bp4 = ctx.createBiquadFilter(); bp4.type = 'bandpass'; bp4.frequency.value = 3200 * v; bp4.Q.value = 6;
      const g4 = ctx.createGain(); this._env(g4, tm, 0.001, 0.35 * (profile.mech ?? 1), 0.04);
      n4.connect(bp4).connect(g4).connect(out);
    }
  }

  // Short metallic foley: magazine out/in, bolt, etc.
  click(type = 'mag', pos = null, vol = 1) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime + 0.001;
    const presets = {
      magOut: [[900, 4, 0.08, 0.5], [2600, 8, 0.03, 0.35]],
      magIn: [[700, 3, 0.06, 0.7], [3400, 10, 0.025, 0.5]],
      bolt: [[1800, 6, 0.05, 0.6], [4200, 12, 0.03, 0.5], [600, 2, 0.08, 0.4, 0.07]],
      empty: [[5200, 14, 0.02, 0.4]],
      switch: [[3800, 10, 0.015, 0.3]],
      shell: [[5200, 20, 0.12, 0.08], [7400, 25, 0.08, 0.05, 0.03]],
      pump: [[1100, 4, 0.07, 0.6], [2200, 6, 0.05, 0.5, 0.12], [900, 4, 0.06, 0.5, 0.14]],
      equip: [[1500, 3, 0.1, 0.25], [3200, 6, 0.04, 0.2, 0.06]],
      cloth: [[700, 0.6, 0.18, 0.12]],
      ads: [[900, 0.8, 0.1, 0.08]],
    };
    const layers = presets[type] || presets.magIn;
    const out = this._out(pos, vol, { reverb: 0.15, ref: 1.5 });
    for (const [f, q, d, a, off = 0] of layers) {
      const tt = t + off;
      const n = this._noiseSrc(tt, d);
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f * (0.95 + Math.random() * 0.1); bp.Q.value = q;
      const g = ctx.createGain(); this._env(g, tt, 0.001, a, d);
      n.connect(bp).connect(g).connect(out);
    }
  }

  footstep(pos, surface = 'concrete', vol = 1) {
    if (!this.ctx) return;
    if (this.has('step_' + surface)) return this.play('step_' + surface, { pos, volume: vol, reverb: 0.1, ref: 2 });
    const ctx = this.ctx, t = ctx.currentTime + 0.001;
    const out = this._out(pos, vol * 0.5, { reverb: 0.08, ref: 2 });
    const f = { concrete: 900, metal: 2400, wood: 500, dirt: 350, gravel: 1500 }[surface] || 900;
    const n = this._noiseSrc(t, 0.12);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f * (0.8 + Math.random() * 0.4); bp.Q.value = surface === 'metal' ? 5 : 1.2;
    const g = ctx.createGain(); this._env(g, t, 0.004, 0.6, surface === 'gravel' ? 0.14 : 0.07);
    n.connect(bp).connect(g).connect(out);
    const o = ctx.createOscillator(); o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(50, t + 0.06);
    const g2 = ctx.createGain(); this._env(g2, t, 0.002, 0.35, 0.07);
    o.connect(g2).connect(out); o.start(t); o.stop(t + 0.12);
  }

  impact(pos, surface = 'concrete') {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime + 0.001;
    const out = this._out(pos, 0.7, { reverb: 0.2, ref: 2, rolloff: 1.4 });
    const f = { concrete: 2200, metal: 3800, wood: 900, dirt: 600, flesh: 400, glass: 5000 }[surface] || 2000;
    const n = this._noiseSrc(t, 0.1);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = surface === 'metal' ? 9 : 1.5;
    const g = ctx.createGain(); this._env(g, t, 0.001, 0.8, surface === 'metal' ? 0.25 : 0.08);
    n.connect(bp).connect(g).connect(out);
    if (surface === 'metal') {
      const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = 2800 + Math.random() * 1500;
      const g2 = ctx.createGain(); this._env(g2, t, 0.001, 0.12, 0.3);
      o.connect(g2).connect(out); o.start(t); o.stop(t + 0.35);
    }
  }

  // Supersonic crack + whizz when a round passes near the listener.
  whiz(pos) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime + 0.001;
    const out = this._out(pos, 0.5, { reverb: 0.05, ref: 1 });
    const n = this._noiseSrc(t, 0.15);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 3;
    bp.frequency.setValueAtTime(5000, t); bp.frequency.exponentialRampToValueAtTime(1200, t + 0.14);
    const g = ctx.createGain(); this._env(g, t, 0.01, 0.7, 0.13);
    n.connect(bp).connect(g).connect(out);
  }

  ui(type) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime + 0.001;
    const out = this._out(null, 1, { reverb: 0 });
    const tone = (f, at, d, a, wave = 'sine') => {
      const o = ctx.createOscillator(); o.type = wave; o.frequency.value = f;
      const g = ctx.createGain(); this._env(g, t + at, 0.001, a, d);
      o.connect(g).connect(out); o.start(t + at); o.stop(t + at + d + 0.05);
    };
    const smp = (name, volume, pitch = 1, pitchVar = 0.03, when = 0) => this.play(name, { volume, pitch, pitchVar, reverb: 0, when });
    // Hit confirms: a crisp sampled tick + a short synthetic "plink" body so it cuts through gunfire.
    if (type === 'hit') {
      if (!smp('ui_tick', 0.9, 1.15, 0.05)) tone(2600, 0, 0.05, 0.18, 'square');
      tone(1750, 0, 0.035, 0.07, 'triangle');
    } else if (type === 'headshot') {
      smp('ui_tick', 1.0, 1.35, 0.03);
      tone(4100, 0, 0.16, 0.09, 'sine'); tone(6150, 0.004, 0.12, 0.04, 'sine');
    } else if (type === 'kill') {
      // Heavy confirm: sub thud + metallic double chime (CoD-style "kill" tick).
      smp('kill_thud', 0.55, 0.85, 0.05);
      smp('ui_tick', 1.0, 0.9, 0.02);
      tone(1320, 0.0, 0.11, 0.12, 'triangle'); tone(1980, 0.055, 0.22, 0.1, 'triangle');
      const o = ctx.createOscillator(); o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(48, t + 0.16);
      const g = ctx.createGain(); this._env(g, t, 0.002, 0.45, 0.16); o.connect(g).connect(out); o.start(t); o.stop(t + 0.25);
    } else if (type === 'headkill') {
      this.ui('kill');
      tone(4100, 0.0, 0.2, 0.08, 'sine'); tone(6150, 0.01, 0.16, 0.035, 'sine');
    } else if (type === 'medal') { if (!smp('ui_medal', 0.45, 1, 0.01)) tone(1600, 0, 0.12, 0.12, 'triangle'); }
    else if (type === 'streak') { if (!smp('ui_streak', 0.6, 1, 0)) tone(900, 0, 0.3, 0.15, 'triangle'); }
    else if (type === 'click') { if (!smp('ui_click', 0.5, 1, 0.04)) tone(1400, 0, 0.03, 0.1, 'square'); }
    else if (type === 'hover') { if (!smp('ui_hover', 0.18, 1, 0.06)) tone(900, 0, 0.02, 0.05); }
    else if (type === 'deploy') { smp('ui_deploy', 0.5, 1, 0); }
    else if (type === 'hurt') {
      const n = this._noiseSrc(t, 0.2);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 400;
      const g = ctx.createGain(); this._env(g, t, 0.003, 0.9, 0.18);
      n.connect(lp).connect(g).connect(out);
    }
  }

  explosion(pos) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime + 0.001;
    // Sampled crunch + low-frequency boom, with the synth layer as a long tail.
    this.play('expl_crunch', { pos, volume: 1.6, pitch: 0.8, pitchVar: 0.08, reverb: 0.7, ref: 12, rolloff: 0.6 });
    this.play('expl_low', { pos, volume: 1.8, pitch: 0.9, pitchVar: 0.05, reverb: 0.5, ref: 14, rolloff: 0.5 });
    const out = this._out(pos, this.has('expl_crunch') ? 1.1 : 2.2, { reverb: 0.8, ref: 10, rolloff: 0.7 });
    const n = this._noiseSrc(t, 1.8);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.setValueAtTime(6000, t); lp.frequency.exponentialRampToValueAtTime(120, t + 1.6);
    const g = ctx.createGain(); this._env(g, t, 0.003, 1.8, 1.6);
    n.connect(lp).connect(g).connect(out);
    const o = ctx.createOscillator(); o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(25, t + 0.8);
    const g2 = ctx.createGain(); this._env(g2, t, 0.004, 2.0, 0.9);
    o.connect(g2).connect(out); o.start(t); o.stop(t + 1);
  }

  // Low ambient bed: distant wind.
  ambient() {
    const ctx = this.ctx;
    const n = ctx.createBufferSource(); n.buffer = this._noise; n.loop = true;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 380;
    const g = ctx.createGain(); g.gain.value = 0.05;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07;
    const lg = ctx.createGain(); lg.gain.value = 160;
    lfo.connect(lg).connect(lp.frequency);
    n.connect(lp).connect(g).connect(this.master);
    n.start(); lfo.start();
  }
}
