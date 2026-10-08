import * as THREE from 'three';

/**
 * Authored first-person rifle animation set (Free FPS Template, Fab), retargeted at effector level by
 * tools/blender/retarget_template.py into public/assets/anims/fp_rifle_anims.json:
 *  - gun:   camera-space delta [px,py,pz,qx,qy,qz,qw] from the template idle (hip) / aim (ADS) base pose,
 *  - handL: support-hand path in gun space (offset from the handguard grip dg, from the magazine well dw,
 *           anchor weight w, rotation delta dq) for Reload,
 *  - mag:   magazine delta about its pivot (gun space), bolt: carrier travel.
 * Metres, three.js axes (camera: -z forward, gun: -z muzzle).
 */
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _va = new THREE.Vector3(), _vb = new THREE.Vector3();

export class FPAnims {
  constructor(data) {
    this.fps = data.fps;
    this.clips = data.clips;
    this.metrics = data.metrics;
  }

  has(name) { return !!this.clips[name]; }
  dur(name) { return this.clips[name]?.dur ?? 0; }

  /** Frame index + fraction for time t (seconds); loops wrap, one-shots clamp. */
  _f(clip, t) {
    const n = clip.n;
    let f = t * this.fps;
    if (clip.loop) f = ((f % n) + n) % n; else f = THREE.MathUtils.clamp(f, 0, n - 1);
    const i = Math.floor(f);
    return [i, clip.loop ? (i + 1) % n : Math.min(n - 1, i + 1), f - i];
  }

  /** Sample a 7-float [p, q] track into out {p: Vector3, q: Quaternion}. */
  _pq(track, i0, i1, a, out, po = 0) {
    const A = track[i0], B = track[i1];
    out.p.set(A[po], A[po + 1], A[po + 2]).lerp(_va.set(B[po], B[po + 1], B[po + 2]), a);
    out.q.set(A[po + 3], A[po + 4], A[po + 5], A[po + 6]).slerp(_qb.set(B[po + 3], B[po + 4], B[po + 5], B[po + 6]), a);
    return out;
  }

  /** Gun delta of clip `name` at time t, scaled toward identity by weight k. */
  gun(name, t, out, k = 1) {
    const c = this.clips[name];
    if (!c || k <= 0) { out.p.set(0, 0, 0); out.q.identity(); return out; }
    const [i0, i1, a] = this._f(c, t);
    this._pq(c.gun, i0, i1, a, out);
    if (k < 1) { out.p.multiplyScalar(k); out.q.slerp(_qa.identity(), 1 - k); }
    return out;
  }

  /** Normalised clip phase -> time. */
  at(name, u) { return u * this.dur(name); }

  /** Support hand during Reload: {dg, dw, w, dq}. */
  handL(t, out) {
    const c = this.clips.Reload;
    const [i0, i1, a] = this._f(c, t);
    const A = c.handL[i0], B = c.handL[i1];
    out.dg.set(A[0], A[1], A[2]).lerp(_va.set(B[0], B[1], B[2]), a);
    out.dw.set(A[3], A[4], A[5]).lerp(_vb.set(B[3], B[4], B[5]), a);
    out.w = A[6] + (B[6] - A[6]) * a;
    out.dq.set(A[7], A[8], A[9], A[10]).slerp(_qb.set(B[7], B[8], B[9], B[10]), a);
    return out;
  }

  /** Magazine delta during Reload: {p, q}. */
  mag(t, out) {
    const c = this.clips.Reload;
    const [i0, i1, a] = this._f(c, t);
    return this._pq(c.mag, i0, i1, a, out);
  }
}

/** Compose camera-space deltas: out = a * b (a applied after b). */
export function composeDelta(a, b, out) {
  // (Ra, ta) * (Rb, tb) = (Ra Rb, Ra tb + ta)
  const p = _va.copy(b.p).applyQuaternion(a.q).add(a.p);
  out.q.copy(a.q).multiply(b.q);
  out.p.copy(p);
  return out;
}
