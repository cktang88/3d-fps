import * as THREE from 'three';

const C = 343; // speed of sound, m/s
const _d = new THREE.Vector3(), _r = new THREE.Vector3();

/**
 * Procedural WebAudio for the ambience layer: distant artillery (delayed by the speed of sound),
 * small-arms crackle, thunder, fire roar + crackle, drizzle hiss and vehicle voices (rotor / jet)
 * with doppler + air absorption. Builds lazily once the game's AudioContext exists.
 */
export class AmbAudio {
  constructor(audio) {
    this.audio = audio;
    this.ready = false;
  }

  _init() {
    if (this.ready || !this.audio.ctx || !this.audio._noise) return this.ready;
    const ctx = (this.ctx = this.audio.ctx);
    this.bus = ctx.createGain();
    this.bus.gain.value = 0.9;
    this.bus.connect(this.audio.sfx || this.audio.master);
    this.verb = ctx.createGain();
    this.verb.gain.value = 1;
    this.verb.connect(this.audio.reverb);
    this.noise = this.audio._noise;
    // Brown-ish noise (integrated white) for rumbles.
    const len = ctx.sampleRate * 9, b = ctx.createBuffer(1, len, ctx.sampleRate), d = b.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * 3.5; }
    this.brown = b;

    // Loops: fire roar, rain hiss.
    this.fireLoop = this._loop(this.noise, 'bandpass', 520, 0.6);
    this.fireLow = this._loop(this.brown, 'lowpass', 260, 0.7);
    this.rainLoop = this._loop(this.noise, 'highpass', 2600, 0.5);
    this.rainLoop.filter2 = ctx.createBiquadFilter(); this.rainLoop.filter2.type = 'lowpass'; this.rainLoop.filter2.frequency.value = 9000;
    this.rainLoop.filter.disconnect(); this.rainLoop.filter.connect(this.rainLoop.filter2).connect(this.rainLoop.gain);
    this.ready = true;
    return true;
  }

  _loop(buffer, type, freq, q) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource(); src.buffer = buffer; src.loop = true;
    src.loopStart = Math.random() * 0.5;
    const filter = ctx.createBiquadFilter(); filter.type = type; filter.frequency.value = freq; filter.Q.value = q;
    const gain = ctx.createGain(); gain.gain.value = 0;
    const pan = ctx.createStereoPanner();
    src.connect(filter).connect(gain).connect(pan).connect(this.bus);
    src.start(ctx.currentTime + Math.random() * 0.1);
    return { src, filter, gain, pan };
  }

  /** Listener-relative distance + stereo pan for a world position. */
  _spatial(pos) {
    const L = this.audio.listener;
    _d.copy(pos).sub(L.pos);
    const dist = _d.length();
    _d.divideScalar(Math.max(1e-3, dist));
    _r.set(-L.fwd.z, 0, L.fwd.x).normalize(); // right = fwd x up
    return { dist, pan: THREE.MathUtils.clamp(_d.dot(_r), -1, 1) * 0.85 };
  }

  _src(buffer, t, dur) {
    const s = this.ctx.createBufferSource(); s.buffer = buffer;
    s.start(t, Math.max(0, Math.random() * (buffer.duration - dur - 0.05)), Math.min(dur, buffer.duration));
    return s;
  }

  _chain(t, pan, gain, verb = 0.3) {
    const ctx = this.ctx;
    const g = ctx.createGain(); g.gain.value = 0;
    const p = ctx.createStereoPanner(); p.pan.value = pan;
    g.connect(p).connect(this.bus);
    if (verb > 0) { const v = ctx.createGain(); v.gain.value = verb; p.connect(v).connect(this.verb); }
    return g;
  }

  /** Distant explosion / artillery: arrives dist/343 s later, low-passed by distance. size ~ 0.5..2 */
  boom(pos, size = 1) {
    if (!this._init()) return;
    const ctx = this.ctx, { dist, pan } = this._spatial(pos);
    const t = ctx.currentTime + dist / C;
    const vol = Math.min(1.4, (90 / Math.max(60, dist)) * size);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.setValueAtTime(THREE.MathUtils.clamp(2400 - dist * 4, 160, 1600), t);
    lp.frequency.exponentialRampToValueAtTime(90, t + 2.5);
    const out = this._chain(t, pan, vol, 0.55);
    const dur = 2.2 + size * 1.4;
    // Body: brown-noise rumble with a soft attack (distance smears the transient).
    const n = this._src(this.brown, t, dur + 0.2);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.03 + dist / 6000);
    g.gain.exponentialRampToValueAtTime(vol * 0.25, t + 0.5); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    n.connect(lp).connect(g).connect(out);
    out.gain.value = 1;
    // Sub thump.
    const o = ctx.createOscillator(); o.frequency.setValueAtTime(58 * (1.2 - size * 0.15), t); o.frequency.exponentialRampToValueAtTime(28, t + 0.7);
    const og = ctx.createGain(); og.gain.setValueAtTime(0.0001, t); og.gain.exponentialRampToValueAtTime(vol * 0.9, t + 0.02); og.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    o.connect(og).connect(out); o.start(t); o.stop(t + 1);
    // Rolling echoes off the terrain.
    for (let k = 1; k <= 2; k++) {
      const e = this._src(this.brown, t + 0.35 * k + Math.random() * 0.3, 1.6);
      const eg = ctx.createGain(); const te = t + 0.35 * k;
      eg.gain.setValueAtTime(0.0001, te); eg.gain.exponentialRampToValueAtTime(vol * 0.3 / k, te + 0.12); eg.gain.exponentialRampToValueAtTime(0.0001, te + 1.5);
      const elp = ctx.createBiquadFilter(); elp.type = 'lowpass'; elp.frequency.value = 220;
      e.connect(elp).connect(eg).connect(out);
    }
  }

  /** A burst of distant small-arms fire (pops arrive delayed, thin and low-passed). */
  crackle(pos, shots = 8, rate = 10) {
    if (!this._init()) return;
    const ctx = this.ctx, { dist, pan } = this._spatial(pos);
    const t0 = ctx.currentTime + dist / C;
    const vol = Math.min(0.5, 30 / Math.max(40, dist));
    const out = this._chain(t0, pan, vol, 0.7);
    out.gain.value = 1;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = THREE.MathUtils.clamp(3200 - dist * 5, 700, 2500);
    lp.connect(out);
    let t = t0;
    for (let i = 0; i < shots; i++) {
      t += (1 / rate) * (0.7 + Math.random() * 0.6);
      const s = this._src(this.noise, t, 0.09);
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol * (0.6 + Math.random() * 0.5), t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
      s.connect(g).connect(lp);
    }
  }

  /** Thunder: optional crack, then a long rolling rumble. */
  thunder(delay, strength = 1, pan = 0) {
    if (!this._init()) return;
    const ctx = this.ctx, t = ctx.currentTime + delay;
    const out = this._chain(t, pan, 1, 0.6);
    out.gain.value = 1;
    const dur = 4.5 + Math.random() * 3;
    if (delay < 2.5) {
      const c = this._src(this.noise, t, 0.6);
      const hp = ctx.createBiquadFilter(); hp.type = 'bandpass'; hp.frequency.value = 1200; hp.Q.value = 0.3;
      const cg = ctx.createGain(); cg.gain.setValueAtTime(0.0001, t); cg.gain.exponentialRampToValueAtTime(0.5 * strength, t + 0.01); cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      c.connect(hp).connect(cg).connect(out);
    }
    const r = this._src(this.brown, t, dur);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.setValueAtTime(700, t); lp.frequency.exponentialRampToValueAtTime(110, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    // Irregular rolls.
    let tt = t + 0.05, level = 0.9 * strength;
    g.gain.exponentialRampToValueAtTime(level, tt + 0.3);
    while (tt < t + dur - 0.8) {
      tt += 0.35 + Math.random() * 0.9;
      level *= 0.55 + Math.random() * 0.55;
      g.gain.exponentialRampToValueAtTime(Math.max(0.02, Math.min(1.1, level)), tt);
    }
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    r.connect(lp).connect(g).connect(out);
  }

  /** Per-frame: fire roar from the nearest fire, drizzle hiss. */
  update(dt, { fireDist = 999, firePos = null, rain = 0, indoor = false } = {}) {
    if (!this._init()) return;
    const t = this.ctx.currentTime;
    const fk = THREE.MathUtils.clamp(1 - (fireDist - 1.5) / 22, 0, 1);
    const fv = fk * fk * 0.22;
    this.fireLoop.gain.gain.setTargetAtTime(fv, t, 0.2);
    this.fireLow.gain.gain.setTargetAtTime(fv * 1.4, t, 0.2);
    if (firePos) { const { pan } = this._spatial(firePos); this.fireLoop.pan.pan.setTargetAtTime(pan, t, 0.1); this.fireLow.pan.pan.setTargetAtTime(pan, t, 0.1); }
    // Crackles: Poisson events, sharper when close.
    if (fk > 0.02 && Math.random() < dt * 14 * fk) {
      const s = this._src(this.noise, t, 0.03);
      const hp = this.ctx.createBiquadFilter(); hp.type = 'bandpass'; hp.frequency.value = 1800 + Math.random() * 3000; hp.Q.value = 1.2;
      const g = this.ctx.createGain(); const v = fk * fk * (0.15 + Math.random() * 0.35);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v, t + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.02 + Math.random() * 0.03);
      s.connect(hp).connect(g).connect(this.fireLoop.pan);
    }
    this.rainLoop.gain.gain.setTargetAtTime(rain * (indoor ? 0.012 : 0.03), t, 0.5);
    this.rainLoop.filter2.frequency.setTargetAtTime(indoor ? 1500 : 9000, t, 0.3);
  }

  /** Continuous vehicle voice. kind: 'heli' | 'jet'. Call .set(pos, vel) every frame, .stop() at end. */
  vehicle(kind) {
    if (!this._init()) return null;
    const ctx = this.ctx, t = ctx.currentTime;
    const pan = ctx.createStereoPanner();
    const gain = ctx.createGain(); gain.gain.value = 0;
    const air = ctx.createBiquadFilter(); air.type = 'lowpass'; air.frequency.value = 3000;
    air.connect(gain).connect(pan).connect(this.bus);
    const vs = ctx.createGain(); vs.gain.value = 0.35; pan.connect(vs).connect(this.verb);
    const nodes = [];
    const v = { kind, pan, gain, air, nodes, history: [], base: {} };
    if (kind === 'heli') {
      // Blade slap: band-passed noise amplitude-modulated at blade-pass frequency.
      const n = ctx.createBufferSource(); n.buffer = this.noise; n.loop = true;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 420; bp.Q.value = 0.7;
      const am = ctx.createGain(); am.gain.value = 0.15;
      const lfo = ctx.createOscillator(); lfo.type = 'sawtooth'; lfo.frequency.value = 19;
      const lg = ctx.createGain(); lg.gain.value = 0.85; lfo.connect(lg).connect(am.gain);
      n.connect(bp).connect(am).connect(air);
      // Low rotor thump.
      const b = ctx.createBufferSource(); b.buffer = this.brown; b.loop = true;
      const blp = ctx.createBiquadFilter(); blp.type = 'lowpass'; blp.frequency.value = 160;
      const bam = ctx.createGain(); bam.gain.value = 0.4; const lg2 = ctx.createGain(); lg2.gain.value = 0.6; lfo.connect(lg2).connect(bam.gain);
      b.connect(blp).connect(bam).connect(air);
      // Turbine whine.
      const o1 = ctx.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 1180;
      const o2 = ctx.createOscillator(); o2.type = 'triangle'; o2.frequency.value = 2310;
      const og = ctx.createGain(); og.gain.value = 0.012; const ohp = ctx.createBiquadFilter(); ohp.type = 'highpass'; ohp.frequency.value = 800;
      o1.connect(og); o2.connect(og); og.connect(ohp).connect(air);
      for (const s of [n, b, lfo, o1, o2]) { s.start(t); nodes.push(s); }
      v.base = { lfo: [lfo, 19], o1: [o1, 1180], o2: [o2, 2310], bp: [bp, 420] };
      v.ref = 60; v.level = 1.1;
    } else {
      // Jet: broadband roar + low rumble + a whistle.
      const n = ctx.createBufferSource(); n.buffer = this.noise; n.loop = true;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 0.35;
      const ng = ctx.createGain(); ng.gain.value = 0.6;
      n.connect(bp).connect(ng).connect(air);
      const b = ctx.createBufferSource(); b.buffer = this.brown; b.loop = true;
      const blp = ctx.createBiquadFilter(); blp.type = 'lowpass'; blp.frequency.value = 240;
      const bg = ctx.createGain(); bg.gain.value = 1.1; b.connect(blp).connect(bg).connect(air);
      const o1 = ctx.createOscillator(); o1.type = 'sine'; o1.frequency.value = 3100;
      const og = ctx.createGain(); og.gain.value = 0.01; o1.connect(og).connect(air);
      for (const s of [n, b, o1]) { s.start(t); nodes.push(s); }
      v.base = { bp: [bp, 900], o1: [o1, 3100] };
      v.ref = 260; v.level = 1.3;
    }
    const self = this;
    v.set = (time, pos, vel) => {
      // Keep emission history; we hear the position the sound was emitted from (retarded time).
      v.history.push({ time, x: pos.x, y: pos.y, z: pos.z, vx: vel.x, vy: vel.y, vz: vel.z });
      const L = self.audio.listener.pos;
      let h = v.history[v.history.length - 1];
      for (let i = v.history.length - 1; i >= 0; i--) {
        const e = v.history[i];
        const d = Math.hypot(e.x - L.x, e.y - L.y, e.z - L.z);
        if (time - e.time >= d / C) { h = e; v.history.splice(0, Math.max(0, i - 2)); break; }
        if (i === 0) h = null;
      }
      const ct = self.ctx.currentTime;
      if (!h) { gain.gain.setTargetAtTime(0, ct, 0.1); return; }
      _d.set(h.x, h.y, h.z);
      const { dist, pan: p } = self._spatial(_d);
      // Doppler: f' = f * c / (c - v_radial_towards_listener).
      const toL = _r.set(L.x - h.x, L.y - h.y, L.z - h.z).normalize();
      const vr = h.vx * toL.x + h.vy * toL.y + h.vz * toL.z;
      const dop = THREE.MathUtils.clamp(C / Math.max(60, C - vr), 0.6, 1.8);
      for (const [node, f] of Object.values(v.base)) node.frequency.setTargetAtTime(f * dop, ct, 0.05);
      const g = Math.min(1.2, v.level * v.ref / Math.max(v.ref * 0.5, dist)) * (v.fade ?? 1);
      gain.gain.setTargetAtTime(g * 0.5, ct, 0.08);
      air.frequency.setTargetAtTime(THREE.MathUtils.clamp(14000 - dist * 22, 500, 12000), ct, 0.1);
      pan.pan.setTargetAtTime(p, ct, 0.08);
    };
    v.stop = () => {
      const ct = self.ctx.currentTime;
      gain.gain.setTargetAtTime(0, ct, 0.4);
      for (const s of nodes) s.stop(ct + 2);
    };
    return v;
  }
}
