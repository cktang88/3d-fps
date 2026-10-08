import * as THREE from 'three';

export const clamp = THREE.MathUtils.clamp;
export const lerp = THREE.MathUtils.lerp;
export const DEG = Math.PI / 180;

// Frame-rate independent exponential smoothing.
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));

export const smoothstep = (t) => t * t * (3 - 2 * t);
export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
export const easeInOutSine = (t) => -(Math.cos(Math.PI * t) - 1) / 2;
export const rand = (a, b) => a + Math.random() * (b - a);
export const randSign = () => (Math.random() < 0.5 ? -1 : 1);

/** Damped spring on a scalar. k = stiffness, z = damping ratio (1 = critical). */
export class Spring {
  constructor(k = 120, z = 1, value = 0) {
    this.k = k; this.z = z; this.x = value; this.v = 0; this.target = value;
  }
  impulse(v) { this.v += v; }
  update(dt) {
    // Semi-implicit Euler, sub-stepped for stability at stiff settings.
    const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / steps;
    const c = 2 * this.z * Math.sqrt(this.k);
    for (let i = 0; i < steps; i++) {
      const a = this.k * (this.target - this.x) - c * this.v;
      this.v += a * h;
      this.x += this.v * h;
    }
    return this.x;
  }
}

/** Damped spring on a Vector3. */
export class Spring3 {
  constructor(k = 120, z = 1) {
    this.k = k; this.z = z;
    this.x = new THREE.Vector3(); this.v = new THREE.Vector3(); this.target = new THREE.Vector3();
    this._a = new THREE.Vector3();
  }
  impulse(x, y, z) { this.v.x += x; this.v.y += y; this.v.z += z; }
  update(dt) {
    const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / steps;
    const c = 2 * this.z * Math.sqrt(this.k);
    for (let i = 0; i < steps; i++) {
      this._a.subVectors(this.target, this.x).multiplyScalar(this.k).addScaledVector(this.v, -c);
      this.v.addScaledVector(this._a, h);
      this.x.addScaledVector(this.v, h);
    }
    return this.x;
  }
}

// 1D value noise for camera shake (smooth, deterministic per seed).
const perm = new Uint8Array(512);
for (let i = 0; i < 256; i++) perm[i] = i;
for (let i = 255; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [perm[i], perm[j]] = [perm[j], perm[i]]; }
for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];
export function noise1(x) {
  const i = Math.floor(x), f = x - i;
  const a = perm[i & 255] / 127.5 - 1, b = perm[(i + 1) & 255] / 127.5 - 1;
  return lerp(a, b, smoothstep(f));
}

// Ray vs capsule (segment a-b, radius r). Returns distance along ray or -1.
const _ba = new THREE.Vector3(), _oa = new THREE.Vector3();
export function rayCapsule(ro, rd, a, b, r) {
  _ba.subVectors(b, a); _oa.subVectors(ro, a);
  const baba = _ba.dot(_ba), bard = _ba.dot(rd), baoa = _ba.dot(_oa);
  const rdoa = rd.dot(_oa), oaoa = _oa.dot(_oa);
  const A = baba - bard * bard;
  let B = baba * rdoa - baoa * bard;
  let C = baba * oaoa - baoa * baoa - r * r * baba;
  let h = B * B - A * C;
  if (h >= 0) {
    const t = (-B - Math.sqrt(h)) / A;
    const y = baoa + t * bard;
    if (y > 0 && y < baba && t > 0) return t;
    // Caps.
    const oc = y <= 0 ? _oa : _oa.clone().sub(_ba);
    B = rd.dot(oc); C = oc.dot(oc) - r * r;
    h = B * B - C;
    if (h > 0) { const t2 = -B - Math.sqrt(h); if (t2 > 0) return t2; }
  }
  return -1;
}

// Closest distance between a ray (origin, unit dir) and a point, plus the parameter.
export function rayPointDistance(ro, rd, p) {
  const t = Math.max(0, _oa.subVectors(p, ro).dot(rd));
  const cx = ro.x + rd.x * t - p.x, cy = ro.y + rd.y * t - p.y, cz = ro.z + rd.z * t - p.z;
  return { dist: Math.sqrt(cx * cx + cy * cy + cz * cz), t };
}
