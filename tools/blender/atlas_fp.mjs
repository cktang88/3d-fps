// Texture atlas for many-material FP rigs (VSS: 26 gun materials, P226: 4): merges every opaque gun material whose
// TEXCOORD_0 stays inside [0, 1] into ONE material with atlased base colour / normal / metal-rough (+ specular
// colour) maps. Atlas space per material is proportional to its world-space surface area (uniform texel density),
// each tile is cropped to the UV range it uses, padded with a 6 px edge-extended gutter, and the UVs are remapped.
// Factors are baked into the pixels (merged material uses factor 1). Ambient occlusion on TEXCOORD_1 (one rig atlas
// shared by every material, possibly packed into the R channel of the metal-rough maps) becomes its own texture.
// Arms, glass and anything else that does not qualify keep their own materials.
//   node tools/blender/atlas_fp.mjs <in.glb> <out.glb> [size=2048]
// Runs on the raw build_rig.py export, before tools/blender/optimize.sh (which keeps atlases at up to 2048 px).
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRMaterialsSpecular } from '@gltf-transform/extensions';
import sharp from 'sharp';

const [IN, OUT, SIZE = '2048'] = process.argv.slice(2);
const S = +SIZE, PAD = 6;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(IN);
const root = doc.getRoot();

// ---- gather primitives per material (with world matrices for surface area)
const mats = new Map(); // material -> { prims: [{prim, world}] }
for (const scene of root.listScenes()) scene.traverse((node) => {
  const mesh = node.getMesh(); if (!mesh) return;
  const W = node.getWorldMatrix();
  for (const prim of mesh.listPrimitives()) {
    const m = prim.getMaterial(); if (!m) continue;
    if (!mats.has(m)) mats.set(m, { prims: [] });
    mats.get(m).prims.push({ prim, W, skinned: !!node.getSkin() });
  }
});

const xf = (W, v) => [W[0] * v[0] + W[4] * v[1] + W[8] * v[2] + W[12], W[1] * v[0] + W[5] * v[1] + W[9] * v[2] + W[13], W[2] * v[0] + W[6] * v[1] + W[10] * v[2] + W[14]];
const triArea3 = (a, b, c) => { const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]; const x = u[1] * v[2] - u[2] * v[1], y = u[2] * v[0] - u[0] * v[2], z = u[0] * v[1] - u[1] * v[0]; return Math.hypot(x, y, z) / 2; };

// Wrapped UVs (tiling textures): shift each triangle by whole tiles into [0, 1] where it fits, splitting vertices
// shared by triangles with different shifts. Returns false (primitive untouched) if some triangle spans a seam.
function unwrapPrim(prim) {
  const uv = prim.getAttribute('TEXCOORD_0'), idx = prim.getIndices();
  if (!uv || !idx || prim.listTargets().length) return false;
  const n = idx.getCount(), shift = new Int32Array(n / 3 * 2);
  for (let t = 0; t < n / 3; t++) {
    const T = [0, 1, 2].map((j) => uv.getElement(idx.getScalar(t * 3 + j), []));
    const su = Math.floor((T[0][0] + T[1][0] + T[2][0]) / 3), sv = Math.floor((T[0][1] + T[1][1] + T[2][1]) / 3);
    for (const q of T) if (q[0] - su < -0.004 || q[0] - su > 1.004 || q[1] - sv < -0.004 || q[1] - sv > 1.004) return false;
    shift[t * 2] = su; shift[t * 2 + 1] = sv;
  }
  if (!shift.some((x) => x !== 0)) return true;
  const key = new Map(), remap = [], newIdx = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const v = idx.getScalar(i), t = (i / 3) | 0, k = `${v},${shift[t * 2]},${shift[t * 2 + 1]}`;
    let ni = key.get(k);
    if (ni === undefined) { ni = remap.length; key.set(k, ni); remap.push([v, shift[t * 2], shift[t * 2 + 1]]); }
    newIdx[i] = ni;
  }
  for (const sem of prim.listSemantics()) {
    const a = prim.getAttribute(sem), es = a.getElementSize(), Arr = a.getArray().constructor, out = new Arr(remap.length * es), el = [];
    remap.forEach(([v, su, sv], i) => { a.getElement(v, el); if (sem === 'TEXCOORD_0') { el[0] -= su; el[1] -= sv; } for (let c = 0; c < es; c++) out[i * es + c] = el[c]; });
    prim.setAttribute(sem, a.clone().setArray(out));
  }
  prim.setIndices(idx.clone().setArray(newIdx));
  return true;
}

const cands = [];
for (const [m, info] of mats) {
  if (!/^arms$/i.test(m.getName() || '') && !/glass/i.test(m.getName() || '') && !info.prims.some((p) => p.skinned)) {
    const ok = info.prims.every(({ prim }) => { const uv = prim.getAttribute('TEXCOORD_0'); if (!uv) return true; const a = uv.getMin([]), b = uv.getMax([]); return (a[0] >= -0.002 && a[1] >= -0.002 && b[0] <= 1.002 && b[1] <= 1.002) || unwrapPrim(prim); });
    if (!ok) console.log(`  (${m.getName()}: some triangles span a texture seam)`);
  }
  const name = m.getName() || '';
  const why = [];
  const ior = m.getExtension('KHR_materials_ior')?.getIOR() ?? 1.5;
  if (/^arms$/i.test(name) || info.prims.some((p) => p.skinned)) why.push('arms/skinned');
  if (/glass/i.test(name)) why.push('glass');
  if (m.getAlphaMode() !== 'OPAQUE') why.push('alpha ' + m.getAlphaMode());
  if (m.getEmissiveTexture()) why.push('emissive tex');
  for (const t of [m.getBaseColorTextureInfo(), m.getNormalTextureInfo(), m.getMetallicRoughnessTextureInfo()]) if (t && t.getTexCoord() !== 0) why.push('texcoord');
  if (m.getExtension('KHR_texture_transform')) why.push('transform');
  let u0 = 1, v0 = 1, u1 = 0, v1 = 0, area = 0, uvArea = 0, outside = 0;
  for (const { prim, W } of info.prims) {
    const uv = prim.getAttribute('TEXCOORD_0'), pos = prim.getAttribute('POSITION'); if (!uv) { why.push('no uv'); continue; }
    const idx = prim.getIndices(); const n = idx ? idx.getCount() : pos.getCount();
    const P = [], T = [];
    for (let i = 0; i < n; i++) {
      const k = idx ? idx.getScalar(i) : i;
      P.push(xf(W, pos.getElement(k, []))); const t = uv.getElement(k, []); T.push(t);
      if (t[0] < -0.005 || t[0] > 1.005 || t[1] < -0.005 || t[1] > 1.005) outside++;
      u0 = Math.min(u0, t[0]); u1 = Math.max(u1, t[0]); v0 = Math.min(v0, t[1]); v1 = Math.max(v1, t[1]);
      if (P.length === 3) { area += triArea3(...P); uvArea += Math.abs((T[1][0] - T[0][0]) * (T[2][1] - T[0][1]) - (T[2][0] - T[0][0]) * (T[1][1] - T[0][1])) / 2; P.length = 0; T.length = 0; }
    }
  }
  if (outside) why.push(`uv outside [0,1] (${outside})`);
  const bc = m.getBaseColorTexture();
  if (why.length) { console.log(`keep  ${name}: ${why.join(', ')}`); continue; }
  u0 = Math.max(0, u0); v0 = Math.max(0, v0); u1 = Math.min(1, u1); v1 = Math.min(1, v1);
  if (u1 - u0 < 1e-4 || v1 - v0 < 1e-4) { u0 = 0; v0 = 0; u1 = 1; v1 = 1; } // solid-colour parts
  cands.push({ m, name, info, u0, v0, u1, v1, area, uvArea, bc, ior });
}
if (new Set(cands.map((c) => c.ior)).size > 1) console.log('warning: mixed IOR', [...new Set(cands.map((c) => c.ior))]);
if (cands.length < 2) { console.log('nothing to atlas'); await io.write(OUT, doc); process.exit(0); }

// ---- decode source images once
const dec = new Map();
async function pixels(tex) {
  if (!tex) return null;
  if (dec.has(tex)) return dec.get(tex);
  const { data, info } = await sharp(Buffer.from(tex.getImage())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const r = { data, w: info.width, h: info.height };
  dec.set(tex, r); return r;
}

// ---- rect sizes: area ~ world area / used UV fraction (uniform texel density), capped at the source crop res.
for (const c of cands) {
  const srcW = c.bc ? (await pixels(c.bc)).w : 256;
  c.cw = (c.u1 - c.u0) * srcW; c.ch = (c.v1 - c.v0) * srcW; // source crop px (square textures)
  const fill = Math.max(0.05, c.uvArea / ((c.u1 - c.u0) * (c.v1 - c.v0)));
  c.need = c.area / fill; // m^2 of atlas-equivalent surface
}
function pack(rho) {
  const rects = cands.map((c) => {
    const asp = (c.u1 - c.u0) / (c.v1 - c.v0);
    let h = Math.sqrt(c.need * rho * rho / asp), w = h * asp;
    const k = Math.min(1, c.cw / w, c.ch / h); w *= k; h *= k;
    return { c, w: Math.max(8, Math.round(w)), h: Math.max(8, Math.round(h)) };
  }).sort((a, b) => b.h - a.h);
  let x = 0, y = 0, rowH = 0;
  for (const r of rects) {
    const W = r.w + 2 * PAD, H = r.h + 2 * PAD;
    if (x + W > S) { x = 0; y += rowH; rowH = 0; }
    r.x = x + PAD; r.y = y + PAD; x += W; rowH = Math.max(rowH, H);
  }
  return y + rowH <= S ? rects : null;
}
let lo = 1, hi = 1e6, best = null;
for (let i = 0; i < 40; i++) { const mid = Math.sqrt(lo * hi); const p = pack(mid); if (p) { best = p; lo = mid; } else hi = mid; }
console.log(`atlas ${S}px: ${best.length} materials, texel density ${(lo / 100).toFixed(0)} px/cm`);

// ---- compose atlases
const has = (k) => cands.some((c) => k(c.m));
const layers = {
  base: { get: (m) => m.getBaseColorTexture(), fill: (m) => { const f = m.getBaseColorFactor(); return [f[0] * 255, f[1] * 255, f[2] * 255, 255]; }, mul: (m) => m.getBaseColorFactor().map((x) => x) },
  normal: has((m) => m.getNormalTexture()) ? { get: (m) => m.getNormalTexture(), fill: () => [128, 128, 255, 255] } : null,
  mr: has((m) => m.getMetallicRoughnessTexture()) || new Set(cands.map((c) => `${c.m.getMetallicFactor()},${c.m.getRoughnessFactor()}`)).size > 1
    ? { get: (m) => m.getMetallicRoughnessTexture(), fill: (m) => [255, m.getRoughnessFactor() * 255, m.getMetallicFactor() * 255, 255], mr: true } : null,
  spec: has((m) => m.getExtension('KHR_materials_specular')?.getSpecularColorTexture())
    ? { get: (m) => m.getExtension('KHR_materials_specular')?.getSpecularColorTexture(), fill: (m) => { const s = m.getExtension('KHR_materials_specular'); const f = s ? s.getSpecularColorFactor() : [1, 1, 1]; return [f[0] * 255, f[1] * 255, f[2] * 255, 255]; }, spec: true } : null,
};
const SRGB = (x) => (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));
const toS = (x) => Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055));
async function compose(L) {
  const out = Buffer.alloc(S * S * 4);
  for (const r of best) {
    const m = r.c.m, tex = L.get(m), src = await pixels(tex);
    const W = r.w + 2 * PAD, H = r.h + 2 * PAD;
    let tile;
    if (src) {
      const left = Math.floor(r.c.u0 * src.w), top = Math.floor(r.c.v0 * src.h);
      const cw = Math.max(1, Math.min(src.w - left, Math.ceil(r.c.u1 * src.w) - left)), ch = Math.max(1, Math.min(src.h - top, Math.ceil(r.c.v1 * src.h) - top));
      tile = await sharp(src.data, { raw: { width: src.w, height: src.h, channels: 4 } }).extract({ left, top, width: cw, height: ch })
        .resize(r.w, r.h, { fit: 'fill', kernel: 'lanczos3' }).extend({ top: PAD, bottom: PAD, left: PAD, right: PAD, extendWith: 'copy' }).raw().toBuffer();
    } else {
      tile = Buffer.alloc(W * H * 4); const f = L.fill(m);
      for (let i = 0; i < W * H; i++) tile.set(f.map((x) => Math.max(0, Math.min(255, Math.round(x)))), i * 4);
    }
    // bake factors (base colour factor in linear space; metal / roughness factors multiply their channels)
    if (src && L === layers.base) {
      const f = m.getBaseColorFactor();
      if (f.some((x) => Math.abs(x - 1) > 1e-3)) for (let i = 0; i < tile.length; i += 4) for (let ch = 0; ch < 3; ch++) tile[i + ch] = toS(SRGB(tile[i + ch] / 255) * f[ch]);
    }
    if (src && L === layers.normal && Math.abs(m.getNormalScale() - 1) > 1e-3) {
      const k = m.getNormalScale();
      for (let i = 0; i < tile.length; i += 4) {
        let x = (tile[i] / 255 * 2 - 1) * k, y = (tile[i + 1] / 255 * 2 - 1) * k, z = tile[i + 2] / 255 * 2 - 1;
        const l = Math.hypot(x, y, z) || 1; x /= l; y /= l; z /= l;
        tile[i] = Math.round((x + 1) * 127.5); tile[i + 1] = Math.round((y + 1) * 127.5); tile[i + 2] = Math.round((z + 1) * 127.5);
      }
    }
    if (src && L.mr) { const mf = m.getMetallicFactor(), rf = m.getRoughnessFactor(); for (let i = 0; i < tile.length; i += 4) { tile[i + 1] = Math.round(tile[i + 1] * rf); tile[i + 2] = Math.round(tile[i + 2] * mf); tile[i] = 255; } }
    if (src && L.spec) { const s = m.getExtension('KHR_materials_specular'); const f = s.getSpecularColorFactor(); if (f.some((x) => Math.abs(x - 1) > 1e-3)) for (let i = 0; i < tile.length; i += 4) for (let ch = 0; ch < 3; ch++) tile[i + ch] = toS(SRGB(tile[i + ch] / 255) * f[ch]); }
    for (let y = 0; y < H; y++) tile.copy(out, ((r.y - PAD + y) * S + (r.x - PAD)) * 4, y * W * 4, (y + 1) * W * 4);
  }
  return sharp(out, { raw: { width: S, height: S, channels: 4 } }).removeAlpha().png().toBuffer();
}

// ---- merged material
const first = cands[0].m;
const atlas = first.clone().setName('gun_atlas');
const mk = async (L, nm) => doc.createTexture(nm).setImage(await compose(L)).setMimeType('image/png').setURI(nm + '.png');
atlas.setBaseColorFactor([1, 1, 1, 1]).setBaseColorTexture(await mk(layers.base, 'atlas_base'));
atlas.setNormalTexture(layers.normal ? await mk(layers.normal, 'atlas_normal') : null);
if (layers.normal) atlas.getNormalTextureInfo().setTexCoord(0);
const scales = new Set(cands.filter((c) => c.m.getNormalTexture()).map((c) => c.m.getNormalScale().toFixed(3)));
atlas.setNormalScale(1); // per-material scales are baked into the atlas pixels
if (layers.mr) { atlas.setMetallicRoughnessTexture(await mk(layers.mr, 'atlas_mr')).setMetallicFactor(1).setRoughnessFactor(1); atlas.getMetallicRoughnessTextureInfo().setTexCoord(0); }
else atlas.setMetallicRoughnessTexture(null);
if (layers.spec) {
  const old = first.getExtension('KHR_materials_specular');
  const s = doc.createExtension(KHRMaterialsSpecular).createSpecular().setSpecularFactor(old ? old.getSpecularFactor() : 1);
  s.setSpecularColorTexture(await mk(layers.spec, 'atlas_spec')).setSpecularColorFactor([1, 1, 1]);
  const ex = new Set(cands.map((c) => { const e = c.m.getExtension('KHR_materials_specular'); return e ? `${e.getSpecularFactor()}|${!!e.getSpecularTexture()}` : 'none'; }));
  if (ex.size > 1) console.log('warning: mixed specular factors / textures', [...ex]);
  atlas.setExtension('KHR_materials_specular', s);
}
// AO (TEXCOORD_1): one shared rig bake; if it lived in the R channel of the per-material MR maps, extract it.
const aoInfo = first.getOcclusionTextureInfo(), aoTex = first.getOcclusionTexture();
if (aoTex && aoInfo.getTexCoord() === 1) {
  if (aoTex !== first.getMetallicRoughnessTexture() && /^rig_.*_ao$/.test(aoTex.getName())) atlas.setOcclusionTexture(aoTex);
  else { // AO packed into R (Blender exporter): keep only that channel
    const src = await pixels(aoTex);
    const ao = Buffer.alloc(src.w * src.h * 3);
    for (let i = 0; i < src.w * src.h; i++) ao[i * 3] = ao[i * 3 + 1] = ao[i * 3 + 2] = src.data[i * 4];
    atlas.setOcclusionTexture(doc.createTexture('rig_ao').setImage(await sharp(ao, { raw: { width: src.w, height: src.h, channels: 3 } }).png().toBuffer()).setMimeType('image/png').setURI('rig_ao.png'));
  }
  atlas.getOcclusionTextureInfo().setTexCoord(1);
  atlas.setOcclusionStrength(first.getOcclusionStrength());
}

// ---- remap UVs (accessors may be shared between primitives: remap each accessor once, per material)
const done = new Map();
for (const r of best) {
  const c = r.c;
  const a = [r.x / S, r.y / S, r.w / S, r.h / S];
  for (const { prim } of c.info.prims) {
    let uv = prim.getAttribute('TEXCOORD_0');
    if (done.has(uv)) { if (done.get(uv) !== c) { uv = uv.clone(); prim.setAttribute('TEXCOORD_0', uv); } else { prim.setMaterial(atlas); continue; } }
    done.set(uv, c);
    const arr = new Float32Array(uv.getCount() * 2);
    for (let i = 0; i < uv.getCount(); i++) {
      const t = uv.getElement(i, []);
      arr[i * 2] = a[0] + ((Math.min(1, Math.max(0, t[0])) - c.u0) / (c.u1 - c.u0)) * a[2];
      arr[i * 2 + 1] = a[1] + ((Math.min(1, Math.max(0, t[1])) - c.v0) / (c.v1 - c.v0)) * a[3];
    }
    uv.setArray(arr).setNormalized(false);
    prim.setMaterial(atlas);
  }
}
for (const c of cands) c.m.dispose();
console.log('merged:', cands.map((c) => c.name).join(' '));
await io.write(OUT, doc);
