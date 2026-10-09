import * as THREE from 'three';
import { Renderer } from '../render/Renderer.js';
import { Effects } from '../render/Effects.js';
import { Perf } from '../render/Perf.js';
import { lodReady, installShadowProxyLayer, consolidateStaticShadows } from '../render/Lod.js';
import { BotOcclusion } from '../render/Occlusion.js';
import { LightPool } from '../render/LightPool.js';
import { Physics, G } from '../core/Physics.js';
import { Input } from '../core/Input.js';
import { Audio } from '../core/Audio.js';
import { Assets } from '../core/Assets.js';
import { Materials } from '../world/Materials.js';
import { Level, LEVEL_HDRI } from '../world/Level.js';
import { Ambience } from '../world/Ambience.js';
import { Player } from './Player.js';
import { FPCamera } from './FPCamera.js';
import { Weapon } from './weapons/Weapon.js';
import { WEAPONS } from './weapons/WeaponDefs.js';
import { GunModels } from './weapons/GunModels.js';
import { ViewModel } from './weapons/ViewModel.js';
import { Ballistics, applySpread } from './Ballistics.js';
import { Bot } from './bots/Bot.js';
import { CharacterTemplate } from './bots/Character.js';
import { Navigation } from './bots/Navigation.js';
import { Match } from './Match.js';
import { HUD } from '../ui/HUD.js';
import { DEG, clamp, rand } from '../core/MathUtil.js';
import { AimRecoil } from './weapons/Recoil.js';

const SAMPLE_SETS = ['m4a1', 'ak74', 'scarl', 'mp5a5', 'vss', 'awm', 'm24', 'p226', 'm1911', 'shotgun'];

export class Game {
  static RESPAWN_MIN = 1.6;
  static RESPAWN_AUTO = 4.5;
  static FUSE = 3.2;

  constructor(canvas, settings) {
    this.canvas = canvas;
    this.settings = settings;
    this.time = 0;
    this.actors = [];
    this.bots = [];
    this.grenades = 2;
    this.grenadeObjs = [];
    this.uavTime = 0;
    this.paused = true;
    this.started = false;
    this.breath = 1;
    this.aimRecoil = new AimRecoil(); // real aim recoil (pull-down, partial settle); visual kick is fpcam/viewmodel
    this.frame = 0;
    this.matchStats = Game.freshStats();
    this.mode = { teams: true, name: 'TEAM DEATHMATCH', score: [0, 0], timeLeft: 600, scoreLimit: 50, friendlyFire: false };
  }

  async init(onProgress) {
    const s = this.settings;
    this.renderer = new Renderer(this.canvas, s);
    this.perf = new Perf(this); window.__perf = this.perf;
    installShadowProxyLayer(this.renderer.renderer);
    this.perf.mark('renderer');
    this.input = new Input(this.canvas);
    this.audio = new Audio();
    this.physics = await Physics.create();
    this.perf.mark('physics');
    this.assets = new Assets(this.renderer.renderer);
    this.assets.onProgress = onProgress;

    this.materials = new Materials(this.assets);
    this.level = new Level(this, this.materials);
    this.gunModels = new GunModels(this.assets);
    const [hdr] = await Promise.all([
      this.assets.hdri(LEVEL_HDRI),
      this.materials.load(),
      this.level.loadProps(this.assets),
      // FP rigs: only the player's loadout before the menu; the rest stream in after init (see below).
      this.gunModels.load([this.settings.loadout.primary, this.settings.loadout.secondary].map((id) => WEAPONS[id]?.model).filter(Boolean)),
      this.assets.model('soldier', 'models/characters/soldier.glb'),
      this.assets.model('soldierTac', 'models/characters/soldier_tac.glb'),
      this.loadSounds(),
      lodReady,
    ]);
    this.perf.mark('assets loaded');
    onProgress?.(0.92, 'Building level');
    await new Promise((r) => setTimeout(r, 0));
    this.level.build();
    this.level.placeProps();
    this.level.setupEnvironment(hdr);
    consolidateStaticShadows(this.level.group); // perf: ~70 static shadow draws -> a handful
    this.renderer.viewScene.environment = this.renderer.scene.environment;
    this.renderer.viewScene.environmentIntensity = 0.9;
    this.perf.tag(this.renderer.scene, 'level'); this.perf.mark('level built');
    // Living war-zone ambience (fires/wrecks add colliders + nav proxies, so build before the navmesh).
    this.ambience = new Ambience(this);
    await this.ambience.init();
    this.perf.tag(this.renderer.scene, 'ambience'); this.perf.mark('ambience');

    onProgress?.(0.95, 'Generating navmesh');
    await new Promise((r) => setTimeout(r, 0));
    this.nav = await Navigation.create(this.level);
    this.perf.mark('navmesh');

    this.effects = new Effects(this);
    this.ballistics = new Ballistics(this);
    this.player = new Player(this);
    this.player.stats = { kills: 0, deaths: 0, assists: 0, score: 0 };
    this.fpcam = new FPCamera(this.renderer.camera, this.renderer.viewCamera, s);
    this.viewmodel = new ViewModel(this, this.gunModels);
    this.charTemplate = new CharacterTemplate(this.assets.models.soldier, this.gunModels, this.assets.models.soldierTac);
    this.charTemplate.camera = this.renderer.camera; // perf: render-time body LOD (Lod.DistanceLod)
    this.botOcclusion = new BotOcclusion(this);
    this.hud = new HUD(this);
    this.hud.show(false);
    this.match = new Match(this);
    this._wirePlayerEvents();
    this.buildLoadout();
    this.perf.tag(this.renderer.scene, 'effects+viewmodel');
    // Perf: N physical point lights (by quality) stand in for every logical PointLight (render/LightPool.js).
    this.lightPool = new LightPool(this.renderer.scene, this.renderer.camera, [3, 4, 6, 8][s.quality] ?? 6);
    this.lightPool.adopt();

    // Patch every material for indoor IBL attenuation (after all scene content exists).
    this.level.applyInteriorOcclusion();
    // Pre-compile shaders to avoid hitches on first view.
    // Perf/robustness: create the sun shadow map now. Passes that run before the first world pass (scope, light
    // probe) never update shadows, and a null map binds a compare-less fallback (GL sampler mismatch).
    this.renderer.primeShadows();
    this.renderer.renderer.compile(this.renderer.scene, this.renderer.camera);
    this.renderer.renderer.compile(this.renderer.viewScene, this.renderer.viewCamera);
    this.perf.mark('shaders compiled');
    onProgress?.(1, 'Ready');
    // Stream the remaining FP weapon rigs while the menu is up (startMatch awaits them).
    this.gunModels.loadRest().then(() => { this._rigsReady = true; });
  }

  async loadSounds() {
    const a = this.audio;
    const jobs = [];
    for (const g of SAMPLE_SETS) {
      jobs.push(a.load(`${g}_near`, `./assets/audio/guns/${g}_player_near.ogg`));
      jobs.push(a.load(`${g}_world`, `./assets/audio/guns/${g}_world.ogg`));
      if (g !== 'shotgun') jobs.push(a.load(`${g}_far`, `./assets/audio/guns/${g}_enemy_distant.ogg`));
    }
    for (const f of ['ak_magin', 'ak_magout', 'ak_rack', 'bolt_back', 'bolt_fwd', 'pistol_dry', 'pistol_magin', 'pistol_magout', 'pistol_slide', 'rifle_boltdrop', 'rifle_dry', 'rifle_magin', 'rifle_magout', 'rifle_rack', 'shotgun_pump', 'shotgun_shell', 'switch']) {
      jobs.push(a.load(f, `./assets/audio/foley/${f}.ogg`));
    }
    for (let i = 0; i < 5; i++) {
      jobs.push(a.load('step_concrete', `./assets/audio/steps/footstep_concrete_00${i}.ogg`));
      jobs.push(a.load('step_wood', `./assets/audio/steps/footstep_wood_00${i}.ogg`));
      jobs.push(a.load('step_dirt', `./assets/audio/steps/footstep_grass_00${i}.ogg`));
      jobs.push(a.load('step_metal', `./assets/audio/steps/footstep_carpet_00${i}.ogg`));
      jobs.push(a.load('imp_metal', `./assets/audio/impacts/impact_metal_light_00${i}.ogg`));
      jobs.push(a.load('imp_wood', `./assets/audio/impacts/impact_wood_light_00${i}.ogg`));
      jobs.push(a.load('imp_concrete', `./assets/audio/impacts/impact_generic_light_00${i}.ogg`));
      jobs.push(a.load('imp_dirt', `./assets/audio/impacts/impact_soft_medium_00${i}.ogg`));
      jobs.push(a.load('imp_flesh', `./assets/audio/impacts/impact_punch_medium_00${i}.ogg`));
      jobs.push(a.load('imp_glass', `./assets/audio/impacts/impact_glass_light_00${i}.ogg`));
    }
    // UI / feedback layer (Kenney, CC0).
    const ui = { ui_tick: ['tick_001', 'tick_002'], ui_hover: ['select_001', 'select_002'], ui_click: ['click_001'], ui_medal: ['confirmation_001'], ui_streak: ['confirmation_003'] };
    for (const [k, files] of Object.entries(ui)) for (const f of files) jobs.push(a.load(k, `./assets/audio/ui/${f}.ogg`));
    for (let i = 0; i < 5; i++) {
      jobs.push(a.load('kill_thud', `./assets/audio/impacts/impact_punch_heavy_00${i}.ogg`));
      jobs.push(a.load('expl_crunch', `./assets/audio/explosion/explosionCrunch_00${i}.ogg`));
    }
    for (let i = 0; i < 3; i++) jobs.push(a.load('imp_metal_heavy', `./assets/audio/impacts/impact_metal_heavy_00${i}.ogg`));
    for (let i = 0; i < 2; i++) jobs.push(a.load('expl_low', `./assets/audio/explosion/lowFrequency_explosion_00${i}.ogg`));
    await Promise.all(jobs);
  }

  static freshStats() {
    return { shots: 0, hits: 0, headshots: 0, damage: 0, bestStreak: 0, medals: {}, xp: 0 };
  }

  // ------------------------------------------------------------------ loadout
  buildLoadout() {
    const lo = this.settings.loadout;
    const mk = (id) => {
      const att = { ...(WEAPONS[id].defaults || {}), ...(lo.attachments?.[id] || {}) };
      const w = new Weapon(id, att, this.player);
      this._wireWeapon(w);
      return w;
    };
    this.inventory = [mk(lo.primary), mk(lo.secondary)];
    this.slot = 0;
    this.currentWeapon = this.inventory[0];
    this.viewmodel.setWeapon(this.currentWeapon);
    this.currentWeapon.equip();
  }

  applyLoadoutChange() {
    // Called from gunsmith. Rebuild weapons, keep player alive. FP rigs load on demand (streamed after init).
    const lo = this.settings.loadout;
    const need = [lo.primary, lo.secondary].map((id) => WEAPONS[id]?.model).filter(Boolean);
    if (!this.gunModels.has(need)) {
      const tok = (this._loadoutTok = (this._loadoutTok || 0) + 1);
      this.gunModels.ensure(need).then(() => { if (tok === this._loadoutTok) this.applyLoadoutChange(); });
      return;
    }
    for (const w of this.inventory || []) this.viewmodel.invalidate(w.id);
    this.buildLoadout();
  }

  _wireWeapon(w) {
    const a = this.audio;
    const fam = () => (w.stats.pistol ? 'pistol' : w.stats.pose === 'ak74' ? 'ak' : 'rifle');
    w.on('reloadStart', (type) => {
      if (type === 'shell') return;
      const f = fam();
      const dur = type === 'empty' ? w.stats.emptyReload : w.stats.tacReload;
      a.play(`${f}_magout`, { volume: 0.6, when: dur * 0.18 });
      a.play(`${f}_magin`, { volume: 0.7, when: dur * 0.68 });
      if (type === 'empty') a.play(f === 'pistol' ? 'pistol_slide' : f === 'ak' ? 'ak_rack' : 'rifle_boltdrop', { volume: 0.7, when: dur * 0.86 });
      a.click('cloth', null, 0.5);
      this.alertBots(this.player, 10);
    });
    w.on('shellIn', () => { a.play('shotgun_shell', { volume: 0.6 }); this.viewmodel.shellInsert(); });
    w.on('pump', () => { a.play('shotgun_pump', { volume: 0.7, when: 0.08 }); this._ejectShell(true, 0.18); });
    w.on('bolt', () => { a.play('bolt_back', { volume: 0.6, when: 0.1 }); a.play('bolt_fwd', { volume: 0.6, when: w.stats.boltTime * 0.5 }); this._ejectShell(false, w.stats.boltTime * 0.35); });
    w.on('dry', () => a.play(w.stats.pistol ? 'pistol_dry' : 'rifle_dry', { volume: 0.6 }));
    w.on('modeChange', () => a.play('switch', { volume: 0.5 }));
    w.on('equip', () => a.click('equip', null, 0.5));
    w.on('melee', () => a.click('cloth', null, 0.9));
  }

  _wirePlayerEvents() {
    const p = this.player;
    p.events.onLand = (fall) => {
      this.fpcam.land(fall);
      this.viewmodel.landY.impulse(-fall * 0.05);
      if (fall > 3) this.audio.footstep(null, this.level.surfaceAt(p.position), Math.min(1.2, fall * 0.12));
    };
    p.events.onStep = (surface, vol) => this.audio.footstep(null, surface, vol);
    p.events.onJump = () => this.audio.click('cloth', null, 0.6);
    p.events.onMantle = () => { this.audio.click('cloth', null, 0.9); this.audio.footstep(null, 'concrete', 0.5); };
    p.events.onSlide = () => { this.audio.click('cloth', null, 1); this.fpcam.addTrauma(0.08); };
  }

  // ------------------------------------------------------------------ match
  startMatch(modeKey) {
    // Bots carry any weapon: make sure every FP rig has streamed in (normally done while the menu is up).
    if (!this._rigsReady) {
      return this.gunModels.loadRest().then(() => { this._rigsReady = true; return this.startMatch(modeKey); });
    }
    this.match.start(modeKey);
    this.started = true;
    this.hud.show(true);
  }

  spawnPlayer() {
    const sp = this.match.pickSpawn(this.player);
    this.player.spawn(sp.pos, sp.yaw);
    for (const w of this.inventory) w.refill();
    this.grenades = 2;
    this.slot = 0;
    this.currentWeapon = this.inventory[0];
    this.viewmodel.setWeapon(this.currentWeapon);
    this.currentWeapon.equip();
    this.deathInfo = null;
    this.cook = null;
    this.hud.prompt('');
    this.aimRecoil.reset();
    this.fpcam.dip.x = -1.2; // settle-in on deploy
    this.hud.onSpawn?.();
  }

  addBot(team) {
    const bot = new Bot(this, team, this.settings.botDifficulty);
    bot.model = this.charTemplate.instance(team);
    this.renderer.scene.add(bot.model.root);
    // Patch new bot materials for indoor lighting.
    bot.model.root.traverse((o) => { if (o.isMesh) for (const m of Array.isArray(o.material) ? o.material : [o.material]) this.materials.applyIndoor(m); });
    this.bots.push(bot);
    this.actors.push(bot);
    return bot;
  }

  spawnBot(bot) {
    const sp = this.match.pickSpawn(bot);
    const p = this.nav.closest(sp.pos) ?? sp.pos;
    if (!bot.agent) bot.agent = this.nav.addAgent(p);
    bot.spawn(p, sp.yaw);
    bot.model.attachWeapon(bot);
  }

  alertBots(source, radius) {
    const pos = source.position;
    for (const b of this.bots) {
      if (b === source || !b.alive) continue;
      if (b.position.distanceTo(pos) < radius) b.hear(source, pos);
    }
  }

  // ------------------------------------------------------------------ combat hooks
  onBulletImpact(point, normal, surface, dir, bullet, exit = false) {
    this.effects.impact(point, normal, surface, dir);
    const d = point.distanceTo(this.player.position);
    if (d < 40 && !exit) {
      const key = 'imp_' + (surface === 'plaster' || surface === 'brick' ? 'concrete' : surface === 'fabric' ? 'dirt' : surface);
      if (this.audio.has(key)) this.audio.play(key, { pos: point, volume: 0.45, ref: 2, rolloff: 1.5 });
      else this.audio.impact(point, surface);
    }
  }

  onActorHit(actor, dmg, attacker, info) {
    if (!actor.alive) return;
    if (this.mode.teams && attacker && actor !== attacker && attacker.team === actor.team && !this.mode.friendlyFire) return;
    const dealt = actor.takeDamage(dmg, attacker, info);
    if (attacker === this.player && dealt > 0 && actor !== this.player) {
      const kill = !actor.alive;
      const ms = this.matchStats;
      // One confirm per frame (shotgun pellets would otherwise machine-gun the hit sound).
      const sameFrame = this._lastHitFrame === this.frame;
      this._lastHitFrame = this.frame;
      if (!sameFrame && info.type !== 'grenade' && info.type !== 'melee') ms.hits++;
      if (info.headshot) ms.headshots += sameFrame ? 0 : 1;
      ms.damage += dealt;
      this.hud.hitmarker(kill ? 'kill' : info.headshot ? 'head' : 'hit');
      if (kill) {
        this.audio.ui(info.headshot ? 'headkill' : 'kill');
        // Kill punch: tiny upward camera nudge + shake, enough to feel it without losing aim.
        this.fpcam.addKick(-0.006, 0, (Math.random() - 0.5) * 0.012);
        this.fpcam.addTrauma(0.07);
      } else if (!sameFrame) this.audio.ui(info.headshot ? 'headshot' : 'hit');
    }
    if (this.audio.has('imp_flesh') && info.point && info.point.distanceTo(this.player.position) < 30) this.audio.play('imp_flesh', { pos: info.point, volume: 0.35 });
    // Blood decal on wall behind.
    if (info.point && info.dir && Math.random() < 0.5) {
      const hit = this.physics.raycast(info.point, info.dir, 3, G.WORLD);
      if (hit) this.effects.decals.blood.add(hit.point, hit.normal);
    }
  }

  onPlayerDamaged(amount, attacker, info) {
    this.renderer.setDamage(Math.min(1, amount / 40));
    this.fpcam.addTrauma(Math.min(0.35, amount / 100));
    // Flinch: pushes view away from the hit direction a little (aim punch).
    this.fpcam.addKick(rand(0.01, 0.03), rand(-0.02, 0.02), rand(-0.03, 0.03));
    const src = info.origin || attacker?.position;
    if (src && attacker !== this.player) this.hud.damageFrom(src, amount);
    this.audio.ui('hurt');
  }

  onSuppressed(amt) {
    this.fpcam.addTrauma(0.05 * amt);
    this.renderer.setDamage(0.05 * amt);
  }

  onActorKilled(victim, killer, info) {
    this.match.onKill(victim, killer, info);
    if (victim === this.player) {
      this.deathInfo = {
        killer, weapon: info.weapon ? (WEAPONS[info.weapon]?.name ?? info.weapon) : info.type === 'grenade' ? 'Frag Grenade' : info.type === 'fall' ? 'Fall damage' : 'Melee',
        headshot: info.headshot, distance: info.distance ?? (killer ? killer.position.distanceTo(victim.position) : 0),
        killerHp: killer && killer !== victim ? Math.max(1, Math.ceil(killer.health)) : 0,
      };
      // Quick respawn: deploy allowed after RESPAWN_MIN, automatic at RESPAWN_AUTO.
      this.respawnTimer = Game.RESPAWN_MIN;
      // Dying with a cooked frag drops it.
      if (this.cook != null) {
        this.grenades--;
        this.throwGrenade(victim, victim.position.clone().setY(victim.position.y + 1), null, Math.max(0.05, Game.FUSE - this.cook));
        this.grenadeObjs[this.grenadeObjs.length - 1].vel.set(0, 1, 0);
        this.cook = null;
        this.hud.prompt('');
      }
      this.deathTime = this.time;
      this.player.velocity.set(0, 0, 0);
      this.audio.ui('hurt');
    }
  }

  // ------------------------------------------------------------------ grenades
  throwGrenade(owner, from, to, fuse = 3.2) {
    const dir = to ? to.clone().sub(from) : null;
    let vel;
    if (owner === this.player) {
      const f = new THREE.Vector3(0, 0, -1).applyQuaternion(this.renderer.camera.quaternion);
      vel = f.multiplyScalar(17).add(new THREE.Vector3(0, 3.5, 0)).add(this.player.velocity.clone().multiplyScalar(0.6));
    } else {
      // Ballistic arc to target (45° launch, solve speed).
      const flat = Math.hypot(dir.x, dir.z);
      const g = 9.81, ang = 40 * DEG;
      const v = Math.sqrt((g * flat * flat) / (2 * Math.cos(ang) ** 2 * Math.max(0.5, flat * Math.tan(ang) - dir.y)));
      const h = new THREE.Vector3(dir.x, 0, dir.z).normalize();
      vel = h.multiplyScalar(Math.cos(ang) * Math.min(v, 22)).add(new THREE.Vector3(0, Math.sin(ang) * Math.min(v, 22), 0));
    }
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 8), new THREE.MeshStandardMaterial({ color: 0x3a4430, roughness: 0.6, metalness: 0.3 }));
    mesh.scale.set(1, 1.3, 1);
    mesh.castShadow = true;
    mesh.position.copy(from);
    this.renderer.scene.add(mesh);
    this.grenadeObjs.push({ mesh, vel, owner, fuse, bounces: 0 });
    this.audio.click('cloth', owner === this.player ? null : from, 0.8);
    owner.model?.playUpper?.('throw');
  }

  _updateGrenades(dt) {
    for (let i = this.grenadeObjs.length - 1; i >= 0; i--) {
      const g = this.grenadeObjs[i];
      g.fuse -= dt;
      g.vel.y -= 9.81 * dt;
      const step = g.vel.clone().multiplyScalar(dt);
      const len = step.length();
      if (len > 1e-5) {
        const hit = this.physics.raycast(g.mesh.position, step.clone().divideScalar(len), len + 0.05, G.WORLD);
        if (hit) {
          g.mesh.position.copy(hit.point).addScaledVector(hit.normal, 0.06);
          const vn = hit.normal.clone().multiplyScalar(g.vel.dot(hit.normal));
          g.vel.sub(vn).multiplyScalar(0.6).addScaledVector(vn, -0.35);
          if (g.bounces++ < 4 && vn.length() > 1) this.audio.impact(hit.point, 'metal');
        } else g.mesh.position.add(step);
      }
      g.mesh.rotation.x += dt * 8; g.mesh.rotation.z += dt * 5;
      if (g.fuse <= 0) {
        this.explode(g.mesh.position.clone(), g.owner);
        this.renderer.scene.remove(g.mesh);
        this.grenadeObjs.splice(i, 1);
      }
    }
  }

  explode(pos, owner) {
    this.effects.explosion(pos);
    this.audio.explosion(pos);
    const pd = pos.distanceTo(this.player.position);
    const near = clamp(1 - pd / 25, 0, 1);
    this.fpcam.addTrauma(near * 0.9);
    this.fpcam.dip.impulse(-near * 2.5);
    if (this.player.alive) {
      this.audio.concussion(clamp(1 - pd / 14, 0, 1));
      if (pd < 10) this.hud.flash(clamp(1 - pd / 10, 0, 1) * 0.55);
    }
    for (const a of this.actors) {
      if (!a.alive) continue;
      const c = a.center;
      const d = c.distanceTo(pos);
      if (d > 8) continue;
      if (!this.physics.lineOfSight(pos.clone().setY(pos.y + 0.3), c)) continue;
      const dmg = d < 3.5 ? 150 : 150 * (1 - (d - 3.5) / 4.5);
      if (this.mode.teams && owner && a !== owner && a.team === owner.team) continue;
      this.onActorHit(a, Math.round(dmg), owner, { type: 'grenade', point: c, origin: pos.clone(), dir: c.clone().sub(pos).normalize(), weapon: null, distance: owner ? owner.position.distanceTo(a.position) : 0 });
    }
    this.alertBots({ position: pos }, 50);
  }

  // ------------------------------------------------------------------ player weapon
  _ejectShell(big = false, delay = 0) {
    const vm = this.viewmodel;
    if (!vm.rig) return;
    const go = () => {
      const p = vm.worldPoint(vm.rig.eject);
      if (!p) return;
      const cam = this.renderer.camera;
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
      const v = right.multiplyScalar(rand(2.2, 3.4)).addScaledVector(up, rand(1.2, 2.2)).add(this.player.velocity);
      this.effects.shells.spawn(p, v, big);
    };
    if (delay > 0) setTimeout(go, delay * 1000); else go();
  }

  _playerFire(shot) {
    const w = this.currentWeapon, s = w.stats, p = this.player;
    this.matchStats.shots++;
    const cam = this.renderer.camera;
    const origin = cam.position.clone();
    // Bullets follow the true aim (player yaw/pitch), never the visual layers on the camera (kick spring,
    // shake, head-bob curves): the punch is felt, not a hidden aim offset.
    const cp = Math.cos(p.pitch);
    const fwd = new THREE.Vector3(-Math.sin(p.yaw) * cp, Math.sin(p.pitch), -Math.cos(p.yaw) * cp);
    const moveF = Math.hypot(p.velocity.x, p.velocity.z) / 4.6;
    const spread = shot.spread ?? w.currentSpread(moveF, !p.grounded, p.crouching);
    const muzzleW = this.viewmodel.worldPoint(this.viewmodel.rig.muzzle) || origin;
    for (let i = 0; i < shot.pellets; i++) {
      const d = applySpread(fwd, shot.pellets > 1 ? s.pelletSpread * (1 - w.adsT * 0.25) : spread);
      this.ballistics.fire(p, origin, d, s, { tracer: shot.pellets > 1 ? i < 2 : (w.shotIndex % 3 === 1), pellet: shot.pellets > 1, tracerFrom: muzzleW });
    }
    // True recoil: eased into the aim by AimRecoil (stance/ADS/attachments already applied in Weapon._fire).
    this.aimRecoil.add(shot.pitch, shot.yaw);
    // Visual camera punch on top (springs back; does not move where bullets go). Follows the shot's direction.
    const kickScale = s.kick * (1 - w.adsT * 0.4);
    const side = clamp(shot.yaw / Math.max(1e-4, Math.abs(shot.pitch) + Math.abs(shot.yaw)), -1, 1);
    this.fpcam.addKick(0.04 * kickScale, (side * 0.6 + (Math.random() - 0.5) * 0.6) * 0.012 * kickScale, (Math.random() - 0.5) * 0.04 * kickScale);
    this.fpcam.addTrauma(s.pellets > 1 || s.cls.includes('Sniper') || s.cls.includes('Marksman') ? 0.22 : 0.035);
    this.viewmodel.onFire(shot);
    // Audio: sampled shot (near) with pitch variance; procedural low layer for punch.
    const key = s.sample + '_near';
    if (this.audio.has(key)) {
      const sup = s.suppressed;
      this.audio.play(key, { volume: sup ? 0.32 : 0.95, pitch: (s.samplePitch ?? 1) * (sup ? 1.12 : 1), pitchVar: 0.04, reverb: sup ? 0.12 : 0.4 });
      if (sup) this.audio.gunshot({ ...s.sound, volume: 0.6 }, null);
      else this.audio.gunshot({ ...s.sound, volume: 0.35, mech: 0.6 }, null);
    } else this.audio.gunshot(s.sound, null);
    // World muzzle light (lights up the surroundings).
    if (!s.suppressed) this.effects.flashLight(muzzleW.clone().addScaledVector(fwd, 0.3), 18, 0.05);
    if (!s.tube && !(s.modes[0] === 'bolt')) this._ejectShell(false, 0.012);
    p.lastFiredTime = this.time;
    this.player.lastFiredTime = this.time;
    this.alertBots(p, s.suppressed ? 18 : 80);
    // Muzzle smoke after sustained fire.
    if (w.shotIndex > 6 && Math.random() < 0.3) this.effects.smoke.spawn({ x: muzzleW.x, y: muzzleW.y, z: muzzleW.z, vy: 0.4, life: 1.5, size0: 0.05, size1: 0.35, alpha: 0.1, drag: 2, color: [0.9, 0.9, 0.9] });
  }

  _meleeHit() {
    const p = this.player, cam = this.renderer.camera;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    for (const b of this.bots) {
      if (!b.alive || (this.mode.teams && b.team === p.team)) continue;
      const to = b.center.sub(cam.position);
      const d = to.length();
      if (d > 2.2) continue;
      if (to.normalize().dot(fwd) < 0.7) continue;
      // Backstab if behind the bot.
      const bf = new THREE.Vector3(-Math.sin(b.yaw), 0, -Math.cos(b.yaw));
      const back = bf.dot(new THREE.Vector3(fwd.x, 0, fwd.z).normalize()) > 0.5;
      this.onActorHit(b, back ? 100 : 55, p, { type: 'melee', point: b.center, dir: fwd, weapon: null, distance: d });
      this.audio.play('imp_flesh', { volume: 0.9 });
      this.fpcam.addTrauma(0.15);
      return;
    }
    const hit = this.physics.raycast(cam.position, fwd, 2, G.WORLD);
    if (hit) { this.effects.impact(hit.point, hit.normal, hit.data.surface || 'concrete', fwd); this.audio.impact(hit.point, hit.data.surface); this.fpcam.addTrauma(0.1); }
  }

  switchSlot(i) {
    if (i === this.slot || !this.inventory[i] || !this.player.alive || this.viewmodel.holstering) return;
    this.currentWeapon.cancelReload();
    if (this.currentWeapon.state === 'reload') this.currentWeapon._setState('idle');
    // Holster (lower-out) first, then swap; the new weapon's equip plays the draw.
    this.currentWeapon._setState('equip', 1); // no firing / ADS while lowering
    this.viewmodel.holster(() => {
      this.slot = i;
      this.currentWeapon = this.inventory[i];
      this.viewmodel.setWeapon(this.currentWeapon);
      this.currentWeapon.equip();
    });
  }

  // ------------------------------------------------------------------ main loop
  update(dt) {
    if (!(dt > 0)) dt = 0; // never step backwards (slow first frame / clock skew)
    const inp = this.input, p = this.player, s = this.settings;
    this.time += dt;
    this.frame++;
    const live = !this.paused && this.started;
    const m = inp.consumeMouse();

    if (live) {
      this.match.update(dt);
      const w = this.currentWeapon;
      if (p.alive) {
        // Look with ADS-relative sensitivity (zoom-normalised).
        const zoomK = w.adsT > 0 ? Math.tan((this.renderer.camera.fov * DEG) / 2) / Math.tan((this.fpcam.vfov(s.fov, this.renderer.camera.aspect) * DEG) / 2) : 1;
        const sens = s.sensitivity * (1 + (zoomK * s.adsSensMult - 1) * w.adsT);
        const pitchBefore = p.pitch, yawBefore = p.yaw;
        p.look(m.x, s.invertY ? -m.y : m.y, sens);
        // Player pulling against recoil reduces the part that would settle back by itself.
        this.aimRecoil.look(p.pitch - pitchBefore, p.yaw - yawBefore);

        // Sniper scope sway + hold breath.
        if (w.stats.overlay && w.adsT > 0.8) {
          const holding = inp.is('sprint');
          if (holding && this.breath > 0) this.breath = Math.max(0, this.breath - dt / 5);
          else this.breath = Math.min(1, this.breath + dt / 4);
          const amp = (holding && this.breath > 0 ? 0.08 : 1) * 0.22 * DEG * (w.stats.sway ?? 1) * (p.crouching ? 0.6 : 1);
          p.yaw += Math.cos(this.time * 0.9) * amp * dt * 2.2;
          p.pitch += Math.sin(this.time * 1.7) * amp * dt * 2.2;
        }

        // Movement command.
        const cmd = {
          moveX: (inp.is('right') ? 1 : 0) - (inp.is('left') ? 1 : 0),
          moveY: (inp.is('forward') ? 1 : 0) - (inp.is('back') ? 1 : 0),
          sprint: inp.is('sprint') && !(w.stats.overlay && w.adsT > 0.5),
          sprintPressed: inp.justPressed('sprint'),
          crouchPressed: inp.justPressed('crouch'),
          crouchHeld: inp.is('crouch'),
          jumpPressed: inp.justPressed('jump'),
          jumpHeld: inp.is('jump'),
          aim: s.toggleAds ? this._adsToggle : inp.is('aim'),
          walk: inp.down.has('AltLeft'),
          leanLeft: inp.is('leanLeft'),
          leanRight: inp.is('leanRight'),
        };
        if (s.toggleAds && inp.justPressed('aim')) this._adsToggle = !this._adsToggle;
        if (s.holdCrouch && inp.justReleased('crouch') && p.crouching && !p.sliding && p.canStand()) p.crouching = false;
        p.update(dt, cmd, w);
        p.regen(dt);
        if (p.health < 35) {
          this._hb = (this._hb ?? 0) - dt;
          if (this._hb <= 0) { this.audio.heartbeat(1 - p.health / 50); this._hb = 0.55 + p.health / 70; }
        }

        // Weapon actions.
        if (inp.justPressed('slot1')) this.switchSlot(0);
        if (inp.justPressed('slot2')) this.switchSlot(1);
        if (m.wheel) this.switchSlot((this.slot + (m.wheel > 0 ? 1 : 1)) % 2);
        if (inp.justPressed('fireMode')) w.cycleMode();
        if (inp.justPressed('inspect')) w.inspect();
        if (inp.justPressed('laser') && w.stats.beam) { w.laserOn = !w.laserOn; this.audio.play('switch', { volume: 0.4 }); }
        if (inp.justPressed('melee') && w.melee()) setTimeout(() => this._meleeHit(), 160);
        // Frag: press pulls the pin, holding cooks it, release throws (fuse keeps counting).
        if (inp.justPressed('grenade') && this.grenades > 0 && w.state !== 'melee' && this.cook == null) {
          this.cook = 0;
          this.audio.play('switch', { volume: 0.45, pitch: 1.4 });
        }
        if (this.cook != null) {
          this.cook += dt;
          const left = Game.FUSE - this.cook;
          if (!inp.is('grenade') || left <= 0.05) {
            this.grenades--;
            this.throwGrenade(p, this.renderer.camera.position.clone().add(new THREE.Vector3(0, -0.1, 0)), null, Math.max(0.05, left));
            this.cook = null;
            this.hud.prompt('');
          } else if (this.cook > 0.18) {
            this.hud.prompt(`<span class="cook ${left < 1.2 ? 'hot' : ''}"><i style="--p:${((left / Game.FUSE) * 100).toFixed(0)}%"></i>COOKING ${left.toFixed(1)}s</span>`);
          }
        }
        if (inp.down.has('Mouse1') && inp.pressed.has('Mouse1') && w.stats.variable) w.toggleZoom();
        const winput = {
          fire: inp.is('fire'), firePressed: inp.justPressed('fire'), aim: cmd.aim && !p.mantle,
          sprinting: p.sprinting || !!p.mantle, reloadPressed: inp.justPressed('reload'), mantling: !!p.mantle,
          canFire: !p.mantle && p.spawnProtect <= 1.3,
          crouched: p.crouching && !p.sliding, moveF: Math.hypot(p.velocity.x, p.velocity.z) / 4.6, airborne: !p.grounded,
        };
        if (winput.firePressed && p.spawnProtect > 0) p.spawnProtect = 0; // firing cancels spawn protection
        const shots = w.update(dt, winput);
        for (const shot of shots) this._playerFire(shot);
        // Recoil: ease kicks into the aim; after the string ends only part of the climb settles back.
        const rec = this.aimRecoil.update(dt, w);
        p.pitch = clamp(p.pitch + rec.dp, -89 * DEG, 89 * DEG);
        p.yaw += rec.dy;
        // Inactive weapon still ticks (for equip timers).
        this.currentSpread = w.currentSpread(Math.hypot(p.velocity.x, p.velocity.z) / 4.6, !p.grounded, p.crouching);
      } else {
        this.respawnTimer -= dt;
        if (this.respawnTimer <= 0 && (inp.justPressed('jump') || inp.justPressed('fire') || this.respawnTimer < -(Game.RESPAWN_AUTO - Game.RESPAWN_MIN))) this.spawnPlayer();
        // Death cam: look at killer.
        if (this.deathInfo?.killer && this.deathInfo.killer.alive) {
          const k = this.deathInfo.killer.head;
          const d = k.sub(this.renderer.camera.position);
          const ty = Math.atan2(-d.x, -d.z), tp = Math.atan2(d.y, Math.hypot(d.x, d.z));
          p.yaw += (((ty - p.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * Math.min(1, dt * 3);
          p.pitch += (tp - p.pitch) * Math.min(1, dt * 3);
        }
        p.eyeHeight.target = 0.35; p.eyeHeight.update(dt);
      }
      if (inp.justPressed('scoreboard')) this.hud.scoreboard(true);
      if (inp.justReleased('scoreboard')) this.hud.scoreboard(false);

      // Bots & world simulation.
      for (const b of this.bots) b.update(dt);
      this.nav.update(dt);
      this.ballistics.update(dt);
      this._updateGrenades(dt);
      this.uavTime = Math.max(0, this.uavTime - dt);
    }
    this.physics.step(dt);

    // Camera + viewmodel.
    this.fpcam.update(dt, p, this.currentWeapon);
    this.renderer.camera.updateMatrixWorld();
    this.viewmodel.update(dt, { weapon: this.currentWeapon, player: p, mouse: m, fpcam: this.fpcam });
    this.viewmodel.holder.visible = p.alive && this.started;
    this.audio.updateListener(this.renderer.camera);
    this.effects.update(dt, this.renderer.camera);
    this.ambience?.update(dt);
    this.botOcclusion.update(); // perf: hide fully wall-occluded bots (shadow proxies keep casting)
    this.lightPool?.update(dt);
    if (this.started) this.hud.update(live ? dt : 0); // HUD timers freeze while paused
    // Muffle on low health (visual + audio).
    const lowHealth = p.alive ? clamp(1 - p.health / 40, 0, 1) : 0.6;
    this.audio.setMuffle(live || !this.started ? lowHealth * 0.55 : 0.75, dt);
    // QA harness hook: skip GPU work on frames that are only advancing the simulation.
    if (!window.__qaSkipRender) this.renderer.render(dt, lowHealth);
    inp.endFrame();
  }
}
