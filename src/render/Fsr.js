import * as THREE from 'three';
import { Pass } from 'postprocessing';

/**
 * AMD FidelityFX Super Resolution 1.0 for WebGL2: EASU (edge-adaptive spatial upsampling) + RCAS (robust
 * contrast-adaptive sharpening). GLSL port of `ffx_fsr1.h` (FidelityFX-FSR, Copyright (c) 2021 Advanced Micro
 * Devices, Inc., MIT licence; see README credits). Full-precision (FP32) path, with the "FsrEasuF" 12-tap kernel and
 * "FsrRcasF" with the denoise option on.
 *
 * Pipeline (Renderer): world + post chain run at an internal size (scale 0.5–1 of the output) and end with SMAA,
 * then this pass: EASU internal → output-size RT, then RCAS → screen. Both work in a perceptual space (gamma 2.0),
 * as AMD recommends; the composer buffers are linear, so EASU converts on fetch and RCAS converts back and encodes
 * sRGB for the canvas.
 *
 * Optional `viewmodel` mode 'output': the viewmodel scene is rendered at output resolution after EASU and composited
 * (ACES + the shared grade + vignette) in the RCAS pass, instead of going through the internal-res chain.
 */

const VERT = /* glsl */`
in vec3 position;
out vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 1.0, 1.0); }`;

const EASU_FRAG = /* glsl */`
precision highp float;
precision highp int;
uniform sampler2D tInput;
uniform vec2 inSize;     // input texture size in pixels
uniform vec2 outSize;    // output size in pixels
uniform float perceptual; // 1: input is linear → convert to gamma-2 on fetch
in vec2 vUv;
out vec4 outColor;

vec3 fetch(ivec2 p) {
  ivec2 m = ivec2(inSize) - 1;
  vec3 c = texelFetch(tInput, clamp(p, ivec2(0), m), 0).rgb;
  c = max(c, vec3(0.0));
  return perceptual > 0.5 ? sqrt(c) : c;
}
float lumaOf(vec3 c) { return c.b * 0.5 + (c.r * 0.5 + c.g); }

void easuSet(inout vec2 dir, inout float len, vec2 pp, bool biS, bool biT, bool biU, bool biV,
             float lA, float lB, float lC, float lD, float lE) {
  float w = 0.0;
  if (biS) w = (1.0 - pp.x) * (1.0 - pp.y);
  if (biT) w = pp.x * (1.0 - pp.y);
  if (biU) w = (1.0 - pp.x) * pp.y;
  if (biV) w = pp.x * pp.y;
  float dc = lD - lC, cb = lC - lB;
  float lenX = max(abs(dc), abs(cb));
  lenX = 1.0 / max(lenX, 1e-8);
  float dirX = lD - lB;
  dir.x += dirX * w;
  lenX = clamp(abs(dirX) * lenX, 0.0, 1.0);
  lenX *= lenX;
  len += lenX * w;
  float ec = lE - lC, ca = lC - lA;
  float lenY = max(abs(ec), abs(ca));
  lenY = 1.0 / max(lenY, 1e-8);
  float dirY = lE - lA;
  dir.y += dirY * w;
  lenY = clamp(abs(dirY) * lenY, 0.0, 1.0);
  lenY *= lenY;
  len += lenY * w;
}

void easuTap(inout vec3 aC, inout float aW, vec2 off, vec2 dir, vec2 len, float lob, float clp, vec3 c) {
  vec2 v;
  v.x = off.x * dir.x + off.y * dir.y;
  v.y = off.x * (-dir.y) + off.y * dir.x;
  v *= len;
  float d2 = v.x * v.x + v.y * v.y;
  d2 = min(d2, clp);
  float wB = 2.0 / 5.0 * d2 - 1.0;
  float wA = lob * d2 - 1.0;
  wB *= wB;
  wA *= wA;
  wB = 25.0 / 16.0 * wB - (25.0 / 16.0 - 1.0);
  float w = wB * wA;
  aC += c * w;
  aW += w;
}

void main() {
  // Output pixel → input pixel-centre space (FSR con0).
  vec2 ip = floor(gl_FragCoord.xy);
  vec2 pp = (ip + 0.5) * (inSize / outSize) - 0.5;
  vec2 fp = floor(pp);
  pp -= fp;
  ivec2 f0 = ivec2(fp);
  //    b c
  //  e f g h
  //  i j k l
  //    n o
  vec3 bC = fetch(f0 + ivec2(0, -1)), cC = fetch(f0 + ivec2(1, -1));
  vec3 eC = fetch(f0 + ivec2(-1, 0)), fC = fetch(f0), gC = fetch(f0 + ivec2(1, 0)), hC = fetch(f0 + ivec2(2, 0));
  vec3 iC = fetch(f0 + ivec2(-1, 1)), jC = fetch(f0 + ivec2(0, 1)), kC = fetch(f0 + ivec2(1, 1)), lC = fetch(f0 + ivec2(2, 1));
  vec3 nC = fetch(f0 + ivec2(0, 2)), oC = fetch(f0 + ivec2(1, 2));
  float bL = lumaOf(bC), cL = lumaOf(cC), eL = lumaOf(eC), fL = lumaOf(fC), gL = lumaOf(gC), hL = lumaOf(hC);
  float iL = lumaOf(iC), jL = lumaOf(jC), kL = lumaOf(kC), lL = lumaOf(lC), nL = lumaOf(nC), oL = lumaOf(oC);
  vec2 dir = vec2(0.0);
  float len = 0.0;
  easuSet(dir, len, pp, true, false, false, false, bL, eL, fL, gL, jL);
  easuSet(dir, len, pp, false, true, false, false, cL, fL, gL, hL, kL);
  easuSet(dir, len, pp, false, false, true, false, fL, iL, jL, kL, nL);
  easuSet(dir, len, pp, false, false, false, true, gL, jL, kL, lL, oL);
  vec2 dir2 = dir * dir;
  float dirR = dir2.x + dir2.y;
  bool zro = dirR < 1.0 / 32768.0;
  dirR = inversesqrt(max(dirR, 1e-12));
  dirR = zro ? 1.0 : dirR;
  dir.x = zro ? 1.0 : dir.x;
  dir *= vec2(dirR);
  len = len * 0.5;
  len *= len;
  float stretch = (dir.x * dir.x + dir.y * dir.y) / max(abs(dir.x), abs(dir.y));
  vec2 len2 = vec2(1.0 + (stretch - 1.0) * len, 1.0 - 0.5 * len);
  float lob = 0.5 + ((1.0 / 4.0 - 0.04) - 0.5) * len;
  float clp = 1.0 / lob;
  vec3 aC = vec3(0.0);
  float aW = 0.0;
  easuTap(aC, aW, vec2(0.0, -1.0) - pp, dir, len2, lob, clp, bC);
  easuTap(aC, aW, vec2(1.0, -1.0) - pp, dir, len2, lob, clp, cC);
  easuTap(aC, aW, vec2(-1.0, 1.0) - pp, dir, len2, lob, clp, iC);
  easuTap(aC, aW, vec2(0.0, 1.0) - pp, dir, len2, lob, clp, jC);
  easuTap(aC, aW, vec2(0.0, 0.0) - pp, dir, len2, lob, clp, fC);
  easuTap(aC, aW, vec2(-1.0, 0.0) - pp, dir, len2, lob, clp, eC);
  easuTap(aC, aW, vec2(1.0, 1.0) - pp, dir, len2, lob, clp, kC);
  easuTap(aC, aW, vec2(2.0, 1.0) - pp, dir, len2, lob, clp, lC);
  easuTap(aC, aW, vec2(2.0, 0.0) - pp, dir, len2, lob, clp, hC);
  easuTap(aC, aW, vec2(1.0, 0.0) - pp, dir, len2, lob, clp, gC);
  easuTap(aC, aW, vec2(1.0, 2.0) - pp, dir, len2, lob, clp, oC);
  easuTap(aC, aW, vec2(0.0, 2.0) - pp, dir, len2, lob, clp, nC);
  // Deringing: clamp to the min/max of the nearest 2x2.
  vec3 mn = min(min(fC, gC), min(jC, kC));
  vec3 mx = max(max(fC, gC), max(jC, kC));
  outColor = vec4(min(mx, max(mn, aC / aW)), 1.0);
}`;

// RCAS (+ optional output-res viewmodel composite). Input: perceptual (gamma 2) texture at output size.
const RCAS_FRAG = /* glsl */`
precision highp float;
precision highp int;
uniform sampler2D tInput;
uniform vec2 size;
uniform float sharp;       // exp2(-stops)
uniform float perceptual;  // 1: input is gamma 2 (from EASU); 0: input is linear (no upscale)
uniform float vmOn;
uniform sampler2D tVm;
uniform vec3 lift; uniform vec3 gammaV; uniform vec3 gain;
uniform vec3 shadowTint; uniform vec3 highTint;
uniform float contrast; uniform float saturation; uniform float exposure;
uniform float vigOffset; uniform float vigDarkness;
in vec2 vUv;
out vec4 outColor;

vec3 fetch(ivec2 p) {
  vec3 c = texelFetch(tInput, clamp(p, ivec2(0), ivec2(size) - 1), 0).rgb;
  c = clamp(c, 0.0, 1.0);
  return perceptual > 0.5 ? c : sqrt(c);
}
vec3 sRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }

vec3 RRTAndODTFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 aces(vec3 color) {
  const mat3 inM = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
  const mat3 outM = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
  color *= 1.0 / 0.6;
  color = inM * color;
  color = RRTAndODTFit(color);
  return clamp(outM * color, 0.0, 1.0);
}
// Same maths as Renderer's GradeEffect (keep in sync).
vec3 grade(vec3 c0) {
  vec3 c = max(c0 * exposure, 0.0);
  c = pow(c, vec3(1.0 / 2.2));
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c += shadowTint * (1.0 - smoothstep(0.0, 0.55, l)) + highTint * smoothstep(0.4, 1.0, l);
  c = c * gain + lift * (1.0 - c);
  c = pow(max(c, 0.0), 1.0 / gammaV);
  vec3 s = c * c * (3.0 - 2.0 * c);
  c = mix(c, s, contrast);
  float l2 = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l2), c, saturation);
  return pow(clamp(c, 0.0, 1.0), vec3(2.2));
}

#define FSR_RCAS_LIMIT (0.25 - (1.0 / 16.0))
void main() {
  ivec2 sp = ivec2(gl_FragCoord.xy);
  //    b
  //  d e f
  //    h
  vec3 b = fetch(sp + ivec2(0, -1)), d = fetch(sp + ivec2(-1, 0)), e = fetch(sp);
  vec3 f = fetch(sp + ivec2(1, 0)), h = fetch(sp + ivec2(0, 1));
  float bL = b.b * 0.5 + (b.r * 0.5 + b.g), dL = d.b * 0.5 + (d.r * 0.5 + d.g), eL = e.b * 0.5 + (e.r * 0.5 + e.g);
  float fL = f.b * 0.5 + (f.r * 0.5 + f.g), hL = h.b * 0.5 + (h.r * 0.5 + h.g);
  // Noise detection (denoise): don't sharpen grain.
  float nz = 0.25 * bL + 0.25 * dL + 0.25 * fL + 0.25 * hL - eL;
  nz = clamp(abs(nz) / max(max(max(bL, dL), max(eL, max(fL, hL))) - min(min(bL, dL), min(eL, min(fL, hL))), 1e-6), 0.0, 1.0);
  nz = -0.5 * nz + 1.0;
  vec3 mn4 = min(min(b, d), min(f, h));
  vec3 mx4 = max(max(b, d), max(f, h));
  vec2 peakC = vec2(1.0, -4.0);
  vec3 hitMin = mn4 / max(4.0 * mx4, 1e-6);
  vec3 hitMax = (peakC.x - mx4) / min(4.0 * mn4 + peakC.y, -1e-6);
  vec3 lobeRGB = max(-hitMin, hitMax);
  float lobe = max(-FSR_RCAS_LIMIT, min(max(lobeRGB.r, max(lobeRGB.g, lobeRGB.b)), 0.0)) * sharp;
  lobe *= nz;
  float rcpL = 1.0 / (4.0 * lobe + 1.0);
  vec3 pix = (lobe * b + lobe * d + lobe * h + lobe * f + e) * rcpL;
  vec3 lin = pix * pix; // gamma 2 → linear
  if (vmOn > 0.5) {
    vec4 vm = texelFetch(tVm, sp, 0);
    if (vm.a > 0.0) {
      vec3 g = grade(aces(vm.rgb));
      vec2 uv = (vec2(sp) + 0.5) / size;
      float dv = distance(uv, vec2(0.5));
      g *= smoothstep(0.8, vigOffset * 0.799, dv * (vigDarkness + vigOffset));
      lin = lin * (1.0 - clamp(vm.a, 0.0, 1.0)) + g;
    }
  }
  outColor = vec4(sRGB(clamp(lin, 0.0, 1.0)), 1.0);
}`;

export const FSR_MODES = {
  off: 1, quality: 1 / 1.3, balanced: 1 / 1.5, performance: 0.5, dynamic: 1,
};

export class FsrPass extends Pass {
  constructor() {
    super('FsrPass');
    this.needsSwap = false;
    const raw = (frag, uniforms) => new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false,
    });
    this.easuMat = raw(EASU_FRAG, {
      tInput: { value: null }, inSize: { value: new THREE.Vector2(1, 1) }, outSize: { value: new THREE.Vector2(1, 1) }, perceptual: { value: 1 },
    });
    this.rcasMat = raw(RCAS_FRAG, {
      tInput: { value: null }, size: { value: new THREE.Vector2(1, 1) }, sharp: { value: 1 }, perceptual: { value: 1 },
      vmOn: { value: 0 }, tVm: { value: null },
      lift: { value: new THREE.Vector3() }, gammaV: { value: new THREE.Vector3(1, 1, 1) }, gain: { value: new THREE.Vector3(1, 1, 1) },
      shadowTint: { value: new THREE.Vector3() }, highTint: { value: new THREE.Vector3() },
      contrast: { value: 0 }, saturation: { value: 1 }, exposure: { value: 1 }, vigOffset: { value: 0.38 }, vigDarkness: { value: 0.3 },
    });
    this.fullscreenMaterial = this.easuMat;
    // EASU output, perceptual (gamma 2) values: 8 bits are enough and halve the bandwidth of the RCAS read.
    this.easuRT = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false, stencilBuffer: false, type: THREE.UnsignedByteType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false });
    this.vmRT = null;
    this.outW = 1; this.outH = 1;
    this.upscale = true;       // false: internal == output, RCAS only
    this.rcas = true;          // false: EASU result copied with RCAS sharpness 0
    this.sharpness = 0.8;      // UI 0..1 → RCAS stops (1 - s) * 2
    this.viewmodel = null;     // { scene, camera, grade, vignette } when the viewmodel renders at output res
    this.gpuTimer = null;
  }

  /** The composer calls this with the internal size; the output size comes from setOutputSize. */
  setSize() {}

  setOutputSize(w, h) {
    this.outW = w; this.outH = h;
    this.easuRT.setSize(w, h);
    this.vmRT?.setSize(w, h);
  }

  _ensureVmRT() {
    if (this.vmRT) return this.vmRT;
    this.vmRT = new THREE.WebGLRenderTarget(this.outW, this.outH, { type: THREE.HalfFloatType, depthBuffer: true, stencilBuffer: false, generateMipmaps: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    return this.vmRT;
  }

  render(renderer, inputBuffer) {
    const r = renderer;
    let src = inputBuffer.texture, perceptual = 0;
    if (this.upscale) {
      const u = this.easuMat.uniforms;
      u.tInput.value = src;
      u.inSize.value.set(inputBuffer.width, inputBuffer.height);
      u.outSize.value.set(this.outW, this.outH);
      this.fullscreenMaterial = this.easuMat;
      r.setRenderTarget(this.easuRT);
      r.render(this.scene, this.camera);
      src = this.easuRT.texture; perceptual = 1;
    }
    const ru = this.rcasMat.uniforms;
    const vm = this.viewmodel;
    if (vm) {
      const rt = this._ensureVmRT();
      const ac = r.autoClear, cc = r.getClearColor(new THREE.Color()), ca = r.getClearAlpha();
      const bg = vm.scene.background; vm.scene.background = null;
      r.setRenderTarget(rt);
      r.setClearColor(0x000000, 0); r.clear(true, true, false);
      r.autoClear = false;
      // Like RenderPass.skipShadowMapUpdate: the viewmodel's own shadow map is rendered by ViewModel.update.
      const sm = r.shadowMap, au = sm.autoUpdate, nu = sm.needsUpdate;
      sm.autoUpdate = false; sm.needsUpdate = false;
      r.render(vm.scene, vm.camera);
      sm.autoUpdate = au; sm.needsUpdate = nu;
      r.autoClear = ac; r.setClearColor(cc, ca); vm.scene.background = bg;
      ru.tVm.value = rt.texture; ru.vmOn.value = 1;
      const gu = vm.grade.uniforms;
      for (const k of ['lift', 'gammaV', 'gain', 'shadowTint', 'highTint']) ru[k].value.copy(gu.get(k).value);
      for (const k of ['contrast', 'saturation', 'exposure']) ru[k].value = gu.get(k).value;
      ru.vigOffset.value = vm.vignette.offset; ru.vigDarkness.value = vm.vignette.darkness;
    } else ru.vmOn.value = 0;
    ru.tInput.value = src;
    ru.perceptual.value = perceptual;
    ru.size.value.set(this.outW, this.outH);
    ru.sharp.value = this.rcas ? Math.pow(2, -(1 - this.sharpness) * 2) : 0;
    this.fullscreenMaterial = this.rcasMat;
    r.setRenderTarget(null);
    r.render(this.scene, this.camera);
  }

  dispose() {
    this.easuRT.dispose(); this.vmRT?.dispose(); this.easuMat.dispose(); this.rcasMat.dispose();
  }
}
