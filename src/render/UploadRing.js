import * as THREE from 'three';

/**
 * Ring-buffered per-frame data textures (render owner; Apple / ANGLE-Metal mitigation).
 *
 * three re-uploads some small data textures on every render() call, from inside the render pass:
 *   - Skeleton.boneTexture (skeleton.update() runs once per render() call that draws the skinned mesh),
 *   - BatchedMesh._indirectTexture (rewritten in onBeforeRender / onBeforeShadow when per-instance culling is on).
 * On D3D11 the driver renames the texture. On Metal (ANGLE), writing a texture that a not-yet-finished command
 * buffer still samples either blocks the CPU until the GPU is done with it, or splits the current render pass for a
 * blit (a full tile store + reload on Apple's TBDR GPUs). Either one, repeated dozens of times per frame, serialises
 * CPU and GPU.
 *
 * The fix: each such texture becomes a ring of N textures, each with its own GL texture object (a new Source; three
 * shares GL textures between textures with the same Source), and every rewrite moves to the next one. The slot being
 * written was last used N writes ago, so the GPU has finished with it. Memory cost is small (bone textures are 4–16 KB,
 * indirect textures a few KB). Toggle with uploadRing.enabled (benchmark A/B step).
 */
export const uploadRing = { enabled: false, size: 8, tick: 0, stats: { bone: 0, indirect: 0, indirectReused: 0 } };
window.__uploadRing = uploadRing; // QA / console

function ringNext(holder, key, current, make) {
  let r = holder[key];
  if (!r || !r.list.includes(current)) r = holder[key] = { list: [current], i: 0 };
  r.i = (r.i + 1) % uploadRing.size;
  if (!r.list[r.i]) r.list[r.i] = make();
  return r.list[r.i];
}

function dataTextureLike(src, data) {
  const t = new THREE.DataTexture(data, src.image.width, src.image.height, src.format, src.type);
  t.minFilter = src.minFilter; t.magFilter = src.magFilter;
  t.generateMipmaps = false; t.flipY = false; t.unpackAlignment = src.unpackAlignment;
  t.internalFormat = src.internalFormat;
  t.colorSpace = src.colorSpace;
  return t;
}

// ---- Skeletons
{
  const P = THREE.Skeleton.prototype, update = P.update, dispose = P.dispose;
  P.update = function () {
    update.call(this);
    const bt = this.boneTexture;
    if (!uploadRing.enabled || !bt) return;
    // All slots share this.boneMatrices (uploaded at bind time, before the next update rewrites it).
    const next = ringNext(this, '_boneRing', bt, () => dataTextureLike(bt, this.boneMatrices));
    if (next.image.data !== this.boneMatrices) next.image.data = this.boneMatrices;
    next.needsUpdate = true;
    this.boneTexture = next;
    uploadRing.stats.bone++;
  };
  P.dispose = function () {
    const r = this._boneRing;
    if (r) for (const t of r.list) if (t && t !== this.boneTexture) t.dispose();
    this._boneRing = null;
    return dispose.call(this);
  };
}

// ---- BatchedMesh indirect (instance id) textures
{
  const P = THREE.BatchedMesh.prototype, before = P.onBeforeRender, dispose = P.dispose;
  P.onBeforeRender = function (...a) {
    const it = this._indirectTexture;
    // Only rewrite when three is about to (it returns early otherwise and the bound texture stays valid).
    if (!(uploadRing.enabled && it && (this._visibilityChanged || this.perObjectFrustumCulled || this.sortObjects))) return before.apply(this, a);
    let r = this._idRing;
    if (!r || !r.list.includes(it)) { r = this._idRing = { list: [it], scratch: null }; it.userData.used = 0; it.userData.count = -1; }
    const tick = ++uploadRing.tick;
    // Cull into a scratch texture first; three writes image.data[0..count).
    const scratch = r.scratch ||= dataTextureLike(it, new it.image.data.constructor(it.image.data.length));
    this._indirectTexture = scratch;
    const res = before.apply(this, a);
    const n = this._multiDrawCount, d = scratch.image.data;
    // Dedupe: the culled list rarely changes between frames (the sun's shadow camera never moves). A slot that
    // already holds exactly this list on the GPU is bound as is: no upload.
    let lru = null;
    for (const t of r.list) {
      if (t.userData.count === n) {
        const td = t.image.data;
        let same = true;
        for (let j = 0; j < n; j++) if (td[j] !== d[j]) { same = false; break; }
        if (same) { t.userData.used = tick; this._indirectTexture = t; uploadRing.stats.indirectReused++; return res; }
      }
      if (!lru || t.userData.used < lru.userData.used) lru = t;
    }
    // Otherwise write the least recently bound slot (or grow the ring): the GPU finished with it frames ago.
    let slot = lru;
    if (r.list.length < uploadRing.size) { slot = dataTextureLike(it, new it.image.data.constructor(it.image.data.length)); r.list.push(slot); }
    slot.image.data.set(n === d.length ? d : d.subarray(0, n));
    slot.needsUpdate = true;
    slot.userData.count = n; slot.userData.used = tick;
    this._indirectTexture = slot;
    uploadRing.stats.indirect++;
    return res;
  };
  P.dispose = function () {
    const r = this._idRing;
    if (r) { for (const t of r.list) if (t && t !== this._indirectTexture) t.dispose(); r.scratch?.dispose(); }
    this._idRing = null;
    return dispose.call(this);
  };
}
