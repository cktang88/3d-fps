import * as THREE from 'three';
import { AmbParticles } from './AmbParticles.js';
import { NOISE } from './glsl.js';
import { smokeAtlas, glowTex } from '../../render/ProcTex.js';
import { rand } from '../../core/MathUtil.js';

const R = 360; // radius of the horizon light band
const SLOTS = 16;
const TAU = Math.PI * 2;
const wrap = (a) => ((((a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;

/**
 * The war beyond the wall: artillery flashes that light the cloud base, delayed booms, AA tracer
 * streams, parachute illumination flares with smoke trails, burning-city horizon glow, and billowing
 * smoke columns rising from the skyline. Everything lives 150–450 m out.
 */
export class DistantBattle {
  constructor(amb) {
    this.amb = amb;
    this.game = amb.game;
    this.scene = amb.scene;
    this.time = 0;
    this.queue = [];
    const sd = this.game.level?.sunDir ?? new THREE.Vector3(0.3, 0.5, 0.8);
    // The front sits roughly opposite the low sun, against the darker storm side of the sky.
    this.frontAz = Math.atan2(sd.z, sd.x) + Math.PI + 0.35;
    this.frontW = 1.25; // ± radians

    this._buildGlow();
    const glow = glowTex(), smoke = smokeAtlas();
    this.flashes = new AmbParticles(this.scene, { max: 64, texture: glow, additive: true, fogScale: 0.11, nearFade: 0, renderOrder: 4 });
    this.tracers = new AmbParticles(this.scene, { max: 700, texture: glow, additive: true, stretch: 0.055, fogScale: 0.1, nearFade: 0, renderOrder: 5 });
    this.fireballs = new AmbParticles(this.scene, { max: 120, texture: smoke, atlas: 4, additive: true, fogScale: 0.13, nearFade: 0, renderOrder: 5 });
    this.smoke = new AmbParticles(this.scene, { max: 900, texture: smoke, atlas: 4, lit: true, sort: true, fogScale: 0.14, nearFade: 0, renderOrder: 3 });

    // Smoke columns from burning buildings on the skyline.
    this.columns = [];
    const nCol = amb.quality === 0 ? 2 : 4;
    for (let i = 0; i < nCol; i++) {
      const az = this.frontAz + (i / (nCol - 1) - 0.5) * this.frontW * 1.6 + rand(-0.12, 0.12);
      const d = rand(230, 380);
      this.columns.push({ pos: this._at(az, d, 0), az, dist: d, acc: 0, rate: rand(0.45, 0.6), scale: rand(0.85, 1.25), slot: this._slot(true) });
    }
    // One column behind the player's usual sightline, so every direction has something.
    const backAz = this.frontAz + Math.PI + rand(-0.4, 0.4);
    this.columns.push({ pos: this._at(backAz, 300, 0), az: backAz, dist: 300, acc: 0, rate: 0.35, scale: 0.8, slot: this._slot(true) });
    this.frontSlot = this._slot(true);

    this.flares = [];
    this.flareLight = null;
    if (amb.quality >= 1) {
      this.flareLight = new THREE.PointLight(0xffeedd, 0, 0, 2);
      this.flareLight.castShadow = false;
      this.scene.add(this.flareLight);
    }
    this.next = { art: 2, tracer: 1, flare: 6, big: rand(25, 40), crackle: 1.5 };
    this._prewarm();
  }

  _at(az, d, y) { return new THREE.Vector3(Math.cos(az) * d, y, Math.sin(az) * d); }
  _frontAz(spread = 1) { return this.frontAz + rand(-1, 1) * this.frontW * spread; }

  // ------------------------------------------------------------------ horizon light band
  _buildGlow() {
    this.slots = [];
    const A = [], B = [];
    for (let i = 0; i < SLOTS; i++) { A.push(new THREE.Vector4(0, 0, 0.1, 0)); B.push(new THREE.Vector4(1, 0.5, 0.2, 0.1)); this.slots.push({ used: false, decay: 0, persist: false }); }
    this.glowA = A; this.glowB = B;
    const geo = new THREE.CylinderGeometry(R, R, 300, 160, 1, true);
    geo.translate(0, 148, 0);
    this.glowMat = new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 }, gA: { value: A }, gB: { value: B }, gain: { value: 1 } },
      vertexShader: /* glsl */`
        varying vec3 vW;
        void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: /* glsl */`
        #define PI 3.14159265
        uniform float time; uniform vec4 gA[${SLOTS}]; uniform vec4 gB[${SLOTS}]; uniform float gain;
        varying vec3 vW;
        ${NOISE}
        void main() {
          float az = atan(vW.z, vW.x);
          float el = vW.y / ${R.toFixed(1)};
          // Cloud-base structure revealed by the light (two octave bands, slowly drifting).
          float c1 = a_fbm(vec2(az * 8.0 + time * 0.006, el * 20.0 - time * 0.01));
          float c2 = a_fbm(vec2(az * 26.0 - time * 0.01, el * 46.0 + 3.0));
          float cloud = smoothstep(0.3, 0.85, c1 * 0.75 + c2 * 0.4);
          vec3 acc = vec3(0.0);
          for (int i = 0; i < ${SLOTS}; i++) {
            vec4 A = gA[i]; vec4 B = gB[i];
            if (A.w <= 0.0) continue;
            float da = mod(az - A.x + PI, 2.0 * PI) - PI;
            float g = exp(-da * da / (A.z * A.z));
            float de = el - A.y;
            g *= de > 0.0 ? exp(-de / B.w) : exp(de / 0.012);
            acc += B.rgb * g * A.w;
          }
          vec3 col = acc * (0.18 + 1.5 * cloud) * gain;
          col *= smoothstep(-0.004, 0.012, el);
          gl_FragColor = vec4(col, 1.0);
        }`,
      transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, side: THREE.BackSide, fog: false,
    });
    this.glow = new THREE.Mesh(geo, this.glowMat);
    this.glow.frustumCulled = false;
    this.glow.renderOrder = 1;
    this.scene.add(this.glow);
  }

  _slot(persist = false) {
    let i = this.slots.findIndex((s) => !s.used);
    if (i < 0) { // steal the dimmest transient slot
      let best = -1, bv = 1e9;
      this.slots.forEach((s, k) => { if (!s.persist && this.glowA[k].w < bv) { bv = this.glowA[k].w; best = k; } });
      i = best;
    }
    this.slots[i].used = true; this.slots[i].persist = persist;
    return i;
  }

  /** A light pulse on the cloud base / horizon. */
  pulse(az, { el = 0.015, width = 0.08, intensity = 2, color = [1, 0.5, 0.2], height = 0.07, decay = 6 } = {}) {
    const i = this._slot(false);
    this.glowA[i].set(az, el, width, intensity);
    this.glowB[i].set(color[0], color[1], color[2], height);
    this.slots[i].decay = decay;
    return i;
  }

  _schedule(delay, fn) { this.queue.push({ t: this.time + delay, fn }); }

  // ------------------------------------------------------------------ events
  artillery(salvo = 1, az0 = this._frontAz(), d0 = rand(180, 440)) {
    for (let s = 0; s < salvo; s++) {
      this._schedule(s * rand(0.15, 0.6), () => {
        const az = az0 + rand(-0.05, 0.05), d = d0 + rand(-25, 25);
        const p = this._at(az, d, rand(1, 6));
        const big = Math.random() < 0.25;
        this.flashes.spawn({ x: p.x, y: p.y + 4, z: p.z, life: rand(0.18, 0.35), size0: big ? 90 : 55, size1: big ? 120 : 75, color: [12, 6, 2.6], alpha: 1 });
        this.pulse(az, { intensity: (big ? 3.2 : 1.8) * (300 / d), width: rand(0.05, 0.09), decay: rand(5, 9), color: [1, 0.55, 0.26], height: rand(0.05, 0.1) });
        // A little burst of dust/smoke that rises behind the wall.
        for (let k = 0; k < (big ? 6 : 3); k++) this.smoke.spawn({
          x: p.x + rand(-6, 6), y: p.y + rand(2, 8), z: p.z + rand(-6, 6), vx: rand(-1, 1), vy: rand(3, 7), vz: rand(-1, 1),
          life: rand(14, 22), size0: 10, size1: rand(26, 40), alpha: 0.4, color: [0.2, 0.18, 0.16], color1: [0.32, 0.3, 0.28],
          emissive: [2.2, 0.9, 0.3], emissiveSpan: 0.05, drag: 0.15, wind: 1, rotV: rand(-0.1, 0.1),
        });
        this.amb.audio.boom(p, big ? 1.4 : rand(0.6, 1));
      });
    }
  }

  bigExplosion(az = this._frontAz(0.8), d = rand(200, 320)) {
    const p = this._at(az, d, 4);
    this.flashes.spawn({ x: p.x, y: p.y + 10, z: p.z, life: 0.45, size0: 100, size1: 135, color: [10, 4.6, 1.7], alpha: 1 });
    this.pulse(az, { intensity: 6 * (260 / d), width: 0.2, decay: 2.2, color: [1, 0.55, 0.25], height: 0.14 });
    for (let k = 0; k < 26; k++) {
      const a = rand(0, TAU), s = rand(4, 18);
      this.fireballs.spawn({
        x: p.x + rand(-5, 5), y: p.y + rand(0, 10), z: p.z + rand(-5, 5), vx: Math.cos(a) * s * 0.6, vy: rand(10, 30), vz: Math.sin(a) * s * 0.6,
        life: rand(1.4, 3.2), size0: rand(14, 22), size1: rand(40, 60), alpha: 0.9, color: [5, 1.9, 0.5], drag: 1.1, gravity: -2, rotV: rand(-0.5, 0.5),
      });
    }
    for (let k = 0; k < 22; k++) {
      const a = rand(0, TAU), s = rand(2, 10);
      this.smoke.spawn({
        x: p.x + rand(-8, 8), y: p.y + rand(4, 26), z: p.z + rand(-8, 8), vx: Math.cos(a) * s, vy: rand(6, 20), vz: Math.sin(a) * s,
        life: rand(30, 45), size0: rand(20, 30), size1: rand(65, 95), alpha: 0.8, fadeIn: 0.02,
        color: [0.08, 0.07, 0.065], color1: [0.22, 0.21, 0.2], colorSpan: 0.7, emissive: [4, 1.5, 0.4], emissiveSpan: 0.08,
        drag: 0.12, wind: 1, rotV: rand(-0.15, 0.15),
      });
    }
    this.amb.audio.boom(p, 2.4);
    // When the pressure wave arrives, the ground rumbles subtly.
    const dist = p.distanceTo(this.amb.camera.position);
    this._schedule(dist / 343, () => this.game.fpcam?.addTrauma?.(0.12));
  }

  tracerBurst(az = this._frontAz(1.1), d = rand(170, 380)) {
    const origin = this._at(az, d, rand(0, 3));
    const aa = Math.random() < 0.7; // AA arcs vs low ground fire
    const el = aa ? rand(0.5, 1.15) : rand(0.08, 0.22);
    const towards = aa ? az + Math.PI + rand(-1.4, 1.4) : az + Math.PI / 2 * (Math.random() < 0.5 ? -1 : 1) + rand(-0.4, 0.4);
    const count = (aa ? rand(18, 45) : rand(10, 24)) | 0, rate = rand(9, 15), speed = aa ? rand(240, 320) : rand(200, 260);
    const sweep = rand(-0.25, 0.25), green = Math.random() < 0.15;
    const col = green ? [2.2, 10, 2.6] : [12, 2.8, 0.8];
    for (let i = 0; i < count; i++) {
      if (i % 4 !== 0 && !aa) continue; // only every 4th round is a tracer in ground fire
      this._schedule(i / rate, () => {
        const h = towards + sweep * (i / count) + rand(-0.02, 0.02), e = el + rand(-0.03, 0.03);
        const v = new THREE.Vector3(Math.cos(h) * Math.cos(e), Math.sin(e), Math.sin(h) * Math.cos(e)).multiplyScalar(speed);
        this.tracers.spawn({ x: origin.x, y: origin.y, z: origin.z, vx: v.x, vy: v.y, vz: v.z, life: rand(2.2, 3.4), size0: 1.5, alpha: 1, color: col, gravity: 9.8 });
      });
    }
    if (Math.random() < 0.6) this.amb.audio.crackle(origin, Math.min(30, count), rate);
  }

  launchFlare(az = this._frontAz(0.9), d = rand(110, 230)) {
    const ground = this._at(az, d, 0);
    const top = rand(140, 210);
    const core = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.flashes.mat.uniforms.map.value, color: new THREE.Color(9, 8, 6.5), blending: THREE.AdditiveBlending, depthWrite: false, fog: false, transparent: true }));
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.flashes.mat.uniforms.map.value, color: new THREE.Color(1, 0.85, 0.65), blending: THREE.AdditiveBlending, depthWrite: false, fog: false, transparent: true, opacity: 0 }));
    core.renderOrder = halo.renderOrder = 6;
    const chute = new THREE.Mesh(new THREE.SphereGeometry(1.4, 10, 5, 0, TAU, 0, Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x2a2724, fog: true }));
    chute.scale.y = 0.6;
    const g = new THREE.Group(); g.add(halo, core, chute);
    chute.position.y = 6;
    g.position.copy(ground).setY(5);
    this.scene.add(g);
    this.flares.push({ g, core, halo, chute, ground, top, state: 'rise', t: 0, burn: rand(28, 40), sway: rand(0, 6), trailAcc: 0 });
  }

  // ------------------------------------------------------------------ update
  _prewarm() {
    const ctx = { wind: this.amb.wind, camera: this.amb.camera, light: this.amb.light, particleScale: 1 };
    for (let i = 0; i < 70; i++) this._columns(0.8, ctx, true);
  }

  _columns(dt, ctx, warm = false) {
    for (const c of this.columns) {
      c.acc += dt * c.rate * (warm ? 1 : ctx.particleScale);
      while (c.acc >= 1) {
        c.acc -= 1;
        const s = c.scale;
        this.smoke.spawn({
          x: c.pos.x + rand(-7, 7) * s, y: rand(6, 14), z: c.pos.z + rand(-7, 7) * s, vx: rand(-0.8, 0.8), vy: rand(5, 7.5) * s, vz: rand(-0.8, 0.8),
          life: rand(55, 75), size0: 18 * s, size1: rand(75, 105) * s, alpha: rand(0.75, 0.9), fadeIn: 0.03,
          color: [0.05, 0.045, 0.04], color1: [0.18, 0.17, 0.16], colorSpan: 0.8, emissive: [3.2, 1.2, 0.35], emissiveSpan: 0.07,
          drag: 0.028, wind: 0.75, rotV: rand(-0.06, 0.06), turb: 0.05,
        });
      }
    }
    if (warm) this.smoke.update(dt, ctx.wind, null, null, null);
  }

  update(dt, ctx) {
    this.time += dt;
    const t = this.time;
    for (let i = this.queue.length - 1; i >= 0; i--) if (this.queue[i].t <= t) { const q = this.queue[i]; this.queue.splice(i, 1); q.fn(); }

    // Event scheduler.
    if ((this.next.art -= dt) <= 0) { this.artillery(Math.random() < 0.3 ? (3 + Math.random() * 4) | 0 : 1); this.next.art = rand(2.5, 8); }
    if ((this.next.tracer -= dt) <= 0) { this.tracerBurst(); this.next.tracer = rand(1.2, 4.5); }
    if ((this.next.flare -= dt) <= 0) { if (this.flares.length < 3) this.launchFlare(); this.next.flare = rand(14, 32); }
    if ((this.next.big -= dt) <= 0) { this.bigExplosion(); this.next.big = rand(45, 95); }
    if ((this.next.crackle -= dt) <= 0) { this.amb.audio.crackle(this._at(this._frontAz(), rand(250, 450), 0), (rand(3, 14)) | 0, rand(6, 12)); this.next.crackle = rand(0.8, 3.5); }

    // Glow slots: transient decay; persistent fire glows flicker.
    for (let i = 0; i < SLOTS; i++) {
      const s = this.slots[i], A = this.glowA[i];
      if (!s.used || s.persist) continue;
      A.w *= Math.exp(-s.decay * dt);
      if (A.w < 0.01) { A.w = 0; s.used = false; }
    }
    const fA = this.glowA[this.frontSlot];
    fA.set(this.frontAz, 0, this.frontW * 0.75, 0.22 + 0.04 * Math.sin(t * 0.7) + 0.03 * Math.sin(t * 2.3));
    this.glowB[this.frontSlot].set(1, 0.33, 0.1, 0.035);
    for (const c of this.columns) {
      const A = this.glowA[c.slot];
      A.set(c.az, 0.004, 9 / c.dist, (0.9 + 0.25 * Math.sin(t * 3.1 + c.az * 9) + 0.15 * Math.sin(t * 7.7 + c.az)) * (250 / c.dist));
      this.glowB[c.slot].set(1, 0.42, 0.12, 0.05);
    }
    this.glowMat.uniforms.time.value = t;

    this._columns(dt, ctx);

    // Flares.
    let brightest = null, bv = 0;
    for (let i = this.flares.length - 1; i >= 0; i--) {
      const f = this.flares[i];
      f.t += dt;
      const p = f.g.position;
      let b = 0;
      if (f.state === 'rise') {
        const k = Math.min(1, f.t / 1.6);
        p.y = 5 + (f.top - 5) * (1 - (1 - k) * (1 - k));
        f.core.scale.setScalar(1.2); f.core.material.color.setRGB(4, 2.4, 1.2);
        f.chute.visible = false;
        if (k >= 1) { f.state = 'burn'; f.t = 0; f.chute.visible = true; this.amb.audio.boom(p, 0.25); }
        if (Math.random() < 0.6) this.tracers.spawn({ x: p.x, y: p.y, z: p.z, vx: 0, vy: 1, vz: 0, life: 0.5, size0: 0.8, color: [3, 1.5, 0.6] });
      } else {
        const life = f.t / f.burn;
        const ign = Math.min(1, f.t / 0.6), out = life > 0.88 ? Math.max(0, 1 - (life - 0.88) / 0.12) : 1;
        b = ign * out * (0.85 + 0.1 * Math.sin(f.t * 17) + 0.08 * (Math.random() - 0.5));
        p.y -= 3.2 * dt;
        p.x += (ctx.wind.x * 0.8) * dt; p.z += (ctx.wind.z * 0.8) * dt;
        const sw = Math.sin(f.t * 1.1 + f.sway) * 0.18;
        f.core.position.set(Math.sin(sw) * 6, -Math.cos(sw) * 6 + 6, 0);
        f.chute.rotation.z = sw * 0.5;
        f.core.scale.setScalar(4 + b * 2);
        f.core.material.color.setRGB(9 * b, 8.2 * b, 6.8 * b);
        f.halo.scale.setScalar(55 + 10 * b);
        f.halo.material.opacity = 0.45 * b;
        f.halo.position.copy(f.core.position);
        f.trailAcc += dt * 2.6 * ctx.particleScale;
        while (f.trailAcc >= 1 && b > 0.05) {
          f.trailAcc -= 1;
          const w = f.core.getWorldPosition(new THREE.Vector3());
          this.smoke.spawn({
            x: w.x + rand(-0.3, 0.3), y: w.y - 0.5, z: w.z + rand(-0.3, 0.3), vx: rand(-0.2, 0.2), vy: rand(0.2, 0.8), vz: rand(-0.2, 0.2),
            life: rand(14, 20), size0: 2.2, size1: rand(11, 16), alpha: 0.32, color: [0.55, 0.53, 0.5], color1: [0.4, 0.39, 0.38],
            emissive: [2.2, 2, 1.7], emissiveSpan: 0.06, drag: 0.4, wind: 1, rotV: rand(-0.2, 0.2), turb: 0.15,
          });
        }
        if (life >= 1) { this.scene.remove(f.g); f.core.material.dispose(); f.halo.material.dispose(); f.chute.geometry.dispose(); this.flares.splice(i, 1); continue; }
      }
      // Fog-out the sprites with distance (sprites ignore fog here so we control it).
      const fog = this.scene.fog, dist = p.distanceTo(ctx.camera.position);
      const fk = fog?.density ? Math.exp(-Math.pow(fog.density * 0.2 * dist, 2)) : 1;
      f.core.material.opacity = fk; f.halo.material.opacity *= fk;
      if (b > bv) { bv = b; brightest = f; }
    }
    if (this.flareLight) {
      if (brightest) {
        brightest.core.getWorldPosition(this.flareLight.position);
        this.flareLight.intensity = 9000 * bv;
      } else this.flareLight.intensity = 0;
    }

    const light = ctx.light;
    this.flashes.update(dt, null, null, this.scene, null);
    this.tracers.update(dt, null, null, this.scene, null);
    this.fireballs.update(dt, ctx.wind, null, this.scene, null);
    this.smoke.update(dt, ctx.wind, ctx.camera, this.scene, light);
  }
}
