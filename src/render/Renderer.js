import * as THREE from 'three';
import {
  EffectComposer, RenderPass, EffectPass, BloomEffect, SMAAEffect, SMAAPreset, ToneMappingEffect,
  ToneMappingMode, VignetteEffect, ChromaticAberrationEffect, NoiseEffect, BlendFunction, GodRaysEffect,
  Effect, EffectAttribute, KernelSize,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';

/* ------------------------------------------------------------------------------------------------
 * Custom effects
 * ---------------------------------------------------------------------------------------------- */

/** Final colour grade (the "glue"): split toning, lift/gamma/gain, filmic contrast, saturation. Runs after tonemapping. */
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
        ['contrast', new THREE.Uniform(0.22)],
        ['saturation', new THREE.Uniform(0.92)],
        ['exposure', new THREE.Uniform(1.0)],
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

/**
 * Owns the WebGL renderer + post stack.
 * Pipeline: world RenderPass -> N8AO -> viewmodel RenderPass (depth cleared, own FOV)
 *   -> [HDR] god rays + bloom + lens (dirt/sun glare)
 *   -> [tonemap] AgX + grade (split tone / LGG / contrast) + vignette + edge CA (damage) + fine grain
 *   -> SMAA (on display-referred image).
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
    this.composer.addPass(this.viewPass);

    // ---- HDR stage
    this.bloom = new BloomEffect({
      intensity: 0.55, luminanceThreshold: 1.15, luminanceSmoothing: 0.35, mipmapBlur: true, radius: 0.82, levels: 7,
    });
    // Sun proxy for god rays (never added to the visible scene; positioned at "infinity" each frame).
    this.sunSource = new THREE.Mesh(
      new THREE.SphereGeometry(18, 16, 8),
      new THREE.MeshBasicMaterial({ color: 0xffc890, transparent: true, depthWrite: false, fog: false }),
    );
    this.sunDir = null;
    this.godRays = new GodRaysEffect(this.camera, this.sunSource, {
      resolutionScale: 0.5, kernelSize: KernelSize.SMALL, density: 0.94, decay: 0.93, weight: 0.32, exposure: 0.55,
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
    this.noise.blendMode.opacity.value = 0.035;
    this.gradePass = new EffectPass(this.camera, this.toneMap, this.grade, this.vignette, this.chroma, this.noise);
    this.smaa = new SMAAEffect({ preset: SMAAPreset.HIGH });
    this.aaPass = new EffectPass(this.camera, this.smaa);

    this.composer.addPass(this.hdrPass);
    this.composer.addPass(this.gradePass);
    this.composer.addPass(this.aaPass);

    this.damagePulse = 0;
    this.ads = 0;
    this._v = new THREE.Vector3();
    this.applySettings();
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  /** Called by the level once the sun is known. dir = unit vector toward the sun. */
  setSun(dir, color) {
    this.sunDir = dir.clone().normalize();
    if (color) { this.sunSource.material.color.copy(color); this.lens.uniforms.get('sunColor').value.copy(color); }
  }

  applySettings() {
    const s = this.settings;
    const q = s.quality; // 0 low, 1 medium, 2 high, 3 ultra
    const on = (k) => s[k] !== false;
    const pr = Math.min(devicePixelRatio, [0.75, 1, 1.25, 2][q]) * s.renderScale;
    this.renderer.setPixelRatio(pr);
    this.aoPass.enabled = q >= 1;
    this.aoPass.setQualityMode(['Performance', 'Low', 'Medium', 'High'][q]);
    this.aoPass.configuration.halfRes = q < 3;
    this.bloom.blendMode.opacity.value = q >= 1 && on('fxBloom') ? 1 : 0;
    this.godRays.blendMode.opacity.value = q >= 1 && on('fxGodRays') ? 1 : 0;
    this.godRays.samples = q >= 2 ? 48 : 32;
    this.lensOn = on('fxLens');
    this.caOn = on('fxCA');
    this.noise.blendMode.opacity.value = on('fxGrain') ? 0.035 : 0;
    this.renderer.shadowMap.enabled = true;
    this.resize();
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.viewCamera.aspect = w / h;
    this.viewCamera.updateProjectionMatrix();
    this.lens.uniforms.get('aspect').value = w / h;
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
    lu.get('dirtK').value = this.lensOn ? 0.55 : 0;
  }

  render(dt, lowHealth = 0) {
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
    this.composer.render(dt);
  }
}
