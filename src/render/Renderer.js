import * as THREE from 'three';
import {
  EffectComposer, RenderPass, EffectPass, BloomEffect, SMAAEffect, SMAAPreset, ToneMappingEffect,
  ToneMappingMode, VignetteEffect, ChromaticAberrationEffect, NoiseEffect, BlendFunction, BrightnessContrastEffect,
  HueSaturationEffect,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';

/**
 * Owns the WebGL renderer + post stack.
 * Pipeline: world RenderPass -> N8AO (SSAO) -> viewmodel RenderPass (depth cleared, own FOV)
 *           -> SMAA + bloom + chromatic aberration (damage) + tonemapping + vignette + grain.
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
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.info.autoReset = false;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(80, 1, 0.05, 900);
    this.scene.add(this.camera);

    // Viewmodel lives in its own scene so it never clips into walls and has its own FOV.
    this.viewScene = new THREE.Scene();
    this.viewCamera = new THREE.PerspectiveCamera(58, 1, 0.01, 10);
    this.viewScene.add(this.viewCamera);

    this.composer = new EffectComposer(r, { frameBufferType: THREE.HalfFloatType, multisampling: 0 });
    this.worldPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.worldPass);

    this.aoPass = new N8AOPostPass(this.scene, this.camera, 1, 1);
    this.aoPass.configuration.aoRadius = 1.6;
    this.aoPass.configuration.distanceFalloff = 0.6;
    this.aoPass.configuration.intensity = 2.2;
    this.aoPass.configuration.halfRes = true;
    this.aoPass.configuration.depthAwareUpsampling = true;
    this.aoPass.configuration.gammaCorrection = false;
    this.aoPass.setQualityMode('Medium');
    this.composer.addPass(this.aoPass);

    this.viewPass = new RenderPass(this.viewScene, this.viewCamera);
    this.viewPass.clearPass.setClearFlags(false, true, false);
    this.viewPass.ignoreBackground = true;
    this.viewPass.skipShadowMapUpdate = true;
    this.composer.addPass(this.viewPass);

    this.bloom = new BloomEffect({
      intensity: 0.9, luminanceThreshold: 0.85, luminanceSmoothing: 0.25, mipmapBlur: true, radius: 0.7,
    });
    this.chroma = new ChromaticAberrationEffect({ offset: new THREE.Vector2(0, 0), radialModulation: true, modulationOffset: 0.2 });
    this.toneMap = new ToneMappingEffect({ mode: ToneMappingMode.AGX });
    this.grade = new BrightnessContrastEffect({ brightness: 0.0, contrast: 0.08 });
    this.sat = new HueSaturationEffect({ saturation: -0.05 });
    this.vignette = new VignetteEffect({ offset: 0.32, darkness: 0.55 });
    this.noise = new NoiseEffect({ blendFunction: BlendFunction.OVERLAY, premultiply: false });
    this.noise.blendMode.opacity.value = 0.06;
    this.smaa = new SMAAEffect({ preset: SMAAPreset.HIGH });

    this.fxPass = new EffectPass(this.camera, this.smaa, this.bloom);
    this.gradePass = new EffectPass(this.camera, this.chroma, this.toneMap, this.grade, this.sat, this.vignette, this.noise);
    this.composer.addPass(this.fxPass);
    this.composer.addPass(this.gradePass);

    this.damagePulse = 0;
    this.applySettings();
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  applySettings() {
    const s = this.settings;
    const q = s.quality; // 0 low, 1 medium, 2 high, 3 ultra
    const pr = Math.min(devicePixelRatio, [0.75, 1, 1.25, 2][q]) * s.renderScale;
    this.renderer.setPixelRatio(pr);
    this.aoPass.enabled = q >= 1;
    this.aoPass.setQualityMode(['Performance', 'Low', 'Medium', 'High'][q]);
    this.aoPass.configuration.halfRes = q < 3;
    this.bloom.blendMode.opacity.value = q >= 1 ? 1 : 0;
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
  }

  setDamage(amount) { this.damagePulse = Math.min(1, this.damagePulse + amount); }

  render(dt, lowHealth = 0) {
    this.damagePulse = Math.max(0, this.damagePulse - dt * 1.8);
    const ca = this.damagePulse * 0.006 + lowHealth * 0.0025;
    this.chroma.offset.set(ca, ca * 0.6);
    this.vignette.darkness = 0.55 + lowHealth * 0.35 + this.damagePulse * 0.25;
    this.sat.saturation = -0.05 - lowHealth * 0.6;
    this.renderer.info.reset();
    this.composer.render(dt);
  }
}
