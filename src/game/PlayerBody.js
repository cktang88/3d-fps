import * as THREE from 'three';
import { damp } from '../core/MathUtil.js';

/**
 * Full-body awareness for the first-person player: the bots' character rig (same mesh, same
 * retargeted clips and gait-phase locomotion) placed under the camera. Everything above the chest
 * is discarded in the colour pass (per-fragment world-height clip), so looking down shows legs,
 * hips and belly but never the inside of the head; the shadow pass uses the unclipped full body,
 * so the player casts a complete, correctly animated shadow.
 */
export class PlayerBody {
  constructor(game) {
    this.game = game;
    const ch = game.charTemplate.instance(0);
    ch._lodInterval = () => 0; // always full rate (it's right under the camera)
    this.ch = ch;
    this.clipY = { value: 1e9 };
    const patched = new Map();
    ch.root.traverse((o) => {
      if (!o.isMesh) return;
      o.frustumCulled = false;
      const patch = (m) => {
        if (!m || m.isMeshDepthMaterial || m.isMeshDistanceMaterial) return m;
        if (patched.has(m)) return patched.get(m);
        const c = m.clone();
        const prev = m.onBeforeCompile, prevKey = m.customProgramCacheKey?.bind(m);
        c.onBeforeCompile = (sh, r) => {
          prev?.call(c, sh, r);
          sh.uniforms.pbClipY = this.clipY;
          sh.vertexShader = sh.vertexShader
            .replace('#include <common>', '#include <common>\nvarying float vPBWorldY;')
            .replace('#include <project_vertex>', '#include <project_vertex>\nvPBWorldY = (modelMatrix * vec4(transformed, 1.0)).y;');
          sh.fragmentShader = sh.fragmentShader
            .replace('#include <common>', '#include <common>\nuniform float pbClipY; varying float vPBWorldY;')
            .replace('void main() {', 'void main() {\n  if (vPBWorldY > pbClipY) discard;');
        };
        c.customProgramCacheKey = () => (prevKey ? prevKey() : '') + '|pbclip';
        patched.set(m, c);
        return c;
      };
      o.material = Array.isArray(o.material) ? o.material.map(patch) : patch(o.material);
    });
    game.renderer.scene.add(ch.root);
    this.actor = {
      alive: true, position: new THREE.Vector3(), velocity: new THREE.Vector3(), yaw: 0, pitch: 0,
      crouch: 0, jumpY: 0, weapon: null, game, aimUp: false,
    };
    this.crouch = 0;
  }

  update(dt) {
    const g = this.game, p = g.player, ch = this.ch;
    const show = !!(p.alive && g.started);
    ch.root.visible = show;
    if (!show) return;
    const a = this.actor;
    // Stand the body a little behind the eye so looking straight down frames the feet, not the
    // chest (and the clipped edge never comes near the near plane).
    const back = 0.1;
    a.position.set(p.position.x + Math.sin(p.yaw) * back, p.position.y, p.position.z + Math.cos(p.yaw) * back);
    a.velocity.set(p.velocity.x, 0, p.velocity.z);
    a.yaw = p.yaw;
    a.pitch = 0;
    this.crouch = damp(this.crouch, p.crouching || p.sliding || p.mantle ? 1 : 0, 10, dt);
    a.crouch = this.crouch;
    a.weapon = g.currentWeapon;
    // Upper-body cut: just below the collarbones, following crouch/slide eye height.
    this.clipY.value = p.position.y + p.eyeHeight.x - 0.48;
    ch.update(dt, a);
  }
}
