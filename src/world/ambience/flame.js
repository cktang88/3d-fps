import * as THREE from 'three';
import { NOISE, FOG } from './glsl.js';

/**
 * Procedural flame on cylindrical (Y-axis) billboards. Instanced: iBase = flame root (world),
 * iSize = (width, height, intensity, seed). Domain-warped fbm scrolled upward, shaped by a soft
 * teardrop envelope and thresholded into separate tongues; black-body colour ramp; additive.
 */
export function makeFlameMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      time: { value: 0 }, wind: { value: new THREE.Vector3() },
      fogColor: { value: new THREE.Color() }, fogDensity: { value: 0 }, fogScale: { value: 1 },
    },
    vertexShader: /* glsl */`
      attribute vec3 iBase; attribute vec4 iSize;
      uniform float time; uniform vec3 wind;
      varying vec2 vUv; varying float vInt; varying float vSeed; varying float vDepth;
      void main() {
        vec3 toCam = cameraPosition - iBase; toCam.y = 0.0;
        vec3 right = normalize(vec3(toCam.z, 0.0, -toCam.x) + vec3(1e-5));
        float h = iSize.y * (0.92 + 0.08 * sin(time * 2.7 + iSize.w * 7.0) + 0.05 * sin(time * 7.3 + iSize.w));
        vec3 p = iBase + right * position.x * iSize.x + vec3(0.0, position.y * h, 0.0);
        float k = position.y * position.y;
        p.xz += wind.xz * k * h * 0.1 + vec2(sin(time * 3.1 + iSize.w), cos(time * 2.3 + iSize.w * 3.0)) * k * 0.06 * h;
        vec4 mv = viewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        vUv = uv; vInt = iSize.z; vSeed = iSize.w; vDepth = -mv.z;
      }`,
    fragmentShader: /* glsl */`
      uniform float time;
      ${NOISE}
      ${FOG}
      varying vec2 vUv; varying float vInt; varying float vSeed; varying float vDepth;
      void main() {
        float x = (vUv.x - 0.5) * 2.0, y = vUv.y;
        float s = vSeed * 3.17;
        // Domain warp: low-frequency sway that grows with height.
        float w1 = a_fbm(vec2(x * 1.2 + s, y * 1.4 - time * 1.1));
        float qx = x + (w1 - 0.47) * 1.1 * y;
        // Upward-scrolling turbulence, stretched vertically (tongues).
        float n1 = a_fbm(vec2(qx * 2.4 + s, y * 1.7 - time * 2.2));
        float n2 = a_fbm(vec2(qx * 5.2 - s, y * 3.6 - time * 3.7));
        float n = n1 * 0.7 + n2 * 0.45;
        // Teardrop envelope: wide hot base, narrowing towards the tip.
        float halfW = mix(0.78, 0.12, pow(y, 0.8));
        float lat = 1.0 - smoothstep(halfW * 0.35, halfW, abs(qx));
        float env = lat * smoothstep(0.0, 0.08, y) * (1.0 - smoothstep(0.55, 1.0, y) * 0.85);
        float f = env * (0.55 + n * 1.25) - y * 0.55 - 0.1;
        float heat = clamp(f * 1.9, 0.0, 1.0);
        vec3 col = mix(vec3(0.45, 0.04, 0.005), vec3(1.0, 0.24, 0.02), smoothstep(0.0, 0.35, heat));
        col = mix(col, vec3(1.0, 0.55, 0.12), smoothstep(0.35, 0.7, heat));
        col = mix(col, vec3(1.0, 0.82, 0.5), smoothstep(0.78, 1.0, heat));
        float a = smoothstep(0.02, 0.45, heat) * 0.9;
        a *= (1.0 - a_fog(vDepth)) * smoothstep(0.0, 0.05, y);
        if (a < 0.004) discard;
        gl_FragColor = vec4(col * vInt * (0.7 + 1.5 * heat), a);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
}
