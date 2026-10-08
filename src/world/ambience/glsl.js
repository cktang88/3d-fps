// Shared GLSL snippets for the ambience layer.

export const NOISE = /* glsl */`
  float a_hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  float a_vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(a_hash12(i), a_hash12(i + vec2(1.0, 0.0)), u.x), mix(a_hash12(i + vec2(0.0, 1.0)), a_hash12(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float a_fbm(vec2 p) {
    float f = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { f += a * a_vnoise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
    return f;
  }
`;

/** Exp2 fog factor (matches THREE.FogExp2) scaled per effect. */
export const FOG = /* glsl */`
  uniform vec3 fogColor; uniform float fogDensity; uniform float fogScale;
  float a_fog(float d) { float k = fogDensity * fogScale * d; return 1.0 - exp(-k * k); }
`;

/** Copies the live scene fog into a material's uniforms. */
export function syncFog(mat, scene) {
  const f = scene.fog, u = mat.uniforms;
  if (!f) { u.fogDensity.value = 0; return; }
  u.fogColor.value.copy(f.color);
  u.fogDensity.value = f.density ?? (f.far ? 2.2 / f.far : 0);
}
