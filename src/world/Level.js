import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GroundedSkybox } from 'three/addons/objects/GroundedSkybox.js';
import { worldBox } from './Geo.js';
import { DEG, rand } from '../core/MathUtil.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

/**
 * "Ironline Depot" — an abandoned industrial compound (~116 x 116 m playable).
 * North: corrugated warehouse w/ catwalk + racks. South: two-storey brick office.
 * East: container yard. West: ruined houses + guard tower. Centre: courtyard w/ barriers & sandbags.
 * All static boxes are batched per material into merged meshes; each gets a box collider tagged with
 * its surface type (footsteps, impacts, penetration).
 */
export class Level {
  constructor(game, materials) {
    this.game = game;
    this.mats = materials;
    this.name = 'Ironline Depot';
    this.group = new THREE.Group();
    this.batches = new Map(); // material -> geometries[]
    this.navGeos = [];
    this.minimapShapes = [];
    this.spawns = { 0: [], 1: [], ffa: [] };
    this.patrolPoints = [];
    this.dynamicProps = [];
    this.interiorLights = [];
    this.bounds = 58;
  }

  // ---------------------------------------------------------------- primitives
  /** Axis-aligned (optionally Y-rotated) box. center = box centre. */
  box(mat, cx, cy, cz, w, h, d, opt = {}) {
    const m = typeof mat === 'string' ? this.mats.get(mat) : mat;
    const uv = opt.uv ?? 2;
    const g = worldBox(w, h, d, uv, { offset: { x: cx, y: cy, z: cz } });
    const rot = opt.rot ?? 0;
    const mtx = new THREE.Matrix4().makeRotationY(rot).setPosition(cx, cy, cz);
    g.applyMatrix4(mtx);
    if (!this.batches.has(m)) this.batches.set(m, { geos: [], cast: [] });
    this.batches.get(m).geos.push({ g, cast: opt.cast !== false });
    if (opt.collide !== false) {
      const q = new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), rot);
      this.game.physics.addStaticBox(V(cx, cy, cz), V(w / 2, h / 2, d / 2), q, { surface: opt.surface ?? this.mats.surface(m) });
    }
    if (opt.nav !== false) this.navGeos.push(g);
    if (opt.map !== false && h > 0.9 && cy + h / 2 > 0.9 && w * d > 0.3 && cy - h / 2 < 3) {
      this.minimapShapes.push({ x: cx, z: cz, w, d, rot, fill: opt.mapFill ?? (h > 2.2 ? 'rgba(210,215,220,0.55)' : 'rgba(210,215,220,0.28)') });
    }
    return g;
  }

  /** Wall from (x1,z1) to (x2,z2) with rectangular openings [{at, w, y0, y1}] measured along the wall. */
  wall(mat, x1, z1, x2, z2, y0, height, thick, holes = [], opt = {}) {
    const dx = x2 - x1, dz = z2 - z1;
    const len = Math.hypot(dx, dz);
    const rot = -Math.atan2(dz, dx);
    const dir = V(dx / len, 0, dz / len);
    const segs = [];
    // Horizontal spans between holes.
    const hs = [...holes].sort((a, b) => a.at - b.at);
    let cursor = 0;
    for (const hl of hs) {
      const a = hl.at - hl.w / 2, b = hl.at + hl.w / 2;
      if (a > cursor) segs.push([cursor, a, y0, y0 + height]);
      // Below & above the hole.
      if (hl.y0 > y0) segs.push([a, b, y0, hl.y0]);
      if (hl.y1 < y0 + height) segs.push([a, b, hl.y1, y0 + height]);
      cursor = b;
    }
    if (cursor < len) segs.push([cursor, len, y0, y0 + height]);
    for (const [a, b, ya, yb] of segs) {
      if (b - a < 0.01 || yb - ya < 0.01) continue;
      const mid = (a + b) / 2;
      const cx = x1 + dir.x * mid, cz = z1 + dir.z * mid;
      this.box(mat, cx, (ya + yb) / 2, cz, b - a, yb - ya, thick, { ...opt, rot, map: opt.map ?? (yb - ya > 1.5 || ya < 1) });
    }
    // Lintels / sills trim on holes for detail.
    if (opt.trim) {
      for (const hl of hs) {
        const cx = x1 + dir.x * hl.at, cz = z1 + dir.z * hl.at;
        if (hl.y0 > y0 + 0.1) this.box(opt.trim, cx, hl.y0 - 0.04, cz, hl.w + 0.2, 0.08, thick + 0.12, { rot, map: false, nav: false });
        this.box(opt.trim, cx, hl.y1 + 0.06, cz, hl.w + 0.2, 0.12, thick + 0.06, { rot, map: false, nav: false });
      }
    }
  }

  stairs(mat, x, z, dirAngle, width, rise, run, yBase = 0, opt = {}) {
    const steps = Math.round(rise / 0.2);
    const sh = rise / steps, sr = run / steps;
    const fwd = V(Math.sin(dirAngle), 0, Math.cos(dirAngle));
    for (let i = 0; i < steps; i++) {
      const top = yBase + sh * (i + 1);
      const c = V(x, 0, z).addScaledVector(fwd, sr * (i + 0.5));
      // Solid stepped block down to base (reads as a staircase, no gaps beneath).
      this.box(mat, c.x, (yBase + top) / 2, c.z, width, top - yBase, sr, { rot: dirAngle, uv: 1, map: i === steps - 1 });
    }
    // Side stringer for visuals.
    if (opt.rail) {
      const side = V(fwd.z, 0, -fwd.x);
      for (const s of [-1, 1]) {
        const p = V(x, 0, z).addScaledVector(fwd, run / 2).addScaledVector(side, s * (width / 2 + 0.03));
        const len = Math.hypot(run, rise);
        const g = this.box('steel', p.x, yBase + rise / 2 + 0.95, p.z, 0.05, 0.05, len, { rot: dirAngle, collide: false, nav: false, map: false });
        // Tilt the rail along the slope.
        g.translate(-p.x, -(yBase + rise / 2 + 0.95), -p.z);
        g.applyMatrix4(new THREE.Matrix4().makeRotationAxis(V(fwd.z, 0, -fwd.x), -Math.atan2(rise, run)));
        g.translate(p.x, yBase + rise / 2 + 0.95, p.z);
      }
    }
  }

  container(x, z, rot, color = 'containerRed', y = 0, open = false) {
    const L = 6.06, W = 2.44, H = 2.59, t = 0.06;
    const m = this.mats.get(color);
    const c = Math.cos(rot), s = Math.sin(rot);
    const local = (lx, lz) => [x + lx * c + lz * s, z - lx * s + lz * c];
    // Long side walls.
    for (const side of [-1, 1]) {
      const [cx, cz] = local(0, side * (W / 2 - t / 2));
      this.box(m, cx, y + H / 2, cz, L, H, t, { rot, uv: 2.6, surface: 'metal', map: false });
    }
    // Roof + floor.
    const [rx, rz] = local(0, 0);
    this.box(m, rx, y + H - t / 2, rz, L, t, W, { rot, uv: 2.6, nav: y > 0.1 ? false : false, map: false });
    this.box('woodDark', rx, y + 0.08, rz, L - 0.1, 0.16, W - 0.1, { rot, uv: 2, map: false });
    // Ends: one closed (or both when not open).
    const [ex, ez] = local(-L / 2 + t / 2, 0);
    this.box(m, ex, y + H / 2, ez, t, H, W, { rot, uv: 2.6, surface: 'metal', map: false });
    if (!open) {
      const [fx, fz] = local(L / 2 - t / 2, 0);
      this.box(m, fx, y + H / 2, fz, t, H, W, { rot, uv: 2.6, surface: 'metal', map: false });
      // Door bars detail.
      for (const o of [-0.5, -0.2, 0.2, 0.5]) {
        const [bx, bz] = local(L / 2 + 0.03, o * W * 0.9);
        this.box('steel', bx, y + H / 2, bz, 0.04, H - 0.2, 0.04, { rot, collide: false, nav: false, map: false });
      }
    }
    // Corner castings.
    for (const lx of [-L / 2 + 0.1, L / 2 - 0.1]) for (const lz of [-W / 2 + 0.1, W / 2 - 0.1]) {
      const [cx, cz] = local(lx, lz);
      this.box('metalDark', cx, y + H - 0.1, cz, 0.2, 0.2, 0.2, { rot, collide: false, nav: false, map: false });
      this.box('metalDark', cx, y + 0.1, cz, 0.2, 0.2, 0.2, { rot, collide: false, nav: false, map: false });
    }
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
            pos.setY(k, Math.max(-bagH * 0.45, Math.min(bagH * 0.5, py)) * (1 + Math.random() * 0.06));
            pos.setX(k, pos.getX(k) * (1 + Math.random() * 0.05));
          }
          g.computeVertexNormals();
          const jitter = (Math.random() - 0.5) * 0.1;
          g.applyMatrix4(new THREE.Matrix4().makeRotationY(rot + jitter).setPosition(x + lx * c + lz * s, bagH * 0.5 + r * bagH * 0.95, z - lx * s + lz * c));
          geos.push(g);
        }
      }
    }
    const merged = mergeGeometries(geos);
    // World-space UVs.
    const p = merged.attributes.position;
    const uv = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) { uv[i * 2] = (p.getX(i) + p.getZ(i)) * 1.2; uv[i * 2 + 1] = p.getY(i) * 1.2; }
    merged.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    if (!this.batches.has(m)) this.batches.set(m, { geos: [] });
    this.batches.get(m).geos.push({ g: merged, cast: true });
    const h = (rows + 1) * bagH * 0.95 + 0.02;
    this.game.physics.addStaticBox(V(x, h / 2, z), V(length / 2, h / 2, bagD + 0.05), new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), rot), { surface: 'dirt' });
    // Nav proxy.
    const proxy = new THREE.BoxGeometry(length, h, bagD * 2 + 0.1);
    proxy.applyMatrix4(new THREE.Matrix4().makeRotationY(rot).setPosition(x, h / 2, z));
    this.navGeos.push(proxy);
    this.minimapShapes.push({ x, z, w: length, d: bagD * 2, rot, fill: 'rgba(200,180,140,0.45)' });
  }

  // ---------------------------------------------------------------- props
  async loadProps(assets) {
    const list = [
      ['crate', 'models/props/old_military_crate/old_military_crate.gltf'],
      ['barrier', 'models/props/concrete_road_barrier/concrete_road_barrier.gltf'],
      ['barrier2', 'models/props/concrete_road_barrier_02/concrete_road_barrier_02.gltf'],
      ['barrel1', 'models/props/Barrel_01/Barrel_01.gltf'],
      ['barrel2', 'models/props/Barrel_02/Barrel_02.gltf'],
      ['barrel3', 'models/props/barrel_03/barrel_03.gltf'],
      ['ammo', 'models/props/ammo_box/ammo_box.gltf'],
      ['cardboard', 'models/props/cardboard_box_01/cardboard_box_01.gltf'],
    ];
    this.props = {};
    await Promise.all(list.map(async ([k, p]) => {
      const g = await assets.model('prop_' + k, p);
      if (!g) return;
      const root = g.scene;
      root.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true; o.receiveShadow = true;
          if (o.material.map) o.material.map.anisotropy = 8;
        }
      });
      const bb = new THREE.Box3().setFromObject(root);
      this.props[k] = { root, bb, size: bb.getSize(new THREE.Vector3()), center: bb.getCenter(new THREE.Vector3()) };
    }));
  }

  /** Place a prop instance; scale chosen so its largest horizontal size ≈ targetSize if given. */
  prop(key, x, z, rot = 0, opt = {}) {
    const p = this.props?.[key];
    if (!p) return null;
    const o = p.root.clone(true);
    const s = opt.scale ?? 1;
    o.scale.setScalar(s);
    o.rotation.y = rot;
    const y = (opt.y ?? 0) - p.bb.min.y * s;
    o.position.set(x, y, z);
    this.group.add(o);
    o.updateMatrixWorld(true);
    const size = p.size.clone().multiplyScalar(s);
    const lc = p.center.clone().multiplyScalar(s);
    const q = new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), rot);
    const wc = lc.applyQuaternion(q).add(o.position);
    const surface = opt.surface ?? (key.startsWith('barrier') ? 'concrete' : key.startsWith('barrel') ? 'metal' : key === 'cardboard' ? 'fabric' : 'wood');
    if (opt.collide !== false) this.game.physics.addStaticBox(wc, size.clone().multiplyScalar(0.5), q, { surface });
    // Nav proxy.
    if (opt.nav !== false) {
      const proxy = new THREE.BoxGeometry(size.x, size.y, size.z);
      proxy.applyMatrix4(new THREE.Matrix4().compose(wc, q, V(1, 1, 1)));
      this.navGeos.push(proxy);
    }
    if (size.y > 0.8) this.minimapShapes.push({ x: wc.x, z: wc.z, w: size.x, d: size.z, rot, fill: 'rgba(210,215,220,0.3)' });
    return { object: o, size, center: wc };
  }

  // ---------------------------------------------------------------- build
  build() {
    const g = this.game;
    const B = this.bounds;

    // ---------- Ground ----------
    this.box('ground', 0, -0.25, 0, 260, 0.5, 260, { uv: 4, map: false });
    // Main road E–W and N–S service road.
    this.box('asphalt', 0, 0.01, 4, B * 2, 0.02, 9, { uv: 5, collide: false, map: false });
    this.box('asphalt', -24, 0.012, -6, 8, 0.02, 30, { uv: 5, collide: false, map: false });
    // Concrete pads.
    this.box('concreteFloor', 0, 0.02, -38, 40, 0.04, 26, { uv: 3, collide: false, map: false });
    this.box('paving', -2, 0.015, 26, 30, 0.03, 6, { uv: 2.5, collide: false, map: false });
    this.box('concreteDirty', 37, 0.014, 0, 34, 0.028, 50, { uv: 4, collide: false, map: false });

    // ---------- Perimeter wall ----------
    const pw = 'concreteWall', ph = 3.4;
    this.wall(pw, -B, -B, B, -B, 0, ph, 0.5);
    this.wall(pw, B, B, -B, B, 0, ph, 0.5);
    this.wall(pw, -B, B, -B, -B, 0, ph, 0.5);
    this.wall(pw, B, -B, B, B, 0, ph, 0.5);
    for (const [x1, z1, x2, z2] of [[-B, -B, B, -B], [B, B, -B, B], [-B, B, -B, -B], [B, -B, B, B]]) {
      // Pillars every 6 m + coping.
      const len = Math.hypot(x2 - x1, z2 - z1);
      for (let d = 0; d <= len; d += 6) {
        const t = d / len;
        this.box('concrete', x1 + (x2 - x1) * t, ph / 2 + 0.1, z1 + (z2 - z1) * t, 0.8, ph + 0.2, 0.8, { uv: 2, map: false });
      }
    }

    this.buildWarehouse();
    this.buildOffice();
    this.buildContainerYard();
    this.buildRuins();
    this.buildCourtyard();
    this.defineSpawns();
    this.finalize();
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
    // South wall (faces courtyard): big door + small door + high windows.
    this.wall(wm, x0, z1, x1, z1, 0, H, t, [
      { at: 9, w: 6, y0: 0, y1: 5 },
      { at: 26, w: 3.2, y0: 0, y1: 3 },
      { at: 3, w: 3, y0: 6, y1: 7.6 }, { at: 16, w: 3, y0: 6, y1: 7.6 }, { at: 21, w: 3, y0: 6, y1: 7.6 }, { at: 32, w: 3, y0: 6, y1: 7.6 },
    ], { trim: 'metalDark' });
    // North wall: windows only (plus catwalk-level window to snipe out? closed by perimeter anyway).
    this.wall(wm, x1, z0, x0, z0, 0, H, t, winRow(36), { trim: 'metalDark' });
    // West wall with door.
    this.wall(wm, x0, z0, x0, z1, 0, H, t, [{ at: 15, w: 3, y0: 0, y1: 2.8 }, { at: 5, w: 3, y0: 6, y1: 7.6 }], { trim: 'metalDark' });
    // East wall with medium door.
    this.wall(wm, x1, z1, x1, z0, 0, H, t, [{ at: 9, w: 4, y0: 0, y1: 3.6 }, { at: 16, w: 3, y0: 6, y1: 7.6 }], { trim: 'metalDark' });
    // Plinth (concrete base strip outside walls) for realism.
    this.box('concrete', 0, 0.3, z1 + 0.05, 36.4, 0.6, 0.45, { map: false, nav: false, collide: false });
    // Roof (pitched look with two slabs) + trusses.
    this.box('corrugated', 0, H + 0.1, (z0 + z1) / 2, 36.6, 0.2, 22.6, { nav: false, map: false, uv: 3 });
    for (let x = x0 + 3; x < x1; x += 6) {
      this.box('steel', x, H - 0.4, (z0 + z1) / 2, 0.25, 0.6, 22, { nav: false, map: false, collide: false });
      for (const z of [z0 + 0.4, z1 - 0.4]) this.box('steel', x, H / 2, z, 0.35, H, 0.35, { map: false, nav: true });
    }
    // Catwalk along north wall at 4 m.
    const cy = 4;
    this.box('steel', 0, cy - 0.12, z0 + 2.2, 35.4, 0.24, 4, { uv: 1.5, map: false });
    // Railing.
    for (let x = x0 + 0.8; x <= x1 - 0.5; x += 2.5) this.box('steel', x, cy + 0.5, z0 + 4.15, 0.06, 1.0, 0.06, { map: false, nav: false, collide: false });
    this.box('steel', 0, cy + 1.0, z0 + 4.15, 35.4, 0.06, 0.06, { map: false, nav: false });
    this.box('steel', 0, cy + 0.5, z0 + 4.15, 35.4, 0.05, 0.05, { map: false, nav: false, collide: false });
    // Invisible rail blocker (so you can't fall through rails but bullets mostly pass — make thin).
    this.game.physics.addStaticBox(V(-1.2, cy + 0.55, z0 + 4.15), V(16.5, 0.55, 0.03), null, { surface: 'metal' });
    // Catwalk supports.
    for (let x = x0 + 4; x < x1; x += 8) this.box('steel', x, cy / 2, z0 + 4, 0.25, cy, 0.25, { map: false });
    // Stairs to catwalk (west end), rising north.
    this.stairs('steel', -16.4, -33.5, Math.PI, 1.8, cy, 7.2, 0, { rail: true });
    // Racks (cover lanes).
    for (const x of [-8, 0, 8]) {
      for (const z of [-38.5, -32]) {
        this.rack(x, z);
      }
    }
    // Crates & barrels inside.
    this.interiorLight(-9, H - 1.2, -38); this.interiorLight(9, H - 1.2, -38);
    for (const x of [-12, -4, 4, 12]) this.lampFixture(x, H - 0.9, -38);
    for (const x of [-12, -4, 4, 12]) this.lampFixture(x, H - 0.9, -32);
    this.patrolPoints.push(V(-12, 0, -30), V(12, 0, -30), V(0, 0, -44), V(-14, cy, -46), V(10, cy, -46), V(14, 0, -42));
  }

  rack(x, z) {
    // Pallet rack: 6 m long (x), 1.1 m deep, 2.6 m tall; shelves with boxes.
    const L = 6, D = 1.1, H = 2.6;
    for (const dx of [-L / 2, 0, L / 2]) for (const dz of [-D / 2, D / 2]) this.box('metalPainted', x + dx, H / 2, z + dz, 0.08, H, 0.08, { map: false, nav: false, uv: 1 });
    for (const y of [0.15, 1.3, 2.5]) this.box('metalPainted', x, y, z, L + 0.1, 0.08, D, { map: y < 1, uv: 1 });
    // Boxes on shelves give cover + bullet-penetrable wood.
    for (let i = 0; i < 4; i++) {
      const bx = x - L / 2 + 0.8 + i * 1.5;
      if (Math.random() < 0.85) this.box('wood', bx, 0.19 + 0.45, z, 1.2, 0.9, 0.95, { uv: 1.2, map: false });
      if (Math.random() < 0.6) this.box('wood', bx, 1.34 + 0.4, z, 1.1, 0.8, 0.9, { uv: 1.2, map: false });
    }
    // Rack backplate (thin metal mesh) for cover on lower part.
    this.minimapShapes.push({ x, z, w: L, d: D, rot: 0, fill: 'rgba(210,215,220,0.45)' });
  }

  lampFixture(x, y, z) {
    this.box('metalDark', x, y + 0.08, z, 1.4, 0.12, 0.3, { collide: false, nav: false, map: false });
    this.box(this.mats.get('light'), x, y, z, 1.2, 0.04, 0.18, { collide: false, nav: false, map: false, cast: false });
    this.box('steel', x, y + 0.5, z, 0.02, 1, 0.02, { collide: false, nav: false, map: false, cast: false });
  }

  interiorLight(x, y, z, color = 0xffe2b0, intensity = 40, dist = 26) {
    const l = new THREE.PointLight(color, intensity, dist, 1.6);
    l.position.set(x, y, z);
    this.group.add(l);
    this.interiorLights.push(l);
  }

  buildOffice() {
    // Footprint x [-14, 10], z [32, 44]. Two floors of 3.4 m.
    const x0 = -14, x1 = 10, z0 = 32, z1 = 44, F = 3.4, t = 0.3;
    const ext = 'brick', trim = 'concrete';
    const winH = (y) => ({ y0: y + 1.0, y1: y + 2.3 });
    // North facade (courtyard side): doors + windows on two floors.
    this.wall(ext, x0, z0, x1, z0, 0, F, t, [
      { at: 3, w: 1.6, ...winH(0) }, { at: 7, w: 1.6, ...winH(0) }, { at: 11.6, w: 1.5, y0: 0, y1: 2.4 },
      { at: 15.5, w: 1.6, ...winH(0) }, { at: 19.7, w: 1.5, y0: 0, y1: 2.4 },
    ], { trim });
    this.wall(ext, x0, z0, x1, z0, F, F + 1.0, t, [
      { at: 3, w: 1.6, ...winH(F) }, { at: 7, w: 1.6, ...winH(F) }, { at: 11.5, w: 1.6, ...winH(F) }, { at: 15.5, w: 1.6, ...winH(F) }, { at: 20, w: 1.6, ...winH(F) },
    ], { trim });
    // South facade.
    this.wall(ext, x1, z1, x0, z1, 0, F, t, [{ at: 4, w: 1.6, ...winH(0) }, { at: 19.5, w: 1.5, y0: 0, y1: 2.4 }, { at: 12, w: 1.6, ...winH(0) }], { trim });
    this.wall(ext, x1, z1, x0, z1, F, F + 1.0, t, [{ at: 4, w: 1.6, ...winH(F) }, { at: 12, w: 1.6, ...winH(F) }, { at: 19, w: 1.6, ...winH(F) }], { trim });
    // West / east.
    this.wall(ext, x0, z1, x0, z0, 0, F, t, [{ at: 6, w: 1.5, y0: 0, y1: 2.4 }], { trim });
    this.wall(ext, x0, z1, x0, z0, F, F + 1.0, t, [{ at: 6, w: 1.6, ...winH(F) }], { trim });
    this.wall(ext, x1, z0, x1, z1, 0, F, t, [{ at: 4, w: 1.6, ...winH(0) }], { trim });
    this.wall(ext, x1, z0, x1, z1, F, F + 1.0, t, [{ at: 4, w: 1.6, ...winH(F) }, { at: 9, w: 1.6, ...winH(F) }], { trim });
    // Floor slabs (2nd floor with stair hole at x [6.6, 9.4], z [33, 40.4]).
    const floorY = F;
    this.box('tiles', -4 + 0.0, 0.03, 38, 23.6, 0.06, 11.6, { collide: false, map: false, uv: 1.5 });
    const slab = 'concreteFloor';
    this.box(slab, (x0 + 6.6) / 2, floorY - 0.12, 38, 6.6 - x0, 0.24, 11.6, { map: false, uv: 3 });
    this.box(slab, (6.6 + x1) / 2 + 0.0, floorY - 0.12, 42.2, x1 - 6.6, 0.24, 3.6, { map: false, uv: 3 });
    // Roof slab + parapet.
    this.box('concrete', -2, F * 2 + 0.15, 38, 24.4, 0.3, 12.4, { map: false, nav: false });
    this.wall('brick', x0, z0, x1, z0, F * 2 + 0.3, 0.9, t);
    this.wall('brick', x1, z1, x0, z1, F * 2 + 0.3, 0.9, t);
    this.wall('brick', x0, z1, x0, z0, F * 2 + 0.3, 0.9, t);
    this.wall('brick', x1, z0, x1, z1, F * 2 + 0.3, 0.9, t);
    // Upper wall section (floor 2 from F+1 to 2F).
    this.wall(ext, x0, z0, x1, z0, F + 1.0 + 1.3, F - 2.3, t, []);
    // Fill between window tops (F+2.3) and roof (2F) on all sides.
    this.wall(ext, x1, z1, x0, z1, F + 2.3, F - 2.3, t);
    this.wall(ext, x0, z1, x0, z0, F + 2.3, F - 2.3, t);
    this.wall(ext, x1, z0, x1, z1, F + 2.3, F - 2.3, t);
    // Floor band between storeys (detail).
    this.box('concrete', -2, F, z0 - 0.02, 24.6, 0.25, 0.42, { map: false, nav: false, collide: false });
    // Interior partitions (plaster), ground floor: wall at x=-4 with doorway, wall at z=38 for west rooms.
    this.wall('plasterWhite', -4, z0 + 0.15, -4, z1 - 0.15, 0, F - 0.25, 0.15, [{ at: 3, w: 1.2, y0: 0, y1: 2.2 }, { at: 9, w: 1.2, y0: 0, y1: 2.2 }]);
    this.wall('plasterWhite', x0 + 0.15, 38, -4, 38, 0, F - 0.25, 0.15, [{ at: 5, w: 1.2, y0: 0, y1: 2.2 }]);
    // Upper floor partitions.
    this.wall('plasterWhite', -2, z0 + 0.15, -2, z1 - 0.15, F, F - 0.25, 0.15, [{ at: 6, w: 1.2, y0: F, y1: F + 2.2 }]);
    this.wall('plasterWhite', 5.8, z0 + 0.15, 5.8, 40.4, F, F - 0.25, 0.15, [{ at: 4, w: 1.2, y0: F, y1: F + 2.2 }]);
    // Stairs at x≈8, rising south (+z) from z=33 to z=40.2.
    this.stairs('concrete', 8, 33.1, 0, 2.2, F, 7.1, 0);
    // Stair rail on landing edge.
    this.box('steel', 6.65, F + 0.5, 36.7, 0.05, 1.0, 7.2, { map: false, nav: false });
    // Furniture: desks, filing cabinets (cover), using wood + metal.
    const desk = (x, z, y = 0, r = 0) => {
      this.box('woodDark', x, y + 0.75, z, 1.6, 0.06, 0.8, { rot: r, map: false, uv: 1 });
      this.box('metalPainted', x, y + 0.37, z, 1.5, 0.72, 0.7, { rot: r, map: false, uv: 1, nav: true });
    };
    desk(-10, 35); desk(-7, 41); desk(1, 35.5); desk(2, 41.5); desk(-9, 35, F); desk(2, 36, F); desk(-6, 42, F);
    const cab = (x, z, y = 0) => this.box('metalPainted', x, y + 0.7, z, 0.5, 1.4, 0.6, { map: false, uv: 1 });
    cab(-13.4, 42); cab(-13.4, 41.2); cab(-4.6, 33); cab(9.4, 43.2, F); cab(-13.4, 33, F);
    // Interior lights (warm).
    this.interiorLight(-8, F - 0.4, 38, 0xffe6c4, 14, 14);
    this.interiorLight(-6, 2 * F - 0.4, 38, 0xffe6c4, 14, 14);
    this.patrolPoints.push(V(-9, 0, 36), V(2, 0, 38), V(-8, F, 40), V(3, F, 35), V(-12, 0, 30), V(8, 0, 30));
  }

  buildContainerYard() {
    const cols = ['containerRed', 'containerBlue', 'containerGreen', 'containerTan'];
    const pick = (i) => cols[i % cols.length];
    // Rows along Z with lanes at x = 26, 34, 42, 50.
    const layout = [
      // [x, z, rot, stacked?, open?]
      [26, -18, Math.PI / 2, true, false], [26, -10, Math.PI / 2, false, true], [26, 10, Math.PI / 2, true, false], [26, 18, Math.PI / 2, false, false],
      [33, -15, 0, false, false], [33, 15, 0, true, false], [34.5, -1, Math.PI / 2, false, true],
      [41, -20, Math.PI / 2, true, false], [41, -8, Math.PI / 2, false, false], [41, 8, Math.PI / 2, false, true], [41, 20, Math.PI / 2, true, false],
      [48, -14, 0, false, false], [48, 0, Math.PI / 2, true, false], [48, 14, 0, false, false],
      [53, -24, Math.PI / 2, true, false], [53, 24, Math.PI / 2, false, false],
      [35, 28, 0.12, false, false], [30, -28, -0.1, true, false],
    ];
    layout.forEach(([x, z, r, stacked, open], i) => {
      this.container(x, z, r, pick(i), 0, open);
      if (stacked) this.container(x + (Math.random() - 0.5) * 0.2, z + (Math.random() - 0.5) * 0.2, r + (Math.random() - 0.5) * 0.04, pick(i + 2), 2.6, false);
    });
    // Crates & barrels between.
    this.patrolPoints.push(V(30, 0, 0), V(37, 0, -8), V(37, 0, 10), V(45, 0, -2), V(52, 0, 8), V(44, 0, -18), V(30, 0, 24));
  }

  buildRuins() {
    // Two half-collapsed houses on the west side + low walls + guard tower.
    const house = (cx, cz, w, d, broken) => {
      const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2, H = 3.2, t = 0.35;
      this.wall('plaster', x0, z0, x1, z0, 0, H, t, [{ at: w * 0.3, w: 1.3, y0: 0.9, y1: 2.1 }, { at: w * 0.7, w: 1.2, y0: 0, y1: 2.3 }], { trim: 'concrete' });
      this.wall('plaster', x1, z1, x0, z1, 0, broken ? 1.6 : H, t, [{ at: w * 0.5, w: 1.3, y0: 0.9, y1: 2.1 }], { trim: 'concrete' });
      this.wall('plaster', x0, z1, x0, z0, 0, H, t, [{ at: d * 0.5, w: 1.2, y0: 0, y1: 2.3 }], { trim: 'concrete' });
      // East wall partly collapsed: stepped pieces.
      this.box('plaster', x1, 0.6, cz - d * 0.3, t, 1.2, d * 0.4);
      this.box('plaster', x1, H / 2, cz + d * 0.3, t, H, d * 0.4);
      // Rubble.
      for (let i = 0; i < 7; i++) {
        const s = rand(0.3, 0.9);
        this.box(i % 2 ? 'brick' : 'concreteDirty', cx + rand(-w / 2, w / 2 + 1.5), s * 0.3, cz + rand(-d / 3, d / 3), s * 1.4, s * 0.6, s, { rot: rand(0, 3), map: false, uv: 1 });
      }
      // Floor.
      this.box('woodDark', cx, 0.03, cz, w - 0.3, 0.06, d - 0.3, { collide: false, map: false, uv: 2 });
      if (!broken) {
        // Partial roof (wood beams + planks).
        this.box('woodDark', cx - w / 4, H + 0.1, cz, w / 2 + 0.4, 0.2, d + 0.4, { nav: false, map: false });
        for (let x = x0 + 0.5; x < cx; x += 1.1) this.box('woodDark', x, H + 0.3, cz, 0.15, 0.2, d + 0.6, { nav: false, map: false, collide: false });
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
    // Guard tower (platform 4 m) at (-50, -36).
    const tx = -48, tz = -40, ty = 4.2;
    for (const [dx, dz] of [[-1.6, -1.6], [1.6, -1.6], [-1.6, 1.6], [1.6, 1.6]]) this.box('woodDark', tx + dx, ty / 2, tz + dz, 0.3, ty, 0.3, { map: false });
    this.box('woodDark', tx, ty - 0.1, tz, 3.8, 0.2, 3.8, { uv: 1.5, map: true });
    for (const [dx, dz, w, d] of [[0, -1.85, 3.8, 0.1], [-1.85, 0, 0.1, 3.8], [1.85, 0, 0.1, 3.8]]) this.box('wood', tx + dx, ty + 0.5, tz + dz, w, 1.0, d, { map: false });
    this.box('corrugated', tx, ty + 2.6, tz, 4.4, 0.12, 4.4, { nav: false, map: false });
    for (const [dx, dz] of [[-1.85, -1.85], [1.85, -1.85], [-1.85, 1.85], [1.85, 1.85]]) this.box('woodDark', tx + dx, ty + 1.3, tz + dz, 0.12, 2.6, 0.12, { map: false, nav: false });
    this.stairs('woodDark', tx, tz + 2.0, 0, 1.2, ty, 6.2, 0);
    // Correct: stairs rising toward +z from the tower — rotate to rise toward tower (dir π).
    this.patrolPoints.push(V(-44, 0, -16), V(-42, 0, 18), V(-38, 0, 34), V(-48, ty, -40), V(-30, 0, -10), V(-50, 0, 10));
  }

  buildCourtyard() {
    // Central container stack + sandbag positions + barriers.
    this.container(-4, -12, 0.08, 'containerBlue', 0, false);
    this.container(-4.2, -12.1, 0.1, 'containerTan', 2.6, false);
    this.container(6, 16, -0.25, 'containerGreen', 0, true);
    this.sandbags(-12, 14, 0.3, 4.5);
    this.sandbags(12, -10, -0.2, 4.2);
    this.sandbags(-14, -20, 1.2, 3.6);
    this.sandbags(16, 22, 0.9, 3.6);
    this.sandbags(-20, 8, Math.PI / 2, 3);
    this.sandbags(20, -2, Math.PI / 2, 3);
    // Bus-stop-like concrete planters / low walls.
    this.box('concrete', 0, 0.45, -22, 10, 0.9, 0.6);
    this.box('concrete', -9, 0.45, 27, 0.6, 0.9, 4);
    this.box('concrete', 14, 0.45, 28, 6, 0.9, 0.6);
    // Utility building (small pump house) at (16, -14).
    const px = 15, pz = -16;
    this.wall('concreteWall', px - 3, pz - 2.5, px + 3, pz - 2.5, 0, 3, 0.3);
    this.wall('concreteWall', px + 3, pz + 2.5, px - 3, pz + 2.5, 0, 3, 0.3, [{ at: 4, w: 1.4, y0: 0, y1: 2.3 }]);
    this.wall('concreteWall', px - 3, pz + 2.5, px - 3, pz - 2.5, 0, 3, 0.3, [{ at: 2.5, w: 1.4, y0: 1.0, y1: 2.0 }]);
    this.wall('concreteWall', px + 3, pz - 2.5, px + 3, pz + 2.5, 0, 3, 0.3, [{ at: 2.5, w: 1.2, y0: 1.0, y1: 2.0 }]);
    this.box('corrugated', px, 3.1, pz, 6.6, 0.15, 5.6, { nav: false, map: false });
    // Elevated walkway / overpass linking courtyard to warehouse catwalk? Keep a loading dock ramp.
    this.box('concrete', 9, 0.6, -24.5, 6, 1.2, 3);
    this.stairs('concrete', 4.2, -24.5, -Math.PI / 2, 3, 1.2, 1.8, 0);
    this.patrolPoints.push(V(0, 0, 0), V(-10, 0, -6), V(10, 0, 8), V(-8, 0, 20), V(14, 0, -6), V(0, 0, 14), V(-16, 0, -12), V(15, 0, -16));
  }

  placeProps() {
    const P = (k, x, z, r = 0, o) => this.prop(k, x, z, r, o);
    // Jersey barriers along road.
    const barr = [[-6, -1, 0.1], [-1, -1.5, 0], [8, 9.5, 0.05], [14, 9, -0.1], [-16, 10, 0.4], [22, -4, 1.57], [22, 4, 1.57], [-28, 6, 1.6]];
    for (const [x, z, r] of barr) P(Math.random() < 0.5 ? 'barrier' : 'barrier2', x, z, r);
    // Crate clusters.
    const crates = [[-2, -20.6], [3, 20], [-17, -30], [-15, -26], [12, -44], [12, -42.7], [-6, 30], [29, 4], [37, 22], [45, -26], [-36, -8], [-46, 26], [20, 30], [-24, -40], [5, -28]];
    for (const [x, z] of crates) {
      P('crate', x, z, rand(0, 0.4));
      if (Math.random() < 0.4) P('crate', x + rand(-0.1, 0.1), z, rand(0, 0.3), { y: 0.72 });
    }
    // Barrels.
    const barrels = [[-7, -7], [-7.6, -6.4], [10, 3], [18, -24], [18.6, -23.4], [31, -6], [44, 12], [44.6, 12.7], [-26, 20], [-40, -2], [-15, -46], [15, -47], [-52, -50], [50, -50], [-52, 50], [52, 52]];
    barrels.forEach(([x, z], i) => P(['barrel1', 'barrel2', 'barrel3'][i % 3], x, z, rand(0, 6)));
    // Ammo boxes & cardboard as small details (no nav).
    for (const [x, z] of [[-12.6, 14.8], [12.4, -9.2], [-3, -29], [36, -1], [-43, -14], [1, 37]]) P('ammo', x, z, rand(0, 3), { nav: false });
    for (const [x, z] of [[-11, 42], [3, 42.5], [-9.4, 36], [-12, 34.5], [8, -40], [-8, -34]]) P('cardboard', x, z, rand(0, 3), { nav: false });
  }

  defineSpawns() {
    for (let i = 0; i < 8; i++) {
      this.spawns[0].push({ pos: V(-53, 0, -30 + i * 8.5), yaw: -Math.PI / 2 });
      this.spawns[1].push({ pos: V(55, 0, -30 + i * 8.5), yaw: Math.PI / 2 });
    }
    const ffa = [[-50, -50], [0, -52], [50, -52], [-52, 0], [55, 0], [-50, 50], [0, 52], [52, 50], [-12, -40], [12, -32], [-8, 38], [30, 0], [-30, 0], [0, 10], [-40, 22], [40, -18]];
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
        // Normalise attributes so geometries can merge (sandbags lack uv1).
        for (const g of list) { if (!g.attributes.uv1) g.setAttribute('uv1', g.attributes.uv.clone()); if (g.index === null) g.setIndex([...Array(g.attributes.position.count).keys()]); }
        const merged = mergeGeometries(list, false);
        if (!merged) { console.warn('merge failed for', mat.name); continue; }
        merged.computeBoundingSphere();
        const mesh = new THREE.Mesh(merged, mat);
        mesh.castShadow = cast;
        mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        this.group.add(mesh);
      }
    }
    scene.add(this.group);
  }

  /** Environment: HDRI sky (grounded skybox), IBL, sun with shadows, fog. */
  setupEnvironment(hdr) {
    const g = this.game, scene = g.renderer.scene, r = g.renderer.renderer;
    const pmrem = new THREE.PMREMGenerator(r);
    const env = pmrem.fromEquirectangular(hdr).texture;
    scene.environment = env;
    scene.environmentIntensity = 0.85;
    // Grounded skybox: HDR projected onto a dome so its asphalt horizon reads as real ground.
    const sky = new GroundedSkybox(hdr, 12, 400, 64);
    sky.position.y = 12 - 0.02;
    sky.material.depthWrite = false;
    sky.renderOrder = -1;
    sky.material.toneMapped = true;
    this.sky = sky;
    scene.add(sky);
    scene.background = new THREE.Color(0x6d7680);
    // Sun direction from HDR (u≈0.60, elev≈56.7°) in three.js equirect convention.
    const phi = (0.5999 - 0.5) * Math.PI * 2, el = 56.7 * DEG;
    const sunDir = V(Math.cos(el) * Math.cos(phi), Math.sin(el), Math.cos(el) * Math.sin(phi)).normalize();
    this.sunDir = sunDir;
    const sun = new THREE.DirectionalLight(0xfff0dc, 3.4);
    sun.position.copy(sunDir).multiplyScalar(120);
    sun.target.position.set(0, 0, 0);
    sun.castShadow = true;
    const q = g.settings.quality;
    sun.shadow.mapSize.set(q >= 2 ? 4096 : 2048, q >= 2 ? 4096 : 2048);
    const S = 78;
    Object.assign(sun.shadow.camera, { left: -S, right: S, top: S, bottom: -S, near: 20, far: 260 });
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.035;
    sun.shadow.radius = 2;
    scene.add(sun, sun.target);
    this.sun = sun;
    const hemi = new THREE.HemisphereLight(0xbcc8d6, 0x5a4e40, 0.25);
    scene.add(hemi);
    scene.fog = new THREE.FogExp2(0x9aa2a8, 0.0045);
    // Distant fog shouldn't hide the sky dome; skybox ignores fog.
    sky.material.fog = false;
    // Interior surfaces get reduced IBL so indoor spaces are darker than outside (fake occlusion).
    this.applyInteriorOcclusion();
  }

  applyInteriorOcclusion() {
    // Volumes considered "indoors" (wall centre-lines): warehouse, office, pump house.
    const vols = [
      new THREE.Box3(V(-18, -1, -49), V(18, 9.1, -27)),
      new THREE.Box3(V(-14, -1, 32), V(10, 6.95, 44)),
      new THREE.Box3(V(12, -1, -18.5), V(18, 3.1, -13.5)),
    ];
    this.indoorVolumes = vols;
    this.mats.setIndoorVolumes(vols);
    this.game.renderer.scene.traverse((o) => {
      if (o.isMesh || o.isInstancedMesh) {
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) this.mats.applyIndoor(m);
      }
    });
  }

  isIndoors(p) { return this.indoorVolumes?.some((b) => b.containsPoint(p)) ?? false; }
}
