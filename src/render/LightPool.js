import * as THREE from 'three';

/**
 * Point-light virtualisation (perf, docs/PERF.md). Every PointLight in the scene costs every lit fragment, even at
 * intensity 0, and changing the light count recompiles programs. Owners keep creating and animating their
 * PointLights as before (level interiors, fires, flares, muzzle-flash pool). `adopt()` moves those *logical* lights
 * to a layer no camera renders, and a fixed pool of N *physical* lights (N by quality) copies the N most relevant
 * logical lights each frame: lit, in or near the view frustum, nearest first. So the shader loop is N lights, not 12+,
 * and the count never changes. A light that loses its slot fades out over ~0.12 s; a new one gets a slot immediately
 * (muzzle flashes are instant).
 */
export const LOGICAL_LIGHT_LAYER = 5;

export class LightPool {
  constructor(scene, camera, n) {
    this.scene = scene;
    this.camera = camera;
    this.logical = [];
    this.slots = [];
    for (let i = 0; i < n; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 1, 2);
      l.castShadow = false;
      l.name = 'lightPool' + i;
      l.userData.lightPool = true;
      l.userData.vmIgnore = true; // the viewmodel mirrors the logical lights itself
      scene.add(l);
      this.slots.push({ light: l, src: null, fade: 0 });
    }
    this._frustum = new THREE.Frustum();
    this._m = new THREE.Matrix4();
    this._sph = new THREE.Sphere();
    this._p = new THREE.Vector3();
    this.enabled = true;
  }

  /** Take over every PointLight currently in the scene (call after all content exists; again if lights are added). */
  adopt() {
    this.scene.traverse((o) => {
      if (!o.isPointLight || o.userData.lightPool || this.logical.includes(o)) return;
      o.layers.set(LOGICAL_LIGHT_LAYER);
      this.logical.push(o);
    });
  }

  _visibleChain(o) { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; }

  update(dt) {
    if (!this.enabled) return;
    // Amortised: re-select every 3rd frame; the copy/fade below runs every frame (flicker, muzzle flashes).
    this._tick = (this._tick || 0) + 1;
    if (this._tick % 3 === 0 || this._newLit()) this._select();
    this._apply(dt);
  }

  // A logical light that just turned on (muzzle flash, flare) shouldn't wait for the next selection.
  _newLit() {
    let changed = false;
    for (const l of this.logical) { const on = l.intensity > 0; if (on && !l.userData._poolOn) changed = true; l.userData._poolOn = on; }
    return changed;
  }

  _select() {
    const cam = this.camera;
    this._frustum.setFromProjectionMatrix(this._m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    const cp = cam.position;
    // Score candidates: lit + influence sphere touches the (slightly inflated) frustum. Lower score = more relevant.
    const cands = [];
    for (const l of this.logical) {
      if (!(l.intensity > 0) || !this._visibleChain(l)) continue;
      const p = l.getWorldPosition(this._p);
      const range = l.distance > 0 ? l.distance : 1e4;
      this._sph.set(p, range + 2);
      if (!this._frustum.intersectsSphere(this._sph)) continue;
      const d = p.distanceTo(cp);
      if (l.distance > 0 && d > range + 40) continue; // too far to light anything we can resolve
      cands.push({ l, score: Math.max(0, d - range * 0.5) - Math.min(30, l.intensity) * 0.05, pos: p.clone() });
    }
    cands.sort((a, b) => a.score - b.score);
    const want = new Set(cands.slice(0, this.slots.length).map((c) => c.l));
    // Release slots whose light is no longer wanted (fade out), keep the rest.
    for (const s of this.slots) if (s.src && !want.has(s.src)) { s.fading = true; }
    for (const c of cands) {
      if (!want.has(c.l)) continue;
      let s = this.slots.find((x) => x.src === c.l);
      if (!s) s = this.slots.find((x) => !x.src) || this.slots.find((x) => x.fading && x.fade <= 0.35);
      if (!s) continue;
      if (s.src !== c.l) { s.src = c.l; s.fade = 1; }
      s.fading = false;
      s.pos = c.pos;
    }
  }

  _apply(dt) {
    for (const s of this.slots) {
      const L = s.light;
      if (!s.src) { L.intensity = 0; continue; }
      if (s.fading) { s.fade -= dt / 0.12; if (s.fade <= 0) { s.src = null; s.fading = false; L.intensity = 0; continue; } }
      const src = s.src;
      L.color.copy(src.color);
      L.intensity = src.intensity * Math.max(0, Math.min(1, s.fade));
      L.distance = src.distance;
      L.decay = src.decay;
      if (s.fading && s.pos) L.position.copy(s.pos); else src.getWorldPosition(L.position); // movers (flares) track every frame
    }
  }
}
