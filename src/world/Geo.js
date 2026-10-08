import * as THREE from 'three';

/**
 * Box geometry with world-space (tri-planar style) UVs so textures tile at a constant texel
 * density across every piece of level geometry — key for consistent-looking art.
 * uvScale = metres per texture repeat.
 */
export function worldBox(w, h, d, uvScale = 2, opts = {}) {
  const g = new THREE.BoxGeometry(w, h, d);
  const pos = g.attributes.position, nor = g.attributes.normal, uv = g.attributes.uv;
  const ox = opts.offset?.x ?? 0, oy = opts.offset?.y ?? 0, oz = opts.offset?.z ?? 0;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + ox, y = pos.getY(i) + oy, z = pos.getZ(i) + oz;
    const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i));
    let u, v;
    if (ny > 0.5) { u = x; v = z; }
    else if (nx > 0.5) { u = z; v = y; }
    else { u = x; v = y; }
    uv.setXY(i, u / uvScale, v / uvScale);
  }
  // Second UV set for AO maps.
  g.setAttribute('uv1', uv.clone());
  return g;
}

/** Re-project UVs of an already transformed geometry into world space (call after applyMatrix4). */
export function worldUV(g, uvScale = 2) {
  const pos = g.attributes.position, nor = g.attributes.normal;
  let uv = g.attributes.uv;
  if (!uv) { uv = new THREE.BufferAttribute(new Float32Array(pos.count * 2), 2); g.setAttribute('uv', uv); }
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i)), nz = Math.abs(nor.getZ(i));
    let u, v;
    if (ny >= nx && ny >= nz) { u = x; v = z; }
    else if (nx >= nz) { u = z; v = y; }
    else { u = x; v = y; }
    uv.setXY(i, u / uvScale, v / uvScale);
  }
  uv.needsUpdate = true;
  g.setAttribute('uv1', uv.clone());
  return g;
}
