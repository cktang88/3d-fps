import * as THREE from 'three';
import { AmbAudio } from './ambience/AmbAudio.js';
import { DistantBattle } from './ambience/DistantBattle.js';
import { Fires } from './ambience/Fires.js';
import { Weather } from './ambience/Weather.js';
import { Flyover } from './ambience/Flyover.js';

/**
 * "Ironline at the edge of a live war zone" — the living, cinematic spectacle layer:
 *  - DistantBattle: artillery flashes lighting the cloud base, delayed booms, AA tracer streams,
 *    parachute flares with smoke trails, burning-city glow, billowing smoke columns on the skyline.
 *  - Fires: burning car wreck, burn barrel and debris fire inside the map (flames, plumes, embers, light).
 *  - Weather: sun-shower drizzle, ash/dust motes in the low sun, drifting embers, lightning + thunder.
 *  - Flyover: helicopter / fast-jet passes with doppler audio.
 * Budget: ≤4 extra PointLights (3 fires + 1 flare), one draw call per particle system, quality-aware.
 *
 * Usage (Game.init, after level setup and before navmesh):  this.ambience = new Ambience(this); await this.ambience.init();
 * Game.update:  this.ambience.update(dt);
 */
export class Ambience {
  constructor(game) {
    this.game = game;
    this.scene = game.renderer.scene;
    this.camera = game.renderer.camera;
    this.quality = game.settings?.quality ?? 2;
    this.time = 0;
    this.windBase = new THREE.Vector3(2.2, 0, 0.9);
    this.wind = this.windBase.clone();
    this.light = { ambient: new THREE.Color(0.5, 0.5, 0.5), sun: new THREE.Color(1, 0.8, 0.6), sunDir: new THREE.Vector3(0, 1, 0) };
    this._updateLight();
    this.audio = new AmbAudio(game.audio);
    this.battle = new DistantBattle(this);
    this.fires = new Fires(this);
    this.weather = new Weather(this);
    this.flyover = new Flyover(this);
    this.enabled = true;
  }

  async init() {
    const A = this.game.assets;
    const [wisp, expl, flame] = await Promise.all([
      A.texture('ambience/vfx/wispysmoke02_8x8.webp', true, false),
      A.texture('ambience/vfx/explosion01_5x5.webp', true, false),
      A.texture('ambience/vfx/flame03_16x4.webp', true, false),
      this.fires.load(),
    ]);
    // The UH-60 streams in after boot (first flyover is ≥18 s in); the primitive heli covers until then.
    setTimeout(() => this.flyover.load(A).catch((e) => console.warn('heli model', e)), 0);
    // Photoreal pre-rendered flipbooks (Unity Labs, CC0) replace the procedural puffs when available.
    if (wisp) { this.fires.smoke.setAtlas(wisp, 8, true); this.battle.smoke.setAtlas(wisp, 8, true); }
    if (flame) this.fires.setFlameFlipbook(flame);
    if (expl) { this.battle.blasts.setAtlas(expl, 5, true); this.battle.hasBlast = true; }
    // Pre-roll fire smoke so plumes are already established on first sight.
    const ctx = this._ctx(0.25);
    for (let i = 0; i < 50; i++) this.fires.update(0.25, ctx);
  }

  /** Route our materials through the shared art pipeline when available (cohesion + indoor IBL). */
  unify(m) {
    const mats = this.game.level?.mats ?? this.game.materials;
    if (!m || !mats) return;
    for (const x of Array.isArray(m) ? m : [m]) { mats.applyUnify?.(x); }
  }

  _updateLight() {
    const L = this.light, scene = this.scene, lvl = this.game.level;
    if (scene.fog) L.ambient.copy(scene.fog.color).multiplyScalar(0.85);
    const sun = lvl?.sun;
    if (sun) {
      L.sun.copy(sun.color).multiplyScalar(Math.min(sun.intensity, 5) * 0.32);
      L.sunDir.copy(sun.position).sub(sun.target?.position ?? new THREE.Vector3()).normalize();
    } else if (lvl?.sunDir) L.sunDir.copy(lvl.sunDir);
    const f = this.weather?.flashLevel ?? 0;
    if (f > 0) L.ambient.add(new THREE.Color(0.35, 0.38, 0.45).multiplyScalar(f));
  }

  _ctx(dt) {
    const q = this.game.settings?.quality ?? this.quality;
    return { dt, wind: this.wind, camera: this.camera, light: this.light, particleScale: [0.4, 0.65, 1, 1.25][q] ?? 1 };
  }

  update(dt) {
    if (!this.enabled || dt <= 0) return;
    this.time += dt;
    const t = this.time;
    // Gusty wind: slow heading wander + gust envelope.
    const gust = 1 + 0.35 * Math.sin(t * 0.21) + 0.2 * Math.sin(t * 0.73 + 1.3) + 0.1 * Math.sin(t * 1.9);
    const head = Math.sin(t * 0.05) * 0.25;
    this.wind.copy(this.windBase).applyAxisAngle(new THREE.Vector3(0, 1, 0), head).multiplyScalar(gust);
    this._updateLight();
    const ctx = this._ctx(dt);
    this.battle.update(dt, ctx);
    this.fires.update(dt, ctx);
    this.weather.update(dt, ctx);
    this.flyover.update(dt, ctx);
    const cam = this.camera.position;
    const nf = this.fires.nearest(cam);
    this.audio.update(dt, {
      fireDist: nf.dist, firePos: nf.site?.lightPos, rain: this.weather.rainAmount,
      indoor: this.game.level?.isIndoors?.(cam) ?? false,
    });
  }
}
