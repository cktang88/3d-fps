import * as THREE from 'three';
import { grimeTex } from '../render/ProcTex.js';

/**
 * Material library for level art. All surfaces are PBR (ambientCG / Poly Haven CC0 sets) with a
 * shared world-space macro-variation pass (large-scale grime / tint noise) that breaks up texture
 * tiling and ties every surface into the same weathered look.
 */
const DEFS = {
  asphalt: { set: 'Asphalt031', tint: 0xb8b4ae, rough: 1, normal: 1, surface: 'concrete' },
  ground: { set: 'Ground054', tint: 0xd8cbb6, rough: 1, normal: 1.2, surface: 'dirt' },
  brick: { set: 'Bricks097', tint: 0xd8cfc6, rough: 1, normal: 1.2, surface: 'concrete' },
  plaster: { set: 'Plaster003', tint: 0xcfc1a6, rough: 1, normal: 1.4, surface: 'concrete' },
  plasterWhite: { set: 'Plaster003', tint: 0xe2ddd2, rough: 1, normal: 1.2, surface: 'concrete' },
  concrete: { set: 'Concrete034', tint: 0xbab5ad, rough: 1, normal: 1, surface: 'concrete' },
  concreteDirty: { set: 'Concrete047A', tint: 0xc9c2b4, rough: 1, normal: 1, surface: 'concrete' },
  concreteFloor: { set: 'concrete_floor', tint: 0xd0cbc3, rough: 1, normal: 1, surface: 'concrete' },
  metalDark: { set: 'Metal046B', tint: 0x9a9a9a, rough: 1, normal: 1, metal: 0.85, surface: 'metal' },
  metalPainted: { set: 'Metal063', tint: 0x8f9da8, rough: 1, normal: 1, metal: 0.6, surface: 'metal' },
  steel: { set: 'Metal055A', tint: 0xa8a8a8, rough: 0.9, normal: 1, metal: 0.9, surface: 'metal' },
  corrugated: { set: 'corrugated_iron', tint: 0xb9b5ad, rough: 1, normal: 1.5, metal: 0.7, surface: 'metal' },
  containerRed: { set: 'rusty_painted_metal', tint: 0xb04a35, rough: 1, normal: 1.2, metal: 0.4, surface: 'metal' },
  containerBlue: { set: 'rusty_painted_metal', tint: 0x4d6d8f, rough: 1, normal: 1.2, metal: 0.4, surface: 'metal' },
  containerGreen: { set: 'rusty_painted_metal', tint: 0x5a7150, rough: 1, normal: 1.2, metal: 0.4, surface: 'metal' },
  containerTan: { set: 'rusty_painted_metal', tint: 0xb39a73, rough: 1, normal: 1.2, metal: 0.4, surface: 'metal' },
  woodDark: { set: 'Wood051', tint: 0xb0a69a, rough: 1, normal: 1, surface: 'wood' },
  wood: { set: 'Wood092', tint: 0xb59c80, rough: 1, normal: 1, surface: 'wood' },
  tiles: { set: 'Tiles139', tint: 0xc8c2b8, rough: 1, normal: 1, surface: 'concrete' },
  sandbag: { set: 'Fabric083', tint: 0xa8946c, rough: 1, normal: 2, surface: 'dirt' },
  paving: { set: 'PavingStones138', tint: 0xbab3a6, rough: 1, normal: 1.2, surface: 'concrete' },
  concreteWall: { set: 'Concrete048', tint: 0xc8c0b2, rough: 1, normal: 1, surface: 'concrete' },
};

export class Materials {
  static indoor = {
    indoorMin: { value: [0, 1, 2, 3].map(() => new THREE.Vector3(1e5, 1e5, 1e5)) },
    indoorMax: { value: [0, 1, 2, 3].map(() => new THREE.Vector3(-1e5, -1e5, -1e5)) },
    indoorCount: { value: 0 },
    indoorAmount: { value: 0.72 },
  };

  constructor(assets) {
    this.assets = assets;
    this.mats = {};
    this.grime = grimeTex(256, 21);
    this.surfaceOf = new Map();
  }

  async load() {
    const sets = [...new Set(Object.values(DEFS).map((d) => d.set))];
    await Promise.all(sets.map((s) => this.assets.materialSet(s)));
    for (const [key, d] of Object.entries(DEFS)) {
      const set = this.assets.materialsets[d.set];
      const m = new THREE.MeshStandardMaterial({
        map: set.map, normalMap: set.normalMap, roughnessMap: set.roughnessMap,
        color: d.tint, roughness: d.rough, metalness: d.metal ?? 0,
        normalScale: new THREE.Vector2(d.normal, d.normal),
      });
      m.name = key;
      this.macro(m, key === 'ground' || key === 'asphalt' ? 0.55 : 0.4);
      this.mats[key] = m;
      this.surfaceOf.set(m, d.surface);
    }
    // Simple extras.
    this.mats.glass = new THREE.MeshPhysicalMaterial({
      color: 0x8fa3a8, roughness: 0.05, metalness: 0, transmission: 0, transparent: true, opacity: 0.35, envMapIntensity: 1.5,
    });
    this.surfaceOf.set(this.mats.glass, 'glass');
    this.mats.black = new THREE.MeshStandardMaterial({ color: 0x0b0b0c, roughness: 0.9 });
    this.mats.light = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff1d6, emissiveIntensity: 4, roughness: 0.4 });
    return this;
  }

  get(key) { return this.mats[key]; }

  setIndoorVolumes(boxes) {
    const u = Materials.indoor;
    boxes.slice(0, 4).forEach((b, i) => { u.indoorMin.value[i].copy(b.min); u.indoorMax.value[i].copy(b.max); });
    u.indoorCount.value = Math.min(4, boxes.length);
  }

  /**
   * Fake large-scale occlusion: inside "indoor" volumes the image-based (sky) lighting is attenuated
   * per-fragment so interiors read darker while sun through openings and interior lamps still light them.
   */
  applyIndoor(mat) {
    if (!mat || mat.userData.indoorPatched || !(mat.isMeshStandardMaterial || mat.isMeshPhysicalMaterial)) return;
    mat.userData.indoorPatched = true;
    const prev = mat.onBeforeCompile;
    const prevKey = mat.customProgramCacheKey?.bind(mat);
    mat.onBeforeCompile = (sh, r) => {
      prev?.call(mat, sh, r);
      Object.assign(sh.uniforms, Materials.indoor);
      if (!sh.vertexShader.includes('vIndoorPos')) {
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vIndoorPos;')
          .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
            vec4 ip4 = vec4(transformed, 1.0);
            #ifdef USE_INSTANCING
              ip4 = instanceMatrix * ip4;
            #endif
            #ifdef USE_SKINNING
              ip4 = vec4(transformed, 1.0);
            #endif
            vIndoorPos = (modelMatrix * ip4).xyz;`);
      }
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vIndoorPos; uniform vec3 indoorMin[4]; uniform vec3 indoorMax[4]; uniform int indoorCount; uniform float indoorAmount;
          float indoorFactor(vec3 p) {
            float k = 0.0;
            for (int i = 0; i < 4; i++) {
              if (i >= indoorCount) break;
              vec3 a = smoothstep(indoorMin[i] - 0.05, indoorMin[i] + 0.6, p) * (1.0 - smoothstep(indoorMax[i] - 0.6, indoorMax[i] + 0.05, p));
              k = max(k, a.x * a.y * a.z);
            }
            return k;
          }`)
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
          {
            float ik = 1.0 - indoorFactor(vIndoorPos) * indoorAmount;
            reflectedLight.indirectDiffuse *= ik;
            reflectedLight.indirectSpecular *= mix(ik, 1.0, 0.25);
          }`);
    };
    mat.customProgramCacheKey = () => (prevKey ? prevKey() : '') + '|indoor';
    mat.needsUpdate = true;
  }
  surface(m) { return this.surfaceOf.get(m) || 'concrete'; }

  /** Inject world-space macro variation (anti-tiling + weathering) into a standard material. */
  macro(mat, strength = 0.4) {
    const grime = this.grime;
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.grimeMap = { value: grime };
      sh.uniforms.grimeStrength = { value: strength };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWorldPos2; varying vec3 vWorldN2;')
        .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
          vec4 wp2 = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            wp2 = instanceMatrix * wp2;
          #endif
          wp2 = modelMatrix * wp2;
          vWorldPos2 = wp2.xyz;
          vWorldN2 = normalize(mat3(modelMatrix) * objectNormal);`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D grimeMap; uniform float grimeStrength; varying vec3 vWorldPos2; varying vec3 vWorldN2;')
        .replace('#include <map_fragment>', `#include <map_fragment>
          {
            vec3 an = abs(vWorldN2);
            vec2 uvA = an.y > 0.5 ? vWorldPos2.xz : (an.x > an.z ? vWorldPos2.zy : vWorldPos2.xy);
            float g1 = texture2D(grimeMap, uvA * 0.031).r;
            float g2 = texture2D(grimeMap, uvA * 0.11 + 0.37).r;
            float g = g1 * 0.65 + g2 * 0.35;
            // Low-frequency brightness/tint variation + darker grime toward the ground on walls.
            float macroV = mix(1.0 - grimeStrength * 0.5, 1.0 + grimeStrength * 0.25, smoothstep(0.25, 0.75, g));
            float groundGrime = an.y < 0.5 ? smoothstep(1.2, 0.0, vWorldPos2.y) * 0.25 * grimeStrength * 2.0 : 0.0;
            diffuseColor.rgb *= macroV * (1.0 - groundGrime);
            diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.04, 0.98, 0.9), g2 * grimeStrength);
          }`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          roughnessFactor = clamp(roughnessFactor * (0.92 + texture2D(grimeMap, (abs(vWorldN2.y) > 0.5 ? vWorldPos2.xz : vWorldPos2.xy) * 0.07).r * 0.2), 0.05, 1.0);`);
    };
    mat.customProgramCacheKey = () => 'macro' + strength;
  }
}
