import * as THREE from 'three';
import { MeshoptSimplifier } from 'three/addons/libs/meshopt_simplifier.module.js';
import { mergeVertices, mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Runtime mesh LOD via meshoptimizer's simplifier (WASM, ~100 ms for a 100k-tri mesh). Only the index buffer
 * changes — vertex attributes (incl. skin weights, UV seams) are shared with the source, so a simplified
 * geometry drops into a SkinnedMesh / material unchanged. Results are cached per source geometry + budget.
 * Await `lodReady` once before first use (Game.init does); before that, sources are returned unchanged.
 */
export const lodReady = MeshoptSimplifier.ready.then(() => { _ready = true; });
let _ready = false;
const _cache = new WeakMap();

/**
 * @param {THREE.BufferGeometry} geo
 * @param {number} maxTris  triangle budget for the whole geometry (all groups)
 * @param {number} error    max deviation relative to the mesh extent (0.01 = 1%)
 */
export function simplifiedGeometry(geo, maxTris, error = 0.01) {
  if (!_ready || !geo?.attributes?.position) return geo;
  const tris = (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
  if (tris <= maxTris * 1.15) return geo;
  let per = _cache.get(geo);
  if (!per) _cache.set(geo, (per = new Map()));
  const key = maxTris + '|' + error;
  if (per.has(key)) return per.get(key);
  const src = geo.index ? geo : mergeVertices(geo);
  const p = src.attributes.position;
  const pos = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) { pos[i * 3] = p.getX(i); pos[i * 3 + 1] = p.getY(i); pos[i * 3 + 2] = p.getZ(i); }
  const index = src.index.array;
  const ratio = maxTris / tris;
  const groups = src.groups.length ? src.groups : [{ start: 0, count: index.length, materialIndex: 0 }];
  const outIdx = [], outGroups = [];
  let at = 0;
  for (const gr of groups) {
    const cnt = Math.min(gr.count, index.length - gr.start);
    const sub = new Uint32Array(index.subarray(gr.start, gr.start + cnt));
    const target = Math.max(3, Math.floor((cnt / 3) * ratio) * 3);
    let res = sub;
    if (target < cnt) {
      try { [res] = MeshoptSimplifier.simplify(sub, pos, 3, target, error); } catch (e) { res = sub; }
      if (res.length < 3) res = sub; // never let a part vanish
    }
    outIdx.push(res);
    outGroups.push({ start: at, count: res.length, materialIndex: gr.materialIndex });
    at += res.length;
  }
  const merged = new Uint32Array(at);
  let o = 0;
  for (const r of outIdx) { merged.set(r, o); o += r.length; }
  const out = new THREE.BufferGeometry();
  for (const [k, v] of Object.entries(src.attributes)) out.setAttribute(k, v);
  out.morphAttributes = src.morphAttributes;
  out.setIndex(new THREE.BufferAttribute(p.count < 65536 ? new Uint16Array(merged) : merged, 1));
  if (src.groups.length) for (const g of outGroups) out.addGroup(g.start, g.count, g.materialIndex);
  out.boundingBox = src.boundingBox; out.boundingSphere = src.boundingSphere;
  if (!out.boundingSphere) out.computeBoundingSphere();
  out.name = (geo.name || '') + '_lod' + maxTris;
  out.userData.lodOf = geo;
  per.set(key, out);
  return out;
}

/**
 * Swap every mesh under `root` (e.g. a cloned gun) to simplified geometry so the whole object fits `maxTris`
 * (budget shared out in proportion to each mesh's triangle count).
 */
export function simplifyObject(root, maxTris, error = 0.01) {
  const meshes = [];
  let total = 0;
  root.traverse((o) => { if (o.isMesh && o.geometry?.attributes.position) { meshes.push(o); total += triCount(o.geometry); } });
  if (total <= maxTris) return root;
  for (const m of meshes) m.geometry = simplifiedGeometry(m.geometry, Math.max(12, Math.round(maxTris * triCount(m.geometry) / total)), error);
  return root;
}

export const triCount = (g) => (g.index ? g.index.count : g.attributes.position.count) / 3;

/**
 * Shadow LOD: objects on this layer are drawn only into shadow maps, never by the main / scope / AO cameras.
 * three tests shadow casters against the *viewing* camera's layers, after the main render list is built, so
 * installShadowProxyLayer() enables the layer on that camera just for the duration of shadowMap.render.
 */
export const SHADOW_PROXY_LAYER = 3;

export function installShadowProxyLayer(renderer) {
  const sm = renderer.shadowMap;
  if (sm.__proxyLayer) return;
  sm.__proxyLayer = true;
  const orig = sm.render;
  sm.render = function (lights, scene, camera) {
    const had = camera.layers.isEnabled(SHADOW_PROXY_LAYER);
    camera.layers.enable(SHADOW_PROXY_LAYER);
    try { return orig.call(this, lights, scene, camera); } finally { if (!had) camera.layers.disable(SHADOW_PROXY_LAYER); }
  };
}

/**
 * Give `mesh` a simplified shadow caster (≤ maxTris) and stop the full mesh casting. Rigid meshes get the proxy
 * as a child (follows transforms + visibility); skinned meshes get a SkinnedMesh sibling bound to the same skeleton
 * (it follows the parent's visibility, not the mesh's own `visible` flag).
 * Returns the proxy (or null when the mesh is already cheap enough).
 */
export function addShadowProxy(mesh, maxTris, error = 0.02) {
  if (!mesh?.isMesh || !mesh.castShadow || mesh.userData.shadowProxy) return null;
  const geo = simplifiedGeometry(mesh.geometry, maxTris, error);
  if (geo === mesh.geometry) return null;
  let proxy;
  if (mesh.isSkinnedMesh) {
    proxy = new THREE.SkinnedMesh(geo, mesh.material);
    proxy.bindMode = mesh.bindMode;
    proxy.position.copy(mesh.position); proxy.quaternion.copy(mesh.quaternion); proxy.scale.copy(mesh.scale);
    mesh.parent.add(proxy);
    proxy.updateMatrixWorld(true);
    proxy.bind(mesh.skeleton, mesh.bindMatrix);
  } else {
    proxy = new THREE.Mesh(geo, mesh.material);
    mesh.add(proxy);
  }
  proxy.name = mesh.name + '_shadowProxy';
  proxy.layers.set(SHADOW_PROXY_LAYER);
  proxy.castShadow = true;
  proxy.receiveShadow = false;
  proxy.frustumCulled = mesh.frustumCulled;
  if (mesh.boundingSphere && proxy.isSkinnedMesh) proxy.boundingSphere = mesh.boundingSphere.clone();
  for (const k of ['perfOwner']) if (mesh.userData[k]) proxy.userData[k] = mesh.userData[k];
  mesh.castShadow = false;
  mesh.userData.shadowProxy = proxy;
  return proxy;
}

const _proxyMat = new Map();
function proxyMaterial(side) {
  if (!_proxyMat.has(side)) { const m = new THREE.MeshBasicMaterial({ side, colorWrite: false }); m.name = 'shadowProxy'; _proxyMat.set(side, m); }
  return _proxyMat.get(side);
}
const _mergedCache = new WeakMap();
const matNear = (a, b) => a.elements.every((v, i) => Math.abs(v - b.elements[i]) < 1e-5);

/**
 * One merged, simplified shadow caster for a whole object (e.g. a bot = ~11 skinned parts, or a 10-part gun):
 * N shadow draw calls -> 1. Rigid meshes are merged in `root` space; skinned meshes that share a skeleton,
 * parent, local transform and bind matrix are merged into one SkinnedMesh bound to that skeleton. Meshes that
 * can't be merged keep casting themselves. Geometry is cached per source (clones share it).
 * Visibility: the proxy follows `root` and its ancestors, not per-part `visible` flags.
 */
export function addMergedShadowProxy(root, maxTris, error = 0.02) {
  if (root.userData.mergedShadowProxy) return root.userData.mergedShadowProxy;
  root.updateMatrixWorld(true);
  const rigid = [], skinned = [];
  root.traverse((o) => {
    if (!o.isMesh || !o.castShadow || !o.visible || o.layers.mask !== 1 || !o.geometry?.attributes.position) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    if (mats.some((m) => m.alphaTest > 0 || m.alphaMap || m.transparent || m.displacementMap)) return;
    if (Object.keys(o.geometry.morphAttributes).length) return;
    (o.isSkinnedMesh ? skinned : o.isInstancedMesh || o.isBatchedMesh ? [] : rigid).push(o);
  });
  let sk = null;
  if (skinned.length) {
    const b = skinned[0];
    // SkeletonUtils.clone gives every part its own Skeleton object over the same bones: compare bones + inverses.
    const sameSkel = (s) => s === b.skeleton || (s.bones.length === b.skeleton.bones.length
      && s.bones.every((x, i) => x === b.skeleton.bones[i]) && s.boneInverses.every((x, i) => matNear(x, b.skeleton.boneInverses[i])));
    sk = skinned.filter((m) => sameSkel(m.skeleton) && m.parent === b.parent && matNear(m.matrix, b.matrix) && matNear(m.bindMatrix, b.bindMatrix));
    if (sk.length < 2) sk = null;
  }
  const parts = sk || (rigid.length >= 2 ? rigid : null);
  if (!parts) return null;
  const total = parts.reduce((s, m) => s + triCount(m.geometry), 0);
  let per = _mergedCache.get(parts[0].geometry);
  if (!per) _mergedCache.set(parts[0].geometry, (per = new Map()));
  const key = maxTris + '|' + error + '|' + parts.map((m) => m.geometry.uuid).join(',');
  let geo = per.get(key);
  if (!geo) {
    const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const keep = sk ? ['position', 'skinIndex', 'skinWeight'] : ['position'];
    const geos = parts.map((m) => {
      const s = simplifiedGeometry(m.geometry, Math.max(12, Math.round(maxTris * triCount(m.geometry) / total)), error);
      const g = new THREE.BufferGeometry();
      for (const k of keep) {
        const a = s.attributes[k];
        if (!a) return null;
        // De-interleave / de-quantize so mergeGeometries can concatenate.
        const arr = new Float32Array(a.count * a.itemSize);
        for (let i = 0; i < a.count; i++) for (let c = 0; c < a.itemSize; c++) arr[i * a.itemSize + c] = a.getComponent(i, c);
        g.setAttribute(k, new THREE.BufferAttribute(arr, a.itemSize));
      }
      g.setIndex(new THREE.BufferAttribute(s.index ? new Uint32Array(s.index.array) : Uint32Array.from({ length: s.attributes.position.count }, (_, i) => i), 1));
      if (!sk) g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
      return g;
    });
    if (geos.includes(null)) return null;
    geo = mergeGeometries(geos, false);
    if (!geo) return null;
    geo.computeBoundingSphere();
    geo.name = 'mergedShadowProxy';
    per.set(key, geo);
  }
  const doubleSided = parts.some((m) => (Array.isArray(m.material) ? m.material : [m.material]).some((x) => x.side === THREE.DoubleSide));
  const mat = proxyMaterial(doubleSided ? THREE.DoubleSide : THREE.FrontSide);
  let proxy;
  if (sk) {
    const b = sk[0];
    proxy = new THREE.SkinnedMesh(geo, mat);
    proxy.bindMode = b.bindMode;
    proxy.position.copy(b.position); proxy.quaternion.copy(b.quaternion); proxy.scale.copy(b.scale);
    b.parent.add(proxy);
    proxy.updateMatrixWorld(true);
    proxy.bind(b.skeleton, b.bindMatrix);
    if (b.boundingSphere) proxy.boundingSphere = b.boundingSphere.clone();
    proxy.frustumCulled = b.frustumCulled;
  } else {
    proxy = new THREE.Mesh(geo, mat);
    root.add(proxy);
  }
  proxy.name = 'shadowProxy';
  proxy.layers.set(SHADOW_PROXY_LAYER);
  proxy.castShadow = true;
  proxy.receiveShadow = false;
  if (root.userData.perfOwner) proxy.userData.perfOwner = root.userData.perfOwner;
  for (const m of parts) m.castShadow = false;
  // Tiny rigid bits riding on a skinned body (eyes, buttons) add a shadow draw each but no visible shadow.
  if (sk) for (const m of rigid) { const r = m.geometry.boundingSphere ?? (m.geometry.computeBoundingSphere(), m.geometry.boundingSphere); if (r.radius * m.matrixWorld.getMaxScaleOnAxis() < 0.12) m.castShadow = false; }
  root.userData.mergedShadowProxy = proxy;
  return proxy;
}

const _tplCache = new WeakMap();
/**
 * Cached third-person LOD template of a rigid model (e.g. a gun): simplified to ≤ maxTris, nodes matching `drop`
 * removed, and all rigid meshes merged per material (+ attribute layout) into root-space meshes, so a 10-part gun
 * becomes 2-4 draw calls. Non-mesh nodes (sockets such as MuzzleSocket) are kept. Clone the result per user.
 */
export function rigidLodTemplate(src, maxTris, error = 0.01, drop = null) {
  let per = _tplCache.get(src);
  if (!per) _tplCache.set(src, (per = new Map()));
  const key = maxTris + '|' + error + '|' + (drop || '');
  if (per.has(key)) return per.get(key);
  const root = src.clone(true);
  if (drop) { const rm = []; root.traverse((o) => { if (o !== root && drop.test(o.name)) rm.push(o); }); for (const o of rm) o.parent?.remove(o); }
  simplifyObject(root, maxTris, error);
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const groups = new Map();
  root.traverse((o) => {
    if (!o.isMesh || o.isSkinnedMesh || o.isInstancedMesh || !o.visible || Array.isArray(o.material)) return;
    const g = o.geometry;
    if (Object.keys(g.morphAttributes).length) return;
    const sig = o.material.uuid + '|' + Object.keys(g.attributes).sort().map((k) => k + g.attributes[k].itemSize).join(',') + '|' + o.castShadow + o.receiveShadow + o.renderOrder;
    (groups.get(sig) || groups.set(sig, []).get(sig)).push(o);
  });
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const geos = list.map((m) => {
      const s = m.geometry, g = new THREE.BufferGeometry();
      for (const [k, a] of Object.entries(s.attributes)) {
        const arr = new Float32Array(a.count * a.itemSize);
        for (let i = 0; i < a.count; i++) for (let c = 0; c < a.itemSize; c++) arr[i * a.itemSize + c] = a.getComponent(i, c);
        g.setAttribute(k, new THREE.BufferAttribute(arr, a.itemSize));
      }
      g.setIndex(new THREE.BufferAttribute(s.index ? new Uint32Array(s.index.array) : Uint32Array.from({ length: s.attributes.position.count }, (_, i) => i), 1));
      g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld)); // into root space
      return g;
    });
    const merged = mergeGeometries(geos, false);
    if (!merged) continue;
    merged.computeBoundingSphere();
    const b = list[0];
    const mesh = new THREE.Mesh(merged, b.material);
    mesh.name = 'lodMerged_' + (b.material.name || '');
    mesh.castShadow = b.castShadow; mesh.receiveShadow = b.receiveShadow; mesh.renderOrder = b.renderOrder;
    mesh.frustumCulled = true;
    for (const m of list) {
      // Keep the node (it may hold sockets/children) but drop its draw.
      const stub = new THREE.Object3D();
      stub.name = m.name; stub.position.copy(m.position); stub.quaternion.copy(m.quaternion); stub.scale.copy(m.scale);
      for (const c of [...m.children]) stub.add(c);
      m.parent.add(stub); m.parent.remove(m);
    }
    root.add(mesh);
  }
  per.set(key, root);
  return root;
}

/**
 * Distance LOD by geometry swap (works for SkinnedMesh: only the index buffer differs, skinning is shared).
 * update(k) takes the camera-relative size metric k = distance * tan(fov/2) (zoom-aware: a 3.5x scope keeps
 * full detail 3.5x further). Switches to the low mesh above `far`, back to full below `near` (hysteresis).
 */
export class DistanceLod {
  constructor(root, ratio = 0.3, error = 0.01, near = 20, far = 24) {
    this.parts = [];
    this.low = false;
    this.near = near; this.far = far;
    root.traverse((o) => {
      if (!o.isMesh || o.layers.mask !== 1 || !o.geometry?.attributes.position) return;
      const t = triCount(o.geometry);
      if (t < 600) return;
      const lo = simplifiedGeometry(o.geometry, Math.round(t * ratio), error);
      if (lo !== o.geometry) this.parts.push([o, o.geometry, lo]);
    });
  }

  set(low) {
    if (low === this.low) return;
    this.low = low;
    for (const [o, hi, lo] of this.parts) o.geometry = low ? lo : hi;
  }

  update(k) { this.set(this.low ? k > this.near : k > this.far); }

  /**
   * Drive the LOD at render time from `camera` (independent of AI/animation update rates or frozen actors):
   * the first visible part's onBeforeRender measures `anchor`'s distance. A swap applies from the next draw.
   */
  bindCamera(camera, anchor) {
    const p = new THREE.Vector3();
    const fn = (r, s, cam) => {
      if (cam !== camera) return;
      p.setFromMatrixPosition(anchor.matrixWorld);
      this.update(p.distanceTo(cam.position) * Math.tan(cam.fov * Math.PI / 360));
    };
    for (const [o] of this.parts) { const prev = o.onBeforeRender; o.onBeforeRender = prev && prev !== THREE.Object3D.prototype.onBeforeRender ? (...a) => { prev.apply(o, a); fn(...a); } : fn; }
    return this;
  }
}
