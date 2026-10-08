import * as THREE from 'three';
import { FOG, syncFog } from './glsl.js';
import { rand } from '../../core/MathUtil.js';

const MAXBOX = 4;

/** Shared GLSL for camera-wrapped particle volumes (rain / motes), with indoor-volume rejection. */
const WRAP = /* glsl */`
  uniform vec3 camPos; uniform vec3 boxSize; uniform float time;
  uniform vec3 inMin[${MAXBOX}]; uniform vec3 inMax[${MAXBOX}];
  vec3 wrapPos(vec3 seedPos, vec3 drift) {
    vec3 lo = camPos - boxSize * 0.5;
    return lo + mod(seedPos * boxSize + drift - lo, boxSize);
  }
  float indoor(vec3 p) {
    for (int i = 0; i < ${MAXBOX}; i++) {
      if (all(greaterThan(p, inMin[i])) && all(lessThan(p, inMax[i]))) return 1.0;
    }
    return 0.0;
  }
`;

function boxUniforms(level) {
  const mins = [], maxs = [];
  const vols = level?.indoorVolumes ?? [];
  for (let i = 0; i < MAXBOX; i++) {
    const b = vols[i];
    // Pad a little so streaks don't poke through walls/windows.
    mins.push(b ? b.min.clone().addScalar(-0.35) : new THREE.Vector3(1e6, 1e6, 1e6));
    maxs.push(b ? b.max.clone().addScalar(0.35) : new THREE.Vector3(1e6 + 1, 1e6 + 1, 1e6 + 1));
  }
  return { inMin: { value: mins }, inMax: { value: maxs } };
}

/**
 * Storm weather: sun-shower drizzle streaks that glint when backlit, wind-blown ash/dust motes that
 * sparkle in the low sun, drifting embers, and lightning (bolt + cloud flash + light + thunder).
 */
export class Weather {
  constructor(amb) {
    this.amb = amb;
    this.game = amb.game;
    this.scene = amb.scene;
    this.time = 0;
    const q = amb.quality;
    this.rainAmount = 0.6;
    this._rainTarget = 0.6;
    this._rainT = rand(20, 40);
    this._buildRain([500, 2200, 4000, 6000][q]);
    this._buildMotes([150, 400, 700, 1000][q], [20, 40, 70, 90][q]);
    if (q >= 1) this._buildSplashes([0, 250, 450, 650][q]);
    this._buildLightning();
    this.nextStrike = rand(9, 16);
  }

  _buildRain(count) {
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < count * 4; i++) seeds[i] = Math.random();
    geo.setAttribute('iSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    geo.instanceCount = count;
    this.rainMat = new THREE.ShaderMaterial({
      uniforms: {
        camPos: { value: new THREE.Vector3() }, boxSize: { value: new THREE.Vector3(40, 26, 40) }, time: { value: 0 },
        ...boxUniforms(this.game.level),
        vel: { value: new THREE.Vector3(1.5, -9, 0.6) }, amount: { value: 0.6 }, len: { value: 0.9 }, width: { value: 0.018 },
        lightCol: { value: new THREE.Color(0.6, 0.6, 0.6) }, sunCol: { value: new THREE.Color(1, 0.8, 0.5) }, sunDir: { value: new THREE.Vector3(0, 1, 0) },
        flash: { value: 0 },
        fogColor: { value: new THREE.Color() }, fogDensity: { value: 0 }, fogScale: { value: 1 },
      },
      vertexShader: /* glsl */`
        attribute vec4 iSeed;
        uniform vec3 vel; uniform float amount; uniform float len; uniform float width;
        ${WRAP}
        varying vec2 vUv; varying float vA; varying float vDepth; varying vec3 vDir;
        void main() {
          float sp = 0.8 + 0.4 * iSeed.w;
          vec3 v = vel * sp;
          vec3 p = wrapPos(iSeed.xyz, v * time);
          vec3 axis = normalize(v);
          vec3 toCam = normalize(cameraPosition - p);
          vec3 side = normalize(cross(axis, toCam));
          float d = distance(p, cameraPosition);
          float w = width * (1.0 + d * 0.06);
          vec3 wp = p - axis * position.y * len * sp + side * position.x * w;
          bool hide = iSeed.w > amount || indoor(p) > 0.5 || p.y < 0.0;
          vec4 mv = viewMatrix * vec4(wp, 1.0);
          gl_Position = hide ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * mv;
          vUv = vec2(position.x + 0.5, position.y);
          vDepth = -mv.z;
          vA = smoothstep(0.8, 2.5, d) * (1.0 - smoothstep(boxSize.x * 0.32, boxSize.x * 0.5, length((p - camPos).xz)));
          vDir = -toCam;
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 lightCol; uniform vec3 sunCol; uniform vec3 sunDir; uniform float flash;
        ${FOG}
        varying vec2 vUv; varying float vA; varying float vDepth; varying vec3 vDir;
        void main() {
          float across = 1.0 - abs(vUv.x * 2.0 - 1.0);
          float along = smoothstep(0.0, 0.25, vUv.y) * (1.0 - smoothstep(0.6, 1.0, vUv.y));
          float a = across * along * vA * 0.42;
          float glint = pow(max(dot(vDir, sunDir), 0.0), 5.0);
          vec3 col = lightCol * 0.8 + sunCol * glint * 2.4 + vec3(0.8, 0.85, 1.0) * flash * 2.0;
          a *= 0.55 + glint * 1.6 + flash;
          a *= 1.0 - a_fog(vDepth) * 0.6;
          if (a < 0.003) discard;
          gl_FragColor = vec4(col, a);
        }`,
      transparent: true, depthWrite: false,
    });
    this.rain = new THREE.Mesh(geo, this.rainMat);
    this.rain.frustumCulled = false;
    this.rain.renderOrder = 14;
    this.scene.add(this.rain);
  }

  _buildMotes(count, emberCount) {
    const mk = (n, additive) => {
      const geo = new THREE.InstancedBufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
      geo.setIndex([0, 1, 2, 0, 2, 3]);
      const seeds = new Float32Array(n * 4);
      for (let i = 0; i < n * 4; i++) seeds[i] = Math.random();
      geo.setAttribute('iSeed', new THREE.InstancedBufferAttribute(seeds, 4));
      geo.instanceCount = n;
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          camPos: { value: new THREE.Vector3() }, boxSize: { value: new THREE.Vector3(26, 14, 26) }, time: { value: 0 },
          ...boxUniforms(this.game.level),
          wind: { value: new THREE.Vector3() }, lightCol: { value: new THREE.Color() }, sunCol: { value: new THREE.Color() },
          sunDir: { value: new THREE.Vector3(0, 1, 0) },
          fogColor: { value: new THREE.Color() }, fogDensity: { value: 0 }, fogScale: { value: 1 },
        },
        vertexShader: /* glsl */`
          attribute vec4 iSeed;
          uniform vec3 wind;
          ${WRAP}
          varying vec2 vUv; varying float vA; varying float vDepth; varying vec3 vDir; varying float vSeed;
          void main() {
            float s = iSeed.w;
            ${additive
              ? 'vec3 drift = wind * time * (0.6 + 0.5 * s) + vec3(0.0, time * (0.15 + 0.3 * s), 0.0);'
              : 'vec3 drift = wind * time * (0.7 + 0.6 * s) + vec3(0.0, -time * (0.1 + 0.25 * s), 0.0);'}
            float ph = s * 60.0;
            drift += vec3(sin(time * 0.9 + ph), sin(time * 1.3 + ph * 1.7) * 0.6, cos(time * 0.7 + ph)) * (0.3 + 0.4 * s);
            vec3 p = wrapPos(iSeed.xyz, drift);
            float d = distance(p, cameraPosition);
            float size = ${additive ? '0.022 + 0.02 * s' : '0.012 + 0.022 * s'};
            vec4 mv = viewMatrix * vec4(p, 1.0);
            float c = cos(time * (1.0 + s * 3.0) + ph), sn = sin(time * (1.0 + s * 3.0) + ph);
            mv.xy += mat2(c, sn, -sn, c) * position.xy * vec2(size, size * ${additive ? '1.0' : '0.55'}) * (1.0 + d * 0.04);
            bool hide = indoor(p) > 0.5 || p.y < 0.05;
            gl_Position = hide ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * mv;
            vUv = position.xy + 0.5; vDepth = -mv.z; vDir = normalize(p - cameraPosition); vSeed = s;
            vA = smoothstep(0.4, 1.5, d) * (1.0 - smoothstep(boxSize.x * 0.3, boxSize.x * 0.5, length((p - camPos).xz)));
          }`,
        fragmentShader: /* glsl */`
          uniform vec3 lightCol; uniform vec3 sunCol; uniform vec3 sunDir; uniform float time;
          ${FOG}
          varying vec2 vUv; varying float vA; varying float vDepth; varying vec3 vDir; varying float vSeed;
          void main() {
            float r = length(vUv - 0.5) * 2.0;
            float m = 1.0 - smoothstep(0.3, 1.0, r);
            ${additive
              ? `float flick = 0.55 + 0.45 * sin(time * (6.0 + vSeed * 9.0) + vSeed * 40.0);
                 vec3 col = vec3(4.0, 1.4, 0.3) * flick; float a = m * vA * 0.9;`
              : `float scat = pow(max(dot(vDir, sunDir), 0.0), 8.0);
                 vec3 col = lightCol * 0.9 + sunCol * scat * 3.0; float a = m * vA * (0.22 + scat * 0.8);`}
            a *= 1.0 - a_fog(vDepth);
            if (a < 0.003) discard;
            gl_FragColor = vec4(col, a);
          }`,
        transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 13;
      this.scene.add(mesh);
      return mat;
    };
    this.moteMat = mk(count, false);
    this.emberMat = mk(emberCount, true);
  }

  /** Rain splashes: tiny crowns popping on the ground around the player (GPU-cycled, no CPU cost). */
  _buildSplashes(count) {
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < count * 4; i++) seeds[i] = Math.random();
    geo.setAttribute('iSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    geo.instanceCount = count;
    this.splashMat = new THREE.ShaderMaterial({
      uniforms: {
        camPos: { value: new THREE.Vector3() }, boxSize: { value: new THREE.Vector3(18, 1, 18) }, time: { value: 0 },
        ...boxUniforms(this.game.level), amount: { value: 0.6 },
        lightCol: { value: new THREE.Color() }, sunCol: { value: new THREE.Color() }, sunDir: { value: new THREE.Vector3(0, 1, 0) },
        fogColor: { value: new THREE.Color() }, fogDensity: { value: 0 }, fogScale: { value: 1 },
      },
      vertexShader: /* glsl */`
        attribute vec4 iSeed;
        uniform float amount;
        ${WRAP}
        varying vec2 vUv; varying float vA; varying float vPh; varying float vDepth;
        float h1(float n) { return fract(sin(n) * 43758.5453); }
        void main() {
          float rate = 1.6 + iSeed.w;
          float cyc = time * rate + iSeed.z * 10.0;
          float ph = fract(cyc), id = floor(cyc);
          vec2 r = vec2(h1(id * 12.9 + iSeed.x * 78.2), h1(id * 4.1 + iSeed.y * 37.7));
          vec3 lo = camPos - boxSize * 0.5;
          vec3 p = vec3(lo.x + r.x * boxSize.x, 0.025, lo.z + r.y * boxSize.z);
          vec3 toCam = cameraPosition - p; toCam.y = 0.0;
          vec3 right = normalize(vec3(toCam.z, 0.0, -toCam.x) + vec3(1e-5));
          float s = 0.05 + 0.07 * ph;
          vec3 wp = p + right * position.x * s * 1.6 + vec3(0.0, position.y * s * (1.0 - ph) * 1.4, 0.0);
          bool hide = iSeed.w > amount || indoor(p + vec3(0.0, 0.5, 0.0)) > 0.5 || ph > 0.35;
          vec4 mv = viewMatrix * vec4(wp, 1.0);
          gl_Position = hide ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * mv;
          vUv = vec2(position.x + 0.5, position.y); vPh = ph / 0.35; vDepth = -mv.z;
          vA = 1.0 - smoothstep(5.0, 9.0, length(toCam));
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 lightCol; uniform vec3 sunCol;
        ${FOG}
        varying vec2 vUv; varying float vA; varying float vPh; varying float vDepth;
        void main() {
          // Crown: two droplet arcs rising from a central point, fading as it ends.
          float x = vUv.x * 2.0 - 1.0, y = vUv.y;
          float crown = smoothstep(0.35, 0.0, abs(abs(x) - (0.25 + 0.5 * vPh) * (1.0 - y * 0.4)) * 4.0 + y * 0.6);
          float a = crown * vA * (1.0 - vPh) * 0.55;
          if (a < 0.003) discard;
          gl_FragColor = vec4(lightCol * 1.2 + sunCol * 0.4, a * (1.0 - a_fog(vDepth)));
        }`,
      transparent: true, depthWrite: false,
    });
    const m = new THREE.Mesh(geo, this.splashMat);
    m.frustumCulled = false; m.renderOrder = 13;
    this.scene.add(m);
  }

  _buildLightning() {
    this.lDir = new THREE.DirectionalLight(0xc8d4ff, 0);
    this.lDir.castShadow = false;
    this.lHemi = new THREE.HemisphereLight(0xb8c6ff, 0x30343c, 0);
    this.scene.add(this.lDir, this.lDir.target, this.lHemi);
    this.boltMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 5.4, 7), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide });
    const g0 = new THREE.BufferGeometry();
    g0.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(9), 3));
    this.bolt = new THREE.Mesh(g0, this.boltMat);
    this.bolt.visible = false;
    this.bolt.frustumCulled = false;
    this.bolt.renderOrder = 2;
    this.scene.add(this.bolt);
    this.flash = { t: 99, pulses: [], strength: 0 };
  }

  /** Jagged, branching bolt as camera-facing ribbons. */
  _makeBolt(top, bottomY, camPos) {
    const pos = [];
    const seg = (pts, w) => {
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const dir = b.clone().sub(a).normalize();
        const side = dir.clone().cross(camPos.clone().sub(a).normalize()).normalize().multiplyScalar(w * (1 - i / pts.length * 0.5));
        const a0 = a.clone().sub(side), a1 = a.clone().add(side), b0 = b.clone().sub(side), b1 = b.clone().add(side);
        pos.push(a0.x, a0.y, a0.z, a1.x, a1.y, a1.z, b1.x, b1.y, b1.z, a0.x, a0.y, a0.z, b1.x, b1.y, b1.z, b0.x, b0.y, b0.z);
      }
    };
    const walk = (start, endY, w, depth) => {
      const pts = [start.clone()];
      const p = start.clone();
      const drift = new THREE.Vector3(rand(-0.6, 0.6), 0, rand(-0.6, 0.6));
      while (p.y > endY) {
        const step = rand(6, 16);
        p.add(new THREE.Vector3(rand(-1, 1) * step * 0.7 + drift.x * step, -step, rand(-1, 1) * step * 0.7 + drift.z * step));
        pts.push(p.clone());
        if (depth < 2 && Math.random() < 0.18) walk(p, p.y - rand(25, 70), w * 0.45, depth + 1);
      }
      seg(pts, w);
    };
    walk(top, bottomY, 1.6, 0);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    this.bolt.geometry.dispose();
    this.bolt.geometry = g;
  }

  strike() {
    const battle = this.amb.battle;
    const az = battle ? battle.frontAz + rand(-1.6, 1.6) : rand(0, Math.PI * 2);
    const d = rand(330, 520), cam = this.amb.camera.position;
    const visibleBolt = Math.random() < 0.65;
    if (visibleBolt) this._makeBolt(new THREE.Vector3(Math.cos(az) * d, rand(230, 300), Math.sin(az) * d), -10, cam);
    this.bolt.visible = visibleBolt;
    const strength = rand(0.6, 1);
    this.flash = { t: 0, strength, pulses: [[0, 0.06], [0.09, 0.05], [0.2, 0.12]].slice(0, 2 + (Math.random() < 0.6 ? 1 : 0)) };
    this.lDir.position.set(Math.cos(az) * 100, 140, Math.sin(az) * 100);
    battle?.pulse(az, { el: 0.3, width: 0.55, intensity: 2.6 * strength, color: [0.7, 0.76, 1], height: 0.5, decay: 9 });
    const delay = (visibleBolt ? d : rand(900, 2500)) / 343;
    const fwd = this.amb.camera.getWorldDirection(new THREE.Vector3());
    const r = new THREE.Vector3(-fwd.z, 0, fwd.x).normalize();
    const pan = THREE.MathUtils.clamp(new THREE.Vector3(Math.cos(az), 0, Math.sin(az)).dot(r), -1, 1) * 0.7;
    this.amb.audio.thunder(delay, strength * (visibleBolt ? 1 : 0.6), pan);
  }

  update(dt, ctx) {
    this.time += dt;
    const t = this.time, cam = ctx.camera.position, L = ctx.light;
    // Drizzle comes and goes.
    if ((this._rainT -= dt) <= 0) { this._rainT = rand(25, 60); this._rainTarget = Math.random() < 0.25 ? rand(0.05, 0.2) : rand(0.4, 0.9); }
    this.rainAmount += (this._rainTarget - this.rainAmount) * Math.min(1, dt * 0.15);
    const ru = this.rainMat.uniforms;
    ru.time.value = t; ru.camPos.value.copy(cam); ru.amount.value = this.rainAmount;
    ru.vel.value.set(ctx.wind.x * 0.8, -9, ctx.wind.z * 0.8);
    ru.lightCol.value.copy(L.ambient); ru.sunCol.value.copy(L.sun); ru.sunDir.value.copy(L.sunDir);
    syncFog(this.rainMat, this.scene);
    for (const m of [this.moteMat, this.emberMat]) {
      const u = m.uniforms;
      u.time.value = t; u.camPos.value.copy(cam); u.wind.value.copy(ctx.wind);
      u.lightCol.value.copy(L.ambient); u.sunCol.value.copy(L.sun); u.sunDir.value.copy(L.sunDir);
      syncFog(m, this.scene);
    }

    if (this.splashMat) {
      const u = this.splashMat.uniforms;
      u.time.value = t; u.camPos.value.copy(cam); u.amount.value = this.rainAmount;
      u.lightCol.value.copy(L.ambient); u.sunCol.value.copy(L.sun);
      syncFog(this.splashMat, this.scene);
    }
    // Lightning.
    if ((this.nextStrike -= dt) <= 0) { this.strike(); this.nextStrike = rand(16, 42); }
    const f = this.flash;
    f.t += dt;
    let k = 0;
    for (const [s, len] of f.pulses) if (f.t >= s && f.t < s + len + 0.25) k = Math.max(k, f.t < s + len ? 1 : Math.exp(-(f.t - s - len) * 18));
    k *= f.strength;
    this.lDir.intensity = k * 3.2;
    this.lHemi.intensity = k * 1.1;
    this.boltMat.opacity = this.bolt.visible ? k : 0;
    ru.flash.value = k;
    this.flashLevel = k;
  }
}
