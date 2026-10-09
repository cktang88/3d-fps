import * as THREE from 'three';

/**
 * Precomputed potentially-visible set (perf, docs/PERF.md).
 *
 * Offline (`node tools/perf/bake_pvs.mjs`), for every 4 m cell of the map and every storey bucket (3.4 m), rays
 * are cast from several eye points in the cell to sample points on every static *target* — level chunks
 * (`lvl_<mat>@<x,z>` meshes, see Level.finalize) and prop instances (BatchedMesh per-instance). Only thick static
 * boxes occlude (walls, containers, crates; fences/glass/grates never do), and each cell's set is dilated with its
 * 8 neighbours, so the result is conservative. It ships as public/assets/pvs/level.json.
 *
 * At runtime the camera's cell is looked up once per cell change and targets outside the set are hidden for every
 * camera (main, scope, AO), but never shadow casters: shadows come from separate static casters (Lod.js), so
 * things behind you still shade the view. If the level changed since the bake (hash mismatch) the PVS disables
 * itself and logs a warning to re-bake.
 */
export const PVS_GRID = { x0: -62, z0: -62, size: 4, nx: 31, nz: 31, storey: 3.4, ny: 3 };

const fnv = (str) => { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); };

/** Deterministic target list (shared by bake + runtime). */
export function pvsTargets(level) {
  const chunks = [];
  for (const o of level.group.children) {
    if (!o.isMesh || !/^lvl_/.test(o.name) || !o.userData.chunk || o.userData.chunk === 'G') continue;
    if (o.castShadow) continue; // its own shadow must never depend on camera visibility
    chunks.push(o);
  }
  chunks.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const props = new Map(); // name -> [bm parts]
  for (const bm of level.propBatches || []) (props.get(bm.name) || props.set(bm.name, []).get(bm.name)).push(bm);
  const targets = [];
  const box = new THREE.Box3(), b2 = new THREE.Box3(), m4 = new THREE.Matrix4();
  for (const c of chunks) {
    c.geometry.computeBoundingBox();
    targets.push({ name: c.name, kind: 'chunk', mesh: c, box: c.geometry.boundingBox.clone() });
  }
  for (const name of [...props.keys()].sort()) {
    const parts = props.get(name);
    const n = Math.min(...parts.map((p) => p.instanceCount));
    for (let i = 0; i < n; i++) {
      box.makeEmpty();
      for (const p of parts) { p.getBoundingBoxAt(0, b2); // full-detail geometry (id 0), LOD-independent
        b2.applyMatrix4(p.getMatrixAt(i, m4)); box.union(b2); }
      targets.push({ name: `${name}:${i}`, kind: 'prop', parts, index: i, box: box.clone() });
    }
  }
  const sig = targets.map((t) => t.name + '|' + t.box.min.toArray().concat(t.box.max.toArray()).map((v) => v.toFixed(1)).join(',')).join(';');
  return { targets, hash: fnv(sig) };
}

export class Pvs {
  constructor(game) {
    this.game = game;
    this.enabled = false;
    this.cell = -2;
    this.stats = { hiddenChunks: 0, hiddenProps: 0 };
  }

  async load(url = './assets/pvs/level.json') {
    let data;
    try { const r = await fetch(url); if (!r.ok) throw new Error(r.status); data = await r.json(); } catch (e) { console.warn('PVS: no baked data (' + e.message + '); culling disabled. Run node tools/perf/bake_pvs.mjs'); return false; }
    const { targets, hash } = pvsTargets(this.game.level);
    if (data.hash !== hash || data.targets !== targets.length) { console.warn(`PVS: level changed since bake (${data.hash} vs ${hash}); culling disabled. Re-run node tools/perf/bake_pvs.mjs`); return false; }
    this.targets = targets;
    this.grid = data.grid;
    this.rowBytes = Math.ceil(targets.length / 8);
    const bin = atob(data.rows);
    this.rows = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) this.rows[i] = bin.charCodeAt(i);
    this.cellRow = Int32Array.from(data.cellRow); // -1 = no data (all visible)
    this._byKey = new Map();
    targets.forEach((t, i) => { if (t.kind === 'chunk') { const k = t.mesh.userData.chunk; (this._byKey.get(k) || this._byKey.set(k, []).get(k)).push(i); } });
    this.enabled = true;
    return true;
  }

  cellOf(p) {
    const G = this.grid;
    const ix = Math.floor((p.x - G.x0) / G.size), iz = Math.floor((p.z - G.z0) / G.size), iy = Math.max(0, Math.min(G.ny - 1, Math.floor(p.y / G.storey)));
    if (ix < 0 || iz < 0 || ix >= G.nx || iz >= G.nz) return -1;
    return (iy * G.nz + iz) * G.nx + ix;
  }

  /**
   * Coarse: could anything at world point p be visible from the camera's cell? (any visible level chunk in the
   * same 24 m chunk cell). Used by ambience to throttle hidden emitters. Always true when the PVS is off.
   */
  visiblePoint(p) {
    if (!this.enabled || this._row < 0) return true;
    const key = `${Math.floor((p.x + 60) / 24)},${Math.floor((p.z + 60) / 24)}`;
    const list = this._byKey.get(key);
    if (!list) return true;
    for (const i of list) if (this.visibleTarget(i)) return true;
    return false;
  }

  visibleTarget(i) {
    if (!this.enabled || this._row < 0) return true;
    return (this.rows[this._row * this.rowBytes + (i >> 3)] >> (i & 7)) & 1;
  }

  update() {
    if (!this.enabled) return;
    const cam = this.game.renderer.camera;
    const cell = this.cellOf(cam.position);
    if (cell === this.cell) return;
    this.cell = cell;
    this._row = cell < 0 ? -1 : this.cellRow[cell];
    let hc = 0, hp = 0;
    for (let i = 0; i < this.targets.length; i++) {
      const t = this.targets[i], vis = !!this.visibleTarget(i);
      if (t.kind === 'chunk') { t.mesh.visible = vis; if (!vis) hc++; }
      else { for (const p of t.parts) p.setVisibleAt(t.index, vis); if (!vis) hp++; }
    }
    this.stats = { hiddenChunks: hc, hiddenProps: hp, cell, row: this._row };
  }

  disable() {
    if (!this.targets) return;
    for (const t of this.targets) { if (t.kind === 'chunk') t.mesh.visible = true; else for (const p of t.parts) p.setVisibleAt(t.index, true); }
    this.enabled = false; this.cell = -2;
  }
}

/**
 * Bake helper (run in the page by tools/perf/bake_pvs.mjs through the QA runner): visibility bitsets for the given
 * cells. Returns { [cell]: base64 bitset | null } (null = no standable floor / camera can't be here → all visible).
 */
export function bakePvsCells(game, cells, grid = PVS_GRID) {
  const ph = game.physics, R = ph.R, world = ph.world;
  const { targets } = pvsTargets(game.level);
  const occ = new Map();
  const isOcc = (c) => {
    let v = occ.get(c.handle);
    if (v === undefined) { const h = c.shapeType() === 1 ? c.halfExtents() : null; v = !!h && Math.min(h.x, h.y, h.z) >= 0.08; occ.set(c.handle, v); }
    return v;
  };
  const ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
  const cast = (o, d, len, pred) => { ray.origin = o; ray.dir = d; return world.castRay(ray, len, true, undefined, undefined, undefined, undefined, pred); };
  // Sample points per target.
  const samples = targets.map((t) => {
    const b = t.box, c = b.getCenter(new THREE.Vector3()), s = b.getSize(new THREE.Vector3()).multiplyScalar(0.45);
    const pts = [c.clone()];
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) pts.push(new THREE.Vector3(c.x + x * s.x, c.y + y * s.y, c.z + z * s.z));
    for (const [x, y, z] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]]) pts.push(new THREE.Vector3(c.x + x * s.x, c.y + y * s.y, c.z + z * s.z));
    if (t.kind === 'chunk') {
      const p = t.mesh.geometry.attributes.position, n = p.count, step = Math.max(1, Math.floor(n / 24));
      for (let i = 0; i < n; i += step) pts.push(new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i)).lerp(c, 0.02));
    }
    return pts;
  });
  const out = {};
  const d = { x: 0, y: 0, z: 0 }, o = { x: 0, y: 0, z: 0 };
  const xzs = [[0.5, 0.5], [0.12, 0.12], [0.88, 0.88], [0.12, 0.88], [0.88, 0.12]];
  for (const cell of cells) {
    const ix = cell % grid.nx, iz = Math.floor(cell / grid.nx) % grid.nz, iy = Math.floor(cell / (grid.nx * grid.nz));
    const y0 = iy * grid.storey;
    const eyes = [];
    for (const [fx, fz] of xzs) {
      const x = grid.x0 + (ix + fx) * grid.size, z = grid.z0 + (iz + fz) * grid.size;
      // Upper storeys only where there is a floor to stand on inside this bucket.
      if (iy > 0) { o.x = x; o.y = y0 + 3.0; o.z = z; d.x = 0; d.y = -1; d.z = 0; const h = cast(o, d, 3.3, undefined); if (!h) continue; }
      for (const hy of [0.5, 1.5, 2.6]) {
        o.x = x; o.y = y0 + hy; o.z = z;
        d.x = 0; d.y = 1; d.z = 0;
        const inside = cast(o, d, 0.02, isOcc);
        if (inside && inside.timeOfImpact === 0) continue;
        eyes.push({ x, y: y0 + hy, z });
      }
    }
    if (!eyes.length) { out[cell] = null; continue; }
    const bits = new Uint8Array(Math.ceil(targets.length / 8));
    for (let ti = 0; ti < targets.length; ti++) {
      let vis = false;
      for (const e of eyes) {
        for (const p of samples[ti]) {
          const dx = p.x - e.x, dy = p.y - e.y, dz = p.z - e.z, len = Math.hypot(dx, dy, dz);
          if (len < 0.8) { vis = true; break; }
          d.x = dx / len; d.y = dy / len; d.z = dz / len;
          if (!cast(e, d, len - 0.45, isOcc)) { vis = true; break; }
        }
        if (vis) break;
      }
      if (vis) bits[ti >> 3] |= 1 << (ti & 7);
    }
    let s = ''; for (const b of bits) s += String.fromCharCode(b);
    out[cell] = btoa(s);
  }
  return { out, targets: targets.length };
}

if (typeof window !== 'undefined') window.__pvsLib = { pvsTargets, bakePvsCells, PVS_GRID };
