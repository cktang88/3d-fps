import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GroundedSkybox } from 'three/addons/objects/GroundedSkybox.js';
import { worldBox, worldUV } from './Geo.js';
import { DEG } from '../core/MathUtil.js';
import { Materials } from './Materials.js';
import { orientHDR, clampedHDR, installAtmosphere, buildLightShafts, buildDust } from './LevelEnv.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0);

// Deterministic PRNG so the layout (and screenshots) are stable between runs.
let _seed = 20240611;
const rnd = () => ((_seed = (_seed * 16807) % 2147483647) / 2147483647);
const rand = (a, b) => a + rnd() * (b - a);

/** HDRI used for sky + IBL (Poly Haven, CC0). Game.js loads it and passes it to setupEnvironment. */
export const LEVEL_HDRI = 'hdr/bambanani_sunset_2k.hdr';

/**
 * Prop catalogue (Poly Haven CC0, optimised to .glb w/ webp textures). Each prop becomes one InstancedMesh per
 * material part, so ~40 draw calls cover hundreds of placed props. `pick` keeps only nodes whose name matches.
 */
const PROPS = {
  crate: ['old_military_crate/old_military_crate.glb'],
  barrier: ['concrete_road_barrier/concrete_road_barrier.glb'],
  barrier2: ['concrete_road_barrier_02/concrete_road_barrier_02.glb'],
  barrel1: ['Barrel_01/Barrel_01.glb'],
  barrel2: ['Barrel_02/Barrel_02.glb'],
  barrel3: ['barrel_03/barrel_03.glb'],
  ammo: ['ammo_box/ammo_box.glb'],
  cardboard: ['cardboard_box_01/cardboard_box_01.glb'],
  tyre: ['old_tyre/old_tyre.glb'],
  aircon: ['exterior_aircon_unit/exterior_aircon_unit.glb', { pick: /rusted/, recenter: true }],
  aircon2: ['exterior_aircon_unit/exterior_aircon_unit.glb', { pick: /^exterior_aircon_unit$/, recenter: true }],
  streetlamp: ['street_lamp_01/street_lamp_01.glb', { emissive: /glass/, emissiveColor: 0xffb46e, emissiveIntensity: 7 }],
  wallLamp: ['security_light/security_light.glb', { emissive: /glass/, emissiveColor: 0xffc58c, emissiveIntensity: 9 }],
  utilityBox: ['utility_box_01/utility_box_01.glb'],
  utilityBox2: ['utility_box_02/utility_box_02.glb'],
  trashCan: ['metal_trash_can/metal_trash_can.glb', { pick: /rust/, recenter: true }],
  manhole: ['water_manhole_cover/water_manhole_cover.glb'],
  car: ['covered_car/covered_car.glb'],
  trashbag: ['trashbag/trashbag.glb'],
  jerrycan: ['metal_jerrycan_green/metal_jerrycan_green.glb'],
  propane: ['propane_tank/propane_tank.glb'],
  generator: ['portable_generator/portable_generator.glb'],
  hangLamp: ['hanging_industrial_lamp/hanging_industrial_lamp.glb', { emissive: /glass/, emissiveColor: 0xffa858, emissiveIntensity: 6 }],
  fluoro: ['mounted_fluorescent_lights/mounted_fluorescent_lights.glb', { emissive: /glass/, emissiveColor: 0xe6f2ff, emissiveIntensity: 2.5 }],
  pipes: ['modular_industrial_pipes_01/modular_industrial_pipes_01.glb'],
  woodCrate: ['wooden_crate_02/wooden_crate_02.glb'],
  cementBag: ['cement_bag/cement_bag.glb'],
  wheelRim: ['rusted_wheel_rim_01/rusted_wheel_rim_01.glb'],
  wetSign: ['WetFloorSign_01/WetFloorSign_01.glb'],
  stove: ['barrel_stove/barrel_stove.glb'],
  crane: ['overhead_crane/overhead_crane.glb', { recenter: true }],
};

/**
 * "Ironline Depot" — an abandoned industrial compound (~116 x 116 m playable) at the edge of a war zone,
 * just after a storm, golden hour.
 * North: corrugated warehouse w/ catwalk + racks. South: two-storey brick office.
 * East: container yard. West: ruined houses + guard tower. Centre: courtyard w/ barriers & sandbags.
 * All static boxes are batched per material into merged meshes; props are instanced; each solid gets a box
 * collider tagged with its surface type (footsteps, impacts, penetration).
 */
export class Level {
  constructor(game, materials) {
    this.game = game;
    this.mats = materials;
    this.name = 'Ironline Depot';
    this.group = new THREE.Group();
    this.batches = new Map(); // material -> { geos: [{g, cast}] }
    this.navGeos = [];
    this.minimapShapes = [];
    this.spawns = { 0: [], 1: [], ffa: [] };
    this.patrolPoints = [];
    this.dynamicProps = [];
    this.interiorLights = [];
    this.propInst = {};
    this.shaftOpenings = [];
    this.flicker = [];
    this.bounds = 58;
    _seed = 20240611;
  }

  // ---------------------------------------------------------------- primitives
  _push(m, g, cast = true) {
    if (!this.batches.has(m)) this.batches.set(m, { geos: [] });
    this.batches.get(m).geos.push({ g, cast });
  }

  /** Axis-aligned (optionally Y-rotated) box. center = box centre. */
  box(mat, cx, cy, cz, w, h, d, opt = {}) {
    const m = typeof mat === 'string' ? this.mats.get(mat) : mat;
    const uv = opt.uv ?? 2;
    const g = worldBox(w, h, d, uv, { offset: { x: cx, y: cy, z: cz } });
    const rot = opt.rot ?? 0;
    const mtx = new THREE.Matrix4().makeRotationY(rot).setPosition(cx, cy, cz);
    g.applyMatrix4(mtx);
    this._push(m, g, opt.cast !== false);
    if (opt.collide !== false) {
      const q = new THREE.Quaternion().setFromAxisAngle(UP, rot);
      this.game.physics.addStaticBox(V(cx, cy, cz), V(w / 2, h / 2, d / 2), q, { surface: opt.surface ?? this.mats.surface(m) });
    }
    if (opt.nav !== false) this.navGeos.push(g);
    if (opt.map !== false && h > 0.9 && cy + h / 2 > 0.9 && w * d > 0.3 && cy - h / 2 < 3) {
      this.minimapShapes.push({ x: cx, z: cz, w, d, rot, fill: opt.mapFill ?? (h > 2.2 ? 'rgba(210,215,220,0.55)' : 'rgba(210,215,220,0.28)') });
    }
    return g;
  }

  /** Arbitrary (visual-only) geometry into the material batch. */
  mesh(mat, g, opt = {}) {
    const m = typeof mat === 'string' ? this.mats.get(mat) : mat;
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    if (opt.worldUV) worldUV(g, opt.worldUV);
    this._push(m, g, opt.cast !== false);
    return g;
  }

  /** Box-section member between two points (visual; optional collider for axis-aligned use). */
  beam(mat, a, b, w, h, opt = {}) {
    const dir = b.clone().sub(a); const len = dir.length(); dir.normalize();
    const g = new THREE.BoxGeometry(w, h, len);
    const ref = Math.abs(dir.y) > 0.95 ? V(1, 0, 0) : UP;
    const x = new THREE.Vector3().crossVectors(ref, dir).normalize();
    const y = new THREE.Vector3().crossVectors(dir, x);
    const m4 = new THREE.Matrix4().makeBasis(x, y, dir).setPosition(a.clone().add(b).multiplyScalar(0.5));
    g.applyMatrix4(m4);
    return this.mesh(mat, g, { worldUV: opt.uv ?? 1, cast: opt.cast });
  }

  /** Cylinder between two points with length-correct UVs. */
  cyl(mat, a, b, r, seg = 10, opt = {}) {
    const dir = b.clone().sub(a); const len = dir.length();
    const g = new THREE.CylinderGeometry(opt.r2 ?? r, r, len, seg, 1, opt.open ?? false);
    const uv = g.attributes.uv, uvs = opt.uv ?? 1;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (2 * Math.PI * r) / uvs, uv.getY(i) * len / uvs);
    const q = new THREE.Quaternion().setFromUnitVectors(UP, dir.normalize());
    g.applyMatrix4(new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, V(1, 1, 1)));
    return this.mesh(mat, g, { cast: opt.cast });
  }

  /** Catenary wire between two points (thin tube). */
  wire(a, b, sag = 0.6, r = 0.016) {
    const pts = [];
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      pts.push(a.clone().lerp(b, t).add(V(0, -sag * 4 * t * (1 - t), 0)));
    }
    const g = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), sag > 0.2 ? 10 : 2, r, 3, false);
    return this.mesh('cable', g, { cast: true });
  }

  /** Flat decal quad (uv 0..1) facing `normal`, centre p, size w x h, rotated `spin` around the normal. */
  decal(mat, p, normal, w, h, spin = 0) {
    const g = new THREE.PlaneGeometry(w, h);
    const q = new THREE.Quaternion().setFromUnitVectors(V(0, 0, 1), normal.clone().normalize());
    const qs = new THREE.Quaternion().setFromAxisAngle(V(0, 0, 1), spin);
    g.applyMatrix4(new THREE.Matrix4().compose(p, q.multiply(qs), V(1, 1, 1)));
    return this.mesh(mat, g, { cast: false });
  }

  /** Soft contact shadow / dirt blob under an object (grounding). */
  blob(x, z, w, d, rot = 0, y = 0.012, strength = 1) {
    const g = new THREE.PlaneGeometry(w, d);
    g.rotateX(-Math.PI / 2);
    g.rotateY(rot);
    g.translate(x, y, z);
    this.mesh(strength >= 1 ? 'blob' : 'blobSoft', g, { cast: false });
  }

  /** Worn road paint strip from (xa,z) to (xb,z) along X. */
  roadPaint(xa, xb, z, width) {
    const g = new THREE.PlaneGeometry(xb - xa, width);
    g.rotateX(-Math.PI / 2);
    g.translate((xa + xb) / 2, 0.023, z);
    this.mesh('paint', g, { cast: false, worldUV: 2.5 });
  }

  /** Wall from (x1,z1) to (x2,z2) with rectangular openings [{at, w, y0, y1}] measured along the wall. */
  wall(mat, x1, z1, x2, z2, y0, height, thick, holes = [], opt = {}) {
    const dx = x2 - x1, dz = z2 - z1;
    const len = Math.hypot(dx, dz);
    const rot = -Math.atan2(dz, dx);
    const dir = V(dx / len, 0, dz / len);
    const nrm = V(-dz / len, 0, dx / len);
    const segs = [];
    const hs = [...holes].sort((a, b) => a.at - b.at);
    let cursor = 0;
    for (const hl of hs) {
      const a = hl.at - hl.w / 2, b = hl.at + hl.w / 2;
      if (a > cursor) segs.push([cursor, a, y0, y0 + height]);
      if (hl.y0 > y0) segs.push([a, b, y0, hl.y0]);
      if (hl.y1 < y0 + height) segs.push([a, b, hl.y1, y0 + height]);
      cursor = b;
    }
    if (cursor < len) segs.push([cursor, len, y0, y0 + height]);
    for (const [a, b, ya, yb] of opt.noWall ? [] : segs) {
      if (b - a < 0.01 || yb - ya < 0.01) continue;
      const mid = (a + b) / 2;
      const cx = x1 + dir.x * mid, cz = z1 + dir.z * mid;
      this.box(mat, cx, (ya + yb) / 2, cz, b - a, yb - ya, thick, { ...opt, rot, map: opt.map ?? (yb - ya > 1.5 || ya < 1) });
    }
    const at = (s, off = 0) => V(x1 + dir.x * s + nrm.x * off, 0, z1 + dir.z * s + nrm.z * off);
    if (opt.wainscot) {
      // Painted lower band + skirting, slightly proud of both faces (institutional interior finish).
      const wh = hs.filter((h) => h.y0 <= y0 + 0.05).map((h) => ({ ...h, y1: y0 + 2 }));
      const o2 = { collide: false, nav: false, map: false, uv: 1.5 };
      this.wall(opt.wainscot, x1, z1, x2, z2, y0, 1.05, thick + 0.016, wh, o2);
      this.wall('woodDark', x1, z1, x2, z2, y0, 0.1, thick + 0.03, wh, { ...o2, uv: 1 });
      this.wall('woodDark', x1, z1, x2, z2, y0 + 1.05, 0.03, thick + 0.03, wh, { ...o2, uv: 1 });
    }
    for (const hl of hs) {
      const c = at(hl.at);
      const isWin = hl.y0 > y0 + 0.1;
      // Lintel / sill trim.
      if (opt.trim) {
        if (isWin) this.box(opt.trim, c.x, hl.y0 - 0.04, c.z, hl.w + 0.2, 0.08, thick + 0.12, { rot, map: false, nav: false, collide: false });
        if (hl.y1 < y0 + height - 0.05) this.box(opt.trim, c.x, hl.y1 + 0.06, c.z, hl.w + 0.2, 0.12, thick + 0.06, { rot, map: false, nav: false, collide: false });
      }
      // Window frames + glass (full, broken, or none).
      if (isWin && opt.glass) {
        const fm = opt.frame ?? 'metalDark', fw = 0.06, fd = Math.min(0.12, thick * 0.6);
        const ym = (hl.y0 + hl.y1) / 2, hh = hl.y1 - hl.y0;
        const o = { rot, map: false, nav: false, collide: false, uv: 1 };
        for (const s of [-1, 1]) { const p = at(hl.at + s * (hl.w / 2 - fw / 2)); this.box(fm, p.x, ym, p.z, fw, hh, fd, o); }
        this.box(fm, c.x, hl.y1 - fw / 2, c.z, hl.w - 2 * fw, fw, fd, o);
        this.box(fm, c.x, hl.y0 + fw / 2, c.z, hl.w - 2 * fw, fw, fd, o);
        const mode = typeof opt.glass === 'function' ? opt.glass(hl) : opt.glass;
        if (mode === 'full' && hl.w > 2) { // mullions on wide industrial windows
          for (const f of [-1 / 6, 1 / 6, 0.5]) { const p = at(hl.at + f * hl.w * (f === 0.5 ? 0 : 1)); if (f !== 0.5) this.box(fm, p.x, ym, p.z, 0.04, hh, fd * 0.8, o); }
          this.box(fm, c.x, ym, c.z, hl.w - 2 * fw, 0.04, fd * 0.8, o);
        }
        if (mode === 'full') this.box('glass', c.x, ym, c.z, hl.w - 2 * fw, hh - 2 * fw, 0.012, { ...o, cast: false });
        else if (mode === 'broken') this.shards(c, dir, nrm, hl.w - 2 * fw, hh - 2 * fw, ym);
        if (opt.shaft && mode === 'full') this.shaftOpenings.push({ center: V(c.x, ym, c.z), w: hl.w - 0.2, h: hh - 0.2, normal: nrm.clone().multiplyScalar(opt.shaft) });
      }
      // Door casing (architrave) on both faces.
      if (!isWin && opt.doorFrame) {
        const fm = opt.doorFrame, cw = 0.1, ct = 0.035;
        for (const side of [-1, 1]) {
          const off = side * (thick / 2 + ct / 2);
          for (const s of [-1, 1]) { const p = at(hl.at + s * (hl.w / 2 + cw / 2), off); this.box(fm, p.x, (y0 + hl.y1 + cw) / 2, p.z, cw, hl.y1 - y0 + cw, ct, { rot, map: false, nav: false, collide: false, uv: 1 }); }
          const p = at(hl.at, off); this.box(fm, p.x, hl.y1 + cw / 2, p.z, hl.w + 2 * cw, cw, ct, { rot, map: false, nav: false, collide: false, uv: 1 });
        }
      }
    }
  }

  /** Broken-window glass: jagged shards hanging from the frame edges. */
  shards(c, dir, nrm, w, h, ym) {
    const pos = [];
    const P = (s, y) => [c.x + dir.x * s, y, c.z + dir.z * s];
    const edges = [
      [(t) => P(-w / 2 + t * w, ym + h / 2), V(0, -1, 0)], [(t) => P(-w / 2 + t * w, ym - h / 2), V(0, 1, 0)],
      [(t) => P(-w / 2, ym - h / 2 + t * h), dir], [(t) => P(w / 2, ym - h / 2 + t * h), dir.clone().negate()],
    ];
    for (const [f, inward] of edges) {
      let t = 0;
      while (t < 0.95) {
        const t2 = Math.min(1, t + rand(0.15, 0.45));
        if (rnd() < 0.7) {
          const a = f(t), b = f(t2), tm = (t + t2) / 2, m = f(tm);
          const depth = rand(0.05, 0.35) * Math.min(w, h);
          const tip = [m[0] + inward.x * depth + dir.x * rand(-0.05, 0.05), m[1] + inward.y * depth, m[2] + inward.z * depth + dir.z * rand(-0.05, 0.05)];
          pos.push(...a, ...b, ...tip);
        }
        t = t2;
      }
    }
    if (!pos.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const n = new Float32Array(pos.length); for (let i = 0; i < n.length; i += 3) { n[i] = nrm.x; n[i + 1] = 0; n[i + 2] = nrm.z; }
    g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
    this.mesh('glass', g, { cast: false });
  }

  /**
   * Stairs. Solid stepped blocks (masonry) or open steel/wood treads with stringers (opt.open).
   * Collision is always a stepped solid so the KCC autostep (0.45) climbs 0.2 m risers reliably.
   */
  stairs(mat, x, z, dirAngle, width, rise, run, yBase = 0, opt = {}) {
    const steps = Math.round(rise / 0.2);
    const sh = rise / steps, sr = run / steps;
    const fwd = V(Math.sin(dirAngle), 0, Math.cos(dirAngle));
    const side = V(fwd.z, 0, -fwd.x);
    for (let i = 0; i < steps; i++) {
      const top = yBase + sh * (i + 1);
      const c = V(x, 0, z).addScaledVector(fwd, sr * (i + 0.5));
      if (!opt.open) {
        this.box(mat, c.x, (yBase + top) / 2, c.z, width, top - yBase, sr, { rot: dirAngle, uv: 1, map: i === steps - 1 });
      } else {
        // Visual tread plate + collider/nav block for the riser band.
        this.box(opt.tread ?? mat, c.x, top - 0.03, c.z, width - 0.06, 0.06, sr + 0.04, { rot: dirAngle, uv: 1, map: false, collide: false, nav: false });
        const bh = Math.min(top - yBase, sh + 0.05);
        const g = this.box(mat, c.x, top - bh / 2, c.z, width, bh, sr, { rot: dirAngle, map: i === steps - 1 });
        // That block is collision/nav only: remove it from the render batch.
        const b = this.batches.get(this.mats.get(mat)); b.geos.pop();
        void g;
      }
    }
    if (opt.open) {
      // Stringers (channel section) on both sides, following the pitch.
      for (const s of [-1, 1]) {
        const a = V(x, yBase - 0.1, z).addScaledVector(side, s * (width / 2 + 0.03));
        const b = a.clone().addScaledVector(fwd, run).add(V(0, rise, 0));
        this.beam(mat, a.clone().add(V(0, 0.05, 0)), b.clone().add(V(0, 0.05, 0)), 0.06, 0.28, { uv: 1 });
      }
    }
    if (opt.rail) {
      for (const s of [-1, 1]) {
        const base = V(x, yBase, z).addScaledVector(side, s * (width / 2 + 0.05));
        const top0 = base.clone().add(V(0, 1.0, 0)), top1 = top0.clone().addScaledVector(fwd, run).add(V(0, rise, 0));
        this.cyl('steel', top0, top1, 0.022, 8);
        this.cyl('steel', top0.clone().add(V(0, -0.48, 0)), top1.clone().add(V(0, -0.48, 0)), 0.016, 6);
        for (let i = 0; i <= 3; i++) {
          const t = i / 3; const p = base.clone().addScaledVector(fwd, run * t).add(V(0, rise * t, 0));
          this.cyl('steel', p, p.clone().add(V(0, 1.0, 0)), 0.02, 6);
        }
      }
    }
  }

  container(x, z, rot, color = 'containerRed', y = 0, open = false) {
    const L = 6.06, W = 2.44, H = 2.59, t = 0.06;
    const m = this.mats.get(color);
    const c = Math.cos(rot), s = Math.sin(rot);
    const local = (lx, lz) => [x + lx * c + lz * s, z - lx * s + lz * c];
    const nc = { rot, collide: false, nav: false, map: false, uv: 1 };
    // Long side walls (inset between the corner posts).
    for (const side of [-1, 1]) {
      const [cx, cz] = local(0, side * (W / 2 - t / 2));
      this.box(m, cx, y + H / 2, cz, L - 0.2, H - 0.2, t, { rot, uv: 2.6, surface: 'metal', map: false });
      // Top + bottom side rails.
      const [rx, rz] = local(0, side * (W / 2 - 0.06));
      this.box('metalDark', rx, y + H - 0.08, rz, L - 0.1, 0.16, 0.14, nc);
      this.box('metalDark', rx, y + 0.08, rz, L - 0.1, 0.16, 0.14, nc);
    }
    // Roof + floor.
    const [rx, rz] = local(0, 0);
    this.box(m, rx, y + H - t / 2, rz, L, t, W, { rot, uv: 2.6, nav: false, map: false });
    this.box('woodDark', rx, y + 0.08, rz, L - 0.1, 0.16, W - 0.1, { rot, uv: 2, map: false });
    // Closed end.
    const [ex, ez] = local(-L / 2 + t / 2, 0);
    this.box(m, ex, y + H / 2, ez, t, H, W, { rot, uv: 2.6, surface: 'metal', map: false });
    // Door end: either open doors swung out, or closed doors with locking bars.
    const [fx, fz] = local(L / 2 - t / 2, 0);
    if (!open) {
      this.box(m, fx, y + H / 2, fz, t, H - 0.2, W - 0.2, { rot, uv: 2.6, surface: 'metal', map: false });
      for (const o of [-0.38, -0.12, 0.12, 0.38]) {
        const [bx, bz] = local(L / 2 + 0.03, o * W);
        this.box('steel', bx, y + H / 2, bz, 0.035, H - 0.25, 0.035, nc);
        const [hx, hz] = local(L / 2 + 0.05, o * W + 0.05);
        this.box('metalDark', hx, y + 1.1, hz, 0.04, 0.22, 0.1, nc);
      }
      const [sx, sz] = local(L / 2 + 0.01, 0);
      this.box('metalDark', sx, y + H / 2, sz, 0.02, H - 0.2, 0.025, nc); // door seam
    } else {
      // Two leaves swung open 90°, standing out from the hinges.
      for (const sd of [-1, 1]) {
        const [dx, dz] = local(L / 2 + W / 4 - 0.02, sd * (W / 2 - 0.04));
        this.box(m, dx, y + H / 2, dz, W / 2 - 0.05, H - 0.2, t, { rot, uv: 2.6, surface: 'metal', map: false });
        for (const o of [0.3, 0.75]) {
          const [bx, bz] = local(L / 2 + o * (W / 2), sd * (W / 2 + 0.01));
          this.box('steel', bx, y + H / 2, bz, 0.035, H - 0.25, 0.035, nc);
        }
      }
    }
    // Corner posts + castings.
    for (const lx of [-L / 2 + 0.08, L / 2 - 0.08]) for (const lz of [-W / 2 + 0.08, W / 2 - 0.08]) {
      const [cx, cz] = local(lx, lz);
      this.box('metalDark', cx, y + H / 2, cz, 0.16, H, 0.16, nc);
      this.box('metalDark', cx, y + H - 0.09, cz, 0.18, 0.18, 0.18, nc);
      this.box('metalDark', cx, y + 0.09, cz, 0.18, 0.18, 0.18, nc);
    }
    if (y < 0.1) this.blob(x, z, L + 1.2, W + 1.2, rot);
    this.minimapShapes.push({ x, z, w: L, d: W, rot, fill: y > 0 ? 'rgba(170,120,100,0.0)' : 'rgba(190,150,120,0.55)' });
  }

  sandbags(x, z, rot, length, rows = 3) {
    // Lumpy stacked sandbag wall (vaultable ~0.95 m).
    const bagW = 0.62, bagH = 0.21, bagD = 0.38;
    const n = Math.max(1, Math.round(length / bagW));
    const c = Math.cos(rot), s = Math.sin(rot);
    const m = this.mats.get('sandbag');
    const geos = [];
    for (let r = 0; r < rows + 1; r++) {
      const off = r % 2 ? bagW / 2 : 0;
      for (let i = 0; i < n - (r % 2); i++) {
        for (const lz of [-bagD / 2, bagD / 2]) {
          const lx = -length / 2 + bagW / 2 + i * bagW + off;
          const g = new THREE.SphereGeometry(0.5, 10, 6);
          g.scale(bagW * 1.02, bagH * 1.25, bagD * 1.1);
          const pos = g.attributes.position;
          for (let k = 0; k < pos.count; k++) {
            const py = pos.getY(k);
            pos.setY(k, Math.max(-bagH * 0.45, Math.min(bagH * 0.5, py)) * (1 + rnd() * 0.06));
            pos.setX(k, pos.getX(k) * (1 + rnd() * 0.05));
          }
          g.computeVertexNormals();
          const jitter = (rnd() - 0.5) * 0.1;
          g.applyMatrix4(new THREE.Matrix4().makeRotationY(rot + jitter).setPosition(x + lx * c + lz * s, bagH * 0.5 + r * bagH * 0.95, z - lx * s + lz * c));
          geos.push(g);
        }
      }
    }
    const merged = mergeGeometries(geos);
    const p = merged.attributes.position;
    const uv = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) { uv[i * 2] = (p.getX(i) + p.getZ(i)) * 1.2; uv[i * 2 + 1] = p.getY(i) * 1.2; }
    merged.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this._push(m, merged, true);
    const h = (rows + 1) * bagH * 0.95 + 0.02;
    this.game.physics.addStaticBox(V(x, h / 2, z), V(length / 2, h / 2, bagD + 0.05), new THREE.Quaternion().setFromAxisAngle(UP, rot), { surface: 'dirt' });
    const proxy = new THREE.BoxGeometry(length, h, bagD * 2 + 0.1);
    proxy.applyMatrix4(new THREE.Matrix4().makeRotationY(rot).setPosition(x, h / 2, z));
    this.navGeos.push(proxy);
    this.blob(x, z, length + 0.8, bagD * 2 + 0.9, rot);
    this.minimapShapes.push({ x, z, w: length, d: bagD * 2, rot, fill: 'rgba(200,180,140,0.45)' });
  }

  /** Wooden pallet (1.2 x 0.8 x 0.144); stack of n. Single collider for the stack. */
  pallets(x, z, rot, n = 1, opt = {}) {
    const c = Math.cos(rot), s = Math.sin(rot);
    const L = (lx, lz) => [x + lx * c + lz * s, z - lx * s + lz * c];
    const o = { rot, collide: false, nav: false, map: false, uv: 0.8 };
    for (let k = 0; k < n; k++) {
      const y = k * 0.145 + (opt.y ?? 0);
      const r2 = rot + (rnd() - 0.5) * 0.06;
      for (const lz of [-0.35, 0, 0.35]) { const [px, pz] = L(0, lz); this.box('wood', px, y + 0.01, pz, 1.2, 0.022, 0.1, { ...o, rot: r2 }); }
      for (const lz of [-0.35, 0, 0.35]) for (const lx of [-0.55, 0, 0.55]) { const [px, pz] = L(lx, lz); this.box('woodDark', px, y + 0.06, pz, 0.1, 0.078, 0.1, o); }
      for (let i = 0; i < 7; i++) {
        const lx = -0.55 + i * (1.1 / 6);
        const [px, pz] = L(lx, 0);
        this.box('wood', px, y + 0.122, pz, 0.1, 0.022, 0.8, { ...o, rot: r2 });
      }
    }
    const h = n * 0.145;
    if (opt.collide !== false) this.game.physics.addStaticBox(V(x, (opt.y ?? 0) + h / 2, z), V(0.6, h / 2, 0.4), new THREE.Quaternion().setFromAxisAngle(UP, rot), { surface: 'wood' });
    if (h > 0.3 && !opt.y) { const pg = new THREE.BoxGeometry(1.2, h, 0.8); pg.applyMatrix4(new THREE.Matrix4().makeRotationY(rot).setPosition(x, h / 2, z)); this.navGeos.push(pg); }
    if (!opt.y) this.blob(x, z, 1.7, 1.3, rot, 0.012, 0.5);
    return h;
  }

  /** Stack of tyres lying flat. */
  tyres(x, z, n = 3) {
    for (let i = 0; i < n; i++) this.prop('tyre', x + rand(-0.04, 0.04), z + rand(-0.04, 0.04), rand(0, 6), { rx: Math.PI / 2, y: i * 0.16, collide: false, nav: false, blob: i === 0 });
    const h = n * 0.16;
    this.game.physics.addStaticBox(V(x, h / 2, z), V(0.3, h / 2, 0.3), null, { surface: 'dirt' });
  }

  // ---------------------------------------------------------------- props
  async loadProps(assets) {
    this.props = {};
    await Promise.all(Object.entries(PROPS).map(async ([k, [path, o = {}]]) => {
      const g = await assets.model('prop_' + k, 'models/props/' + path);
      if (!g) return;
      const root = g.scene;
      root.updateMatrixWorld(true);
      const parts = [];
      root.traverse((m) => {
        if (!m.isMesh) return;
        const name = m.name + ' ' + (m.parent?.name ?? '');
        if (o.pick && !o.pick.test(m.name) && !o.pick.test(m.parent?.name ?? '')) return;
        const geo = m.geometry.clone().applyMatrix4(m.matrixWorld);
        geo.morphAttributes = {}; geo.morphTargetsRelative = false;
        let mat = m.material;
        if (o.emissive && o.emissive.test(mat.name)) {
          mat = mat.clone();
          mat.emissive = new THREE.Color(o.emissiveColor ?? 0xffc080);
          mat.emissiveIntensity = o.emissiveIntensity ?? 6;
          mat.transparent = false; mat.opacity = 1;
          mat.userData.noUnify = true;
        }
        if (mat.map) mat.map.anisotropy = 8;
        void name;
        parts.push({ geo, mat });
      });
      if (!parts.length) return;
      const bb = new THREE.Box3();
      for (const p of parts) { p.geo.computeBoundingBox(); bb.union(p.geo.boundingBox); }
      if (o.recenter) {
        const c = bb.getCenter(new THREE.Vector3());
        for (const p of parts) p.geo.translate(-c.x, 0, -c.z);
        bb.translate(V(-c.x, 0, -c.z));
      }
      this.props[k] = { parts, bb, size: bb.getSize(new THREE.Vector3()), center: bb.getCenter(new THREE.Vector3()) };
      this.propInst[k] = [];
    }));
  }

  /**
   * Place a prop instance (instanced rendering). opt: scale, y, rx/rz (tilt), collide, nav, surface, blob.
   * Returns { size, center } in world space.
   */
  prop(key, x, z, rot = 0, opt = {}) {
    const p = this.props?.[key];
    if (!p) return null;
    const s = opt.scale ?? 1;
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(opt.rx ?? 0, rot, opt.rz ?? 0, 'YXZ'));
    // Local bbox after tilt+scale (to rest it on the ground and size the collider).
    const tb = p.bb.clone().applyMatrix4(new THREE.Matrix4().compose(V(0, 0, 0), new THREE.Quaternion().setFromEuler(new THREE.Euler(opt.rx ?? 0, 0, opt.rz ?? 0)), V(s, s, s)));
    const y = (opt.y ?? 0) - tb.min.y + (opt.dy ?? 0);
    const pos = V(x, y, z);
    const m4 = new THREE.Matrix4().compose(pos, q, V(s, s, s));
    this.propInst[key].push(m4);
    const size = tb.getSize(new THREE.Vector3());
    const qy = new THREE.Quaternion().setFromAxisAngle(UP, rot);
    const wc = tb.getCenter(new THREE.Vector3()).applyQuaternion(qy).add(pos);
    const surface = opt.surface ?? (key.startsWith('barrier') ? 'concrete' : /barrel|aircon|utility|trash|propane|generator|car|jerry|stove/.test(key) ? 'metal' : key === 'cardboard' || key === 'trashbag' || key === 'cementBag' ? 'fabric' : key === 'tyre' ? 'dirt' : 'wood');
    if (opt.collide !== false && !opt.mount) this.game.physics.addStaticBox(wc, size.clone().multiplyScalar(0.5), qy, { surface });
    if (opt.nav !== false && !opt.mount && size.y > 0.25) {
      const proxy = new THREE.BoxGeometry(size.x, size.y, size.z);
      proxy.applyMatrix4(new THREE.Matrix4().compose(wc, qy, V(1, 1, 1)));
      this.navGeos.push(proxy);
    }
    if (opt.blob !== false && !opt.mount && (opt.y ?? 0) < 0.05) this.blob(wc.x, wc.z, size.x * 1.25 + 0.3, size.z * 1.25 + 0.3, rot, 0.012, size.y > 0.5 ? 1 : 0.5);
    if (size.y > 0.8 && !opt.mount) this.minimapShapes.push({ x: wc.x, z: wc.z, w: size.x, d: size.z, rot, fill: 'rgba(210,215,220,0.3)' });
    return { size, center: wc };
  }

  finalizeProps() {
    for (const [k, list] of Object.entries(this.propInst)) {
      const p = this.props[k];
      if (!p || !list.length) continue;
      const big = p.size.y * p.size.x > 0.08;
      for (const part of p.parts) {
        const im = new THREE.InstancedMesh(part.geo, part.mat, list.length);
        list.forEach((m, i) => im.setMatrixAt(i, m));
        im.instanceMatrix.needsUpdate = true;
        im.castShadow = big && !part.mat.userData.noUnify;
        im.receiveShadow = true;
        im.computeBoundingSphere();
        im.name = 'prop_' + k;
        this.group.add(im);
        this.mats.applyUnify(part.mat, 'prop');
      }
    }
  }

  // ---------------------------------------------------------------- build
  build() {
    const B = this.bounds;
    this.mats.mats.cable = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.6, metalness: 0.2 });
    this.mats.mats.cable.name = 'cable';
    this.mats.mats.blob = blobMaterial(0.62);
    this.mats.mats.blobSoft = blobMaterial(0.38);
    this.mats.mats.rackBeam = this.mats.get('metalPainted').clone();
    this.mats.mats.rackBeam.color.set(0xd06a28);
    this.mats.mats.rackBeam.name = 'rackBeam';
    this.mats.surfaceOf.set(this.mats.mats.rackBeam, 'metal');
    this.mats.surfaceOf.set(this.mats.mats.cable, 'metal');
    const rp = this.mats.get('metalDark').clone(); rp.color.set(0x8a6d58); rp.name = 'rustPipe';
    this.mats.mats.rustPipe = rp; this.mats.surfaceOf.set(rp, 'metal');
    const paint = new THREE.MeshStandardMaterial({
      color: 0xcdc3a5, roughness: 0.6, alphaMap: Materials.unify.uNoise.value, alphaTest: 0.42,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    paint.name = 'paint';
    this.mats.mats.paint = paint;
    this.mats.applyUnify(paint, { grime: 0.5, wet: 1, puddle: 1, rmin: 0.3, sat: 0.9, contact: 0, streaks: 0 });

    // ---------- Ground ----------
    this.box('ground', 0, -0.25, 0, 300, 0.5, 300, { uv: 3.2, map: false });
    // Main road E–W and N–S service road + kerbs.
    this.box('asphalt', 0, 0.01, 4, B * 2, 0.02, 9, { uv: 5, collide: false, map: false });
    this.box('asphalt', -24, 0.012, -6, 8, 0.02, 30, { uv: 5, collide: false, map: false });
    for (const zz of [-0.55, 8.55]) this.box('concrete', 0, 0.06, zz, B * 2 - 1, 0.12, 0.2, { uv: 1, map: false, collide: false, nav: false });
    // Road markings (worn).
    for (let x = -B + 3; x < B - 4; x += 6) this.roadPaint(x, x + 3, 4, 0.14);
    this.roadPaint(-B + 1, B - 1, 0.0, 0.12); this.roadPaint(-B + 1, B - 1, 8.0, 0.12);
    // Concrete pads.
    this.box('concreteFloor', 0, 0.02, -38, 40, 0.04, 26, { uv: 3, collide: false, map: false });
    this.box('paving', -2, 0.015, 26, 30, 0.03, 6, { uv: 2.5, collide: false, map: false });
    this.box('concreteDirty', 37, 0.014, 0, 34, 0.028, 50, { uv: 4, collide: false, map: false });

    this.buildPerimeter();
    this.buildWarehouse();
    this.buildOffice();
    this.buildContainerYard();
    this.buildRuins();
    this.buildCourtyard();
    this.buildBackdrop();
    this.defineSpawns();
    this.finalize();
  }

  buildPerimeter() {
    const B = this.bounds, ph = 3.4;
    const pw = 'concreteWall';
    const sides = [[-B, -B, B, -B], [B, B, -B, B], [-B, B, -B, -B], [B, -B, B, B]];
    for (const [x1, z1, x2, z2] of sides) {
      this.wall(pw, x1, z1, x2, z2, 0, ph, 0.5);
      // Coping cap + a darker plinth course: breaks the long plane into readable architecture.
      this.wall('concrete', x1, z1, x2, z2, ph, 0.12, 0.66, [], { collide: false, nav: false, map: false, uv: 1.5 });
      this.wall('concreteDirty', x1, z1, x2, z2, 0, 0.45, 0.56, [], { collide: false, nav: false, map: false, uv: 2 });
    }
    for (const [x1, z1, x2, z2] of sides) {
      const len = Math.hypot(x2 - x1, z2 - z1);
      const dir = V((x2 - x1) / len, 0, (z2 - z1) / len);
      const inward = V(-dir.z, 0, dir.x); // left of travel = inside for this winding
      for (let d = 0; d <= len + 0.01; d += 6) {
        const p = V(x1, 0, z1).addScaledVector(dir, d);
        this.box('concrete', p.x, ph / 2 + 0.1, p.z, 0.8, ph + 0.2, 0.8, { uv: 2, map: false });
        // Fence post on top of each pillar, angled barbed-wire arm leaning outward.
        const top = V(p.x, ph + 0.2, p.z);
        this.cyl('steel', top, top.clone().add(V(0, 2.1, 0)), 0.04, 6);
        const arm = top.clone().add(V(0, 2.1, 0)).addScaledVector(inward, -0.45).add(V(0, 0.35, 0));
        this.cyl('steel', top.clone().add(V(0, 2.05, 0)), arm, 0.025, 5);
        if (d + 6 <= len + 0.01) {
          // Chain-link panel to next post + rails + barbed strands.
          const q = V(x1, 0, z1).addScaledVector(dir, d + 6);
          const a = V(p.x, ph + 0.25, p.z), b = V(q.x, ph + 0.25, q.z);
          const mid = a.clone().add(b).multiplyScalar(0.5).add(V(0, 1.0, 0));
          const g = new THREE.PlaneGeometry(6, 2.0);
          g.applyMatrix4(new THREE.Matrix4().makeRotationY(-Math.atan2(dir.z, dir.x)).setPosition(mid));
          this.fencePanel(g, 6, 2.0);
          this.cyl('steel', a.clone().add(V(0, 1.95, 0)), b.clone().add(V(0, 1.95, 0)), 0.025, 6);
          for (const k of [0.2, 0.45]) {
            const off = inward.clone().multiplyScalar(-0.45 * (k / 0.45)), y = ph + 2.3 + 0.35 * (k / 0.45) - 0.12;
            this.wire(V(p.x, y, p.z).add(off), V(q.x, y, q.z).add(off), 0.05, 0.008);
          }
        }
      }
      // Rain streaks down the wall face (inside).
      for (let d = 3; d < len; d += rand(4, 9)) {
        const p = V(x1, 0, z1).addScaledVector(dir, d).addScaledVector(inward, 0.26);
        this.decal('leakDecal', V(p.x, ph - 0.9, p.z), inward, rand(1.4, 2.6), 1.8);
      }
      // Clip collider above the fence (out-of-bounds guard; never reachable from inside).
      const c = V((x1 + x2) / 2, 0, (z1 + z2) / 2);
      const q = new THREE.Quaternion().setFromAxisAngle(UP, -Math.atan2(dir.z, dir.x));
      this.game.physics.addStaticBox(V(c.x, ph + 13, c.z), V(len / 2 + 1, 13, 0.3), q, { surface: 'metal' });
    }
    // Power line along the west perimeter (inside), feeding the ruins + tower.
    const poles = [];
    for (let z = -50; z <= 50; z += 20) poles.push(V(-56.2, 0, z));
    this.powerLine(poles);
  }

  /** Chain-link panel (alpha-tested) with world-scaled uvs + thin collider-free (bullets pass). */
  fencePanel(g, w, h) {
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w / 1.6, uv.getY(i) * h / 1.6);
    this.mesh('chainlink', g, { cast: true });
  }

  /** Free-standing chain-link fence from a to b (2.4 m) with posts; solid for movement. */
  fence(a, b, h = 2.4, opt = {}) {
    const len = a.distanceTo(b), dir = b.clone().sub(a).normalize();
    const n = Math.max(1, Math.round(len / 3));
    for (let i = 0; i <= n; i++) {
      const p = a.clone().lerp(b, i / n);
      this.cyl('steel', p, p.clone().add(V(0, h + 0.05, 0)), 0.035, 8);
    }
    this.cyl('steel', a.clone().add(V(0, h, 0)), b.clone().add(V(0, h, 0)), 0.022, 6);
    this.cyl('steel', a.clone().add(V(0, 0.08, 0)), b.clone().add(V(0, 0.08, 0)), 0.016, 6);
    const g = new THREE.PlaneGeometry(len, h - 0.05);
    g.applyMatrix4(new THREE.Matrix4().makeRotationY(-Math.atan2(dir.z, dir.x)).setPosition(a.clone().lerp(b, 0.5).add(V(0, h / 2, 0))));
    this.fencePanel(g, len, h);
    const c = a.clone().lerp(b, 0.5);
    if (opt.collide !== false) {
      this.game.physics.addStaticBox(V(c.x, h / 2, c.z), V(len / 2, h / 2, 0.04), new THREE.Quaternion().setFromAxisAngle(UP, -Math.atan2(dir.z, dir.x)), { surface: 'metal' });
      const pg = new THREE.BoxGeometry(len, h, 0.1);
      pg.applyMatrix4(new THREE.Matrix4().makeRotationY(-Math.atan2(dir.z, dir.x)).setPosition(c.x, h / 2, c.z));
      this.navGeos.push(pg);
      this.minimapShapes.push({ x: c.x, z: c.z, w: len, d: 0.12, rot: -Math.atan2(dir.z, dir.x), fill: 'rgba(210,215,220,0.35)' });
    }
  }

  /** Wooden utility poles with cross-arms, insulators and sagging cables. */
  powerLine(pts, H = 8.5, opt = {}) {
    const arms = [];
    pts.forEach((p, i) => {
      const lean = V(rand(-0.06, 0.06), 1, rand(-0.06, 0.06)).normalize();
      const top = p.clone().addScaledVector(lean, H);
      this.cyl('woodDark', p.clone().add(V(0, -0.3, 0)), top, 0.13, 10, { r2: 0.1, uv: 1.5 });
      const nxt = pts[Math.min(i + 1, pts.length - 1)], prv = pts[Math.max(i - 1, 0)];
      const along = nxt.clone().sub(prv).setY(0).normalize();
      const across = V(along.z, 0, -along.x);
      const armY = top.clone().add(V(0, -0.45, 0));
      this.beam('woodDark', armY.clone().addScaledVector(across, -1.1), armY.clone().addScaledVector(across, 1.1), 0.1, 0.12, { uv: 1 });
      const ins = [];
      for (const s of [-0.95, -0.35, 0.95]) {
        const ip = armY.clone().addScaledVector(across, s).add(V(0, 0.06, 0));
        this.cyl('concrete', ip, ip.clone().add(V(0, 0.16, 0)), 0.035, 6, { r2: 0.05 });
        ins.push(ip.clone().add(V(0, 0.17, 0)));
      }
      // Transformer can on every third pole.
      if (opt.transformers !== false && i % 3 === 1) {
        const tp = top.clone().add(V(0, -2.2, 0)).addScaledVector(across, 0.32);
        this.cyl('metalPainted', tp.clone().add(V(0, -0.45, 0)), tp.clone().add(V(0, 0.45, 0)), 0.26, 12);
      }
      arms.push(ins);
      if (opt.collide !== false && opt.noCollide !== true) this.game.physics.addStaticBox(V(p.x, H / 2, p.z), V(0.13, H / 2, 0.13), null, { surface: 'wood' });
    });
    for (let i = 0; i + 1 < arms.length; i++) for (let k = 0; k < 3; k++) this.wire(arms[i][k], arms[i + 1][k], 0.55 + k * 0.05);
  }

  /** Tall street light (steel pole + arm + sodium head). */
  lampPost(x, z, rot = 0, opt = {}) {
    const H = 7.2, fwd = V(Math.sin(rot), 0, Math.cos(rot));
    const base = V(x, 0, z), top = V(x, H, z);
    this.box('concrete', x, 0.25, z, 0.5, 0.5, 0.5, { map: false, uv: 1 });
    this.cyl('steel', base.clone().add(V(0, 0.5, 0)), top, 0.09, 10, { r2: 0.065 });
    const tip = top.clone().addScaledVector(fwd, 1.6).add(V(0, 0.25, 0));
    this.cyl('steel', top.clone().add(V(0, -0.1, 0)), tip, 0.045, 8);
    const head = tip.clone().addScaledVector(fwd, 0.2);
    this.beam('metalDark', tip.clone(), head.clone().addScaledVector(fwd, 0.45), 0.32, 0.16, { uv: 1 });
    const lens = head.clone().addScaledVector(fwd, 0.22).add(V(0, -0.085, 0));
    this.beam(this.mats.get('light'), lens.clone().addScaledVector(fwd, -0.18), lens.clone().addScaledVector(fwd, 0.18), 0.22, 0.02, { cast: false });
    if (opt.collide !== false) this.game.physics.addStaticBox(V(x, H / 2, z), V(0.25, H / 2, 0.25), null, { surface: 'metal' });
    this.blob(x, z, 1.1, 1.1, 0, 0.012, 0.5);
  }

  buildWarehouse() {
    // Footprint x [-18, 18], z [-49, -27], height 9.
    const x0 = -18, x1 = 18, z0 = -49, z1 = -27, H = 9, t = 0.3;
    const wm = 'corrugated';
    const winRow = (len) => {
      const holes = [];
      for (let a = 3; a < len - 2; a += 5) holes.push({ at: a, w: 3, y0: 6, y1: 7.6 });
      return holes;
    };
    const wo = { trim: 'metalDark', glass: 'full', frame: 'metalDark' };
    const southHoles = [
      { at: 9, w: 6, y0: 0, y1: 5 }, { at: 26, w: 3.2, y0: 0, y1: 3 },
      { at: 3, w: 3, y0: 6, y1: 7.6 }, { at: 16, w: 3, y0: 6, y1: 7.6 }, { at: 21, w: 3, y0: 6, y1: 7.6 }, { at: 32, w: 3, y0: 6, y1: 7.6 },
    ];
    this.wall(wm, x0, z1, x1, z1, 0, H, t, southHoles, { ...wo, shaft: -1, doorFrame: 'metalDark' });
    this.wall(wm, x1, z0, x0, z0, 0, H, t, winRow(36), wo);
    const westHoles = [{ at: 15, w: 3, y0: 0, y1: 2.8 }, { at: 5, w: 3, y0: 6, y1: 7.6 }];
    const eastHoles = [{ at: 9, w: 4, y0: 0, y1: 3.6 }, { at: 16, w: 3, y0: 6, y1: 7.6 }];
    this.wall(wm, x0, z0, x0, z1, 0, H, t, westHoles, { ...wo, doorFrame: 'metalDark' });
    this.wall(wm, x1, z1, x1, z0, 0, H, t, eastHoles, { ...wo, doorFrame: 'metalDark' });
    // Concrete plinth around the base (outside), broken at door openings.
    const pl = { collide: false, nav: false, map: false };
    this.wall('concrete', x0 - 0.2, z1 + 0.22, x1 + 0.2, z1 + 0.22, 0, 0.6, 0.15, [{ at: 9.2, w: 6, y0: 0, y1: 5 }, { at: 26.2, w: 3.2, y0: 0, y1: 3 }], pl);
    this.wall('concrete', x1 + 0.2, z0 - 0.22, x0 - 0.2, z0 - 0.22, 0, 0.6, 0.15, [], pl);
    this.wall('concrete', x0 - 0.22, z0 - 0.2, x0 - 0.22, z1 + 0.2, 0, 0.6, 0.15, [{ at: 15.2, w: 3, y0: 0, y1: 2.8 }], pl);
    this.wall('concrete', x1 + 0.22, z1 + 0.2, x1 + 0.22, z0 - 0.2, 0, 0.6, 0.15, [{ at: 9.2, w: 4, y0: 0, y1: 3.6 }], pl);
    // Roll-up shutter half open over the main door + housing.
    this.box('metalDark', -9, 5.35, z1 + 0.32, 6.4, 0.6, 0.45, { map: false, nav: false, collide: false });
    this.box('corrugated', -9, 4.3, z1 + 0.05, 5.9, 1.4, 0.06, { map: false, nav: false, collide: false, uv: 1.2 });
    this.box('metalDark', -9, 3.62, z1 + 0.05, 5.9, 0.08, 0.1, { map: false, nav: false, collide: false });
    // Roof + trusses + edge flashing + gutters & downpipes.
    this.box('corrugated', 0, H + 0.1, (z0 + z1) / 2, 36.6, 0.2, 22.6, { nav: false, map: false, uv: 3 });
    for (const zz of [z0 - 0.35, z1 + 0.35]) {
      this.box('metalDark', 0, H + 0.12, zz, 36.9, 0.28, 0.25, { map: false, nav: false, collide: false });
      for (const xx of [x0 + 0.3, x1 - 0.3, -6, 6]) this.cyl('metalDark', V(xx, 0.15, zz), V(xx, H, zz), 0.06, 8);
    }
    for (let x = x0 + 3; x < x1; x += 6) {
      // Steel portal frame: columns + bottom chord + diagonals.
      this.box('steel', x, H - 0.25, (z0 + z1) / 2, 0.22, 0.3, 22, { nav: false, map: false, collide: false });
      this.box('steel', x, H - 1.6, (z0 + z1) / 2, 0.14, 0.14, 22, { nav: false, map: false, collide: false });
      for (let k = 0; k < 8; k++) {
        const za = z0 + 0.4 + k * (21.2 / 8), zb = za + 21.2 / 8;
        const up = k % 2 === 0;
        this.beam('steel', V(x, up ? H - 1.6 : H - 0.25, za), V(x, up ? H - 0.25 : H - 1.6, zb), 0.08, 0.08);
      }
      for (const z of [z0 + 0.4, z1 - 0.4]) this.box('steel', x, H / 2, z, 0.35, H, 0.35, { map: false, nav: true });
    }
    // Longitudinal purlins.
    for (const zz of [-44, -38, -32]) this.box('steel', 0, H - 0.1, zz, 36, 0.12, 0.1, { nav: false, map: false, collide: false });
    // Overhead gantry crane parked over the centre aisle (hero piece), on runway beams.
    this.prop('crane', -1.5, -35.2, 0, { y: H - 1.75 - 5.1, mount: true });
    for (const zz of [-37.2, -33.2]) this.box('steel', 0, H - 1.85, zz, 35.4, 0.2, 0.25, { nav: false, map: false, collide: false });
    // Ceiling ducting.
    // Catwalk along north wall at 4 m: perforated grating deck on a steel frame.
    const cy = 4;
    this.box('grating', 0, cy - 0.03, z0 + 2.2, 35.4, 0.06, 4, { uv: 1.2, map: false });
    // Collision/nav for the deck is the grating box above; add frame members.
    for (const zz of [z0 + 0.25, z0 + 4.15]) this.box('steel', 0, cy - 0.15, zz, 35.4, 0.24, 0.1, { map: false, nav: false, collide: false });
    for (let x = x0 + 1; x < x1; x += 2.5) this.box('steel', x, cy - 0.12, z0 + 2.2, 0.08, 0.16, 3.9, { map: false, nav: false, collide: false });
    // Railing: posts, top + mid rail, kick plate.
    for (let x = -15.2; x <= x1 - 0.3; x += 2.5) this.box('steel', x, cy + 0.5, z0 + 4.15, 0.06, 1.0, 0.06, { map: false, nav: false, collide: false });
    this.box('steel', 1.25, cy + 1.0, z0 + 4.15, 32.9, 0.06, 0.06, { map: false, nav: false });
    this.box('steel', 1.25, cy + 0.5, z0 + 4.15, 32.9, 0.05, 0.05, { map: false, nav: false, collide: false });
    this.box('steel', 1.25, cy + 0.08, z0 + 4.15, 32.9, 0.14, 0.02, { map: false, nav: false, collide: false });
    this.game.physics.addStaticBox(V(1.25, cy + 0.55, z0 + 4.15), V(16.45, 0.55, 0.03), null, { surface: 'metal' });
    for (let x = x0 + 4; x < x1; x += 8) this.box('steel', x, cy / 2, z0 + 4, 0.25, cy, 0.25, { map: false });
    // Open steel stairs to the catwalk (west end), rising north and landing on the deck edge (z = -44.8).
    this.stairs('steel', -16.4, -44.8 + 7.2, Math.PI, 1.8, cy, 7.2, 0, { rail: true, open: true, tread: 'grating' });
    // Racks (cover lanes).
    for (const x of [-8, 0, 8]) for (const z of [-38.5, -32]) this.rack(x, z);
    // Sodium high-bay lamps + their light.
    for (const x of [-12, -4, 4, 12]) for (const z of [-38, -32]) this.prop('hangLamp', x, z, 0, { y: H - 0.35 - 1.36, mount: true });
    this.interiorLight(-7, H - 2.2, -37, 0xffa65a, 38, 24);
    this.interiorLight(8, H - 2.2, -37, 0xffa65a, 38, 24);
    // Floor clutter.
    this.pallets(-14.5, -43.5, 0.1, 4); this.pallets(-14.4, -42.2, 0.05, 2); this.pallets(15.2, -30.2, 1.4, 5);
    this.prop('generator', 13.8, -45.6, 0.4); this.prop('jerrycan', 14.6, -45.2, 1.1, { nav: false });
    this.prop('propane', -16.8, -46.8, 0); this.prop('propane', -16.3, -47.2, 0.5);
    this.prop('cementBag', -12.6, -29.1, 0.2, { nav: false }); this.prop('cementBag', -12.4, -29.1, 0.3, { y: 0.18, nav: false });
    this.prop('stove', 2.2, -29.6, 0.7);
    // Exterior wall lamps above doors.
    this.prop('wallLamp', -9, z1 + 0.18, 0, { y: 5.9, mount: true });
    this.prop('wallLamp', 8, z1 + 0.18, 0, { y: 3.6, mount: true });
    this.prop('wallLamp', x1 + 0.18, -36, Math.PI / 2, { y: 4.2, mount: true });
    // Exterior pipes run along the east wall.
    for (const yy of [2.2, 2.55]) this.cyl('rustPipe', V(x1 + 0.35, yy, -28.5), V(x1 + 0.35, yy, -33.6), 0.08, 10);
    for (const zz of [-28.5, -31, -33.5]) this.box('metalDark', x1 + 0.2, 2.4, zz, 0.3, 0.7, 0.08, { map: false, nav: false, collide: false });
    this.cyl('rustPipe', V(x1 + 0.35, 2.2, -33.6), V(x1 + 0.35, 0.1, -33.6), 0.08, 10);
    this.patrolPoints.push(V(-12, 0, -30), V(12, 0, -30), V(0, 0, -44), V(-14, cy, -46), V(10, cy, -46), V(14, 0, -42));
  }

  rack(x, z) {
    // Pallet rack: 6 m long (x), 1.1 m deep, 2.6 m tall; orange beams, blue uprights, pallets of goods.
    const L = 6, D = 1.1, H = 2.6;
    for (const dx of [-L / 2, 0, L / 2]) for (const dz of [-D / 2, D / 2]) this.box('metalPainted', x + dx, H / 2, z + dz, 0.08, H, 0.08, { map: false, nav: false, uv: 1 });
    for (const dx of [-L / 2, 0, L / 2]) for (const y of [0.6, 1.9]) this.beam('metalPainted', V(x + dx, y - 0.5, z - D / 2), V(x + dx, y + 0.5, z + D / 2), 0.03, 0.03);
    for (const y of [0.15, 1.3, 2.5]) {
      for (const dz of [-D / 2, D / 2]) this.box('rackBeam', x, y, z + dz, L + 0.1, 0.1, 0.05, { map: false, uv: 1, collide: false, nav: false });
      this.box('metalDark', x, y + 0.03, z, L, 0.03, D - 0.06, { map: y < 1, uv: 1 });
    }
    for (let i = 0; i < 4; i++) {
      const bx = x - L / 2 + 0.8 + i * 1.5;
      for (const [shelfY, p] of [[0.19, 0.85], [1.34, 0.6]]) {
        if (rnd() > p) continue;
        this.pallets(bx, z, Math.PI / 2 + rand(-0.04, 0.04), 1, { y: shelfY, collide: false });
        const r = rnd();
        if (r < 0.55) this.box('wood', bx, shelfY + 0.145 + 0.38, z, 1.1, 0.76, 0.9, { uv: 1.2, map: false });
        else if (r < 0.85) {
          // Stack of cardboard boxes (instanced).
          for (let k = 0; k < 4; k++) this.prop('cardboard', bx + (k % 2 - 0.5) * 0.44, z + rand(-0.15, 0.15), rand(-0.1, 0.1), { y: shelfY + 0.145 + Math.floor(k / 2) * 0.34, mount: true });
          this.game.physics.addStaticBox(V(bx, shelfY + 0.145 + 0.34, z), V(0.45, 0.34, 0.3), null, { surface: 'fabric' });
        } else {
          for (let k = 0; k < 2; k++) this.prop('barrel3', bx + (k - 0.5) * 0.55, z, rand(0, 6), { y: shelfY + 0.145, mount: true });
          this.game.physics.addStaticBox(V(bx, shelfY + 0.145 + 0.47, z), V(0.6, 0.47, 0.32), null, { surface: 'metal' });
        }
      }
    }
    this.blob(x, z, L + 0.8, D + 1.0, 0, 0.012, 0.5);
    this.minimapShapes.push({ x, z, w: L, d: D, rot: 0, fill: 'rgba(210,215,220,0.45)' });
  }

  lampFixture(x, y, z) {
    this.box('metalDark', x, y + 0.08, z, 1.4, 0.12, 0.3, { collide: false, nav: false, map: false });
    this.box(this.mats.get('light'), x, y, z, 1.2, 0.04, 0.18, { collide: false, nav: false, map: false, cast: false });
    this.box('steel', x, y + 0.5, z, 0.02, 1, 0.02, { collide: false, nav: false, map: false, cast: false });
  }

  interiorLight(x, y, z, color = 0xffe2b0, intensity = 40, dist = 26, flicker = false) {
    const l = new THREE.PointLight(color, intensity, dist, 1.7);
    l.position.set(x, y, z);
    this.group.add(l);
    this.interiorLights.push(l);
    if (flicker) this.flicker.push({ light: l, base: intensity });
    return l;
  }

  buildOffice() {
    // Footprint x [-14, 10], z [32, 44]. Two floors of 3.4 m.
    const x0 = -14, x1 = 10, z0 = 32, z1 = 44, F = 3.4, t = 0.3;
    const ext = 'brick', trim = 'concrete';
    const winH = (y) => ({ y0: y + 1.0, y1: y + 2.3 });
    // Mostly blown-out windows; a few intact panes.
    const glassPick = (hl) => (rnd() < 0.3 ? 'full' : 'broken');
    const wo = { trim, glass: glassPick, frame: 'woodDark', doorFrame: 'woodDark' };
    this.wall(ext, x0, z0, x1, z0, 0, F, t, [
      { at: 3, w: 1.6, ...winH(0) }, { at: 7, w: 1.6, ...winH(0) }, { at: 11.6, w: 1.5, y0: 0, y1: 2.4 },
      { at: 15.5, w: 1.6, ...winH(0) }, { at: 19.7, w: 1.5, y0: 0, y1: 2.4 },
    ], wo);
    this.wall(ext, x0, z0, x1, z0, F, F + 1.0, t, [
      { at: 3, w: 1.6, ...winH(F) }, { at: 7, w: 1.6, ...winH(F) }, { at: 11.5, w: 1.6, ...winH(F) }, { at: 15.5, w: 1.6, ...winH(F) }, { at: 20, w: 1.6, ...winH(F) },
    ], { trim, glass: 'none' });
    this.wall(ext, x1, z1, x0, z1, 0, F, t, [{ at: 4, w: 1.6, ...winH(0) }, { at: 19.5, w: 1.5, y0: 0, y1: 2.4 }, { at: 12, w: 1.6, ...winH(0) }], wo);
    this.wall(ext, x1, z1, x0, z1, F, F + 1.0, t, [{ at: 4, w: 1.6, ...winH(F) }, { at: 12, w: 1.6, ...winH(F) }, { at: 19, w: 1.6, ...winH(F) }], { trim, glass: 'none' });
    this.wall(ext, x0, z1, x0, z0, 0, F, t, [{ at: 6, w: 1.5, y0: 0, y1: 2.4 }], wo);
    this.wall(ext, x0, z1, x0, z0, F, F + 1.0, t, [{ at: 6, w: 1.6, ...winH(F) }], { trim, glass: 'none' });
    this.wall(ext, x1, z0, x1, z1, 0, F, t, [{ at: 4, w: 1.6, ...winH(0) }], wo);
    this.wall(ext, x1, z0, x1, z1, F, F + 1.0, t, [{ at: 4, w: 1.6, ...winH(F) }, { at: 9, w: 1.6, ...winH(F) }], { trim, glass: 'none' });
    // Upper-floor window frames/glass (the windows straddle the two wall bands; add them once, full height).
    const upperWins = [
      [x0, z0, x1, z0, [3, 7, 11.5, 15.5, 20]], [x1, z1, x0, z1, [4, 12, 19]], [x0, z1, x0, z0, [6]], [x1, z0, x1, z1, [4, 9]],
    ];
    for (const [ax, az, bx, bz, ats] of upperWins) {
      this.wall(ext, ax, az, bx, bz, F, 3, t, ats.map((at) => ({ at, w: 1.6, ...winH(F) })), { ...wo, noWall: true, trim: null, doorFrame: null });
    }
    // Floor slabs (2nd floor with stair hole at x [6.6, 9.4], z [33, 40.4]).
    const floorY = F;
    this.box('tiles', -4, 0.03, 38, 23.6, 0.06, 11.6, { collide: false, map: false, uv: 1.5 });
    const slab = 'concreteFloor';
    this.box(slab, (x0 + 6.6) / 2, floorY - 0.12, 38, 6.6 - x0, 0.24, 11.6, { map: false, uv: 3 });
    this.box(slab, (6.6 + x1) / 2, floorY - 0.12, 42.2, x1 - 6.6, 0.24, 3.6, { map: false, uv: 3 });
    // Ceilings (plaster underside) for both floors.
    this.box('plasterWhite', (x0 + 6.6) / 2, floorY - 0.245, 38, 6.6 - x0 - 0.3, 0.01, 11.4, { map: false, nav: false, collide: false, uv: 2 });
    this.box('plasterWhite', -2, F * 2 - 0.005, 38, 23.6, 0.01, 11.6, { map: false, nav: false, collide: false, uv: 2 });
    // Roof slab + parapet + coping.
    this.box('concrete', -2, F * 2 + 0.15, 38, 24.4, 0.3, 12.4, { map: false, nav: false });
    this.wall('brick', x0, z0, x1, z0, F * 2 + 0.3, 0.9, t);
    this.wall('brick', x1, z1, x0, z1, F * 2 + 0.3, 0.9, t);
    this.wall('brick', x0, z1, x0, z0, F * 2 + 0.3, 0.9, t);
    this.wall('brick', x1, z0, x1, z1, F * 2 + 0.3, 0.9, t);
    this.box('concrete', -2, F * 2 + 1.25, z0, 24.5, 0.1, 0.42, { map: false, nav: false, collide: false });
    this.box('concrete', -2, F * 2 + 1.25, z1, 24.5, 0.1, 0.42, { map: false, nav: false, collide: false });
    this.box('concrete', x0, F * 2 + 1.25, 38, 0.42, 0.1, 12.4, { map: false, nav: false, collide: false });
    this.box('concrete', x1, F * 2 + 1.25, 38, 0.42, 0.1, 12.4, { map: false, nav: false, collide: false });
    // Upper wall section (floor 2 from F+1 to 2F).
    this.wall(ext, x0, z0, x1, z0, F + 1.0 + 1.3, F - 2.3, t, []);
    this.wall(ext, x1, z1, x0, z1, F + 2.3, F - 2.3, t);
    this.wall(ext, x0, z1, x0, z0, F + 2.3, F - 2.3, t);
    this.wall(ext, x1, z0, x1, z1, F + 2.3, F - 2.3, t);
    // Floor band between storeys (detail).
    this.box('concrete', -2, F, z0 - 0.02, 24.6, 0.25, 0.42, { map: false, nav: false, collide: false });
    this.box('concrete', -2, F, z1 + 0.02, 24.6, 0.25, 0.42, { map: false, nav: false, collide: false });
    // Entrance canopy over the main door.
    this.box('concrete', -2.4, 2.75, z0 - 0.7, 3.2, 0.14, 1.4, { map: false, nav: false, collide: false });
    // Interior partitions (plaster) with door casings.
    const pw = { doorFrame: 'woodDark', wainscot: 'plasterGreen' };
    this.wall('plasterWhite', -4, z0 + 0.15, -4, z1 - 0.15, 0, F - 0.25, 0.15, [{ at: 3, w: 1.2, y0: 0, y1: 2.2 }, { at: 9, w: 1.2, y0: 0, y1: 2.2 }], pw);
    this.wall('plasterWhite', x0 + 0.15, 38, -4, 38, 0, F - 0.25, 0.15, [{ at: 5, w: 1.2, y0: 0, y1: 2.2 }], pw);
    this.wall('plasterWhite', -2, z0 + 0.15, -2, z1 - 0.15, F, F - 0.25, 0.15, [{ at: 6, w: 1.2, y0: F, y1: F + 2.2 }], pw);
    this.wall('plasterWhite', 5.8, z0 + 0.15, 5.8, 40.4, F, F - 0.25, 0.15, [{ at: 4, w: 1.2, y0: F, y1: F + 2.2 }], pw);
    // Skirting boards along partitions.
    // Stairs at x≈8, rising south (+z) from z=33 to z=40.2.
    this.stairs('concrete', 8, 33.1, 0, 2.2, F, 7.1, 0);
    this.box('steel', 6.65, F + 0.5, 36.7, 0.05, 1.0, 7.2, { map: false, nav: false });
    this.box('steel', 6.65, F + 1.0, 36.7, 0.06, 0.06, 7.2, { map: false, nav: false, collide: false });
    // Furniture: desks, filing cabinets (cover), using wood + metal.
    const desk = (x, z, y = 0) => {
      const o = { map: false, uv: 1, collide: false, nav: false };
      this.box('woodDark', x, y + 0.75, z, 1.6, 0.05, 0.8, o);                       // top
      for (const dx of [-0.74, 0.74]) for (const dz of [-0.34, 0.34]) this.box('steel', x + dx, y + 0.36, z + dz, 0.04, 0.72, 0.04, o);
      this.box('metalPainted', x, y + 0.48, z + 0.36, 1.44, 0.42, 0.02, o);           // modesty panel
      this.box('metalPainted', x + 0.5, y + 0.36, z, 0.42, 0.7, 0.66, o);             // drawer pedestal
      for (const dy of [0.18, 0.4, 0.6]) this.box('steel', x + 0.5, y + dy, z - 0.335, 0.14, 0.02, 0.02, o);
      this.game.physics.addStaticBox(V(x, y + 0.39, z), V(0.8, 0.39, 0.4), null, { surface: 'wood' });
      const pg = new THREE.BoxGeometry(1.6, 0.78, 0.8); pg.translate(x, y + 0.39, z); this.navGeos.push(pg);
      this.blob(x, z, 2.0, 1.2, 0, y + 0.012, 0.5);
    };
    desk(-10, 35); desk(-7, 41); desk(1, 35.5); desk(2, 41.5); desk(-9, 35, F); desk(2, 36, F); desk(-6, 42, F);
    const cab = (x, z, y = 0) => {
      this.box('metalPainted', x, y + 0.7, z, 0.5, 1.4, 0.6, { map: false, uv: 1 });
      const fz = z < 38 ? z + 0.305 : z - 0.305, fx = x < -4 ? x + 0.255 : x - 0.255;
      // Drawer seams + handles on the open face (toward the room).
      const alongX = Math.abs(x - -13.4) < 0.01 || Math.abs(x - 9.4) < 0.01;
      for (const dy of [0.35, 0.7, 1.05]) {
        if (alongX) this.box('metalDark', fx, y + dy, z, 0.012, 0.012, 0.5, { map: false, collide: false, nav: false });
        else this.box('metalDark', x, y + dy, fz, 0.42, 0.012, 0.012, { map: false, collide: false, nav: false });
      }
      for (const dy of [0.2, 0.55, 0.9, 1.25]) {
        if (alongX) this.box('steel', fx + Math.sign(fx - x) * 0.01, y + dy, z, 0.02, 0.025, 0.14, { map: false, collide: false, nav: false });
        else this.box('steel', x, y + dy, fz + Math.sign(fz - z) * 0.01, 0.14, 0.025, 0.02, { map: false, collide: false, nav: false });
      }
    };
    cab(-13.4, 42); cab(-13.4, 41.2); cab(-4.6, 33); cab(9.4, 43.2, F); cab(-13.4, 33, F);
    // Office chairs (steel frame, worn wood seat/back), one knocked over.
    const chair = (x, z, y = 0, r = 0, fallen = false) => {
      const c = Math.cos(r), sn = Math.sin(r);
      const L = (lx, ly, lz) => V(x + lx * c + lz * sn, y + ly, z - lx * sn + lz * c);
      if (fallen) {
        // Lying on its back: seat vertical, legs pointing sideways.
        this.beam('woodDark', V(x, y + 0.24, z).addScaledVector(V(c, 0, -sn), -0.22), V(x, y + 0.24, z).addScaledVector(V(c, 0, -sn), 0.22), 0.42, 0.04, { uv: 0.6 });
        for (const s2 of [-0.18, 0.18]) this.cyl('steel', V(x, y + 0.03, z).addScaledVector(V(c, 0, -sn), s2), V(x, y + 0.03, z).addScaledVector(V(c, 0, -sn), s2).addScaledVector(V(sn, 0, c), 0.45), 0.012, 5);
        return;
      }
      this.box('woodDark', ...L(0, 0.45, 0).toArray(), 0.44, 0.03, 0.42, { rot: r, map: false, collide: false, nav: false, uv: 0.6 });
      this.box('woodDark', ...L(0, 0.75, -0.2).toArray(), 0.42, 0.26, 0.025, { rot: r, map: false, collide: false, nav: false, uv: 0.6 });
      for (const lx of [-0.19, 0.19]) for (const lz of [-0.18, 0.18]) this.cyl('steel', L(lx, 0, lz), L(lx, lz < 0 ? 0.88 : 0.44, lz), 0.011, 5);
      this.blob(x, z, 0.7, 0.7, r, y + 0.012, 0.5);
    };
    chair(-10, 35.75, 0, Math.PI); chair(1.2, 36.3, 0, Math.PI + 0.3); chair(-7.3, 40.3, 0, 0.2); chair(-9, 35.8, F, Math.PI - 0.2);
    chair(2.1, 34.9, F, 0.5, true); chair(-6, 41.2, F, 0.1);
    // Clutter.
    this.prop('cardboard', -11, 42, 0.3, { nav: false }); this.prop('cardboard', 3, 42.6, 1.2, { nav: false });
    this.prop('cardboard', -9.4, 36, 2.1, { nav: false, y: 0.78, mount: true }); this.prop('cardboard', -12, 34.5, 0.2, { nav: false });
    this.prop('trashbag', -0.6, 33.0, 0.4, { nav: false }); this.prop('trashbag', -12.8, 43.0, 1.8, { nav: false });
    this.prop('wetSign', 4.2, 37.2, 0.6, { nav: false, collide: false });
    this.prop('cardboard', -7.4, 42.7, 0.2, { y: F, nav: false });
    // Ceiling fluorescents (cool) — one flickers on each floor.
    for (const [x, z] of [[-10, 35], [-10, 41], [-1, 35], [-1, 41], [4, 41]]) this.prop('fluoro', x, z, 0, { y: F - 0.32, mount: true });
    for (const [x, z] of [[-9, 35], [-9, 41], [2, 35], [2, 41], [-5, 38]]) this.prop('fluoro', x, z, Math.PI / 2, { y: 2 * F - 0.07, mount: true });
    this.interiorLight(-6, F - 0.5, 38, 0xdbe8ff, 10, 14, true);
    this.interiorLight(-4, 2 * F - 0.5, 38, 0xdbe8ff, 10, 14);
    // Exterior: AC units on the roof and wall, lamps over doors, downpipes, leak streaks.
    this.prop('aircon', -9, z1 - 2.5, 0.0, { y: 2 * F + 0.3 }); this.prop('aircon', -5.4, z1 - 2.5, 0.0, { y: 2 * F + 0.3 });
    this.prop('aircon2', 3.5, z1 - 2.2, Math.PI, { y: 2 * F + 0.3 });
    this.prop('aircon', -3, z1 + 0.42, 0, { y: F + 1.0, mount: true });
    this.cyl('steel', V(-11, 2 * F + 0.3, 40), V(-11, 2 * F + 1.6, 40), 0.18, 12);
    this.prop('wallLamp', -2.4, z0 - 0.17, Math.PI, { y: 2.3, mount: true });
    this.prop('wallLamp', 5.7, z0 - 0.17, Math.PI, { y: 2.6, mount: true });
    for (const [x, z] of [[x0 - 0.25, z0 - 0.25], [x1 + 0.25, z0 - 0.25], [x0 - 0.25, z1 + 0.25], [x1 + 0.25, z1 + 0.25]]) this.cyl('metalDark', V(x, 0.1, z), V(x, 2 * F + 1.2, z), 0.06, 8);
    for (const at of [3, 7, 15.5]) this.decal('leakDecal', V(x0 + at, F - 0.25, z0 - 0.165), V(0, 0, -1), 1.5, 1.2);
    for (const at of [4, 12]) this.decal('leakDecal', V(x1 - at, 2 * F - 0.9, z1 + 0.165), V(0, 0, 1), 1.8, 1.6);
    this.patrolPoints.push(V(-9, 0, 36), V(2, 0, 38), V(-8, F, 40), V(3, F, 35), V(-12, 0, 30), V(8, 0, 30));
  }

  buildContainerYard() {
    const cols = ['containerRed', 'containerBlue', 'containerGreen', 'containerTan', 'containerWhite'];
    const pick = (i) => cols[i % cols.length];
    const layout = [
      // [x, z, rot, stacked?, open?]
      [26, -18, Math.PI / 2, true, false], [26, -10, Math.PI / 2, false, true], [26, 10, Math.PI / 2, true, false], [26, 18, Math.PI / 2, false, false],
      [33, -15, 0, false, false], [33, 15, 0, true, false], [34.5, -1, Math.PI / 2, false, true],
      [41, -20, Math.PI / 2, true, false], [41, -8, Math.PI / 2, false, false], [41, 8, Math.PI / 2, false, true], [41, 20, Math.PI / 2, true, false],
      [48, -14, 0, false, false], [48, 0, Math.PI / 2, true, false], [48, 14, 0, false, false],
      [51, -24, Math.PI / 2, true, false], [51, 24, Math.PI / 2, false, false],
      [35, 28, 0.12, false, false], [30, -28, -0.1, true, false],
    ];
    layout.forEach(([x, z, r, stacked, open], i) => {
      this.container(x, z, r, pick(i), 0, open);
      if (stacked) this.container(x + (rnd() - 0.5) * 0.2, z + (rnd() - 0.5) * 0.2, r + (rnd() - 0.5) * 0.04, pick(i + 2), 2.6, false);
    });
    // Yard dressing: pallets, tyres, barrels, lamp posts.
    this.pallets(29.5, 6.0, 0.2, 3); this.pallets(44.5, -3.5, 1.2, 6); this.pallets(37.5, 21.5, 0.4, 2);
    this.tyres(30.4, -4.5, 4); this.tyres(31.1, -5.1, 2); this.tyres(52.5, 6.5, 5); this.tyres(44.2, 25.2, 3);
    this.prop('wheelRim', 31.0, -3.6, 0.3, { rx: Math.PI / 2, nav: false, collide: false });
    this.lampPost(37.8, -26.5, Math.PI); this.lampPost(55.6, 2.5, -Math.PI / 2);
    this.patrolPoints.push(V(30, 0, 0), V(37, 0, -8), V(37, 0, 10), V(45, 0, -2), V(52, 0, 8), V(44, 0, -18), V(30, 0, 24));
  }

  buildRuins() {
    const house = (cx, cz, w, d, broken) => {
      const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2, H = 3.2, t = 0.35;
      const wo = { trim: 'concrete', glass: 'none', frame: 'woodDark', doorFrame: 'woodDark' };
      this.wall('plaster', x0, z0, x1, z0, 0, H, t, [{ at: w * 0.3, w: 1.3, y0: 0.9, y1: 2.1 }, { at: w * 0.7, w: 1.2, y0: 0, y1: 2.3 }], { ...wo, glass: 'broken' });
      this.wall('plaster', x1, z1, x0, z1, 0, broken ? 1.6 : H, t, [{ at: w * 0.5, w: 1.3, y0: 0.9, y1: 2.1 }], wo);
      this.wall('plaster', x0, z1, x0, z0, 0, H, t, [{ at: d * 0.5, w: 1.2, y0: 0, y1: 2.3 }], wo);
      // East wall partly collapsed: stepped, ragged top.
      this.box('plaster', x1, 0.6, cz - d * 0.3, t, 1.2, d * 0.4);
      this.box('plaster', x1, 1.0, cz - d * 0.45, t, 0.8, d * 0.12, { map: false, nav: false });
      this.box('plaster', x1, H / 2, cz + d * 0.3, t, H, d * 0.4);
      this.box('plaster', x1, H - 0.4, cz + d * 0.05, t, 0.8, d * 0.12, { map: false });
      // Exposed brick where plaster spalled.
      this.box('brick', x1 + 0.02, 1.4, cz + d * 0.3, t, 0.8, d * 0.25, { map: false, nav: false, collide: false });
      // Rubble.
      for (let i = 0; i < 9; i++) {
        const s = rand(0.3, 0.9);
        let rx = cx + rand(-w / 2, w / 2 + 1.5), rz = cz + rand(-d / 3, d / 3);
        if (Math.hypot(rx - cx, rz - cz) < 1.8) rx = cx + Math.sign(rx - cx || 1) * 1.8 + (rx - cx) * 0.2; // keep the centre walkable
        this.box(i % 2 ? 'brick' : 'concreteDirty', rx, s * 0.3, rz, s * 1.4, s * 0.6, s, { rot: rand(0, 3), map: false, uv: 1 });
      }
      // Small debris (visual only).
      for (let i = 0; i < 18; i++) {
        const s = rand(0.08, 0.22);
        this.box(i % 3 ? 'brick' : 'plaster', cx + rand(-w / 2 - 1, w / 2 + 2), s * 0.35, cz + rand(-d / 2 - 1, d / 2 + 1), s * 1.6, s * 0.7, s, { rot: rand(0, 3), map: false, uv: 0.5, collide: false, nav: false });
      }
      this.box('woodDark', cx, 0.03, cz, w - 0.3, 0.06, d - 0.3, { collide: false, map: false, uv: 2 });
      if (!broken) {
        this.box('woodDark', cx - w / 4, H + 0.1, cz, w / 2 + 0.4, 0.2, d + 0.4, { nav: false, map: false });
        for (let x = x0 + 0.5; x < cx; x += 1.1) this.box('woodDark', x, H + 0.3, cz, 0.15, 0.2, d + 0.6, { nav: false, map: false, collide: false });
        // Broken rafters hanging into the open half.
        for (let k = 0; k < 3; k++) {
          const zz = cz - d / 3 + k * d / 3;
          this.beam('woodDark', V(cx + 0.1, H + 0.2, zz), V(cx + w / 2 - rand(0.6, 1.5), rand(0.4, 1.6), zz + rand(-0.4, 0.4)), 0.14, 0.18);
        }
      } else {
        for (let k = 0; k < 2; k++) this.beam('woodDark', V(x0 + 0.3, 1.5, cz - 1 + k * 2), V(x1 - 1, 0.1, cz - 0.6 + k * 1.6), 0.14, 0.18);
      }
    };
    house(-44, -16, 9, 7, false);
    house(-42, 18, 8, 7, true);
    house(-38, 34, 7, 6, false);
    // Low vaultable walls.
    this.box('brick', -34, 0.55, 0, 0.4, 1.1, 8, { uv: 2 });
    this.box('brick', -48, 0.5, 4, 6, 1.0, 0.4);
    this.box('concreteWall', -30, 0.55, -24, 7, 1.1, 0.4);
    this.box('concreteWall', -38, 0.55, 26, 0.4, 1.1, 5);
    // Guard tower (platform 4.2 m) at (-48, -40).
    const tx = -48, tz = -40, ty = 4.2;
    for (const [dx, dz] of [[-1.6, -1.6], [1.6, -1.6], [-1.6, 1.6], [1.6, 1.6]]) this.box('woodDark', tx + dx, ty / 2, tz + dz, 0.3, ty, 0.3, { map: false });
    for (const s of [-1, 1]) {
      this.beam('woodDark', V(tx - 1.6, 0.4, tz + s * 1.6), V(tx + 1.6, ty - 0.4, tz + s * 1.6), 0.1, 0.14);
      this.beam('woodDark', V(tx + s * 1.6, 0.4, tz - 1.6), V(tx + s * 1.6, ty - 0.4, tz + 1.6), 0.1, 0.14);
    }
    this.box('woodDark', tx, ty - 0.1, tz, 3.8, 0.2, 3.8, { uv: 1.5, map: true });
    for (const [dx, dz, w, d] of [[0, -1.85, 3.8, 0.1], [-1.85, 0, 0.1, 3.8], [1.85, 0, 0.1, 3.8]]) this.box('wood', tx + dx, ty + 0.5, tz + dz, w, 1.0, d, { map: false });
    this.box('corrugated', tx, ty + 2.6, tz, 4.4, 0.12, 4.4, { nav: false, map: false });
    for (const [dx, dz] of [[-1.85, -1.85], [1.85, -1.85], [-1.85, 1.85], [1.85, 1.85]]) this.box('woodDark', tx + dx, ty + 1.3, tz + dz, 0.12, 2.6, 0.12, { map: false, nav: false });
    this.stairs('woodDark', tx, tz + 1.95 + 6.2, Math.PI, 1.2, ty, 6.2, 0, { open: true, tread: 'wood', rail: true });
    this.prop('wallLamp', tx, tz - 1.7, Math.PI, { y: ty + 2.0, mount: true });
    // Dressing.
    this.tyres(-35.5, -11.5, 3); this.pallets(-47.5, 9.0, 0.6, 2); this.pallets(-36.2, 22.4, 1.1, 1);
    this.prop('car', -32.2, -31.5, 0.35);
    this.prop('trashbag', -40.2, -9.6, 0.4, { nav: false }); this.prop('trashbag', -40.8, -9.2, 2.4, { nav: false });
    this.prop('stove', -45.2, 26.6, 0);
    this.patrolPoints.push(V(-44, 0, -16), V(-42, 0, 18), V(-38, 0, 34), V(-48, ty, -40), V(-30, 0, -10), V(-50, 0, 10));
  }

  buildCourtyard() {
    this.container(-4, -12, 0.08, 'containerBlue', 0, false);
    this.container(-4.2, -12.1, 0.1, 'containerTan', 2.6, false);
    this.container(6, 16, -0.25, 'containerGreen', 0, true);
    this.sandbags(-12, 14, 0.3, 4.5);
    this.sandbags(12, -10, -0.2, 4.2);
    this.sandbags(-14, -20, 1.2, 3.6);
    this.sandbags(16, 22, 0.9, 3.6);
    this.sandbags(-20, 8, Math.PI / 2, 3);
    this.sandbags(20, -2, Math.PI / 2, 3);
    // Concrete planters / low walls.
    this.box('concrete', 0, 0.45, -22, 10, 0.9, 0.6);
    this.box('concrete', -9, 0.45, 27, 0.6, 0.9, 4);
    this.box('concrete', 14, 0.45, 28, 6, 0.9, 0.6);
    // Pump house at (15, -16).
    const px = 15, pz = -16;
    const pdo = { doorFrame: 'metalDark', trim: 'concrete', glass: 'broken', frame: 'metalDark' };
    this.wall('concreteWall', px - 3, pz - 2.5, px + 3, pz - 2.5, 0, 3, 0.3);
    this.wall('concreteWall', px + 3, pz + 2.5, px - 3, pz + 2.5, 0, 3, 0.3, [{ at: 4, w: 1.4, y0: 0, y1: 2.3 }], pdo);
    this.wall('concreteWall', px - 3, pz + 2.5, px - 3, pz - 2.5, 0, 3, 0.3, [{ at: 2.5, w: 1.4, y0: 1.0, y1: 2.0 }], pdo);
    this.wall('concreteWall', px + 3, pz - 2.5, px + 3, pz + 2.5, 0, 3, 0.3, [{ at: 2.5, w: 1.2, y0: 1.0, y1: 2.0 }], pdo);
    this.box('corrugated', px, 3.1, pz, 6.6, 0.15, 5.6, { nav: false, map: false });
    this.prop('pipes', px - 1.5, pz - 2.2, 0, { y: 0.0, mount: true });
    this.prop('wallLamp', px + 1, pz + 2.67, 0, { y: 2.55, mount: true });
    this.prop('utilityBox2', px + 3.4, pz - 1.0, -Math.PI / 2);
    // Loading dock.
    this.box('concrete', 9, 0.6, -24.5, 6, 1.2, 3);
    this.box('metalDark', 9, 1.18, -23.0, 6, 0.06, 0.08, { map: false, nav: false, collide: false });
    for (const xx of [6.8, 11.2]) this.box('black', xx, 0.75, -22.95, 0.5, 0.45, 0.12, { map: false, nav: false, collide: false });
    this.stairs('concrete', 4.2, -24.5, Math.PI / 2, 3, 1.2, 1.8, 0);
    // Street lights along the road + utility boxes, manholes, bins.
    for (const x of [-42, -18, 6, 30]) this.lampPost(x, -1.4, 0);
    for (const x of [-30, -6, 18]) this.lampPost(x, 9.4, Math.PI);
    this.prop('streetlamp', -12, 23.4, 0); this.prop('streetlamp', 6, 23.4, 0);
    this.prop('manhole', -10, 4.6, 0.3, { nav: false, collide: false, blob: false, dy: -0.012 });
    this.prop('manhole', 14, 3.2, 1.0, { nav: false, collide: false, blob: false, dy: -0.012 });
    this.prop('utilityBox', -21.2, -0.9, 0); this.prop('utilityBox2', 21.5, 9.6, Math.PI);
    this.prop('trashCan', 9.6, 29.0, 0.1); this.prop('trashCan', -15.8, 29.4, -0.1);
    this.prop('car', 17.6, 31.0, 1.4);
    this.pallets(-1.5, -24.4, 0.3, 2); this.pallets(12.6, -22.0, 1.3, 3);
    this.tyres(-17.6, 2.0, 3);
    this.prop('trashbag', 11.1, 29.6, 0.2, { nav: false }); this.prop('trashbag', 10.6, 30.2, 2.1, { nav: false });
    // Chain-link fence separating the courtyard from the container yard (gaps at the road + north).
    this.fence(V(22.5, 0, 11.5), V(22.5, 0, 30));
    this.fence(V(22.5, 0, -30), V(22.5, 0, -12));
    this.patrolPoints.push(V(0, 0, 0), V(-10, 0, -6), V(10, 0, 8), V(-8, 0, 20), V(14, 0, -6), V(0, 0, 14), V(-16, 0, -12), V(15, 0, -16));
  }

  /** Distant skyline beyond the perimeter: industrial silhouettes that the haze swallows. */
  buildBackdrop() {
    const o = { collide: false, nav: false, map: false };
    const bld = (x, z, w, h, d, mat = 'concreteWall', rot = 0) => {
      this.box(mat, x, h / 2, z, w, h, d, { ...o, rot, uv: 4 });
      this.box('metalDark', x, h + 0.25, z, w + 0.3, 0.5, d + 0.3, { ...o, rot, uv: 4 });
      // Window bands on the face toward the depot (dark openings; some lit later by fires).
      const c = Math.cos(rot), sn = Math.sin(rot);
      const toC = V(-x, 0, -z).normalize();
      const faces = [[V(c, 0, -sn), w, d], [V(sn, 0, c), d, w]];
      for (const [ax, along, depth] of faces) {
        const n = V(ax.z, 0, -ax.x); // face normal candidate
        const sgn = Math.sign(n.dot(toC)) || 1;
        const fc = V(x, 0, z).addScaledVector(n, sgn * (depth / 2 + 0.06));
        const nx = Math.floor((along - 4) / 4), ny = Math.floor((h - 3) / 4);
        for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
          if (rnd() < 0.15) continue;
          const p = fc.clone().addScaledVector(ax, -along / 2 + 3 + i * 4);
          this.box('black', p.x, 2.5 + j * 4, p.z, 1.8, 1.5, 0.12, { ...o, rot: Math.atan2(-ax.z, ax.x) });
        }
      }
    };
    // North: factory block with saw-tooth roofs & chimneys.
    bld(-30, -95, 40, 14, 22, 'brick'); bld(15, -105, 30, 20, 26, 'concreteWall'); bld(48, -92, 20, 10, 18, 'corrugated');
    for (let i = 0; i < 6; i++) this.beam('corrugated', V(-48 + i * 6.5, 14, -95 + 11), V(-48 + i * 6.5 + 3.2, 17, -95 + 11), 6.5, 0.2, { uv: 4 });
    this.cyl('brick', V(-8, 0, -112), V(-8, 46, -112), 2.4, 16, { r2: 1.7, uv: 3 });
    this.cyl('concrete', V(30, 0, -125), V(30, 38, -125), 2.8, 16, { r2: 2.0, uv: 3 });
    // East: silos + crane.
    for (const [x, z] of [[95, -20], [101, -12], [95, -4]]) { this.cyl('steel', V(x, 0, z), V(x, 22, z), 3.6, 18, { uv: 4 }); this.cyl('steel', V(x, 22, z), V(x, 24.5, z), 0.4, 18, { r2: 3.6, uv: 4 }); }
    bld(110, 20, 24, 16, 40, 'corrugated', 0.1);
    const cx = 86, cz = 40;
    for (const s of [-1, 1]) this.beam('rackBeam', V(cx + s * 5, 0, cz), V(cx + s * 5, 30, cz), 0.8, 0.8, { uv: 2 });
    this.beam('rackBeam', V(cx - 12, 30, cz), V(cx + 30, 30, cz), 1.2, 1.4, { uv: 2 });
    this.beam('rackBeam', V(cx - 12, 33, cz), V(cx + 30, 31, cz), 0.3, 0.3, { uv: 2 });
    // South: apartment blocks (shelled) + water tower.
    bld(-20, 100, 26, 22, 14, 'concreteWall', -0.05); bld(18, 108, 22, 30, 16, 'concrete', 0.08); bld(-60, 92, 18, 12, 14, 'brick');
    const wt = V(55, 0, 95);
    for (const [dx, dz] of [[-3, -3], [3, -3], [-3, 3], [3, 3]]) this.beam('steel', wt.clone().add(V(dx * 1.3, 0, dz * 1.3)), wt.clone().add(V(dx, 18, dz)), 0.4, 0.4);
    this.cyl('steel', wt.clone().add(V(0, 18, 0)), wt.clone().add(V(0, 25, 0)), 5.5, 20, { uv: 3 });
    this.cyl('steel', wt.clone().add(V(0, 25, 0)), wt.clone().add(V(0, 27.5, 0)), 0.5, 20, { r2: 5.5, uv: 3 });
    // West: low sheds + tree line silhouettes (dark boxes read as hedges in haze).
    bld(-100, -30, 18, 7, 30, 'corrugated', 0.2); bld(-96, 25, 14, 9, 20, 'brick', -0.15);
    // Outside power line marching along the north and east.
    const pts = []; for (let x = -120; x <= 120; x += 30) pts.push(V(x, 0, -72));
    this.powerLine(pts, 10, { noCollide: true, transformers: false });
    const pts2 = []; for (let z = -110; z <= 110; z += 30) pts2.push(V(72, 0, z));
    this.powerLine(pts2, 10, { noCollide: true, transformers: false });
    // Earth berms hiding the ground seam beyond the walls.
    for (const [x, z, w, d] of [[0, -66, 140, 6], [0, 66, 140, 6], [-66, 0, 6, 140], [66, 0, 6, 140]]) this.box('ground', x, 0.2, z, w, 0.8, d, { ...o, uv: 4 });
  }

  placeProps() {
    const P = (k, x, z, r = 0, o) => this.prop(k, x, z, r, o);
    // Jersey barriers along road.
    const barr = [[-6, -1, 0.1], [-1, -1.5, 0], [8, 9.5, 0.05], [14, 9, -0.1], [-16, 10, 0.4], [22, -4, 1.57], [22, 4, 1.57], [-28, 6, 1.6]];
    for (const [x, z, r] of barr) P(rnd() < 0.5 ? 'barrier' : 'barrier2', x, z, r);
    // Crate clusters.
    const crates = [[-2, -20.6], [3, 20], [-17, -30], [-15, -26], [12, -44], [12, -42.7], [-6, 30], [29, 4], [37, 22], [45, -26], [-36, -8], [-46, 26], [20, 30], [-24, -40], [5, -28]];
    for (const [x, z] of crates) {
      P('crate', x, z, rand(0, 0.4));
      if (rnd() < 0.4) P('crate', x + rand(-0.1, 0.1), z, rand(0, 0.3), { y: 0.3 });
    }
    // Wooden crates (cover-sized clusters).
    for (const [x, z, r] of [[-26.5, 13.5, 0.2], [27.5, -23.5, 1.1], [-6.5, 19.5, 0.6], [44.6, 3.6, 0.1]]) {
      P('woodCrate', x, z, r); P('woodCrate', x + 0.62 * Math.cos(r), z - 0.62 * Math.sin(r), r + 0.05);
      P('woodCrate', x + 0.3 * Math.cos(r), z - 0.3 * Math.sin(r), r - 0.1, { y: 0.46 });
    }
    // Barrels.
    const barrels = [[-7, -7], [-7.6, -6.4], [10, 3], [18, -24], [18.6, -23.4], [31, -6], [44, 12], [44.6, 12.7], [-26, 20], [-40, -2], [-15, -46], [15, -47], [-52, -50], [50, -50], [-52, 50], [52, 52]];
    barrels.forEach(([x, z], i) => P(['barrel1', 'barrel2', 'barrel3'][i % 3], x, z, rand(0, 6)));
    // A couple of toppled barrels.
    P('barrel1', 19.4, -22.6, 0.6, { rz: Math.PI / 2, collide: true });
    P('barrel3', -41.0, -1.0, 2.1, { rz: Math.PI / 2 });
    // Ammo boxes, cardboard, jerrycans as small details.
    for (const [x, z] of [[-12.6, 14.8], [12.4, -9.2], [-3, -29], [36, -1], [-43, -14], [1, 37]]) P('ammo', x, z, rand(0, 3), { nav: false, collide: false });
    for (const [x, z] of [[8, -40], [-8, -34]]) P('cardboard', x, z, rand(0, 3), { nav: false });
    for (const [x, z] of [[-11.4, 15.6], [21.0, -1.0], [-46.0, -13.0]]) P('jerrycan', x, z, rand(0, 3), { nav: false, collide: false });
    this.finalizeProps();
  }

  defineSpawns() {
    for (let i = 0; i < 8; i++) {
      this.spawns[0].push({ pos: V(-53, 0, -30 + i * 8.5), yaw: -Math.PI / 2 });
      this.spawns[1].push({ pos: V(55, 0, -30 + i * 8.5), yaw: Math.PI / 2 });
    }
    const ffa = [[-50, -50], [0, -52], [50, -52], [-52, 0], [55, 0], [-50, 50], [0, 52], [52, 50], [-12, -40], [12, -32], [-7, 35], [30, 0], [-30, 0], [0, 10], [-34.5, 21], [37.5, -18]];
    for (const [x, z] of ffa) this.spawns.ffa.push({ pos: V(x, 0, z), yaw: Math.atan2(x, z) });
  }

  surfaceAt(pos) {
    const hit = this.game.physics.raycast(V(pos.x, pos.y + 0.3, pos.z), V(0, -1, 0), 1, 1);
    return hit?.data?.surface ?? 'concrete';
  }

  finalize() {
    const scene = this.game.renderer.scene;
    for (const [mat, { geos }] of this.batches) {
      const castG = geos.filter((x) => x.cast !== false).map((x) => x.g);
      const noCastG = geos.filter((x) => x.cast === false).map((x) => x.g);
      for (const [list, cast] of [[castG, true], [noCastG, false]]) {
        if (!list.length) continue;
        for (let i = list.length - 1; i >= 0; i--) {
          const arr = list[i].attributes.position.array;
          let ok = true;
          for (let k = 0; k < arr.length; k++) if (!Number.isFinite(arr[k])) { ok = false; break; }
          if (!ok) { console.warn('Level: dropping non-finite geometry in', mat.name); list.splice(i, 1); }
        }
        for (const g of list) {
          if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
          if (!g.attributes.normal) g.computeVertexNormals();
          for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
          if (g.index === null) g.setIndex([...Array(g.attributes.position.count).keys()]);
        }
        const merged = mergeGeometries(list, false);
        if (!merged) { console.warn('merge failed for', mat.name); continue; }
        merged.computeBoundingSphere();
        const mesh = new THREE.Mesh(merged, mat);
        mesh.castShadow = cast && !mat.transparent;
        mesh.receiveShadow = !mat.transparent || mat === this.mats.get('leakDecal');
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        mesh.name = 'lvl_' + (mat.name || 'mat');
        if (mat.transparent) mesh.renderOrder = mat.name === 'glass' ? 3 : 1;
        this.group.add(mesh);
      }
    }
    scene.add(this.group);
  }

  /** Environment: HDRI sky (grounded skybox), IBL, low golden sun with shadows, height fog, shafts. */
  setupEnvironment(hdr) {
    const g = this.game, scene = g.renderer.scene, r = g.renderer.renderer;
    // Re-orient the HDRI so the low sun sits in the south-south-west (rakes across the courtyard and
    // pours through the warehouse's south windows).
    const targetPhi = Math.atan2(0.89, -0.45);
    const info = orientHDR(hdr, targetPhi);
    this.hdrInfo = info;
    // IBL from a sun-clamped copy (the sun is a real shadowed light; leaving it in the IBL leaks light indoors).
    const pmrem = new THREE.PMREMGenerator(r);
    const iblSrc = clampedHDR(hdr, 6);
    const env = pmrem.fromEquirectangular(iblSrc).texture;
    iblSrc.dispose(); pmrem.dispose();
    scene.environment = env;
    scene.environmentIntensity = 0.42;
    // Grounded skybox: HDR projected onto a dome so its field horizon reads as real ground.
    const sky = new GroundedSkybox(hdr, 14, 600, 48);
    sky.position.y = 14 - 0.05;
    sky.material.depthWrite = false;
    sky.renderOrder = -1;
    sky.material.fog = false;
    // Storm grade on the sky: brooding, cooler upper sky; the warm band at the horizon and the glow around the
    // sun stay bright, so the eye goes to the light breaking through.
    {
      const sd = info.dir;
      sky.material.onBeforeCompile = (sh) => {
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vSkyDir;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSkyDir = normalize(position);');
        sh.fragmentShader = sh.fragmentShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vSkyDir;')
          .replace('#include <map_fragment>', `#include <map_fragment>
            {
              vec3 d = normalize(vSkyDir);
              float sunK = pow(max(dot(d, vec3(${sd.x.toFixed(4)}, ${sd.y.toFixed(4)}, ${sd.z.toFixed(4)})), 0.0), 6.0);
              float el = d.y;
              float storm = smoothstep(0.02, 0.5, el) * (1.0 - sunK);
              float l = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
              vec3 grey = l * vec3(0.78, 0.84, 0.95);
              diffuseColor.rgb = mix(diffuseColor.rgb, grey, storm * 0.6) * mix(1.0, 0.5, storm);
              diffuseColor.rgb *= 1.0 + sunK * 0.35;
              // The projected ground of the HDRI: darker, damp.
              diffuseColor.rgb *= mix(1.0, 0.62, smoothstep(0.0, -0.05, el));
            }`);
      };
      sky.material.needsUpdate = true;
    }
    this.sky = sky;
    scene.add(sky);
    scene.background = new THREE.Color(0x40444a);
    // Sun light: same azimuth as the HDRI sun, raised a little so shadows are long but the yard isn't black.
    const el = Math.max(info.el, 14 * DEG);
    const sunDir = V(Math.cos(info.phi) * Math.cos(el), Math.sin(el), Math.sin(info.phi) * Math.cos(el)).normalize();
    this.sunDir = sunDir;
    this.sunDirVisual = info.dir.clone();
    const sunCol = new THREE.Color(1.0, 0.68, 0.42);
    const sun = new THREE.DirectionalLight(sunCol, 3.8);
    sun.position.copy(sunDir).multiplyScalar(160);
    sun.target.position.set(0, 0, 0);
    sun.castShadow = true;
    const q = g.settings.quality;
    const sms = [1024, 2048, 4096, 4096][q] ?? 4096; // keep in sync with Renderer.applySettings (perf)
    sun.shadow.mapSize.set(sms, sms);
    const S = 84;
    Object.assign(sun.shadow.camera, { left: -S, right: S, top: S * 0.62, bottom: -S * 0.62, near: 40, far: 340 });
    sun.shadow.bias = -0.00025;
    sun.shadow.normalBias = 0.045;
    sun.shadow.radius = 2.5;
    sun.shadow.blurSamples = 12;
    scene.add(sun, sun.target);
    this.sun = sun;
    // Cool sky fill from above (IBL does most of it), warm bounce from the ground.
    const hemi = new THREE.HemisphereLight(0x8fa2bd, 0x4a3a2c, 0.18);
    scene.add(hemi);
    // Height fog coloured from the HDRI horizon, glowing toward the sun.
    // Fog: the HDRI horizon, darkened and cooled (storm haze), glowing warm toward the sun.
    const fogCol = info.horizon.clone().multiplyScalar(0.42).lerp(new THREE.Color(0.2, 0.24, 0.3), 0.45);
    const scatterCol = info.sunHorizon.clone().sub(info.horizon).multiplyScalar(0.32);
    scatterCol.r = Math.max(scatterCol.r, 0.25); scatterCol.g = Math.max(scatterCol.g, 0.14); scatterCol.b = Math.max(scatterCol.b, 0.05);
    installAtmosphere({ sunDir: info.dir, sunColor: scatterCol, heightFalloff: 0.06, heightShare: 0.7, scatter: 1.0, indoor: INDOOR_VOLUMES() });
    scene.fog = new THREE.FogExp2(fogCol, 0.0042);
    g.renderer.setSun?.(info.dir, new THREE.Color(1.0, 0.7, 0.42));
    // Fake volumetric shafts through the warehouse's south windows + the main door, with dust motes.
    this.shaftOpenings.push({ center: V(-9, 2.4, -27), w: 5.6, h: 4.6, normal: V(0, 0, 1), length: 14 });
    const shafts = buildLightShafts(this.shaftOpenings, sunDir, new THREE.Color(1.0, 0.72, 0.45), { length: 24, intensity: 0.14 });
    this.group.add(shafts);
    const dust = buildDust([new THREE.Box3(V(-17, 0.5, -44), V(17, 7.5, -28))], 700, new THREE.Color(1.0, 0.8, 0.6).multiplyScalar(0.55), sunDir);
    this.group.add(dust);
    // Per-frame animation driven from the sky's render callback (always drawn).
    const t0 = performance.now();
    sky.onBeforeRender = () => {
      const t = (performance.now() - t0) / 1000;
      Materials.unify.uTime.value = t;
      Materials.unify.uRain.value = Math.min(1, this.game.ambience?.weather?.rainAmount ?? 0);
      shafts.material.uniforms.uTime.value = t;
      dust.material.uniforms.uTime.value = t;
      for (const f of this.flicker) {
        const k = Math.sin(t * 13.0 + f.base) > 0.93 || (Math.sin(t * 0.7 + f.base) > 0.97 && Math.sin(t * 41) > 0) ? 0.08 : 1;
        f.light.intensity = f.base * k;
      }
    };
    this.applyInteriorOcclusion();
  }

  applyInteriorOcclusion() {
    const vols = INDOOR_VOLUMES();
    this.indoorVolumes = vols;
    this.mats.setIndoorVolumes(vols);
    this.game.renderer.scene.traverse((o) => {
      if (o.isMesh || o.isInstancedMesh) {
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          if (m?.userData?.unify) continue;
          this.mats.applyUnify(m, o.isSkinnedMesh ? 'character' : 'prop');
        }
      }
    });
  }

  isIndoors(p) { return this.indoorVolumes?.some((b) => b.containsPoint(p)) ?? false; }
}

function INDOOR_VOLUMES() {
  return [
    new THREE.Box3(V(-18, -1, -49), V(18, 9.1, -27)),
    new THREE.Box3(V(-14, -1, 32), V(10, 6.95, 44)),
    new THREE.Box3(V(12, -1, -18.5), V(18, 3.1, -13.5)),
  ];
}

function blobMaterial(opacity) {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 2, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.55, 'rgba(255,255,255,0.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  const m = new THREE.MeshBasicMaterial({
    color: 0x080604, alphaMap: t, transparent: true, opacity, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  });
  m.name = 'blob';
  return m;
}
