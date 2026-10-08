import * as THREE from 'three';

/**
 * Material library + the scene-wide COHESION PIPELINE ("unify" shader patch).
 *
 * Every lit material in the world (level, props, bots — and, with softer settings, the viewmodel) is run
 * through `applyUnify()`. It injects one shared shader block that:
 *   1. normalises albedo into a PBR-plausible band, pulls saturation toward the palette, remaps roughness
 *      so no asset reads as plastic or chalk;
 *   2. adds a shared world-space weathering layer: low-frequency grime / tint variation (anti-tiling),
 *      ground-contact dirt on vertical faces, dust on indoor up-facing surfaces;
 *   3. GLOBAL WETNESS (art direction: just after rain): darker albedo + low roughness on exposed up-facing
 *      surfaces, rain streaks on walls, and mirror-like puddles collecting in low areas of ground surfaces
 *      (with optional animated rain ripples via `Materials.unify.uRain`);
 *   4. indoor IBL attenuation (fake large-scale occlusion inside building volumes, no wetness indoors).
 * See docs/ART_PIPELINE.md.
 */
const DEFS = {
  asphalt: { set: 'Asphalt031', tint: 0x9d9a96, normal: 1, surface: 'concrete', grime: 0.55, wet: 1, puddle: 1, rmin: 0.35 },
  ground: { set: 'Ground110', tint: 0xb3aa9c, normal: 1.3, surface: 'dirt', grime: 0.6, wet: 1, puddle: 1, rmin: 0.4 },
  brick: { set: 'Bricks097', tint: 0xc9bdb2, normal: 1.2, surface: 'concrete', grime: 0.45, wet: 0.8, rmin: 0.45 },
  plaster: { set: 'Plaster003', tint: 0xbcae96, normal: 1.4, surface: 'concrete', grime: 0.5, wet: 0.8, rmin: 0.5 },
  plasterGreen: { set: 'Plaster003', tint: 0x7d8a7c, normal: 1.0, surface: 'concrete', grime: 0.45, wet: 0.5, rmin: 0.45 },
  plasterWhite: { set: 'Plaster003', tint: 0xd6d0c4, normal: 1.1, surface: 'concrete', grime: 0.35, wet: 0.6, rmin: 0.5 },
  concrete: { set: 'Concrete034', tint: 0xb0aba3, normal: 1, surface: 'concrete', grime: 0.45, wet: 0.9, rmin: 0.45 },
  concreteDirty: { set: 'Concrete047A', tint: 0xb8b0a2, normal: 1, surface: 'concrete', grime: 0.5, wet: 1, puddle: 1, rmin: 0.4 },
  concreteFloor: { set: 'concrete_floor', tint: 0xc0bab1, normal: 1, surface: 'concrete', grime: 0.45, wet: 1, puddle: 1, rmin: 0.35 },
  metalDark: { set: 'Metal046B', tint: 0x8a8a8a, normal: 1, metal: 0.85, surface: 'metal', grime: 0.35, wet: 0.6, rmin: 0.3 },
  metalPainted: { set: 'Metal063', tint: 0x7f8c96, normal: 1, metal: 0.55, surface: 'metal', grime: 0.35, wet: 0.6, rmin: 0.35 },
  steel: { set: 'Metal055A', tint: 0x9c9c9c, rough: 0.9, normal: 1, metal: 0.9, surface: 'metal', grime: 0.3, wet: 0.5, rmin: 0.25 },
  corrugated: { set: 'corrugated_iron', tint: 0xaaa69e, normal: 1.5, metal: 0.7, surface: 'metal', grime: 0.45, wet: 0.7, rmin: 0.3 },
  // Containers re-paint the red paint of the scan with their own colour, keeping rust streaks.
  containerRed: { set: 'rusty_painted_metal', tint: 0xe0d8d0, paint: 0x8e2f22, normal: 1.2, metal: 0.35, surface: 'metal', grime: 0.4, wet: 0.7, rmin: 0.35 },
  containerBlue: { set: 'rusty_painted_metal', tint: 0xe0d8d0, paint: 0x2c4f73, normal: 1.2, metal: 0.35, surface: 'metal', grime: 0.4, wet: 0.7, rmin: 0.35 },
  containerGreen: { set: 'rusty_painted_metal', tint: 0xe0d8d0, paint: 0x3f5a35, normal: 1.2, metal: 0.35, surface: 'metal', grime: 0.4, wet: 0.7, rmin: 0.35 },
  containerTan: { set: 'rusty_painted_metal', tint: 0xe0d8d0, paint: 0x9a7d55, normal: 1.2, metal: 0.35, surface: 'metal', grime: 0.4, wet: 0.7, rmin: 0.35 },
  containerWhite: { set: 'rusty_painted_metal', tint: 0xe0d8d0, paint: 0xa9a7a0, normal: 1.2, metal: 0.35, surface: 'metal', grime: 0.45, wet: 0.7, rmin: 0.35 },
  woodDark: { set: 'Wood051', tint: 0x9c9286, normal: 1, surface: 'wood', grime: 0.4, wet: 0.9, rmin: 0.5 },
  wood: { set: 'Wood092', tint: 0x9a9184, normal: 1, surface: 'wood', grime: 0.35, wet: 0.9, rmin: 0.5 },
  tiles: { set: 'Tiles139', tint: 0xb8b2a8, normal: 1, surface: 'concrete', grime: 0.4, wet: 0.3, rmin: 0.2 },
  sandbag: { set: 'Fabric083', tint: 0x9a8865, normal: 2, surface: 'dirt', grime: 0.5, wet: 1, rmin: 0.6 },
  paving: { set: 'PavingStones138', tint: 0xaca598, normal: 1.2, surface: 'concrete', grime: 0.5, wet: 1, puddle: 1, rmin: 0.35 },
  concreteWall: { set: 'Concrete048', tint: 0xbab2a5, normal: 1, surface: 'concrete', grime: 0.5, wet: 0.9, rmin: 0.45 },
};

/** Tileable 4-channel noise (R macro fbm, G detail fbm, B very low-freq puddle field, A streak noise). */
function unifyNoiseTex(size = 512, seed = 7) {
  const rnd = (() => { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); })();
  const P = 256, lat = new Float32Array(P * P);
  for (let i = 0; i < lat.length; i++) lat[i] = rnd();
  const fade = (t) => t * t * (3 - 2 * t);
  // Periodic value noise: freq cells across the tile (integer) so the tile wraps seamlessly.
  const vn = (x, y, fx, fy, off) => {
    const xi = Math.floor(x), yi = Math.floor(y), tx = fade(x - xi), ty = fade(y - yi);
    const L = (a, b) => lat[(((b % fy) + fy) % fy + off) % P * P + ((((a % fx) + fx) % fx) + off * 3) % P];
    const a = L(xi, yi), b = L(xi + 1, yi), c = L(xi, yi + 1), d = L(xi + 1, yi + 1);
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  };
  const fbm = (u, v, fx, fy, oct, off) => {
    let f = 0, amp = 0.5, n = 0;
    for (let o = 0; o < oct; o++) { const m = 1 << o; f += amp * vn(u * fx * m, v * fy * m, fx * m, fy * m, off + o * 17); n += amp; amp *= 0.5; }
    return f / n;
  };
  const data = new Uint8Array(size * size * 4);
  const st = (x) => Math.max(0, Math.min(255, Math.round(x * 255)));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size, i = (y * size + x) * 4;
    const r = fbm(u, v, 4, 4, 5, 1), g = fbm(u, v, 16, 16, 4, 40), b = fbm(u, v, 2, 2, 5, 90), a = fbm(u, v, 48, 3, 3, 140);
    // Contrast-stretch so thresholds behave predictably.
    const k = (n, c) => 0.5 + (n - 0.5) * c;
    data[i] = st(k(r, 1.9)); data[i + 1] = st(k(g, 1.9)); data[i + 2] = st(k(b, 2.1)); data[i + 3] = st(k(a, 2.2));
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true; t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

const UNIFY_VERT_PARS = /* glsl */`
varying vec3 vUWP; varying vec3 vUWN;`;
const UNIFY_VERT = /* glsl */`
{
  vec4 uwp = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    uwp = instanceMatrix * uwp;
  #endif
  #ifdef USE_BATCHING
    uwp = batchingMatrix * uwp;
  #endif
  vUWP = (modelMatrix * uwp).xyz;
  vUWN = normalize((vec4(transformedNormal, 0.0) * viewMatrix).xyz);
}`;
const UNIFY_FRAG_PARS = /* glsl */`
varying vec3 vUWP; varying vec3 vUWN;
uniform sampler2D uNoise; uniform float uWet; uniform float uRain; uniform float uTime;
uniform vec4 uUni; uniform vec4 uUni2;
uniform vec3 indoorMin[4]; uniform vec3 indoorMax[4]; uniform int indoorCount; uniform float indoorAmount;
float indoorFactor(vec3 p) {
  float k = 0.0;
  for (int i = 0; i < 4; i++) {
    if (i >= indoorCount) break;
    vec3 a = smoothstep(indoorMin[i] - 0.05, indoorMin[i] + 0.6, p) * (1.0 - smoothstep(indoorMax[i] - 0.6, indoorMax[i] + 0.05, p));
    k = max(k, a.x * a.y * a.z);
  }
  return k;
}
float uHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
// Expanding rain-ripple rings (returns xz normal offset).
vec2 uRipple(vec2 p, float t) {
  vec2 acc = vec2(0.0);
  for (int k = 0; k < 2; k++) {
    vec2 q = p * (k == 0 ? 2.3 : 3.7) + float(k) * 7.31;
    vec2 c = floor(q); vec2 f = fract(q);
    float h = uHash(c);
    vec2 o = vec2(uHash(c + 3.1), uHash(c + 7.7)) * 0.6 + 0.2;
    float ph = fract(t * 1.1 + h);
    vec2 d = f - o; float r = length(d);
    float w = sin((r - ph * 0.45) * 55.0) * smoothstep(0.0, 0.08, ph * 0.45 - r + 0.08) * smoothstep(0.45, 0.0, r) * (1.0 - ph);
    acc += (r > 1e-4 ? d / r : vec2(0.0)) * w;
  }
  return acc;
}`;
const UNIFY_FRAG = /* glsl */`
{
  vec3 P = vUWP; vec3 N = normalize(vUWN); vec3 aN = abs(N);
  vec2 tp = aN.y > 0.5 ? P.xz : (aN.x > aN.z ? P.zy : P.xy);
  vec4 n1 = texture2D(uNoise, tp * 0.021);
  vec4 n2 = texture2D(uNoise, tp * 0.083 + 0.37);
  float g = n1.r * 0.65 + n2.g * 0.35;
  float ind = indoorFactor(P);
  float outside = 1.0 - ind;
  float up = smoothstep(0.55, 0.92, N.y);
  // 1. albedo normalisation + palette pull
  float lum = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  diffuseColor.rgb = max(mix(vec3(lum), diffuseColor.rgb, uUni2.x), 0.0);
  float tl = clamp(lum, 0.022, 0.70);
  diffuseColor.rgb *= tl / max(lum, 1e-4);
  // 2. shared weathering: macro grime / tint variation
  float gk = uUni.x;
  diffuseColor.rgb *= mix(1.0 - gk * 0.55, 1.0 + gk * 0.18, smoothstep(0.2, 0.8, g));
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.05, 0.97, 0.86), n2.g * gk * 0.8);
  // ground-contact dirt band on non-horizontal faces (bottom ~0.9 m)
  float contact = (1.0 - smoothstep(0.0, 0.9 + n2.g * 0.4, P.y)) * (1.0 - up) * uUni2.y;
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.62, 0.56, 0.48), contact * 0.75);
  // indoor dust on up-facing surfaces
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.30, 0.28, 0.25) * (0.7 + 0.6 * n2.g), up * ind * 0.22 * uUni2.y);
  // roughness band remap
  roughnessFactor = mix(uUni.w, 1.0, roughnessFactor) * (0.93 + n2.g * 0.14);
  // 3. wetness
  float wetK = uWet * uUni.y * outside;
  float sx = aN.x > aN.z ? P.z : P.x;
  float streak = texture2D(uNoise, vec2(sx * 0.11, P.y * 0.035 + n1.r * 0.08)).a;
  streak = smoothstep(0.42, 0.78, streak) * (1.0 - up) * uUni2.z;
  float wet = wetK * clamp(up * 0.8 + streak * 0.75 + (1.0 - up) * (0.12 + 0.3 * smoothstep(0.6, 0.0, P.y)), 0.0, 1.0);
  wet *= mix(0.3, 1.0, smoothstep(0.3, 0.72, g));            // damp vs drying patches
  float pud = 0.0;
  if (uUni.z > 0.0 && up > 0.5) {
    float pf = texture2D(uNoise, P.xz * 0.0105 + 0.13).b * 0.75 + n1.r * 0.25 - P.y * 1.5;
    float rim = smoothstep(0.46, 0.55, pf);
    pud = smoothstep(0.55, 0.585, pf) * up * outside * uUni.z * uWet;
    wet = max(wet, rim * up * outside * uWet);
  }
  float porous = 1.0 - metalnessFactor * 0.7;
  diffuseColor.rgb *= mix(1.0, 0.58, wet * porous);
  roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.38 + 0.06, wet);
  if (pud > 0.0) {
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.45, pud);
    roughnessFactor = mix(roughnessFactor, 0.025, pud);
    metalnessFactor = mix(metalnessFactor, 0.0, pud);
    vec3 nUp = vec3(0.0, 1.0, 0.0);
    if (uRain > 0.0) { vec2 rp = uRipple(P.xz, uTime) * uRain * 0.35; nUp = normalize(vec3(rp.x, 1.0, rp.y)); }
    vec3 vUp = normalize((viewMatrix * vec4(nUp, 0.0)).xyz);
    normal = normalize(mix(normal, vUp, pud * 0.97));
  }
  roughnessFactor = clamp(roughnessFactor, 0.02, 1.0);
  uIndoorK = ind;
}`;

// Re-paint: replace the scan's (red) paint with uPaint while keeping rust/grime areas of the texture.
const REPAINT_FRAG = /* glsl */`
#ifdef USE_MAP
  vec4 sampledDiffuseColor = texture2D(map, vMapUv);
  {
    float tl = dot(sampledDiffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
    float paintM = smoothstep(0.015, 0.07, sampledDiffuseColor.r - sampledDiffuseColor.g * 0.95) * smoothstep(0.025, 0.08, tl);
    vec3 rp = uPaint * clamp(tl * 3.4, 0.0, 1.6);
    sampledDiffuseColor.rgb = mix(sampledDiffuseColor.rgb * vec3(0.8, 0.72, 0.66), rp, paintM);
  }
  diffuseColor *= sampledDiffuseColor;
#endif`;

export class Materials {
  /** Shared uniforms for the unify pass (other systems may animate uWet / uRain / uTime). */
  static unify = {
    uNoise: { value: null },
    uWet: { value: 1 },
    uRain: { value: 0 },
    uTime: { value: 0 },
    indoorMin: { value: [0, 1, 2, 3].map(() => new THREE.Vector3(1e5, 1e5, 1e5)) },
    indoorMax: { value: [0, 1, 2, 3].map(() => new THREE.Vector3(-1e5, -1e5, -1e5)) },
    indoorCount: { value: 0 },
    indoorAmount: { value: 0.78 },
  };
  static get indoor() { return Materials.unify; }

  /** Per-category presets for applyUnify(mat, preset). */
  static PRESETS = {
    level: { grime: 0.45, wet: 0.9, puddle: 0, rmin: 0.4, sat: 0.88, contact: 1, streaks: 1 },
    prop: { grime: 0.3, wet: 0.75, puddle: 0, rmin: 0.38, sat: 0.85, contact: 1, streaks: 0.5 },
    character: { grime: 0.18, wet: 0.35, puddle: 0, rmin: 0.45, sat: 0.85, contact: 0.8, streaks: 0 },
    viewmodel: { grime: 0.08, wet: 0, puddle: 0, rmin: 0.3, sat: 0.9, contact: 0, streaks: 0 },
  };

  constructor(assets) {
    this.assets = assets;
    this.mats = {};
    if (!Materials.unify.uNoise.value) Materials.unify.uNoise.value = unifyNoiseTex(512, 7);
    this.noise = Materials.unify.uNoise.value;
    this.surfaceOf = new Map();
  }

  async load() {
    const sets = [...new Set(Object.values(DEFS).map((d) => d.set))];
    const alphaSets = ['Fence006', 'MetalWalkway013', 'Leaking003'];
    const alpha = {};
    await Promise.all([
      ...sets.map((s) => this.assets.materialSet(s)),
      ...alphaSets.map(async (s) => {
        const [map, normalMap, roughnessMap] = await Promise.all([
          this.assets.texture(`textures/${s}/ColorA.webp`, true),
          this.assets.texture(`textures/${s}/NormalGL.webp`, false),
          this.assets.texture(`textures/${s}/Roughness.webp`, false),
        ]);
        alpha[s] = { map, normalMap, roughnessMap };
      }),
    ]);
    // Non-square scans cover a non-square physical area: keep texels square under world-space UVs.
    for (const name of sets) {
      const set = this.assets.materialsets[name];
      const img = set?.map?.image;
      if (!img || !img.width || !img.height || img.width === img.height) continue;
      const k = img.width / img.height;
      for (const t of [set.map, set.normalMap, set.roughnessMap]) if (t) { t.repeat.set(1, k); t.needsUpdate = true; }
    }
    for (const [key, d] of Object.entries(DEFS)) {
      const set = this.assets.materialsets[d.set];
      const m = new THREE.MeshStandardMaterial({
        map: set.map, normalMap: set.normalMap, roughnessMap: set.roughnessMap,
        color: d.tint, roughness: d.rough ?? 1, metalness: d.metal ?? 0,
        normalScale: new THREE.Vector2(d.normal, d.normal),
      });
      m.name = key;
      this.applyUnify(m, { grime: d.grime, wet: d.wet, puddle: d.puddle ?? 0, rmin: d.rmin, sat: 0.86, contact: 1, streaks: 1, paint: d.paint });
      this.mats[key] = m;
      this.surfaceOf.set(m, d.surface);
    }
    // Chain-link fence (alpha tested, double sided).
    const fs = alpha.Fence006;
    this.mats.chainlink = new THREE.MeshStandardMaterial({
      map: fs.map, normalMap: fs.normalMap, roughnessMap: fs.roughnessMap, metalness: 0.85, roughness: 0.8,
      alphaTest: 0.45, side: THREE.DoubleSide, color: 0xa8a49c,
    });
    this.mats.chainlink.name = 'chainlink';
    this.applyUnify(this.mats.chainlink, { grime: 0.2, wet: 0.5, rmin: 0.3, sat: 0.9, contact: 0.4, streaks: 0, alphaOK: true });
    this.surfaceOf.set(this.mats.chainlink, 'metal');
    // Perforated steel grating (catwalk floor).
    const gs = alpha.MetalWalkway013;
    this.mats.grating = new THREE.MeshStandardMaterial({
      map: gs.map, normalMap: gs.normalMap, roughnessMap: gs.roughnessMap, metalness: 0.8, roughness: 0.75,
      alphaTest: 0.5, side: THREE.DoubleSide, color: 0x8f8b84,
    });
    this.mats.grating.name = 'grating';
    this.applyUnify(this.mats.grating, { grime: 0.3, wet: 0.2, rmin: 0.3, sat: 0.9, contact: 0, streaks: 0, alphaOK: true });
    this.surfaceOf.set(this.mats.grating, 'metal');
    // Decal: rain/leak streaks on walls. Depth-tested, no depth write, polygon offset.
    const ls = alpha.Leaking003;
    ls.map.wrapS = ls.map.wrapT = THREE.ClampToEdgeWrapping;
    this.mats.leakDecal = new THREE.MeshStandardMaterial({
      map: ls.map, normalMap: ls.normalMap, roughness: 0.45, metalness: 0, color: 0x6e6a62, transparent: true, opacity: 0.8,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    this.mats.leakDecal.name = 'leakDecal';
    // Window glass: dirty, slightly reflective, see-through.
    this.mats.glass = new THREE.MeshPhysicalMaterial({
      color: 0x6f7f84, roughness: 0.12, metalness: 0, transparent: true, opacity: 0.32, envMapIntensity: 1.6,
      depthWrite: false, side: THREE.DoubleSide,
    });
    this.mats.glass.name = 'glass';
    this.surfaceOf.set(this.mats.glass, 'glass');
    this.mats.black = new THREE.MeshStandardMaterial({ color: 0x0b0b0c, roughness: 0.9 });
    // Practical light emitters (bloom sources): warm sodium + cool fluorescent.
    this.mats.light = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffc58a, emissiveIntensity: 9, roughness: 0.4 });
    this.mats.light.name = 'light';
    this.mats.lightCool = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xdff0ff, emissiveIntensity: 7, roughness: 0.4 });
    this.mats.lightCool.name = 'lightCool';
    for (const k of ['light', 'lightCool', 'black']) this.mats[k].userData.noUnify = true;
    return this;
  }

  get(key) { return this.mats[key]; }

  setIndoorVolumes(boxes) {
    const u = Materials.unify;
    boxes.slice(0, 4).forEach((b, i) => { u.indoorMin.value[i].copy(b.min); u.indoorMax.value[i].copy(b.max); });
    u.indoorCount.value = Math.min(4, boxes.length);
  }

  /** Back-compat alias (Game.js applies this to bot materials): unify with character preset. */
  applyIndoor(mat) {
    if (mat?.userData?.unify) return;
    this.applyUnify(mat, mat?.skinning || mat?.userData?.character ? 'character' : 'prop');
  }

  /**
   * The cohesion pass. `preset` is a key of Materials.PRESETS or an object
   * { grime, wet, puddle, rmin, sat, contact, streaks }. Idempotent per material.
   */
  applyUnify(mat, preset = 'prop') {
    if (!mat || !(mat.isMeshStandardMaterial || mat.isMeshPhysicalMaterial)) return;
    if (mat.userData.unify || mat.userData.noUnify) return;
    const p = typeof preset === 'string' ? Materials.PRESETS[preset] ?? Materials.PRESETS.prop : preset;
    if (mat.transparent && !p.alphaOK) return;
    mat.userData.unify = p;
    // Per-asset normalisation that is cheaper on the CPU: keep normal intensity in a common band.
    if (mat.normalMap && mat.normalScale) {
      const s = THREE.MathUtils.clamp(Math.abs(mat.normalScale.x), 0.6, 2.0);
      mat.normalScale.set(s * Math.sign(mat.normalScale.x || 1), s * Math.sign(mat.normalScale.y || 1));
    }
    const uUni = { value: new THREE.Vector4(p.grime ?? 0.3, p.wet ?? 0.7, p.puddle ?? 0, p.rmin ?? 0.38) };
    const uUni2 = { value: new THREE.Vector4(p.sat ?? 0.86, p.contact ?? 1, p.streaks ?? 0.5, 0) };
    const uPaint = p.paint !== undefined ? { value: new THREE.Color(p.paint) } : null;
    const prev = mat.onBeforeCompile;
    const prevKey = mat.customProgramCacheKey?.bind(mat);
    mat.onBeforeCompile = (sh, r) => {
      prev?.call(mat, sh, r);
      Object.assign(sh.uniforms, Materials.unify, { uUni, uUni2 });
      if (uPaint) { sh.uniforms.uPaint = uPaint; sh.fragmentShader = 'uniform vec3 uPaint;\n' + sh.fragmentShader; }
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>' + UNIFY_VERT_PARS)
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>' + UNIFY_VERT);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>' + UNIFY_FRAG_PARS)
        .replace('#include <map_fragment>', uPaint ? REPAINT_FRAG : '#include <map_fragment>')
        .replace('#include <emissivemap_fragment>', 'float uIndoorK = 0.0;' + UNIFY_FRAG + '\n#include <emissivemap_fragment>')
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
          {
            float ik = 1.0 - uIndoorK * indoorAmount;
            reflectedLight.indirectDiffuse *= ik;
            reflectedLight.indirectSpecular *= mix(ik, 1.0, 0.2);
          }`);
    };
    mat.customProgramCacheKey = () => (prevKey ? prevKey() : '') + '|unify' + (uPaint ? 'P' : '');
    mat.needsUpdate = true;
  }

  surface(m) { return this.surfaceOf.get(m) || 'concrete'; }

  /** Kept for API compatibility; level materials get their weathering through applyUnify. */
  macro() {}
}
