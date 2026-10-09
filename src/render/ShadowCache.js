import * as THREE from 'three';
import { SHADOW_PROXY_LAYER, STATIC_SHADOW_LAYER } from './Lod.js';

export { STATIC_SHADOW_LAYER };

/**
 * Static/dynamic sun-shadow split (perf, docs/PERF.md).
 *
 * Static casters (the level's merged static caster + the props' batched caster, see Lod.consolidateStaticShadows)
 * live on STATIC_SHADOW_LAYER. They are rendered into the sun's shadow map ONCE ("bake"), and that depth is copied
 * into a private render target. Every later frame the shadow pass runs without the static layer:
 *   three clears the map → a "blitter" object (first in traversal order, shadow-only) copies the baked static depth
 *   back with a single glBlitFramebuffer(DEPTH) → dynamic casters (bots, guns, ambience, alpha-tested fences…)
 *   draw on top with the normal depth test.
 * Result: identical shadow map, but the ~350k-tri static geometry isn't redrawn per frame; the per-frame cost is
 * one depth blit + the dynamic casters. Re-bakes on: first frame, shadow-map resize (quality), `invalidate()`.
 * Keeping the single map (vs. a second dynamic cascade) means no shader changes in the ~40 lit material variants.
 */
export class StaticShadowCache {
  /** Install early (before Lod.installShadowProxyLayer) so the proxy layer is enabled *outside* this wrapper. */
  constructor(renderer, scene, light = null) {
    this.r = renderer;
    this.scene = scene;
    this.light = light;
    this.enabled = true;
    this.dirty = true;
    this.rt = null;
    this.bakes = 0;
    // Shadow-only, zero-draw object whose onBeforeShadow performs the blit. Must be traversed first.
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(9), 3));
    g.setDrawRange(0, 0);
    const blitter = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
    blitter.name = 'staticShadowBlitter';
    blitter.frustumCulled = false;
    blitter.castShadow = true;
    blitter.layers.set(SHADOW_PROXY_LAYER);
    blitter.onBeforeShadow = (r, obj, cam, shadowCam) => { if (this._blitArmed) this._blit(false); };
    scene.add(blitter);
    scene.children.splice(scene.children.indexOf(blitter), 1);
    scene.children.unshift(blitter);
    this.blitter = blitter;
    this._blitArmed = false;
    this._install();
  }

  invalidate() { this.dirty = true; }

  _fb(rt) { return this.r.properties.get(rt).__webglFramebuffer; }

  _ensureRT() {
    const map = this.light.shadow.map;
    if (!map) return false;
    if (!this.rt || this.rt.width !== map.width || this.rt.height !== map.height) {
      this.rt?.dispose();
      this.rt = new THREE.WebGLRenderTarget(map.width, map.height, { depthBuffer: true, stencilBuffer: false, generateMipmaps: false });
      this.rt.depthTexture = new THREE.DepthTexture(map.width, map.height, map.depthTexture.type);
      this.rt.depthTexture.format = map.depthTexture.format;
      this.r.initRenderTarget(this.rt);
      this.dirty = true;
    }
    return true;
  }

  /** toCache: shadow map → cache; else cache → shadow map (the shadow map's FBO is bound by three at this point). */
  _blit(toCache) {
    const gl = this.r.getContext(), map = this.light.shadow.map;
    const a = this._fb(map), b = this._fb(this.rt);
    if (!a || !b) return;
    const w = map.width, h = map.height;
    const scissor = gl.isEnabled(gl.SCISSOR_TEST);
    if (scissor) gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, toCache ? a : b);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, toCache ? b : a);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
    // Leave the shadow map bound for both targets, which is what three's state cache believes.
    gl.bindFramebuffer(gl.FRAMEBUFFER, a);
    if (scissor) gl.enable(gl.SCISSOR_TEST);
  }

  _install() {
    const sm = this.r.shadowMap, orig = sm.render, self = this;
    sm.render = function (lights, scene, camera) {
      const mine = self.enabled && self.light && scene === self.scene && lights.includes(self.light);
      if (!mine) {
        // Fallback / other scenes: static casters render normally every time.
        const had = camera.layers.isEnabled(STATIC_SHADOW_LAYER);
        camera.layers.enable(STATIC_SHADOW_LAYER);
        try { return orig.call(this, lights, scene, camera); } finally { if (!had) camera.layers.disable(STATIC_SHADOW_LAYER); }
      }
      if (!(sm.autoUpdate || sm.needsUpdate)) return orig.call(this, lights, scene, camera);
      const mask = camera.layers.mask;
      try {
        if (self.dirty || !self.rt || !self.light.shadow.map || self.rt.width !== self.light.shadow.map.width) {
          // Bake: static casters only, then copy the depth into the cache.
          camera.layers.set(STATIC_SHADOW_LAYER);
          self._blitArmed = false;
          orig.call(this, lights, scene, camera);
          if (self._ensureRT()) {
            const r = self.r, prev = r.getRenderTarget(), face = r.getActiveCubeFace(), mip = r.getActiveMipmapLevel();
            r.setRenderTarget(self.light.shadow.map);
            self._blit(true);
            r.setRenderTarget(prev, face, mip);
            self.dirty = false;
            self.bakes++;
          }
          camera.layers.mask = mask;
          sm.needsUpdate = true;
        }
        // Per frame: cleared map ← blit cached static depth (blitter, first in traversal) ← dynamic casters.
        camera.layers.disable(STATIC_SHADOW_LAYER);
        self._blitArmed = !!self.rt && !self.dirty;
        return orig.call(this, lights, scene, camera);
      } finally {
        camera.layers.mask = mask;
        self._blitArmed = false;
      }
    };
  }
}
