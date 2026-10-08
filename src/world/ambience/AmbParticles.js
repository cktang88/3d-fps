import * as THREE from 'three';
import { FOG, syncFog } from './glsl.js';

/**
 * Instanced camera-facing particles for the ambience layer (fires, plumes, distant battle).
 * Like render/Effects' ParticleSystem but with: wind coupling, albedo + emissive colour over life,
 * fake volumetric lighting (dense core darker, sun forward-scatter on thin edges), animated atlas,
 * near-camera fade (no hard quad clipping), per-system fog scale and optional back-to-front sort.
 * One draw call per system.
 */
export class AmbParticles {
  constructor(scene, {
    max = 400, texture, atlas = 1, additive = false, stretch = 0, lit = false, fogScale = 1, nearFade = 0.6,
    sort = false, renderOrder, flipbook = false,
  }) {
    this.max = max;
    this.count = 0;
    this.atlas = atlas;
    this.ax = atlas; this.ay = atlas;
    this.sort = sort;
    this.additive = additive;
    const f = (n) => new Float32Array(max * n);
    Object.assign(this, {
      p: f(3), v: f(3), life: f(1), maxLife: f(1), s0: f(1), s1: f(1), rot: f(1), rotV: f(1),
      c0: f(3), c1: f(3), cSpan: f(1), e0: f(3), eSpan: f(1), a0: f(1), fadeIn: f(1), grav: f(1), drag: f(1),
      windK: f(1), frame: f(1), frameRate: f(1), turb: f(1),
    });
    this._order = new Int32Array(max);
    this._dist = new Float32Array(max);

    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const ia = (n) => new THREE.InstancedBufferAttribute(new Float32Array(max * n), n).setUsage(THREE.DynamicDrawUsage);
    this.aPos = ia(3); this.aVel = ia(3); this.aCol = ia(4); this.aEmi = ia(3); this.aMisc = ia(3);
    geo.setAttribute('iPos', this.aPos); geo.setAttribute('iVel', this.aVel); geo.setAttribute('iCol', this.aCol);
    geo.setAttribute('iEmi', this.aEmi); geo.setAttribute('iMisc', this.aMisc);
    geo.instanceCount = 0;
    this.geo = geo;

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: texture }, atlas: { value: new THREE.Vector2(atlas, atlas) }, aspect: { value: 1 }, stretch: { value: stretch },
        lightCol: { value: new THREE.Color(1, 1, 1) }, sunCol: { value: new THREE.Color(0, 0, 0) },
        sunDir: { value: new THREE.Vector3(0, 1, 0) }, nearFade: { value: nearFade },
        fogColor: { value: new THREE.Color() }, fogDensity: { value: 0 }, fogScale: { value: fogScale },
      },
      vertexShader: /* glsl */`
        attribute vec3 iPos; attribute vec3 iVel; attribute vec4 iCol; attribute vec3 iEmi; attribute vec3 iMisc;
        uniform float stretch; uniform vec2 atlas; uniform float aspect;
        varying vec2 vUv; varying vec4 vCol; varying vec3 vEmi; varying float vDepth; varying vec3 vDir;
        void main() {
          float size = iMisc.x, rot = iMisc.y, frame = iMisc.z;
          vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
          vec2 corner = position.xy;
          if (stretch > 0.0) {
            vec2 d = (modelViewMatrix * vec4(iVel, 0.0)).xy; float l = length(d);
            vec2 dir = l > 1e-4 ? d / l : vec2(0.0, 1.0);
            mv.xy += dir * corner.y * (size * 2.0 + l * stretch) + vec2(-dir.y, dir.x) * corner.x * size;
          } else {
            float c = cos(rot), s = sin(rot);
            mv.xy += mat2(c, s, -s, c) * vec2(corner.x, corner.y * aspect) * size;
          }
          gl_Position = projectionMatrix * mv;
          float fx = mod(frame, atlas.x), fy = floor(frame / atlas.x);
          vUv = (uv + vec2(fx, atlas.y - 1.0 - fy)) / atlas;
          vCol = iCol; vEmi = iEmi; vDepth = -mv.z;
          vDir = normalize(iPos - cameraPosition);
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D map; uniform vec3 lightCol; uniform vec3 sunCol; uniform vec3 sunDir; uniform float nearFade;
        ${FOG}
        varying vec2 vUv; varying vec4 vCol; varying vec3 vEmi; varying float vDepth; varying vec3 vDir;
        void main() {
          vec4 t = texture2D(map, vUv);
          float a = t.a * vCol.a * smoothstep(nearFade * 0.25, nearFade, vDepth);
          float f = a_fog(vDepth);
          #ifdef LIT
            // Thick core self-shadows; thin edges catch light and forward-scatter the low sun.
            float thin = 1.0 - t.a;
            vec3 rgb = vCol.rgb * lightCol * (0.55 + 0.6 * thin) * (0.8 + 0.25 * t.r);
            rgb += vCol.rgb * sunCol * pow(max(dot(vDir, sunDir), 0.0), 6.0) * thin * 1.6;
            rgb += vEmi * (0.6 + 0.6 * t.a);
            rgb = mix(rgb, fogColor, f);
          #elif defined(FLIPBOOK)
            // Pre-rendered fire/smoke flipbook: boost the hot (bright, warm) texels into HDR for bloom.
            float hot = smoothstep(0.35, 0.95, t.r) * smoothstep(0.0, 0.25, t.r - t.b);
            vec3 rgb = t.rgb * vCol.rgb * (1.0 + hot * 5.0) + vEmi * t.a;
            rgb = mix(rgb, fogColor, f * (1.0 - hot));
          #else
            vec3 rgb = t.rgb * vCol.rgb + vEmi;
            a *= 1.0 - f;
          #endif
          if (a < 0.002) discard;
          gl_FragColor = vec4(rgb, a);
        }`,
      defines: lit ? { LIT: 1 } : flipbook ? { FLIPBOOK: 1 } : {},
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder ?? (additive ? 12 : 10);
    scene.add(this.mesh);
  }

  /** Swap in a (loaded) atlas texture, e.g. a pre-rendered flipbook. */
  setAtlas(texture, atlas, lifeFrames = false, atlasY = atlas, aspect = 1) {
    if (!texture) return;
    this.atlas = atlas; this.ax = atlas; this.ay = atlasY;
    this.mat.uniforms.aspect.value = aspect;
    this.lifeFrames = lifeFrames;
    this.mat.uniforms.map.value = texture;
    this.mat.uniforms.atlas.value.set(atlas, atlasY);
  }

  spawn(o) {
    let i;
    if (this.count < this.max) i = this.count++;
    else {
      // Replace the oldest-looking slot rather than a random one (avoids popping fresh particles).
      let best = 0, bt = -1;
      for (let k = 0; k < 16; k++) { const j = (Math.random() * this.max) | 0; const t = this.life[j] / this.maxLife[j]; if (t > bt) { bt = t; best = j; } }
      i = best;
    }
    const i3 = i * 3;
    this.p[i3] = o.x; this.p[i3 + 1] = o.y; this.p[i3 + 2] = o.z;
    this.v[i3] = o.vx || 0; this.v[i3 + 1] = o.vy || 0; this.v[i3 + 2] = o.vz || 0;
    this.life[i] = 0; this.maxLife[i] = o.life || 1;
    this.s0[i] = o.size0 ?? 0.2; this.s1[i] = o.size1 ?? this.s0[i];
    this.rot[i] = o.rot ?? Math.random() * Math.PI * 2; this.rotV[i] = o.rotV ?? 0;
    const c0 = o.color || [1, 1, 1], c1 = o.color1 || c0, e = o.emissive || [0, 0, 0];
    for (let k = 0; k < 3; k++) { this.c0[i3 + k] = c0[k]; this.c1[i3 + k] = c1[k]; this.e0[i3 + k] = e[k]; }
    this.cSpan[i] = o.colorSpan ?? 1; this.eSpan[i] = o.emissiveSpan ?? 0.3;
    this.a0[i] = o.alpha ?? 1; this.fadeIn[i] = o.fadeIn ?? 0;
    this.grav[i] = o.gravity ?? 0; this.drag[i] = o.drag ?? 0; this.windK[i] = o.wind ?? 0; this.turb[i] = o.turb ?? 0;
    this.frame[i] = o.frame ?? ((Math.random() * this.ax * this.ay) | 0);
    this.frameRate[i] = o.frameRate ?? (this.lifeFrames ? -1 : 0);
  }

  _copy(from, to) {
    for (const k of ['p', 'v', 'c0', 'c1', 'e0']) { const a = this[k]; a[to * 3] = a[from * 3]; a[to * 3 + 1] = a[from * 3 + 1]; a[to * 3 + 2] = a[from * 3 + 2]; }
    for (const k of ['life', 'maxLife', 's0', 's1', 'rot', 'rotV', 'cSpan', 'eSpan', 'a0', 'fadeIn', 'grav', 'drag', 'windK', 'frame', 'frameRate', 'turb']) this[k][to] = this[k][from];
  }

  update(dt, wind, camera, scene, light) {
    let n = this.count;
    const wx = wind?.x ?? 0, wy = wind?.y ?? 0, wz = wind?.z ?? 0;
    for (let i = 0; i < n; i++) {
      this.life[i] += dt;
      if (this.life[i] >= this.maxLife[i]) { n--; if (i !== n) this._copy(n, i); i--; continue; }
      const i3 = i * 3, d = Math.exp(-this.drag[i] * dt), tb = this.turb[i];
      if (tb > 0) {
        this.v[i3] += (Math.random() - 0.5) * tb * dt * 10;
        this.v[i3 + 1] += (Math.random() - 0.5) * tb * dt * 6;
        this.v[i3 + 2] += (Math.random() - 0.5) * tb * dt * 10;
      }
      this.v[i3] *= d; this.v[i3 + 1] = this.v[i3 + 1] * d - this.grav[i] * dt; this.v[i3 + 2] *= d;
      const wk = this.windK[i] * Math.min(1, this.life[i] * 0.6 + 0.2);
      this.p[i3] += (this.v[i3] + wx * wk) * dt;
      this.p[i3 + 1] += (this.v[i3 + 1] + wy * wk) * dt;
      this.p[i3 + 2] += (this.v[i3 + 2] + wz * wk) * dt;
      this.rot[i] += this.rotV[i] * dt;
    }
    this.count = n;

    const order = this._order;
    for (let i = 0; i < n; i++) order[i] = i;
    if (this.sort && camera && n > 1) {
      const cp = camera.position, D = this._dist;
      for (let i = 0; i < n; i++) { const dx = this.p[i * 3] - cp.x, dy = this.p[i * 3 + 1] - cp.y, dz = this.p[i * 3 + 2] - cp.z; D[i] = dx * dx + dy * dy + dz * dz; }
      const sub = order.subarray(0, n);
      sub.sort((a, b) => D[b] - D[a]);
    }

    const P = this.aPos.array, V = this.aVel.array, C = this.aCol.array, E = this.aEmi.array, M = this.aMisc.array;
    const atl2 = this.ax * this.ay;
    for (let j = 0; j < n; j++) {
      const i = order[j], i3 = i * 3, t = this.life[i] / this.maxLife[i];
      P[j * 3] = this.p[i3]; P[j * 3 + 1] = this.p[i3 + 1]; P[j * 3 + 2] = this.p[i3 + 2];
      V[j * 3] = this.v[i3]; V[j * 3 + 1] = this.v[i3 + 1]; V[j * 3 + 2] = this.v[i3 + 2];
      const ct = Math.min(1, t / this.cSpan[i]), cs = ct * ct * (3 - 2 * ct);
      C[j * 4] = this.c0[i3] + (this.c1[i3] - this.c0[i3]) * cs;
      C[j * 4 + 1] = this.c0[i3 + 1] + (this.c1[i3 + 1] - this.c0[i3 + 1]) * cs;
      C[j * 4 + 2] = this.c0[i3 + 2] + (this.c1[i3 + 2] - this.c0[i3 + 2]) * cs;
      const fi = this.fadeIn[i] > 0 ? Math.min(1, t / this.fadeIn[i]) : 1;
      C[j * 4 + 3] = this.a0[i] * fi * (1 - t) * (1 - t * 0.3);
      const et = Math.max(0, 1 - t / this.eSpan[i]), ek = et * et;
      E[j * 3] = this.e0[i3] * ek; E[j * 3 + 1] = this.e0[i3 + 1] * ek; E[j * 3 + 2] = this.e0[i3 + 2] * ek;
      M[j * 3] = this.s0[i] + (this.s1[i] - this.s0[i]) * Math.sqrt(t);
      M[j * 3 + 1] = this.rot[i];
      const fr = this.frameRate[i];
      M[j * 3 + 2] = fr > 0 ? Math.floor(this.frame[i] + this.life[i] * fr) % atl2 : fr < 0 ? Math.min(atl2 - 1, Math.floor(t * atl2)) : this.frame[i];
    }
    this.geo.instanceCount = n;
    this.aPos.needsUpdate = this.aVel.needsUpdate = this.aCol.needsUpdate = this.aEmi.needsUpdate = this.aMisc.needsUpdate = true;
    if (scene) syncFog(this.mat, scene);
    if (light) {
      const u = this.mat.uniforms;
      u.lightCol.value.copy(light.ambient);
      u.sunCol.value.copy(light.sun);
      u.sunDir.value.copy(light.sunDir);
    }
  }
}

