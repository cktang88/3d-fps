import * as THREE from 'three';
import { G, groups } from '../core/Physics.js';

/**
 * Conservative occlusion culling for bots (perf, docs/PERF.md). A bot's ~15 draw calls are skipped when the
 * level geometry fully hides it from the camera. Each frame, 6 rays go from the eye to sample points on the body
 * (head, chest left/centre/right, hips, knees). They only count hits on *thick* static boxes (min half-extent ≥ 8 cm:
 * walls, containers, crates), so fences, glass, grates and shards never occlude. The bot is hidden only if every ray
 * is blocked for 2 consecutive frames, and shown again as soon as any ray is clear. Its merged shadow proxy keeps
 * casting while it is hidden, so shadows around corners still read.
 */
export class BotOcclusion {
  constructor(game) {
    this.game = game;
    this.enabled = true;
    this._occ = new Map(); // collider handle -> is occluder
    this._ray = null;
    this._o = new THREE.Vector3(); this._d = new THREE.Vector3(); this._p = new THREE.Vector3(); this._r = new THREE.Vector3();
    this.hiddenCount = 0;
  }

  _isOccluder(c) {
    let v = this._occ.get(c.handle);
    if (v === undefined) {
      const h = c.shapeType() === 1 ? c.halfExtents() : null; // Cuboid
      v = !!h && Math.min(h.x, h.y, h.z) >= 0.08 && c.parent()?.isFixed?.() !== false;
      this._occ.set(c.handle, v);
    }
    return v;
  }

  _blocked(eye, p) {
    const ph = this.game.physics;
    const d = this._d.subVectors(p, eye);
    const len = d.length();
    if (len < 1.5) return false;
    d.divideScalar(len);
    if (!this._ray) this._ray = new ph.R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    this._ray.origin = { x: eye.x, y: eye.y, z: eye.z };
    this._ray.dir = { x: d.x, y: d.y, z: d.z };
    const hit = ph.world.castRay(this._ray, len - 0.35, true, undefined, groups(0xffff, G.WORLD), undefined, undefined, (c) => this._isOccluder(c));
    return !!hit;
  }

  _setHidden(model, hide) {
    if (hide === !!model._occHidden) return;
    if (hide) {
      const list = [];
      model.root.traverse((o) => { if ((o.isMesh || o.isSkinnedMesh) && o.visible && o.layers.mask === 1) { o.visible = false; list.push(o); } });
      model._occHidden = list;
    } else {
      for (const o of model._occHidden) o.visible = true;
      model._occHidden = null;
    }
  }

  update() {
    const g = this.game, cam = g.renderer.camera;
    let hidden = 0;
    const eye = this._o.setFromMatrixPosition(cam.matrixWorld);
    for (const b of g.bots) {
      const m = b.model;
      if (!m?.root) continue;
      if (!this.enabled || !b.alive || !m.root.visible) { this._setHidden(m, false); m._occFrames = 0; continue; }
      // Right vector perpendicular to the view ray, for the shoulder samples.
      const base = b.position, top = b.head.y - base.y;
      const r = this._r.subVectors(base, eye).setY(0);
      if (r.lengthSq() < 1e-6) r.set(1, 0, 0); else r.normalize();
      r.set(-r.z, 0, r.x).multiplyScalar(0.38);
      const pts = [[0, top + 0.12], [0, top * 0.78], [1, top * 0.72], [-1, top * 0.72], [0, top * 0.5], [0, top * 0.22]];
      let allBlocked = true;
      for (const [s, y] of pts) {
        const p = this._p.set(base.x + r.x * s, base.y + y, base.z + r.z * s);
        if (!this._blocked(eye, p)) { allBlocked = false; break; }
      }
      m._occFrames = allBlocked ? (m._occFrames || 0) + 1 : 0;
      this._setHidden(m, m._occFrames >= 2);
      if (m._occHidden) hidden++;
    }
    this.hiddenCount = hidden;
  }
}
