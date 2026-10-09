import * as THREE from 'three';
import {
  EffectComposer, RenderPass, EffectPass, BloomEffect, SMAAEffect, SMAAPreset, ToneMappingEffect,
  ToneMappingMode, VignetteEffect, ChromaticAberrationEffect, NoiseEffect, BlendFunction, GodRaysEffect,
  Effect, EffectAttribute, KernelSize,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import { FsrPass } from './Fsr.js';
import { GpuTimer } from './GpuTimer.js';
import { uploadRing } from './UploadRing.js';

/* ------------------------------------------------------------------------------------------------
 * Custom effects
 * ---------------------------------------------------------------------------------------------- */

/** Contrast-adaptive sharpening (after AMD FidelityFX CAS). Restores the crispness lost to SMAA, TAA-free
 * upscaling (dynamic resolution / render scale) and half-res effects, without ringing on hard edges. */
class SharpenEffect extends Effect {
  constructor(amount = 0.5) {
    super('SharpenEffect', /* glsl */`
      uniform float sharpness;
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        vec3 b = texture2D(inputBuffer, uv + vec2(0.0, -texelSize.y)).rgb;
        vec3 d = texture2D(inputBuffer, uv + vec2(-texelSize.x, 0.0)).rgb;
        vec3 e = inputColor.rgb;
        vec3 f = texture2D(inputBuffer, uv + vec2(texelSize.x, 0.0)).rgb;
        vec3 h = texture2D(inputBuffer, uv + vec2(0.0, texelSize.y)).rgb;
        vec3 mn = min(e, min(min(b, d), min(f, h)));
        vec3 mx = max(e, max(max(b, d), max(f, h)));
        vec3 amp = sqrt(clamp(min(mn, 2.0 - mx) / max(mx, 1e-4), 0.0, 1.0));
        vec3 w = -amp / mix(8.0, 5.0, sharpness);
        vec3 c = (e + (b + d + f + h) * w) / (1.0 + 4.0 * w);
        outputColor = vec4(clamp(c, 0.0, 1.0), inputColor.a);
      }`, {
      attributes: EffectAttribute.CONVOLUTION,
      uniforms: new Map([['sharpness', new THREE.Uniform(amount)]]),
    });
  }
}

/** Final colour grade (the "glue"): split toning, lift/gamma/gain, filmic contrast, saturation. Runs after tonemapping.
 * Keep in sync with grade() in render/Fsr.js (output-res viewmodel composite). */
class GradeEffect extends Effect {
  constructor() {
    super('GradeEffect', /* glsl */`
      uniform vec3 lift; uniform vec3 gammaV; uniform vec3 gain;
      uniform vec3 shadowTint; uniform vec3 highTint;
      uniform float contrast; uniform float saturation; uniform float exposure;
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        vec3 c = max(inputColor.rgb * exposure, 0.0);
        c = pow(c, vec3(1.0 / 2.2));                       // grade in display space
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        c += shadowTint * (1.0 - smoothstep(0.0, 0.55, l)) + highTint * smoothstep(0.4, 1.0, l);
        c = c * gain + lift * (1.0 - c);
        c = pow(max(c, 0.0), 1.0 / gammaV);
        vec3 s = c * c * (3.0 - 2.0 * c);                  // filmic S-curve
        c = mix(c, s, contrast);
        float l2 = dot(c, vec3(0.2126, 0.7152, 0.0722));
        c = mix(vec3(l2), c, saturation);
        outputColor = vec4(pow(clamp(c, 0.0, 1.0), vec3(2.2)), inputColor.a);
      }`, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map([
        ['lift', new THREE.Uniform(new THREE.Vector3(0.012, 0.018, 0.026))],
        ['gammaV', new THREE.Uniform(new THREE.Vector3(1.0, 1.0, 1.0))],
        ['gain', new THREE.Uniform(new THREE.Vector3(1.03, 1.0, 0.95))],
        ['shadowTint', new THREE.Uniform(new THREE.Vector3(-0.012, 0.004, 0.016))],
        ['highTint', new THREE.Uniform(new THREE.Vector3(0.022, 0.008, -0.018))],
        ['contrast', new THREE.Uniform(0.3)],
        ['saturation', new THREE.Uniform(0.92)],
        ['exposure', new THREE.Uniform(0.9)],
      ]),
    });
  }
}

/** Lens: dirt lit by bloom + soft sun glare (only when the sun disc is on screen and unoccluded). HDR, pre-tonemap. */
class LensEffect extends Effect {
  constructor(bloom, dirtTex) {
    super('LensEffect', /* glsl */`
      uniform sampler2D tBloom; uniform sampler2D tDirt;
      uniform vec2 sunUV; uniform float sunOn; uniform vec3 sunColor; uniform float dirtK; uniform float aspect;
      float skyAt(vec2 p) { return step(0.9999, readDepth(clamp(p, 0.001, 0.999))); }
      void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
        vec3 dirt = texture2D(tDirt, uv).rgb;
        vec3 b = texture2D(tBloom, uv).rgb;
        vec3 col = inputColor.rgb + b * dirt * dirtK;
        if (sunOn > 0.0) {
          // Visibility of the sun disc from the depth buffer (9 taps).
          float vis = 0.0;
          for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++) vis += skyAt(sunUV + vec2(float(i), float(j)) * vec2(0.012 / aspect, 0.012));
          vis = vis / 9.0 * sunOn;
          vec2 d = (uv - sunUV) * vec2(aspect, 1.0);
          float r = length(d);
          float glow = exp(-r * 5.0) * 0.18 + exp(-r * 18.0) * 0.35;
          float streak = exp(-abs(d.y) * 90.0) * exp(-abs(d.x) * 3.0) * 0.12;
          // Faint ghost opposite the sun.
          vec2 g = (uv - (1.0 - sunUV)) * vec2(aspect, 1.0);
          float ghost = smoothstep(0.07, 0.0, abs(length(g) - 0.05)) * 0.02;
          col += sunColor * vis * (glow + streak + ghost + dirt * exp(-r * 1.6) * 0.22);
        }
        outputColor = vec4(col, inputColor.a);
      }`, {
      blendFunction: BlendFunction.NORMAL,
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map([
        ['tBloom', new THREE.Uniform(bloom.texture)],
        ['tDirt', new THREE.Uniform(dirtTex)],
        ['sunUV', new THREE.Uniform(new THREE.Vector2(0.5, 0.5))],
        ['sunOn', new THREE.Uniform(0)],
        ['sunColor', new THREE.Uniform(new THREE.Color(1.0, 0.72, 0.42))],
        ['dirtK', new THREE.Uniform(0.55)],
        ['aspect', new THREE.Uniform(1.6)],
      ]),
    });
    this.bloom = bloom;
  }
  update() { this.uniforms.get('tBloom').value = this.bloom.texture; }
}

/** Procedural lens-dirt texture: smudges, specks, faint streaks (subtle, only visible against bright light). */
function lensDirtTexture(w = 1024, h = 576) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
  let s = 1337; const R = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 70; i++) { // large soft smudges
    const x = R() * w, y = R() * h, r = 30 + R() * 140, a = 0.03 + R() * 0.07;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, `rgba(255,245,230,${a})`); gr.addColorStop(1, 'rgba(255,245,230,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  for (let i = 0; i < 260; i++) { // specks / droplets
    const x = R() * w, y = R() * h, r = 1 + R() * 6, a = 0.08 + R() * 0.22;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, `rgba(255,255,255,${a})`); gr.addColorStop(0.7, `rgba(255,255,255,${a * 0.5})`); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  g.lineCap = 'round';
  for (let i = 0; i < 14; i++) { // wipe streaks
    g.strokeStyle = `rgba(255,250,240,${0.02 + R() * 0.04})`; g.lineWidth = 8 + R() * 30;
    const x = R() * w, y = R() * h, l = 120 + R() * 300, a = R() * Math.PI;
    g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + Math.cos(a) * l * 0.5 + 40, y + Math.sin(a) * l * 0.5, x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

/* ------------------------------------------------------------------------------------------------
 * Quality presets (render owner). One table drives every graphics cost; adaptive quality and the benchmark apply
 * overrides on top (Renderer.features). Keys consumed outside the Renderer (Game.applyGraphicsFeatures):
 * lights, probe, vmShadow, unify, pip, particles, fog.
 * ---------------------------------------------------------------------------------------------- */
export const QUALITY_PRESETS = [
  { // Low: genuinely cheap. One-tap PCF, no AO / god rays / probe / viewmodel shadow, 2 point lights, lite materials.
    name: 'Low', ao: null, aoHalf: true, godRays: 0, bloom: true, bloomLevels: 4, lens: true, shadow: 1024, pcfLite: true,
    probe: 0, vmShadow: 0, lights: 2, unify: 'lite', pip: 256, pipEvery: 2, smaa: true, particles: true, fog: true,
  },
  { // Medium (default on Apple / integrated GPUs).
    name: 'Medium', ao: 'Low', aoHalf: true, godRays: 32, bloom: true, bloomLevels: 5, lens: true, shadow: 2048, pcfLite: false,
    probe: 4, vmShadow: 512, lights: 4, unify: 'full', pip: 384, pipEvery: 2, smaa: true, particles: true, fog: true,
  },
  {
    name: 'High', ao: 'Medium', aoHalf: true, godRays: 48, bloom: true, bloomLevels: 7, lens: true, shadow: 4096, pcfLite: false,
    probe: 2, vmShadow: 1024, lights: 6, unify: 'full', pip: 512, pipEvery: 1, smaa: true, particles: true, fog: true,
  },
  {
    name: 'Ultra', ao: 'High', aoHalf: false, godRays: 48, bloom: true, bloomLevels: 7, lens: true, shadow: 4096, pcfLite: false,
    probe: 2, vmShadow: 1024, lights: 8, unify: 'full', pip: 768, pipEvery: 1, smaa: true, particles: true, fog: true,
  },
];
/** Pixel-ratio cap per quality. With FSR on it caps the *internal* ratio (the expensive part); the output is native. */
const PR_CAP = [0.75, 1, 1.5, 2];

/** Adaptive quality: cumulative step-downs, in order (src/render/Adaptive.js). */
export const ADAPTIVE_STEPS = [
  { label: 'ambient occlusion off', apply: () => ({ ao: null }) },
  { label: 'god rays off', apply: () => ({ godRays: 0 }) },
  { label: 'smaller shadow map', apply: (f) => ({ shadow: Math.max(1024, f.shadow / 2), pcfLite: true }) },
  { label: 'viewmodel light probe off', apply: () => ({ probe: 0, vmShadow: 0 }) },
  { label: 'lighter bloom', apply: () => ({ bloomLevels: 3 }) },
  { label: 'lower render resolution', apply: (f, s) => (s.upscalingAuto === false ? {} : { scaleMul: 0.75 }) },
];

/** Upscaling modes → internal scale of the output (FSR 1 presets; 'dynamic' = dynamic resolution, 0.5–1). */
export const UPSCALING = { off: 1, quality: 0.77, balanced: 0.67, performance: 0.5, dynamic: 1 };

// PCF "lite" (Low preset / adaptive): one hardware-filtered (2x2 bilinear compare) tap instead of five when
// shadow.radius < 0.5. Uniform branch, so no extra program variants.
{
  const k = 'shadowmap_pars_fragment', src = THREE.ShaderChunk[k];
  const from = '\t\t\t\tshadow = (\n\t\t\t\t\ttexture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 0, 5, phi )';
  if (src.includes(from)) THREE.ShaderChunk[k] = src.replace(from, '\t\t\t\tif ( shadowRadius < 0.5 ) shadow = texture( shadowMap, shadowCoord.xyz ); else\n' + from);
  else console.info('[render] PCF-lite patch skipped (three shadow chunk changed)');
}

/**
 * Owns the WebGL renderer + post stack.
 * Pipeline (all at the internal resolution): world RenderPass -> N8AO -> [HDR] god rays + bloom + lens (need world
 *   depth) -> viewmodel RenderPass (depth cleared, own FOV) -> [tonemap] ACES + grade + vignette + CA + grain -> SMAA
 *   -> CAS (upscaling Off only) -> FSR 1 (EASU to the output size + RCAS; render/Fsr.js) -> canvas.
 * With upscaling Off and no dynamic-res drop, internal == output and the FSR pass is skipped entirely.
 * Effects are motivated & subtle; each can be toggled via settings: fxBloom, fxGodRays, fxLens, fxCA, fxGrain.
 */
export class Renderer {
  constructor(canvas, settings) {
    this.settings = settings;
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, stencil: false, depth: true, powerPreference: 'high-performance',
    });
    const r = this.renderer;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.NoToneMapping; // tonemapping happens in post
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap; // PCFSoft was removed in r18x; PCF + shadow.radius gives soft edges
    r.info.autoReset = false;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(80, 1, 0.05, 1500);
    this.scene.add(this.camera);

    // Viewmodel lives in its own scene so it never clips into walls and has its own FOV.
    this.viewScene = new THREE.Scene();
    this.viewCamera = new THREE.PerspectiveCamera(58, 1, 0.01, 10);
    this.viewScene.add(this.viewCamera);

    this.composer = new EffectComposer(r, { frameBufferType: THREE.HalfFloatType, multisampling: 0 });
    this.worldPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.worldPass);

    this.aoPass = new N8AOPostPass(this.scene, this.camera, 1, 1);
    Object.assign(this.aoPass.configuration, {
      aoRadius: 1.1, distanceFalloff: 0.35, intensity: 2.6, halfRes: true, depthAwareUpsampling: true,
      gammaCorrection: false, color: new THREE.Color(0x0d0a08),
    });
    this.aoPass.setQualityMode('Medium');
    this.composer.addPass(this.aoPass);

    this.viewPass = new RenderPass(this.viewScene, this.viewCamera);
    this.viewPass.clearPass.setClearFlags(false, true, false);
    this.viewPass.ignoreBackground = true;
    this.viewPass.skipShadowMapUpdate = true;

    // ---- HDR stage
    this.bloom = new BloomEffect({
      // Tight bloom (level art A/B, job *_level_veil): the wide 0.82 radius laid a milky veil over distant silhouettes.
      intensity: 0.42, luminanceThreshold: 1.15, luminanceSmoothing: 0.35, mipmapBlur: true, radius: 0.62, levels: 7,
    });
    // Sun proxy for god rays (never added to the visible scene; positioned at "infinity" each frame).
    this.sunSource = new THREE.Mesh(
      new THREE.SphereGeometry(18, 16, 8),
      new THREE.MeshBasicMaterial({ color: 0xffc890, transparent: true, depthWrite: false, fog: false }),
    );
    this.sunDir = null;
    this.godRays = new GodRaysEffect(this.camera, this.sunSource, {
      resolutionScale: 0.5, kernelSize: KernelSize.SMALL, density: 0.94, decay: 0.93, weight: 0.18, exposure: 0.45,
      samples: 48, clampMax: 1.0, blur: true,
    });
    this.lens = new LensEffect(this.bloom, lensDirtTexture());
    this.hdrPass = new EffectPass(this.camera, this.godRays, this.bloom, this.lens);

    // ---- display stage
    this.toneMap = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
    this.grade = new GradeEffect();
    this.chroma = new ChromaticAberrationEffect({ offset: new THREE.Vector2(0, 0), radialModulation: true, modulationOffset: 0.45 });
    this.vignette = new VignetteEffect({ offset: 0.38, darkness: 0.32 });
    this.noise = new NoiseEffect({ blendFunction: BlendFunction.OVERLAY, premultiply: false });
    this.noise.blendMode.opacity.value = 0.02;
    this.gradePass = new EffectPass(this.camera, this.toneMap, this.grade, this.vignette, this.chroma, this.noise);
    this.smaa = new SMAAEffect({ preset: SMAAPreset.HIGH });
    this.aaPass = new EffectPass(this.camera, this.smaa);
    this.sharpen = new SharpenEffect(0.55);
    this.sharpenPass = new EffectPass(this.camera, this.sharpen);
    this.fsrPass = new FsrPass();

    // HDR effects that read scene depth (god rays, sun-glare occlusion) must run BEFORE the viewmodel pass,
    // which clears depth — otherwise the sun "shines through" walls and ceilings.
    this.composer.addPass(this.hdrPass);
    this.composer.addPass(this.viewPass);
    this.composer.addPass(this.gradePass);
    this.composer.addPass(this.aaPass);
    this.composer.addPass(this.sharpenPass);
    this.composer.addPass(this.fsrPass);
    this.composer.autoRenderToScreen = false; // routed by _route(): the last *enabled* pass draws to the canvas

    // Effects whose blend is "off" still ran their internal passes every frame (postprocessing calls
    // effect.update() for every effect regardless of opacity): Low paid for god rays + the bloom mip chain.
    // _setEffectActive() SKIPs the blend and the update.
    for (const e of [this.godRays, this.bloom, this.lens]) {
      const u = e.update.bind(e);
      e._blendOn = e.blendMode.blendFunction;
      e.update = (...a) => { if (e._active !== false) u(...a); };
    }

    // GPU timing per pass (EXT_disjoint_timer_query_webgl2; off unless gpuTimer.enabled).
    this.gpuTimer = new GpuTimer(r.getContext());
    this._installGpuTimer();

    this.damagePulse = 0;
    this.ads = 0;
    this._v = new THREE.Vector3();
    this.bench = {};          // benchmark overrides (render/Benchmark.js)
    this.dynScale = 1;
    this.autoQuality();
    this.applySettings();
    addEventListener('resize', () => this.resize());
  }

  _installGpuTimer() {
    const t = this.gpuTimer, r = this.renderer;
    if (!t.available) return;
    const names = new Map([[this.worldPass, 'world'], [this.aoPass, 'ao_n8ao'], [this.hdrPass, 'hdr_godrays_bloom_lens'], [this.viewPass, 'viewmodel'],
      [this.gradePass, 'grade_tonemap'], [this.aaPass, 'smaa'], [this.sharpenPass, 'cas'], [this.fsrPass, 'fsr_easu_rcas']]);
    for (const [p, label] of names) {
      const orig = p.render.bind(p);
      p.render = (...a) => { t.push(label); try { return orig(...a); } finally { t.pop(); } };
    }
    const sm = r.shadowMap, origSm = sm.render.bind(sm);
    sm.render = (...a) => {
      const will = sm.enabled && (sm.autoUpdate || sm.needsUpdate);
      if (!will || !t.on) return origSm(...a);
      t.push('shadow_map'); try { return origSm(...a); } finally { t.pop(); }
    };
    // Renders outside the composer (viewmodel update: scope PiP, light-probe face, viewmodel sun shadow).
    const origRender = r.render.bind(r);
    r.render = (scene, camera) => {
      if (!t.on || t.stack.length) return origRender(scene, camera);
      const rt = r.getRenderTarget();
      const label = scene === this.viewScene ? 'vm_sun_shadow' : scene === this.scene ? (rt?.isWebGLCubeRenderTarget ? 'vm_light_probe' : camera === this.camera ? 'world_extra' : 'pip_scope') : 'other';
      t.push(label); try { return origRender(scene, camera); } finally { t.pop(); }
    };
  }

  /**
   * GPU tier from the unmasked renderer string. Until the player picks a quality / upscaling mode themselves
   * (settings.qualityAuto / upscalingAuto): software + phones → Low + FSR Performance; integrated (Apple M-series,
   * Intel Iris/UHD, Radeon APUs) → Medium + FSR Balanced; discrete → High + FSR Quality. Result in this.gpuInfo.
   */
  autoQuality() {
    const s = this.settings, gl = this.renderer.getContext();
    let name = '';
    try { const ext = gl.getExtension('WEBGL_debug_renderer_info'); name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)); } catch { /* ignore */ }
    const touch = navigator.maxTouchPoints > 1;
    const software = /swiftshader|llvmpipe|softpipe|microsoft basic render/i.test(name);
    // Chrome/ANGLE: "ANGLE (Apple, ANGLE Metal Renderer: Apple M2, …)"; Safari masks it as "Apple GPU" (Mac and iOS).
    const apple = /apple m\d|apple gpu/i.test(name) && !(touch && /iphone|ipad|mobile/i.test(navigator.userAgent)) && !(touch && /apple gpu/i.test(name) && !/mac/i.test(navigator.platform || ''));
    const mobile = !apple && (/mali|adreno|powervr|apple gpu/i.test(name) || (touch && /android|iphone|ipad/i.test(navigator.userAgent)));
    const integrated = apple || /intel|uhd graphics|iris|radeon\(tm\) graphics|radeon graphics|vega \d+ graphics/i.test(name);
    const tier = software || mobile ? 0 : integrated ? 1 : 2;
    this.gpuInfo = { name, tier, software, mobile, integrated, apple };
    if (window.__qaFixedDt || navigator.webdriver) return;
    if (s.qualityAuto !== false) s.quality = tier;
    if (s.upscalingAuto !== false) s.upscaling = ['performance', 'balanced', 'quality'][tier];
  }

  /** Called by the level once the sun is known. dir = unit vector toward the sun. */
  setSun(dir, color) {
    this.sunDir = dir.clone().normalize();
    if (color) { this.sunSource.material.color.copy(color); this.lens.uniforms.get('sunColor').value.copy(color); }
  }

  /** Preset for the current quality, plus adaptive step-downs, plus benchmark overrides. */
  computeFeatures() {
    const s = this.settings, q = THREE.MathUtils.clamp(s.quality | 0, 0, 3);
    const f = { ...QUALITY_PRESETS[q], scaleMul: 1 };
    // Apple GPUs (ANGLE-Metal) on auto quality: skip the viewmodel probe's GPU→CPU readback and the extra viewmodel
    // shadow pass — both stall a tile-based GPU far more than they cost on desktop (gun falls back to hemi + rim + local lights).
    if (this.gpuInfo?.apple && s.qualityAuto !== false) { f.probe = 0; f.vmShadow = 0; }
    const lvl = s.qualityAuto !== false && s.adaptiveQuality !== false ? Math.min(ADAPTIVE_STEPS.length, s.adaptiveLevel | 0) : 0;
    for (let i = 0; i < lvl; i++) Object.assign(f, ADAPTIVE_STEPS[i].apply(f, s));
    return Object.assign(f, this.bench);
  }

  _setEffectActive(e, on) {
    if ((e._active !== false) === on) return;
    e._active = on;
    e.blendMode.blendFunction = on ? e._blendOn : BlendFunction.SKIP; // dispatches "change" → pass recompiles once
  }

  applySettings() {
    const s = this.settings;
    const on = (k) => s[k] !== false;
    const f = this.features = this.computeFeatures();
    this.aoPass.enabled = !!f.ao;
    if (f.ao) { this.aoPass.setQualityMode(f.ao); this.aoPass.configuration.halfRes = !!f.aoHalf; }
    const bloomOn = !!f.bloom && on('fxBloom');
    this._setEffectActive(this.bloom, bloomOn);
    if (bloomOn && this.bloom.mipmapBlurPass.levels !== f.bloomLevels) this.bloom.mipmapBlurPass.levels = f.bloomLevels;
    this._setEffectActive(this.godRays, f.godRays > 0 && on('fxGodRays'));
    if (f.godRays > 0) this.godRays.samples = f.godRays;
    this.lensOn = on('fxLens') && f.lens !== false;
    this._setEffectActive(this.lens, this.lensOn || bloomOn);
    this.caOn = on('fxCA');
    this.noise.blendMode.opacity.value = on('fxGrain') ? 0.02 : 0;
    this.aaPass.enabled = f.smaa !== false;
    uploadRing.enabled = f.uploadRing === true; // opt-in until verified on Metal (benchmark A/B step turns it on)
    const r = this.renderer;
    r.shadowMap.enabled = f.shadow > 0;
    // Sun shadow-map size per quality, applied live. PCF-lite = one tap (radius 0, see the chunk patch above).
    this.scene.traverse((o) => {
      if (!o.isDirectionalLight || !o.castShadow) return;
      o.userData.baseShadowRadius ??= o.shadow.radius;
      o.shadow.radius = f.pcfLite ? 0 : o.userData.baseShadowRadius;
      if (f.shadow > 0 && o.shadow.mapSize.x !== f.shadow) {
        // three resizes the existing map on its next shadow render. Don't dispose it: a null map makes the
        // array shadow-sampler fall back to an empty depth texture without compare mode (GL sampler mismatch).
        o.shadow.mapSize.set(f.shadow, f.shadow);
      }
    });
    // Upscaling + sharpening.
    const mode = UPSCALING[s.upscaling] !== undefined ? s.upscaling : 'off';
    this.upscaling = mode;
    const sharp = THREE.MathUtils.clamp(s.sharpness ?? 0.8, 0, 1);
    this.fsrPass.sharpness = sharp;
    this.sharpen.uniforms.get('sharpness').value = sharp * 0.7;
    this._casBase = sharp * 0.7;
    if (s.dynamicRes === false && mode !== 'dynamic') this.dynScale = 1;
    if (mode === 'dynamic' && this._lastMode !== 'dynamic' && !(window.__qaFixedDt || navigator.webdriver)) this.dynScale = 0.77;
    this._lastMode = mode;
    this.resize();
    this.onFeatures?.(f);
  }

  /** Effective internal scale bounds for the current mode (used by resize and dynamic resolution). */
  _scaleTarget(outPR) {
    const s = this.settings, q = THREE.MathUtils.clamp(s.quality | 0, 0, 3), mode = this.upscaling;
    const f = this.features;
    let t = mode === 'off' ? 1 : Math.min(UPSCALING[mode], PR_CAP[q] / outPR);
    t *= f.scaleMul ?? 1;
    if (f.renderScale) t *= f.renderScale; // benchmark "render scale 0.5"
    return Math.min(1, t);
  }

  resize() {
    const w = innerWidth, h = innerHeight, s = this.settings;
    const q = THREE.MathUtils.clamp(s.quality | 0, 0, 3), fsrOn = this.upscaling !== 'off';
    const dpr = devicePixelRatio || 1;
    // Output (canvas) ratio: native (≤ 2) with FSR; the quality cap × render scale otherwise (as before).
    const outPR = fsrOn ? Math.min(dpr, 2) : Math.min(dpr, PR_CAP[q]) * (s.renderScale ?? 1);
    const r = this.renderer;
    if (r.getPixelRatio() !== outPR) r.setPixelRatio(outPR);
    r.setSize(w, h, false);
    const out = r.getDrawingBufferSize(new THREE.Vector2());
    const target = this._scaleTarget(outPR);
    // Floors for dynamic resolution: 50% of the output with FSR (33% on Retina-class outputs), 55% without.
    this._effFloor = fsrOn ? (outPR >= 1.5 ? 0.33 : 0.5) : 0.55;
    this._dynFloor = Math.min(1, this._effFloor / target);
    const eff = THREE.MathUtils.clamp(target * this.dynScale, Math.min(target, this._effFloor), 1);
    const iw = Math.max(1, Math.round(out.x * eff)), ih = Math.max(1, Math.round(out.y * eff));
    const c = this.composer;
    c.inputBuffer.setSize(iw, ih);
    c.outputBuffer.setSize(iw, ih);
    c.depthRenderTarget?.setSize(iw, ih);
    for (const p of c.passes) p.setSize(iw, ih);
    const upscale = iw !== out.x || ih !== out.y;
    const fsr = this.fsrPass;
    fsr.setOutputSize(out.x, out.y);
    fsr.upscale = upscale;
    fsr.rcas = fsrOn;
    fsr.enabled = fsrOn || upscale;
    // CAS only with upscaling Off (RCAS replaces it); sharper while dynamic resolution has dropped.
    this.sharpenPass.enabled = !fsrOn && (s.sharpness ?? 0.8) > 0 && s.sharpen !== false;
    this.sharpen.uniforms.get('sharpness').value = Math.min(1, (this._casBase ?? 0.55) + (1 - eff) * 0.9);
    // Viewmodel at output resolution (composited in the RCAS pass) or through the internal chain (default).
    const vmOut = fsr.enabled && upscale && s.fsrViewmodel === 'output';
    this.viewPass.enabled = !vmOut;
    fsr.viewmodel = vmOut ? { scene: this.viewScene, camera: this.viewCamera, grade: this.grade, vignette: this.vignette } : null;
    this._route();
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.viewCamera.aspect = w / h;
    this.viewCamera.updateProjectionMatrix();
    this.lens.uniforms.get('aspect').value = w / h;
    this.internalSize = { w: iw, h: ih, scale: +eff.toFixed(3) };
    this.outputSize = { w: out.x, h: out.y, pixelRatio: outPR };
  }

  /** The last enabled pass renders to the canvas; every other pass to the internal ping-pong buffers. */
  _route() {
    const passes = this.composer.passes;
    let last = null;
    for (const p of passes) if (p.enabled) last = p;
    for (const p of passes) { const want = p === last; if (p.renderToScreen !== want) p.renderToScreen = want; }
  }

  /** Render the shadow maps once (via an empty 1x1 view) so no pass ever samples a not-yet-created map. */
  primeShadows() {
    const r = this.renderer, rt = new THREE.WebGLRenderTarget(1, 1);
    const cam = new THREE.PerspectiveCamera(1, 1, 0.1, 0.2);
    cam.position.set(0, 1e4, 0); cam.lookAt(0, 2e4, 0); cam.updateMatrixWorld();
    const prev = r.getRenderTarget();
    r.setRenderTarget(rt);
    r.shadowMap.needsUpdate = true;
    r.render(this.scene, cam);
    r.setRenderTarget(prev);
    rt.dispose();
  }

  setDamage(amount) { this.damagePulse = Math.min(1, this.damagePulse + amount); }

  _updateSun() {
    const cam = this.camera, lu = this.lens.uniforms;
    if (!this.sunDir) { lu.get('sunOn').value = 0; return; }
    cam.updateMatrixWorld();
    this.sunSource.position.copy(cam.position).addScaledVector(this.sunDir, 900);
    this.sunSource.updateMatrixWorld();
    const v = this._v.copy(this.sunSource.position).project(cam);
    const facing = cam.getWorldDirection(new THREE.Vector3()).dot(this.sunDir);
    const onScreen = v.z < 1 && Math.abs(v.x) < 1.3 && Math.abs(v.y) < 1.3 && facing > 0;
    lu.get('sunUV').value.set(v.x * 0.5 + 0.5, v.y * 0.5 + 0.5);
    lu.get('sunOn').value = onScreen && this.lensOn ? THREE.MathUtils.smoothstep(facing, 0.4, 0.9) : 0;
    lu.get('dirtK').value = this.lensOn && this.bloom._active !== false ? 0.55 : 0;
  }

  /**
   * Dynamic resolution: hold ~60 fps by trading the *internal* render scale (FSR upscales to the output). Active in
   * the 'dynamic' upscaling mode, or with the Dynamic resolution option on top of a fixed mode (down to the floor).
   */
  _updateDynRes() {
    const dynOn = this.upscaling === 'dynamic' || this.settings.dynamicRes !== false;
    // Off when disabled, in QA (fixed-step / automation: 1-fps software rendering would ratchet it down) — reset to 100%.
    if (!dynOn || window.__qaFixedDt || navigator.webdriver || this.benchRunning) {
      if (this.dynScale !== 1) { this.dynScale = 1; this.resize(); }
      return;
    }
    const now = performance.now();
    if (this._drT0 === undefined) { this._drT0 = now; this._drN = 0; this._drOkSince = now; this._drHoldUntil = 0; this._drBackoff = 4000; return; }
    this._drN++;
    const span = now - this._drT0;
    if (span < 700) return;
    const ms = span / this._drN;
    this._drT0 = now; this._drN = 0;
    if (document.hidden || ms > 250) { this._drOkSince = now; return; } // tab switch / hitch: not a GPU signal
    // Under vsync a frame that fits takes ~16.7 ms (8.3 at 120 Hz), so "has headroom" can't be read from wall
    // time. Instead: step down on misses; after 3 s at refresh rate, probe one step up. If that probe causes misses
    // within 2 s, step back down and double the wait before the next probe (4 s → 60 s): no oscillation,
    // but resolution recovers after a heavy moment passes. (perf, docs/PERF.md)
    let sc = this.dynScale;
    const floor = this._dynFloor ?? 0.55;
    const probing = now - (this._drLastUp ?? -1e9) < 2500;
    if (ms > 19) {
      if (probing) {
        // The probe step failed: undo it, remember the ceiling, back off exponentially before probing again.
        sc = this._drPrev;
        this._drCeil = this.dynScale;
        this._drHoldUntil = now + this._drBackoff;
        this._drBackoff = Math.min(60000, this._drBackoff * 2);
        this._drLastUp = -1e9;
      } else sc = Math.max(floor, sc - (ms > 40 ? 0.15 : 0.08));
      this._drOkSince = now;
    } else if (ms <= 17.6) {
      if (now > this._drHoldUntil) this._drCeil = 2;
      const next = Math.min(1, sc + 0.05);
      if (sc < 1 && now - this._drOkSince > 3000 && next < (this._drCeil ?? 2) - 1e-6) {
        this._drPrev = sc;
        sc = next;
        this._drLastUp = now;
        this._drOkSince = now;
      }
    } else this._drOkSince = now;
    if (sc !== this.dynScale) {
      this.dynScale = sc;
      this.resize();
    }
  }

  render(dt, lowHealth = 0) {
    this._updateDynRes();
    this.damagePulse = Math.max(0, this.damagePulse - dt * 1.8);
    const ca = this.caOn ? this.damagePulse * 0.006 + lowHealth * 0.002 : 0;
    this.chroma.offset.set(ca, ca * 0.6);
    // Vignette: barely there at rest; deepens with damage / low health / ADS.
    const adsT = this.camera.fov < 60 ? 1 : 0;
    this.ads += (adsT - this.ads) * Math.min(1, dt * 8);
    this.vignette.darkness = 0.3 + this.ads * 0.12 + lowHealth * 0.35 + this.damagePulse * 0.25;
    this.grade.uniforms.get('saturation').value = 0.92 - lowHealth * 0.55;
    this._updateSun();
    this.renderer.info.reset();
    // Perf: shadow maps render exactly once per frame (in the world pass). With autoUpdate every
    // renderer.render(scene) re-rendered them — N8AO's two transparency passes and the PiP scope included.
    const sm = this.renderer.shadowMap;
    sm.autoUpdate = !!window.__perfLegacy; // QA A/B switch (docs/PERF.md)
    sm.needsUpdate = true;
    this.composer.render(dt);
    this.gpuTimer.endFrame();
  }
}
