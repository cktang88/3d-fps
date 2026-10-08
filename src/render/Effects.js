import * as THREE from 'three';
import {
  smokeAtlas, glowTex, tracerTex, bulletHoleTextures, bloodTex, scorchTex, muzzleFlashAtlas,
} from './ProcTex.js';
import { G } from '../core/Physics.js';
import { rand } from '../core/MathUtil.js';

const _o = new THREE.Vector3(), _d = new THREE.Vector3(), _refl = new THREE.Vector3(), _down = new THREE.Vector3(0, -1, 0);
const _tm = new THREE.Matrix4(), _tq = new THREE.Quaternion(), _ts = new THREE.Vector3(), _ta = new THREE.Vector3(), _tb = new THREE.Vector3(), _tc = new THREE.Vector3(), _tmid = new THREE.Vector3();

// Per-surface impact look: dust colour/amount, chip colour/count.
const SURF = {
  concrete: { color: [0.72, 0.7, 0.66], chip: [0.42, 0.41, 0.39], puffs: 4, puffSpeed: 1, alpha: 0.32, size: 1, life: 1, grav: 0.15, chips: 5, chipSize: 1 },
  brick: { color: [0.66, 0.46, 0.38], chip: [0.42, 0.22, 0.16], puffs: 4, puffSpeed: 1, alpha: 0.34, size: 1, life: 1, grav: 0.15, chips: 6, chipSize: 1.1 },
  plaster: { color: [0.86, 0.85, 0.82], chip: [0.8, 0.79, 0.76], puffs: 5, puffSpeed: 1.1, alpha: 0.38, size: 1.1, life: 1.1, grav: 0.1, chips: 5, chipSize: 0.9 },
  wood: { color: [0.55, 0.43, 0.3], chip: [0.45, 0.32, 0.2], puffs: 2, puffSpeed: 0.8, alpha: 0.25, size: 0.8, life: 0.8, grav: 0.3, chips: 7, chipSize: 1.3 },
  metal: { color: [0.6, 0.6, 0.6], chip: [0.3, 0.3, 0.3], puffs: 1, puffSpeed: 0.6, alpha: 0.18, size: 0.6, life: 0.6, grav: 0.1, chips: 0, chipSize: 1 },
  dirt: { color: [0.5, 0.42, 0.32], chip: [0.3, 0.24, 0.17], puffs: 4, puffSpeed: 1.2, alpha: 0.42, size: 1.1, life: 1, grav: 0.8, chips: 7, chipSize: 1.2 },
  glass: { color: [0.85, 0.9, 0.92], chip: [0.7, 0.8, 0.85], puffs: 1, puffSpeed: 0.5, alpha: 0.12, size: 0.5, life: 0.5, grav: 0.1, chips: 8, chipSize: 0.8 },
  fabric: { color: [0.55, 0.5, 0.42], chip: [0.4, 0.36, 0.3], puffs: 3, puffSpeed: 0.8, alpha: 0.3, size: 0.9, life: 1, grav: 0.4, chips: 2, chipSize: 0.8 },
  foliage: { color: [0.35, 0.42, 0.25], chip: [0.2, 0.3, 0.12], puffs: 2, puffSpeed: 0.6, alpha: 0.2, size: 0.8, life: 0.8, grav: 0.5, chips: 6, chipSize: 1.2 },
};

/**
 * GPU-instanced camera-facing particle system. All per-particle state lives in typed arrays;
 * one draw call per system. Supports atlas frames, rotation, size/alpha over life, gravity, drag,
 * optional velocity-stretched rendering (sparks).
 */
class ParticleSystem {
  constructor(scene, { max = 1500, texture, atlas = 1, blending = THREE.NormalBlending, stretch = false, lit = false, depthWrite = false, softness = 0 }) {
    this.max = max;
    this.count = 0;
    this.atlas = atlas;
    this.p = new Float32Array(max * 3);
    this.v = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.size0 = new Float32Array(max);
    this.size1 = new Float32Array(max);
    this.rot = new Float32Array(max);
    this.rotV = new Float32Array(max);
    this.col = new Float32Array(max * 4);
    this.alpha0 = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.frame = new Float32Array(max);
    this.fadeIn = new Float32Array(max);
    this.collide = new Uint8Array(max);
    this.floor = new Float32Array(max);

    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aVel = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aMisc = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage); // size, rot, frame
    geo.setAttribute('iPos', this.aPos);
    geo.setAttribute('iVel', this.aVel);
    geo.setAttribute('iCol', this.aCol);
    geo.setAttribute('iMisc', this.aMisc);
    geo.instanceCount = 0;
    this.geo = geo;

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: texture },
        atlas: { value: atlas },
        stretch: { value: stretch ? 1 : 0 },
        ambient: { value: new THREE.Color(1, 1, 1) },
        fogColor: { value: new THREE.Color() },
        fogDensity: { value: 0 },
      },
      vertexShader: /* glsl */`
        attribute vec3 iPos; attribute vec3 iVel; attribute vec4 iCol; attribute vec3 iMisc;
        uniform float stretch;
        varying vec2 vUv; varying vec4 vCol; varying float vFog;
        uniform float atlas;
        void main() {
          float size = iMisc.x; float rot = iMisc.y; float frame = iMisc.z;
          vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
          vec2 corner = position.xy;
          if (stretch > 0.5) {
            vec3 vv = (modelViewMatrix * vec4(iVel, 0.0)).xyz;
            vec2 d = vv.xy; float l = length(d);
            vec2 dir = l > 1e-4 ? d / l : vec2(0.0, 1.0);
            vec2 perp = vec2(-dir.y, dir.x);
            float len = size + l * 0.03;
            mv.xy += dir * corner.y * len + perp * corner.x * size * 0.35;
          } else {
            float c = cos(rot), s = sin(rot);
            mv.xy += mat2(c, s, -s, c) * corner * size;
          }
          gl_Position = projectionMatrix * mv;
          float fx = mod(frame, atlas), fy = floor(frame / atlas);
          vUv = (uv + vec2(fx, atlas - 1.0 - fy)) / atlas;
          vCol = iCol;
          vFog = -mv.z;
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D map; uniform vec3 ambient; uniform vec3 fogColor; uniform float fogDensity;
        varying vec2 vUv; varying vec4 vCol; varying float vFog;
        void main() {
          vec4 t = texture2D(map, vUv);
          vec4 c = vec4(t.rgb * vCol.rgb * ambient, t.a * vCol.a);
          float f = 1.0 - exp(-fogDensity * fogDensity * vFog * vFog);
          c.rgb = mix(c.rgb, fogColor, f * ${lit ? '1.0' : '0.0'});
          if (c.a < 0.003) discard;
          gl_FragColor = c;
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite,
      blending,
    });
    this.lit = lit;
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = blending === THREE.AdditiveBlending ? 12 : 10;
    scene.add(this.mesh);
  }

  spawn(o) {
    let i;
    if (this.count < this.max) i = this.count++;
    else i = (Math.random() * this.max) | 0;
    this.p[i * 3] = o.x; this.p[i * 3 + 1] = o.y; this.p[i * 3 + 2] = o.z;
    this.v[i * 3] = o.vx || 0; this.v[i * 3 + 1] = o.vy || 0; this.v[i * 3 + 2] = o.vz || 0;
    this.life[i] = 0;
    this.maxLife[i] = o.life || 1;
    this.size0[i] = o.size0 ?? 0.2;
    this.size1[i] = o.size1 ?? this.size0[i];
    this.rot[i] = o.rot ?? Math.random() * Math.PI * 2;
    this.rotV[i] = o.rotV ?? 0;
    const c = o.color || [1, 1, 1];
    this.col[i * 4] = c[0]; this.col[i * 4 + 1] = c[1]; this.col[i * 4 + 2] = c[2];
    this.alpha0[i] = o.alpha ?? 1;
    this.grav[i] = o.gravity ?? 0;
    this.drag[i] = o.drag ?? 0;
    this.frame[i] = o.frame ?? ((Math.random() * this.atlas * this.atlas) | 0);
    this.fadeIn[i] = o.fadeIn ?? 0;
    this.collide[i] = o.collide !== undefined && o.collide !== false ? 1 : 0;
    this.floor[i] = typeof o.collide === 'number' ? o.collide : -1e9;
  }

  update(dt, groundY = null) {
    let n = this.count;
    for (let i = 0; i < n; i++) {
      this.life[i] += dt;
      if (this.life[i] >= this.maxLife[i]) {
        // Swap-remove.
        n--;
        this._copy(n, i);
        i--;
        continue;
      }
      const d = Math.exp(-this.drag[i] * dt);
      this.v[i * 3] *= d; this.v[i * 3 + 1] = this.v[i * 3 + 1] * d - this.grav[i] * dt; this.v[i * 3 + 2] *= d;
      this.p[i * 3] += this.v[i * 3] * dt; this.p[i * 3 + 1] += this.v[i * 3 + 1] * dt; this.p[i * 3 + 2] += this.v[i * 3 + 2] * dt;
      if (this.collide[i] && this.p[i * 3 + 1] < this.floor[i]) {
        // Bounce on the floor captured at spawn (cheap, no per-frame raycasts).
        this.p[i * 3 + 1] = this.floor[i];
        this.v[i * 3 + 1] *= -0.3; this.v[i * 3] *= 0.45; this.v[i * 3 + 2] *= 0.45;
        this.rotV[i] *= 0.5;
      }
      this.rot[i] += this.rotV[i] * dt;
    }
    this.count = n;
    const P = this.aPos.array, V = this.aVel.array, C = this.aCol.array, M = this.aMisc.array;
    for (let i = 0; i < n; i++) {
      const t = this.life[i] / this.maxLife[i];
      P[i * 3] = this.p[i * 3]; P[i * 3 + 1] = this.p[i * 3 + 1]; P[i * 3 + 2] = this.p[i * 3 + 2];
      V[i * 3] = this.v[i * 3]; V[i * 3 + 1] = this.v[i * 3 + 1]; V[i * 3 + 2] = this.v[i * 3 + 2];
      C[i * 4] = this.col[i * 4]; C[i * 4 + 1] = this.col[i * 4 + 1]; C[i * 4 + 2] = this.col[i * 4 + 2];
      const fi = this.fadeIn[i] > 0 ? Math.min(1, t / this.fadeIn[i]) : 1;
      C[i * 4 + 3] = this.alpha0[i] * fi * (1 - t) * (1 - t * 0.3);
      M[i * 3] = this.size0[i] + (this.size1[i] - this.size0[i]) * Math.sqrt(t);
      M[i * 3 + 1] = this.rot[i];
      M[i * 3 + 2] = this.frame[i];
    }
    this.geo.instanceCount = n;
    this.aPos.needsUpdate = this.aVel.needsUpdate = this.aCol.needsUpdate = this.aMisc.needsUpdate = true;
    this.aPos.clearUpdateRanges?.();
  }

  _copy(from, to) {
    if (from === to) return;
    for (let k = 0; k < 3; k++) { this.p[to * 3 + k] = this.p[from * 3 + k]; this.v[to * 3 + k] = this.v[from * 3 + k]; }
    for (let k = 0; k < 4; k++) this.col[to * 4 + k] = this.col[from * 4 + k];
    this.life[to] = this.life[from]; this.maxLife[to] = this.maxLife[from];
    this.size0[to] = this.size0[from]; this.size1[to] = this.size1[from];
    this.rot[to] = this.rot[from]; this.rotV[to] = this.rotV[from];
    this.alpha0[to] = this.alpha0[from]; this.grav[to] = this.grav[from]; this.drag[to] = this.drag[from];
    this.frame[to] = this.frame[from]; this.fadeIn[to] = this.fadeIn[from]; this.collide[to] = this.collide[from]; this.floor[to] = this.floor[from];
  }
}

/** Ring-buffer of oriented decal quads (instanced) – cheap bullet holes / blood / scorch. */
class DecalPool {
  constructor(scene, material, max = 200, sizeRange = [0.08, 0.12], atlas = 1) {
    this.max = max;
    this.next = 0;
    this.atlas = atlas;
    const geo = new THREE.PlaneGeometry(1, 1);
    this.mesh = new THREE.InstancedMesh(geo, material, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 2;
    this.sizeRange = sizeRange;
    if (atlas > 1) {
      this.frames = new THREE.InstancedBufferAttribute(new Float32Array(max), 1);
      geo.setAttribute('iFrame', this.frames);
      material.onBeforeCompile = (sh) => {
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', '#include <common>\nattribute float iFrame;')
          .replace('#include <uv_vertex>', `#include <uv_vertex>
            float fx = mod(iFrame, ${atlas.toFixed(1)}); float fy = floor(iFrame / ${atlas.toFixed(1)});
            #ifdef USE_MAP
              vMapUv = (vMapUv + vec2(fx, fy)) / ${atlas.toFixed(1)};
            #endif
            #ifdef USE_NORMALMAP
              vNormalMapUv = (vNormalMapUv + vec2(fx, fy)) / ${atlas.toFixed(1)};
            #endif`);
      };
    }
    scene.add(this.mesh);
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._s = new THREE.Vector3();
    this._z = new THREE.Vector3(0, 0, 1);
  }

  add(point, normal, size) {
    const s = size ?? rand(this.sizeRange[0], this.sizeRange[1]);
    this._q.setFromUnitVectors(this._z, normal);
    const spin = new THREE.Quaternion().setFromAxisAngle(this._z, Math.random() * Math.PI * 2);
    this._q.multiply(spin);
    this._s.set(s, s, s);
    const p = point.clone().addScaledVector(normal, 0.004 + Math.random() * 0.002);
    this._m.compose(p, this._q, this._s);
    const i = this.next;
    this.mesh.setMatrixAt(i, this._m);
    if (this.frames) { this.frames.array[i] = (Math.random() * this.atlas * this.atlas) | 0; this.frames.needsUpdate = true; }
    this.next = (this.next + 1) % this.max;
    this.mesh.count = Math.max(this.mesh.count, i + 1);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** Brass casings with cheap custom physics (raycast bounce), instanced. */
class ShellPool {
  constructor(scene, physics, audio, max = 80) {
    this.physics = physics;
    this.audio = audio;
    const geo = new THREE.CylinderGeometry(0.0045, 0.0045, 0.03, 8);
    geo.rotateZ(Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({ color: 0xc8a050, metalness: 1, roughness: 0.28 });
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = false;
    this.mesh.frustumCulled = false;
    this.mesh.count = max;
    this.items = [];
    this.max = max;
    this.next = 0;
    const hide = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < max; i++) { this.mesh.setMatrixAt(i, hide); this.items.push(null); }
    scene.add(this.mesh);
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._e = new THREE.Euler();
    this._s = new THREE.Vector3(1, 1, 1);
  }

  spawn(pos, vel, big = false) {
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    this.items[i] = {
      p: pos.clone(), v: vel.clone(), r: new THREE.Vector3(Math.random() * 6, Math.random() * 6, 0),
      rv: new THREE.Vector3(rand(-25, 25), rand(-25, 25), rand(-25, 25)), life: 0, bounces: 0, rest: false, scale: big ? 1.6 : 1,
    };
  }

  update(dt) {
    for (let i = 0; i < this.max; i++) {
      const s = this.items[i];
      if (!s) continue;
      s.life += dt;
      if (s.life > 12) {
        this.items[i] = null;
        this.mesh.setMatrixAt(i, this._m.makeScale(0, 0, 0));
        continue;
      }
      if (!s.rest) {
        s.v.y -= 9.81 * dt;
        const step = _o.copy(s.v).multiplyScalar(dt);
        const len = step.length();
        if (len > 1e-5) {
          const hit = this.physics.raycast(s.p, _d.copy(step).divideScalar(len), len + 0.01, G.WORLD);
          if (hit) {
            s.p.copy(hit.point).addScaledVector(hit.normal, 0.005);
            const vn = hit.normal.multiplyScalar(s.v.dot(hit.normal));
            s.v.sub(vn).multiplyScalar(0.55).addScaledVector(vn, -0.35);
            s.rv.multiplyScalar(0.6);
            if (s.bounces < 3 && vn.length() > 0.6) this.audio.click('shell', s.p, 0.5 / (1 + s.bounces));
            s.bounces++;
            if (s.v.length() < 0.25 && hit.normal.y > 0.6) { s.rest = true; s.r.x = Math.PI / 2 * 0; s.r.z = 0; }
          } else s.p.add(step);
        }
        s.r.addScaledVector(s.rv, dt);
      }
      this._e.set(s.r.x, s.r.y, s.r.z);
      this._q.setFromEuler(this._e);
      this._s.setScalar(s.scale);
      this._m.compose(s.p, this._q, this._s);
      this.mesh.setMatrixAt(i, this._m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

export class Effects {
  constructor(game) {
    this.game = game;
    const scene = game.renderer.scene;
    this.scene = scene;
    this.smokeTex = smokeAtlas();
    this.glow = glowTex();

    this.smoke = new ParticleSystem(scene, { max: 900, texture: this.smokeTex, atlas: 4, lit: true });
    this.dust = new ParticleSystem(scene, { max: 900, texture: this.smokeTex, atlas: 4, lit: true });
    this.sparks = new ParticleSystem(scene, { max: 800, texture: this.glow, blending: THREE.AdditiveBlending, stretch: true });
    this.flashes = new ParticleSystem(scene, { max: 64, texture: muzzleFlashAtlas(), atlas: 2, blending: THREE.AdditiveBlending });
    this.debris = new ParticleSystem(scene, { max: 500, texture: this.glow, lit: true });
    this.blood = new ParticleSystem(scene, { max: 500, texture: this.smokeTex, atlas: 4 });
    this.fire = new ParticleSystem(scene, { max: 400, texture: this.smokeTex, atlas: 4, blending: THREE.AdditiveBlending });

    // Tracers: velocity-stretched additive quads.
    this.tracerTex = tracerTex();
    this.tracers = [];
    const tgeo = new THREE.PlaneGeometry(1, 1);
    tgeo.translate(0.5, 0, 0);
    this.tracerMat = new THREE.MeshBasicMaterial({
      map: this.tracerTex, color: new THREE.Color(1.0, 0.75, 0.45).multiplyScalar(6), transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    });
    this.tracerMesh = new THREE.InstancedMesh(tgeo, this.tracerMat, 256);
    this.tracerMesh.count = 0;
    this.tracerMesh.frustumCulled = false;
    this.tracerMesh.renderOrder = 13;
    scene.add(this.tracerMesh);

    // Decals.
    const holeC = bulletHoleTextures('concrete'), holeM = bulletHoleTextures('metal'), holeW = bulletHoleTextures('wood');
    const decalMat = (t, rough = 0.9, metal = 0) => new THREE.MeshStandardMaterial({
      map: t.map, normalMap: t.normal, normalScale: new THREE.Vector2(1.5, 1.5), transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, roughness: rough, metalness: metal,
    });
    this.decals = {
      concrete: new DecalPool(scene, decalMat(holeC), 220, [0.07, 0.11], 2),
      metal: new DecalPool(scene, decalMat(holeM, 0.4, 0.8), 120, [0.04, 0.06], 2),
      wood: new DecalPool(scene, decalMat(holeW), 120, [0.05, 0.08], 2),
      blood: new DecalPool(scene, new THREE.MeshStandardMaterial({
        map: bloodTex(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, roughness: 0.3,
      }), 60, [0.4, 0.9]),
      scorch: new DecalPool(scene, new THREE.MeshStandardMaterial({
        map: scorchTex(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, roughness: 1,
      }), 20, [2.5, 3.5]),
    };
    this.shells = new ShellPool(scene, game.physics, game.audio);

    // Pool of point lights for muzzle flashes / explosions (avoid shader recompiles: fixed count).
    this.lights = [];
    for (let i = 0; i < 4; i++) {
      const l = new THREE.PointLight(0xffaa55, 0, 9, 2);
      l.castShadow = false;
      scene.add(l);
      this.lights.push({ light: l, life: 0, max: 1, intensity: 0 });
    }
    this.nextLight = 0;
  }

  flashLight(pos, intensity = 30, dur = 0.06, color = 0xffaa55, range = 9) {
    const L = this.lights[this.nextLight];
    this.nextLight = (this.nextLight + 1) % this.lights.length;
    L.light.position.copy(pos);
    L.light.color.set(color);
    L.light.distance = range;
    L.life = 0; L.max = dur; L.intensity = intensity;
    L.light.intensity = intensity;
  }

  /** World-space muzzle flash (bots / third person). */
  muzzleFlash(pos, dir, scale = 1, suppressed = false) {
    if (!suppressed) {
      this.flashes.spawn({ x: pos.x, y: pos.y, z: pos.z, life: 0.05, size0: 0.35 * scale, size1: 0.5 * scale, color: [3, 2.4, 1.6] });
      this.flashLight(pos.clone().addScaledVector(dir, 0.2), 25 * scale, 0.05);
    }
    for (let i = 0; i < 2; i++) {
      this.smoke.spawn({
        x: pos.x + dir.x * 0.1, y: pos.y + dir.y * 0.1, z: pos.z + dir.z * 0.1,
        vx: dir.x * rand(0.5, 1.5) + rand(-0.2, 0.2), vy: dir.y * 1 + rand(0.1, 0.4), vz: dir.z * rand(0.5, 1.5) + rand(-0.2, 0.2),
        life: rand(0.6, 1.2), size0: 0.08, size1: 0.5, alpha: 0.12, drag: 2.5, gravity: -0.3, color: [0.9, 0.9, 0.9],
      });
    }
  }

  tracer(from, to, speed = 600, width = 0.025) {
    const dir = to.clone().sub(from);
    const len = dir.length();
    if (len < 0.5) return;
    dir.divideScalar(len);
    this.tracers.push({ from: from.clone(), dir, len, d: 0, speed, width });
  }

  /** Floor height under a point (one raycast per effect, used for debris bounce). */
  _floorAt(p) {
    _o.set(p.x, p.y + 0.05, p.z);
    const hit = this.game.physics.raycast(_o, _down, 6, G.WORLD);
    return hit ? hit.point.y + 0.01 : p.y - 6;
  }

  impact(point, normal, surface = 'concrete', dir = null) {
    const n = normal;
    const p = point;
    const refl = _refl.copy(dir ?? n);
    if (dir) refl.reflect(n);
    if (surface === 'flesh') {
      // Red mist + a few heavy droplets.
      for (let i = 0; i < 4; i++) {
        this.blood.spawn({
          x: p.x, y: p.y, z: p.z,
          vx: (dir?.x ?? 0) * rand(0.5, 2) + rand(-0.6, 0.6), vy: rand(-0.2, 0.9), vz: (dir?.z ?? 0) * rand(0.5, 2) + rand(-0.6, 0.6),
          life: rand(0.25, 0.5), size0: 0.06, size1: rand(0.35, 0.55), alpha: 0.75, color: [0.42, 0.02, 0.02], drag: 5, gravity: 1.5,
        });
      }
      for (let i = 0; i < 5; i++) {
        this.debris.spawn({
          x: p.x, y: p.y, z: p.z,
          vx: (dir?.x ?? 0) * rand(1, 3) + rand(-1, 1), vy: rand(0, 2), vz: (dir?.z ?? 0) * rand(1, 3) + rand(-1, 1),
          life: rand(0.3, 0.6), size0: rand(0.01, 0.02), alpha: 1, color: [0.3, 0.01, 0.01], gravity: 9.8, drag: 0.4,
        });
      }
      return;
    }
    const decal = this.decals[surface] || this.decals.concrete;
    if (surface !== 'glass' && surface !== 'dirt' && surface !== 'water' && surface !== 'foliage' && surface !== 'fabric') decal.add(p, n);
    else if (surface === 'dirt') this.decals.concrete.add(p, n, 0.05);

    const C = SURF[surface] || SURF.concrete;
    const floor = n.y > 0.7 ? p.y + 0.01 : this._floorAt(p);
    // Initial burst: tight, fast puff along the normal + a slower lingering cloud.
    for (let i = 0; i < C.puffs; i++) {
      const s = rand(0.6, 2.4) * C.puffSpeed;
      this.dust.spawn({
        x: p.x + n.x * 0.04, y: p.y + n.y * 0.04, z: p.z + n.z * 0.04,
        vx: n.x * s + refl.x * 0.6 + rand(-0.35, 0.35), vy: n.y * s + rand(0, 0.45), vz: n.z * s + refl.z * 0.6 + rand(-0.35, 0.35),
        life: rand(0.7, 1.6) * C.life, size0: 0.05, size1: rand(0.35, 0.7) * C.size, alpha: C.alpha, color: C.color, drag: 4, gravity: C.grav,
      });
    }
    // Dirt kicks a vertical spray.
    if (surface === 'dirt' || surface === 'foliage') {
      for (let i = 0; i < 3; i++) this.dust.spawn({ x: p.x, y: p.y + 0.02, z: p.z, vx: rand(-0.4, 0.4), vy: rand(2, 4), vz: rand(-0.4, 0.4), life: rand(0.5, 0.9), size0: 0.06, size1: 0.35, alpha: 0.5, color: C.color, drag: 3, gravity: 5 });
    }
    // Chips / splinters that bounce on the floor.
    for (let i = 0; i < C.chips; i++) {
      const s = rand(1.5, 4.5);
      this.debris.spawn({
        x: p.x + n.x * 0.02, y: p.y + n.y * 0.02, z: p.z + n.z * 0.02,
        vx: n.x * s + rand(-1.4, 1.4), vy: n.y * s + rand(0.6, 2.6), vz: n.z * s + rand(-1.4, 1.4),
        life: rand(0.6, 1.3), size0: rand(0.01, 0.022) * C.chipSize, alpha: 1, color: C.chip, gravity: 9.8, drag: 0.6, collide: floor,
      });
    }
    // Sparks: always on metal, sometimes on concrete/brick.
    const sparks = surface === 'metal' ? (8 + (Math.random() * 6) | 0) : (surface === 'concrete' || surface === 'brick') && Math.random() < 0.3 ? 3 : 0;
    for (let i = 0; i < sparks; i++) {
      const s = rand(3, 10);
      _d.set(refl.x + rand(-0.7, 0.7), refl.y + rand(-0.3, 0.8), refl.z + rand(-0.7, 0.7)).normalize();
      this.sparks.spawn({
        x: p.x, y: p.y, z: p.z, vx: _d.x * s, vy: _d.y * s, vz: _d.z * s,
        life: rand(0.12, 0.4), size0: 0.01, alpha: 1, color: [4, 2.3, 0.9], gravity: 9.8, drag: 1.5, collide: floor,
      });
    }
    // Tiny hot flash on hard surfaces sells the "hit".
    if (surface === 'metal' || surface === 'concrete' || surface === 'brick') {
      this.flashes.spawn({ x: p.x + n.x * 0.03, y: p.y + n.y * 0.03, z: p.z + n.z * 0.03, life: 0.045, size0: surface === 'metal' ? 0.16 : 0.1, size1: 0.05, color: surface === 'metal' ? [3, 2.4, 1.6] : [1.4, 1.2, 1] });
    }
    if (surface === 'metal') this.flashLight(_o.copy(p).addScaledVector(n, 0.1), 3, 0.04, 0xffbb66, 2);
  }

  explosion(pos) {
    const floor = this._floorAt(pos);
    this.flashLight(_o.copy(pos).setY(pos.y + 0.6), 520, 0.3, 0xff8a3a, 28);
    // Core flash.
    this.flashes.spawn({ x: pos.x, y: pos.y + 0.5, z: pos.z, life: 0.12, size0: 3.2, size1: 4.5, color: [4, 3, 2] });
    // Fireball: fast-expanding, short-lived additive puffs.
    for (let i = 0; i < 26; i++) {
      _d.set(rand(-1, 1), rand(0.15, 1.3), rand(-1, 1)).normalize();
      const s = rand(2, 9);
      this.fire.spawn({ x: pos.x, y: pos.y + 0.3, z: pos.z, vx: _d.x * s, vy: _d.y * s, vz: _d.z * s, life: rand(0.18, 0.5), size0: 0.7, size1: rand(1.8, 2.8), alpha: 0.9, color: [3, 1.4, 0.45], drag: 5 });
    }
    // Dark column + lingering smoke.
    for (let i = 0; i < 22; i++) {
      _d.set(rand(-1, 1), rand(0.4, 1.6), rand(-1, 1)).normalize();
      const s = rand(1, 4.5);
      this.smoke.spawn({ x: pos.x, y: pos.y + 0.5, z: pos.z, vx: _d.x * s, vy: _d.y * s, vz: _d.z * s, life: rand(3.5, 7), size0: 1, size1: rand(4, 6.5), alpha: 0.42, color: [0.2, 0.19, 0.18], drag: 1.7, gravity: -0.22, fadeIn: 0.04 });
    }
    // Ground dust ring rolling outward.
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2 + rand(-0.1, 0.1), s = rand(5, 9);
      this.dust.spawn({ x: pos.x, y: floor + 0.25, z: pos.z, vx: Math.cos(a) * s, vy: rand(0.2, 0.8), vz: Math.sin(a) * s, life: rand(1.6, 2.6), size0: 0.6, size1: rand(2, 3), alpha: 0.4, color: [0.55, 0.5, 0.43], drag: 2.6 });
    }
    // Dirt chunks + sparks.
    for (let i = 0; i < 26; i++) {
      _d.set(rand(-1, 1), rand(0.5, 2), rand(-1, 1)).normalize();
      const s = rand(4, 12);
      this.debris.spawn({ x: pos.x, y: pos.y + 0.2, z: pos.z, vx: _d.x * s, vy: _d.y * s, vz: _d.z * s, life: rand(0.9, 1.8), size0: rand(0.025, 0.06), alpha: 1, color: [0.16, 0.14, 0.12], gravity: 9.8, drag: 0.3, collide: floor });
    }
    for (let i = 0; i < 36; i++) {
      _d.set(rand(-1, 1), rand(0.2, 1.5), rand(-1, 1)).normalize();
      const s = rand(6, 20);
      this.sparks.spawn({ x: pos.x, y: pos.y + 0.2, z: pos.z, vx: _d.x * s, vy: _d.y * s, vz: _d.z * s, life: rand(0.3, 1.0), size0: 0.02, color: [4, 2, 0.6], gravity: 9.8, drag: 0.8, collide: floor });
    }
    const hit = this.game.physics.raycast(_o.copy(pos).setY(pos.y + 0.5), _down, 2, G.WORLD);
    if (hit) this.decals.scorch.add(hit.point, hit.normal);
  }

  update(dt, camera) {
    // Particle lighting tint follows scene ambience a bit.
    const fog = this.scene.fog;
    for (const sys of [this.smoke, this.dust, this.debris]) {
      if (fog) { sys.mat.uniforms.fogColor.value.copy(fog.color); sys.mat.uniforms.fogDensity.value = fog.density ?? 0; }
    }
    const groundY = null;
    this.smoke.update(dt); this.dust.update(dt); this.sparks.update(dt, groundY); this.flashes.update(dt);
    this.debris.update(dt); this.blood.update(dt); this.fire.update(dt);
    this.shells.update(dt);

    for (const L of this.lights) {
      if (L.light.intensity <= 0) continue;
      L.life += dt;
      L.light.intensity = L.life >= L.max ? 0 : L.intensity * (1 - L.life / L.max);
    }

    // Tracers: segment of length ~ speed*0.04 sliding along path, camera-facing ribbon.
    const m = _tm, q = _tq, s = _ts;
    const camPos = camera.position;
    let n = 0;
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.d += t.speed * dt;
      if (t.d - Math.min(t.len, 14) > t.len) { this.tracers.splice(i, 1); continue; }
      if (n >= 256) continue;
      const segLen = Math.min(t.speed * 0.035, 14);
      const head = Math.min(t.d, t.len), tail = Math.max(0, t.d - segLen);
      if (head - tail < 0.01) continue;
      const start = _ta.copy(t.from).addScaledVector(t.dir, tail);
      // Orient: x along dir, plane faces camera.
      const mid = _tmid.copy(start).addScaledVector(t.dir, (head - tail) / 2);
      const toCam = _tc.copy(camPos).sub(mid).normalize();
      const yAxis = _tb.crossVectors(toCam, t.dir).normalize();
      const zAxis = toCam.crossVectors(t.dir, yAxis).normalize();
      m.makeBasis(t.dir, yAxis, zAxis);
      q.setFromRotationMatrix(m);
      const dist = mid.distanceTo(camPos);
      s.set(head - tail, t.width * Math.max(1, dist * 0.04), 1);
      m.compose(start, q, s);
      this.tracerMesh.setMatrixAt(n++, m);
    }
    this.tracerMesh.count = n;
    this.tracerMesh.instanceMatrix.needsUpdate = true;
  }
}
