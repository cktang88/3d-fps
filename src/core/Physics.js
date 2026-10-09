import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

// Collision groups: upper 16 bits = membership, lower 16 bits = filter.
export const G = {
  WORLD: 1 << 0,
  PLAYER: 1 << 1,
  BOT: 1 << 2,
  DEBRIS: 1 << 3,
  GLASS: 1 << 4,
};
export const groups = (member, filter) => ((member & 0xffff) << 16) | (filter & 0xffff);

export class Physics {
  static async create() {
    await RAPIER.init();
    return new Physics();
  }

  constructor() {
    this.R = RAPIER;
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = 1 / 60;
    this.accum = 0;
    this.colliderData = new Map(); // collider handle -> { material, object }
    this.dynamicLinks = []; // { body, object }
    this._ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    this._initTrace();
  }

  // ---------------------------------------------------------------- hang forensics
  // Cheap ring buffer of the last TRACE_LEN physics frames (window.__physTrace). The QA runner reads it under
  // CDP Debugger.pause when a page hangs, so it must stay plain data and be complete *before* world.step().
  _initTrace() {
    this.traceFrame = 0;
    this._trace = [];
    this._cur = this._newTraceFrame();
    this.nColliders = 0; this.nBodies = 0;
    this.stepsTotal = 0; this.lateCreates = []; // colliders created after the first world.step()
    const w = this.world, self = this;
    const cc = w.createCollider.bind(w), rc = w.removeCollider.bind(w);
    const cb = w.createRigidBody.bind(w), rb = w.removeRigidBody.bind(w);
    w.createCollider = (desc, parent) => {
      self._validateDesc(desc, parent);
      const c = cc(desc, parent);
      self.nColliders++;
      if (self.stepsTotal > 0 && self.lateCreates.length < 64) self.lateCreates.push([self.traceFrame, c.handle, desc.shape?.type]);
      if (self._cur.ev.length < 16) self._cur.ev.push(['+c', c.handle, desc.shape?.type, parent ? parent.handle : -1]);
      return c;
    };
    w.removeCollider = (c, wake) => {
      self.nColliders--;
      if (self._cur.ev.length < 16) self._cur.ev.push(['-c', c.handle]);
      return rc(c, wake);
    };
    w.createRigidBody = (desc) => {
      const bad = Physics._badPose(desc.translation, desc.rotation);
      if (bad) throw new Error(`Physics: refusing rigid body with ${bad}`);
      const b = cb(desc);
      self.nBodies++;
      if (self._cur.ev.length < 16) self._cur.ev.push(['+b', b.handle, desc.status]);
      return b;
    };
    w.removeRigidBody = (b) => {
      self.nBodies--;
      if (self._cur.ev.length < 16) self._cur.ev.push(['-b', b.handle]);
      return rb(b);
    };
    if (typeof window !== 'undefined') {
      window.__physTrace = this._trace;
      window.__physRepro = () => this.reproBundle();
      window.__physInfo = () => ({ frame: this.traceFrame, steps: this.stepsTotal, lateCreates: this.lateCreates, colliders: this.nColliders, bodies: this.nBodies, accum: this.accum, cur: this._cur });
    }
  }

  _reproOn() {
    return typeof window !== 'undefined' && (window.__qaFixedDt !== undefined || window.__physRecord === true);
  }

  /** Replay bundle for the last ~120-240 physics frames: { checkpoints: [{ frame, snap (base64), log }] }. */
  reproBundle() {
    const enc = (u8) => { let b = ''; for (let i = 0; i < u8.length; i += 0x8000) b += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(b); };
    const cks = [this._ckAll, this._ckPrev, this._ck].filter(Boolean).map((c) => ({ frame: c.frame, all: c === this._ckAll, snap: enc(c.snap), log: c.log }));
    return { timestep: this.world.timestep, frame: this.traceFrame, checkpoints: cks };
  }

  // ---------------------------------------------------------------- input validation (defensive layer)
  // Every collider/body goes through these checks, so no non-finite or absurd geometry can reach Rapier: a
  // non-finite value makes Rapier panic (wasm trap; the world is then unusable) and absurd magnitudes break the
  // broad phase's float math.
  static LIMIT = 1e4;

  static _badVec(v, lim = Physics.LIMIT) {
    return !v || !(Math.abs(v.x) < lim && Math.abs(v.y) < lim && Math.abs(v.z) < lim);
  }

  static _badPose(t, r) {
    if (t && Physics._badVec(t)) return `translation ${JSON.stringify(t)}`;
    if (r && !(Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.z) && Number.isFinite(r.w) &&
      Math.abs(Math.hypot(r.x, r.y, r.z, r.w) - 1) < 1e-3)) return `rotation ${JSON.stringify(r)}`;
    return null;
  }

  _validateDesc(desc, parent) {
    const R = this.R, sh = desc.shape, T = R.ShapeType;
    let bad = Physics._badPose(desc.translation, desc.rotation);
    if (!bad && sh) {
      if (sh.type === T.Cuboid) {
        const h = sh.halfExtents;
        if (Physics._badVec(h)) bad = `cuboid half-extents ${JSON.stringify(h)}`;
        else if (!(h.x > 0 && h.y > 0 && h.z > 0)) {
          // Zero/negative extents: clamp to a sliver (keeps the level building; reported once).
          this._warnOnce('cuboid', `Physics: non-positive cuboid half-extents ${JSON.stringify(h)} clamped`);
          h.x = Math.max(h.x, 1e-3); h.y = Math.max(h.y, 1e-3); h.z = Math.max(h.z, 1e-3);
        }
      } else if (sh.type === T.Capsule) {
        if (!(sh.halfHeight >= 0 && sh.halfHeight < 100 && sh.radius > 0 && sh.radius < 100)) bad = `capsule ${sh.halfHeight}/${sh.radius}`;
      } else if (sh.type === T.TriMesh) {
        const v = sh.vertices, ix = sh.indices;
        for (let i = 0; i < v.length && !bad; i++) if (!(Math.abs(v[i]) < Physics.LIMIT)) bad = `trimesh vertex ${i} = ${v[i]}`;
        for (let i = 0; i < ix.length && !bad; i++) if (!(ix[i] < v.length / 3)) bad = `trimesh index ${i} = ${ix[i]}`;
        if (!bad && ix.length % 3) bad = `trimesh index count ${ix.length}`;
      }
    }
    if (bad) {
      console.error(`Physics: refusing collider with ${bad}`, new Error().stack);
      throw new Error(`Physics: refusing collider with ${bad}`);
    }
  }

  _warnOnce(key, msg) {
    (this._warned ||= new Set());
    if (!this._warned.has(key)) { this._warned.add(key); console.warn(msg); }
  }

  _newTraceFrame() { return { f: this.traceFrame, dt: 0, accum: 0, steps: 0, done: false, nc: 0, nb: 0, pc: null, ev: [], kcc: [] }; }

  /** Player/KCC code reports its calls here (kept to a few entries per frame). */
  traceKcc(kind, a, b, c) {
    const k = this._cur.kcc;
    if (k.length < 12) k.push([kind, a, b, c]);
  }

  step(dt) {
    const tr = this._cur;
    tr.dt = dt;
    tr.nc = this.nColliders; tr.nb = this.nBodies;
    const pc = this.playerCollider;
    if (pc) { const t = pc.translation(); tr.pc = [t.x, t.y, t.z, pc.halfHeight()]; }
    this.accum += Math.min(dt, 0.1);
    tr.accum = this.accum;
    this._trace.push(tr);
    if (this._trace.length > 120) this._trace.shift();
    const rec = this._reproOn();
    if (rec && this._ck) {
      // Exact replay log: the only world mutation between steps is the player collider's pose/height.
      let a = this.accum, n = 0;
      while (a >= this.world.timestep && n < 8) { a -= this.world.timestep; n++; }
      if (n > 0) {
        const e = tr.pc ? [...tr.pc, n] : [null, null, null, null, n];
        this._ck.log.push(e);
        if (this._ckAll && this._ckAll.log.length < 200000) this._ckAll.log.push(e);
      }
    }
    let steps = 0;
    while (this.accum >= this.world.timestep && steps < 8) {
      tr.steps = steps + 1; // written before the call: a hang shows which sub-step never returned
      this.world.step();
      this.stepsTotal++;
      this.accum -= this.world.timestep;
      steps++;
    }
    tr.done = true;
    // Checkpoint (QA only, ~1 ms): a world snapshot taken between steps, plus the log above, lets a hang be
    // replayed deterministically offline (tools/qa/phys_replay.mjs).
    if (rec && steps > 0 && (!this._ck || this.traceFrame - this._ck.frame >= 120)) {
      this._ckPrev = this._ck;
      this._ck = { frame: this.traceFrame, snap: this.world.takeSnapshot(), log: [] };
      // window.__physRecordAll: also keep one long-lived checkpoint so a whole session can be replayed offline.
      if (!this._ckAll && window.__physRecordAll) this._ckAll = { frame: this.traceFrame, snap: this._ck.snap, log: [] };
    }
    this.traceFrame++;
    this._cur = this._newTraceFrame();
    for (const l of this.dynamicLinks) {
      const p = l.body.translation();
      const q = l.body.rotation();
      l.object.position.set(p.x, p.y, p.z);
      l.object.quaternion.set(q.x, q.y, q.z, q.w);
    }
  }

  tag(collider, data) {
    this.colliderData.set(collider.handle, data);
    return collider;
  }

  dataOf(collider) { return this.colliderData.get(collider.handle); }

  addStaticBox(center, half, quat, data = {}, group = G.WORLD) {
    const body = this.world.createRigidBody(
      this.R.RigidBodyDesc.fixed().setTranslation(center.x, center.y, center.z)
        .setRotation(quat ? { x: quat.x, y: quat.y, z: quat.z, w: quat.w } : { x: 0, y: 0, z: 0, w: 1 }),
    );
    const c = this.world.createCollider(
      this.R.ColliderDesc.cuboid(half.x, half.y, half.z).setCollisionGroups(groups(group, 0xffff)),
      body,
    );
    return this.tag(c, data);
  }

  // Static collider that exactly matches a mesh's oriented bounding box.
  addMeshBox(mesh, data = {}) {
    mesh.updateWorldMatrix(true, false);
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox;
    const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3();
    mesh.matrixWorld.decompose(pos, quat, scl);
    const localCenter = bb.getCenter(new THREE.Vector3());
    const size = bb.getSize(new THREE.Vector3()).multiply(scl).multiplyScalar(0.5);
    const center = localCenter.multiply(scl).applyQuaternion(quat).add(pos);
    return this.addStaticBox(center, size, quat, data);
  }

  addTrimesh(mesh, data = {}) {
    mesh.updateWorldMatrix(true, false);
    let g = mesh.geometry.index ? mesh.geometry : mesh.geometry;
    const posAttr = g.attributes.position;
    const verts = new Float32Array(posAttr.count * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < posAttr.count; i++) {
      v.fromBufferAttribute(posAttr, i).applyMatrix4(mesh.matrixWorld);
      verts[i * 3] = v.x; verts[i * 3 + 1] = v.y; verts[i * 3 + 2] = v.z;
    }
    let idx;
    if (g.index) idx = new Uint32Array(g.index.array);
    else { idx = new Uint32Array(posAttr.count); for (let i = 0; i < idx.length; i++) idx[i] = i; }
    const body = this.world.createRigidBody(this.R.RigidBodyDesc.fixed());
    const c = this.world.createCollider(
      this.R.ColliderDesc.trimesh(verts, idx).setCollisionGroups(groups(G.WORLD, 0xffff)), body);
    return this.tag(c, data);
  }

  addDynamicBox(object, half, mass = 1, velocity, angVel, group = G.DEBRIS) {
    const body = this.world.createRigidBody(
      this.R.RigidBodyDesc.dynamic()
        .setTranslation(object.position.x, object.position.y, object.position.z)
        .setRotation(object.quaternion)
        .setLinearDamping(0.1).setAngularDamping(0.4)
        .setCcdEnabled(true),
    );
    if (velocity) body.setLinvel(velocity, true);
    if (angVel) body.setAngvel(angVel, true);
    this.world.createCollider(
      this.R.ColliderDesc.cuboid(half.x, half.y, half.z).setMass(mass).setRestitution(0.35).setFriction(0.8)
        .setCollisionGroups(groups(group, G.WORLD | G.DEBRIS)),
      body,
    );
    const link = { body, object };
    this.dynamicLinks.push(link);
    return link;
  }

  removeDynamic(link) {
    const i = this.dynamicLinks.indexOf(link);
    if (i >= 0) this.dynamicLinks.splice(i, 1);
    this.world.removeRigidBody(link.body);
  }

  /**
   * Raycast against world geometry. Returns { point, normal, distance, collider, data } or null.
   * mask selects which membership groups are hit.
   */
  raycast(origin, dir, maxDist, mask = G.WORLD, exclude) {
    this._ray.origin = origin;
    this._ray.dir = dir;
    const hit = this.world.castRayAndGetNormal(
      this._ray, maxDist, true, undefined, groups(0xffff, mask), exclude,
    );
    if (!hit) return null;
    const t = hit.timeOfImpact;
    return {
      point: new THREE.Vector3(origin.x + dir.x * t, origin.y + dir.y * t, origin.z + dir.z * t),
      normal: new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z),
      distance: t,
      collider: hit.collider,
      data: this.dataOf(hit.collider) || {},
    };
  }

  // Cheap line-of-sight check used by AI.
  lineOfSight(a, b) {
    const d = new THREE.Vector3().subVectors(b, a);
    const len = d.length();
    if (len < 1e-4) return true;
    d.divideScalar(len);
    return !this.raycast(a, d, len - 0.05, G.WORLD);
  }
}
