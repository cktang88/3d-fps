import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { AmbParticles } from './AmbParticles.js';
import { syncFog } from './glsl.js';
import { makeFlameMaterial } from './flame.js';
import { smokeAtlas, glowTex } from '../../render/ProcTex.js';
import { rand } from '../../core/MathUtil.js';
import { addMergedShadowProxy } from '../../render/Lod.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

/** Box geometry with world-ish (size-proportional) UVs so tiling textures don't stretch. */
function uvBox(w, h, d, uvScale = 0.9) {
  const g = new THREE.BoxGeometry(w, h, d);
  const p = g.attributes.position, n = g.attributes.normal, uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i));
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    if (ax > 0.5) uv.setXY(i, z * uvScale, y * uvScale);
    else if (ay > 0.5) uv.setXY(i, x * uvScale, z * uvScale);
    else uv.setXY(i, x * uvScale, y * uvScale);
  }
  return g;
}

/** Thin box spanning a→b (struts, pillars, beams). */
function strut(a, b, tw, th = tw) {
  const len = a.distanceTo(b);
  const g = uvBox(len, th, tw);
  const dir = b.clone().sub(a).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(V(1, 0, 0), dir);
  g.applyMatrix4(new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, V(1, 1, 1)));
  return g;
}

const place = (g, x, y, z, rx = 0, ry = 0, rz = 0) => g.applyMatrix4(new THREE.Matrix4().compose(V(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), V(1, 1, 1)));

/** Dark charcoal with glowing ember cracks (emissive map). */
function emberTex() {
  const S = 256, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, S, S);
  g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 70; i++) {
    let x = Math.random() * S, y = Math.random() * S;
    g.strokeStyle = `rgba(255,${90 + Math.random() * 80 | 0},20,${0.25 + Math.random() * 0.6})`;
    g.lineWidth = 0.6 + Math.random() * 1.8;
    g.beginPath(); g.moveTo(x, y);
    for (let k = 0; k < 6; k++) { x += rand(-14, 14); y += rand(-14, 14); g.lineTo(x, y); }
    g.stroke();
  }
  for (let i = 0; i < 40; i++) {
    const x = Math.random() * S, y = Math.random() * S, r = 2 + Math.random() * 7;
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, 'rgba(255,150,40,0.9)'); rg.addColorStop(1, 'rgba(255,60,0,0)');
    g.fillStyle = rg; g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Soft, irregular burn mark that fades fully to transparent at the edges (no visible quad). */
function scorchMark() {
  const S = 256, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  const blobs = [];
  for (let i = 0; i < 14; i++) blobs.push([rand(0.3, 0.7) * S, rand(0.3, 0.7) * S, rand(0.12, 0.3) * S]);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let v = 0;
    for (const [bx, by, br] of blobs) { const d = Math.hypot(x - bx, y - by) / br; v = Math.max(v, 1 - d); }
    const r = Math.hypot(x - S / 2, y - S / 2) / (S / 2);
    const n = Math.sin(x * 0.21 + Math.sin(y * 0.13) * 3) * 0.5 + 0.5;
    let a = Math.min(1, v * 1.6) * (1 - Math.min(1, r) ** 2) * (0.75 + 0.25 * n);
    a = Math.max(0, Math.min(1, a));
    const i = (y * S + x) * 4;
    const shade = 12 + 18 * n * (1 - a);
    img.data[i] = shade; img.data[i + 1] = shade * 0.9; img.data[i + 2] = shade * 0.85; img.data[i + 3] = a * 235;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * Burning wrecks inside the map: a burnt-out sedan (SE yard), a burn barrel (courtyard) and a debris
 * fire in the collapsed house (west ruins). Shader flames on cylindrical billboards (one draw call),
 * dense wind-blown smoke plumes, rising embers, occasional spark bursts and flickering PointLights.
 */
export class Fires {
  constructor(amb) {
    this.amb = amb;
    this.game = amb.game;
    this.scene = amb.scene;
    this.group = new THREE.Group();
    this.group.name = 'ambience-fires';
    this.scene.add(this.group);
    this.sites = [];
    this.time = 0;
    const q = amb.quality;

    // Site layout (chosen in open spots that don't block lanes; see Level.js).
    this.siteDefs = [
      { kind: 'car', pos: V(33, 0, 44.5), rot: 0.55, light: 34, smoke: 'oil' },
      { kind: 'barrel', pos: V(-9.3, 0, -7.7), rot: 0, light: 12, smoke: 'grey' },
      { kind: 'pile', pos: V(-43.6, 0, 19.9), rot: 0.4, light: 22, smoke: 'brown' },
    ];
    const lightCount = q === 0 ? 2 : 3;
    this.siteDefs.forEach((d, i) => { d.hasLight = i < lightCount; });

    this.smoke = new AmbParticles(this.scene, { max: 900, texture: smokeAtlas(), atlas: 4, lit: true, sort: true, fogScale: 1, nearFade: 1.2 });
    this.embers = new AmbParticles(this.scene, { max: 500, texture: glowTex(), additive: true, stretch: 0.06, fogScale: 1, nearFade: 1.4 });

    this._buildFlameMesh();
  }

  async load() {
    const a = this.game.assets;
    const P = 'ambience/';
    // Reuse the level's Poly Haven props (already loaded as webp .glb) instead of loading duplicates.
    const prop = (k, file) => a.models['prop_' + k] ?? a.model('prop_' + k, 'models/props/' + file);
    const [stove, rim, tyre, diff, nor, arm, car] = await Promise.all([
      prop('stove', 'barrel_stove/barrel_stove.glb'),
      prop('wheelRim', 'rusted_wheel_rim_01/rusted_wheel_rim_01.glb'),
      prop('tyre', 'old_tyre/old_tyre.glb'),
      a.texture(P + 'textures/rusty_metal_04_diff_1k.webp', true),
      a.texture(P + 'textures/rusty_metal_04_nor_gl_1k.webp', false),
      a.texture(P + 'textures/rusty_metal_04_arm_1k.webp', false),
      a.model('amb_burnt_car', P + 'models/burnt_car/burnt_car.glb'),
    ]);
    this.models = { stove, rim, tyre, car };
    this.ember = emberTex();
    this.mats = {
      burnt: new THREE.MeshStandardMaterial({
        name: 'amb_burnt_metal', map: diff, normalMap: nor, roughnessMap: arm, metalnessMap: arm,
        color: new THREE.Color(0.62, 0.52, 0.47), roughness: 1, metalness: 0.3, normalScale: new THREE.Vector2(1.3, 1.3),
      }),
      char: new THREE.MeshStandardMaterial({
        name: 'amb_char', map: diff, normalMap: nor, color: new THREE.Color(0.075, 0.065, 0.06), roughness: 0.92, metalness: 0.15,
        emissive: new THREE.Color(1, 0.45, 0.15), emissiveMap: this.ember, emissiveIntensity: 1.5,
      }),
      charWood: new THREE.MeshStandardMaterial({
        name: 'amb_char_wood', map: diff, normalMap: nor, color: new THREE.Color(0.06, 0.05, 0.045), roughness: 0.9, metalness: 0,
        emissive: new THREE.Color(1, 0.4, 0.12), emissiveMap: this.ember, emissiveIntensity: 2.2,
      }),
      scorch: new THREE.MeshStandardMaterial({
        name: 'amb_scorch', map: scorchMark(), transparent: true, depthWrite: false, polygonOffset: true,
        polygonOffsetFactor: -6, polygonOffsetUnits: -6, roughness: 0.55, color: new THREE.Color(0.85, 0.8, 0.78),
      }),
    };
    for (const m of Object.values(this.mats)) this.amb.unify(m);
    for (const d of this.siteDefs) this._buildSite(d);
  }

  // ------------------------------------------------------------------ geometry
  _collider(center, half, rot, surface = 'metal', mapFill = 'rgba(120,110,100,0.5)') {
    const lvl = this.game.level;
    const q = new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), rot);
    this.game.physics.addStaticBox(center, half, q, { surface });
    const proxy = new THREE.BoxGeometry(half.x * 2, half.y * 2, half.z * 2);
    proxy.applyMatrix4(new THREE.Matrix4().compose(center, q, V(1, 1, 1)));
    lvl.navGeos?.push(proxy);
    lvl.minimapShapes?.push({ x: center.x, z: center.z, w: half.x * 2, d: half.z * 2, rot, fill: mapFill });
  }

  _mesh(geos, mat, root, cast = true) {
    const g = mergeGeometries(geos.map((x) => (x.index ? x.toNonIndexed() : x)), false);
    const m = new THREE.Mesh(g, mat);
    m.castShadow = cast; m.receiveShadow = true;
    root.add(m);
    return m;
  }

  _scorch(root, size) {
    const s = new THREE.Mesh(new THREE.PlaneGeometry(size, size), this.mats.scorch);
    s.rotation.x = -Math.PI / 2; s.rotation.z = Math.random() * 6;
    s.position.y = 0.035; s.renderOrder = 2; s.receiveShadow = true;
    root.add(s);
  }

  _fitModel(gltf, targetSize, axis = 'max') {
    const o = gltf.scene.clone(true);
    const bb = new THREE.Box3().setFromObject(o), sz = bb.getSize(V(0, 0, 0));
    const ref = axis === 'y' ? sz.y : Math.max(sz.x, sz.y, sz.z);
    o.scale.setScalar(targetSize / ref);
    o.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; this.amb.unify(c.material); } });
    const w = new THREE.Group(); w.add(o);
    const bb2 = new THREE.Box3().setFromObject(o), c = bb2.getCenter(V(0, 0, 0));
    o.position.sub(c); // centre on origin
    return { obj: w, size: bb2.getSize(V(0, 0, 0)) };
  }

  _buildSite(d) {
    const root = new THREE.Group();
    root.position.copy(d.pos); root.rotation.y = d.rot;
    this.group.add(root);
    const site = { def: d, root, flames: [], smokeAcc: 0, emberAcc: 0, burstT: rand(3, 8), smokeAt: [], phase: Math.random() * 100 };
    const local = (x, y, z) => V(x, y, z).applyAxisAngle(V(0, 1, 0), d.rot).add(d.pos);
    if (d.kind === 'car') this._buildCar(root, d, local, site);
    else if (d.kind === 'barrel') this._buildBarrel(root, d, local, site);
    else this._buildPile(root, d, local, site);
    if (d.hasLight) {
      const l = new THREE.PointLight(0xff7428, d.light, d.kind === 'barrel' ? 11 : 18, 1.7);
      l.castShadow = false;
      l.position.copy(site.lightPos);
      this.group.add(l);
      site.light = l;
    }
    this.sites.push(site);
    this._writeFlames();
  }

  _buildCar(root, d, local, site) {
    if (this.models.car) return this._buildCarScan(root, d, local, site);
    const ext = [], int = [];
    // Lower body: extruded side profile of a sedan (bumper → hood → belt → trunk) with wheel arches.
    const body = new THREE.Shape();
    body.moveTo(-2.24, 0.24);
    // Rear arch (from rear to front along the bottom) then front arch.
    body.lineTo(-1.76, 0.24);
    for (let i = 0; i <= 12; i++) { const a = Math.PI - Math.PI * (i / 12); body.lineTo(-1.38 + Math.cos(a) * 0.38, 0.24 + Math.sin(a) * 0.36); }
    body.lineTo(1.0, 0.24);
    for (let i = 0; i <= 12; i++) { const a = Math.PI - Math.PI * (i / 12); body.lineTo(1.38 + Math.cos(a) * 0.38, 0.24 + Math.sin(a) * 0.36); }
    body.lineTo(2.2, 0.24);
    body.lineTo(2.3, 0.4); body.lineTo(2.28, 0.6); body.lineTo(2.16, 0.72);
    body.lineTo(1.4, 0.8); body.lineTo(0.98, 0.86);
    body.lineTo(-1.3, 0.9); body.lineTo(-1.42, 0.9);
    body.lineTo(-2.12, 0.86); body.lineTo(-2.28, 0.66); body.lineTo(-2.3, 0.42);
    body.lineTo(-2.24, 0.24);
    const bodyG = new THREE.ExtrudeGeometry(body, { depth: 1.7, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.04, bevelSegments: 2, curveSegments: 4 });
    bodyG.translate(0, 0, -0.85);
    // Sag + slump: the shell has settled onto its rims and the roof line drooped from the heat.
    const bp = bodyG.attributes.position;
    for (let i = 0; i < bp.count; i++) {
      const x = bp.getX(i), y = bp.getY(i), z = bp.getZ(i);
      bp.setY(i, y - 0.05 * Math.max(0, x / 2.3) - 0.03 * Math.abs(z) * y);
    }
    bodyG.computeVertexNormals();
    this._uvScale(bodyG, 0.38);
    ext.push(bodyG);
    // Greenhouse: two side frames (A/B/C pillars + roof rail) with blown-out windows, then the roof skin.
    const frame = new THREE.Shape();
    frame.moveTo(0.98, 0.86); frame.lineTo(0.36, 1.36); frame.lineTo(-0.78, 1.38); frame.lineTo(-1.36, 0.9); frame.lineTo(0.98, 0.86);
    const h1 = new THREE.Path(); h1.moveTo(0.8, 0.92); h1.lineTo(0.34, 1.29); h1.lineTo(-0.14, 1.3); h1.lineTo(-0.14, 0.92); h1.lineTo(0.8, 0.92);
    const h2 = new THREE.Path(); h2.moveTo(-0.27, 0.93); h2.lineTo(-0.27, 1.3); h2.lineTo(-0.72, 1.3); h2.lineTo(-1.14, 0.93); h2.lineTo(-0.27, 0.93);
    frame.holes.push(h1, h2);
    for (const sgn of [-1, 1]) {
      const fg = new THREE.ExtrudeGeometry(frame, { depth: 0.06, bevelEnabled: false, curveSegments: 2 });
      fg.translate(0, 0, -0.03);
      // Tumblehome: lean the frame inward as it rises.
      const p = fg.attributes.position;
      for (let i = 0; i < p.count; i++) p.setZ(i, p.getZ(i) + sgn * (0.8 - (p.getY(i) - 0.86) * 0.32));
      fg.computeVertexNormals();
      this._uvScale(fg, 0.38);
      ext.push(fg);
    }
    const roof = uvBox(1.18, 0.05, 1.42);
    const rp = roof.attributes.position;
    for (let i = 0; i < rp.count; i++) rp.setY(i, rp.getY(i) - 0.06 * (1 - Math.abs(rp.getX(i) / 0.6)) * (1 - Math.abs(rp.getZ(i) / 0.72)));
    roof.computeVertexNormals();
    ext.push(place(roof, -0.21, 1.36, 0));
    // Panel seams & a buckled, half-open hood edge.
    for (const sgn of [-1, 1]) for (const x of [0.96, -0.2, -1.3]) int.push(place(uvBox(0.025, 0.52, 0.03), x, 0.6, sgn * 0.885));
    const hood = uvBox(1.15, 0.035, 1.62);
    hood.translate(0.58, 0, 0);
    ext.push(place(hood, 1.0, 0.9, 0.02, 0.04, 0.03, 0.17));
    // Interior: charred floor, dash, seat frames, steering wheel (all ember-lit).
    int.push(place(uvBox(3.2, 0.06, 1.6), -0.2, 0.4, 0));
    int.push(place(uvBox(0.34, 0.24, 1.5), 0.78, 0.9, 0));
    for (const z of [-0.4, 0.4]) {
      int.push(place(uvBox(0.5, 0.12, 0.48), 0.1, 0.52, z));
      int.push(place(uvBox(0.09, 0.62, 0.46), -0.18, 0.82, z, 0, 0, 0.22));
    }
    int.push(place(uvBox(0.55, 0.12, 1.42), -0.85, 0.52, 0));
    int.push(place(uvBox(0.1, 0.55, 1.42), -1.1, 0.8, 0, 0, 0, 0.3));
    int.push(place(new THREE.TorusGeometry(0.17, 0.016, 6, 18), 0.56, 1.0, 0.4, 0, Math.PI / 2, 0.55));
    // Engine bay showing under the lifted hood.
    int.push(place(uvBox(0.9, 0.36, 1.3), 1.6, 0.58, 0));
    this._mesh(ext, this.mats.burnt, root);
    this._mesh(int, this.mats.char, root);
    // Rims (no tyres: burnt off) under the arches; a scorched loose tyre nearby.
    if (this.models.rim) {
      for (const [x, z, tilt] of [[1.38, 0.74, 0.1], [1.38, -0.74, -0.05], [-1.38, 0.74, 0.03], [-1.38, -0.74, -0.08]]) {
        const { obj } = this._fitModel(this.models.rim, 0.46);
        const inner = obj.children[0];
        const bb = new THREE.Box3().setFromObject(inner), sz = bb.getSize(V(0, 0, 0));
        if (sz.x < sz.y && sz.x < sz.z) obj.rotation.y = Math.PI / 2;
        else if (sz.y < sz.x && sz.y < sz.z) obj.rotation.x = Math.PI / 2;
        obj.traverse((c) => { if (c.isMesh) { c.material = c.material.clone(); c.material.color.setRGB(0.5, 0.42, 0.38); } });
        const w = new THREE.Group(); w.add(obj);
        w.position.set(x, 0.22, z); w.rotation.x = tilt;
        root.add(w);
      }
    }
    if (this.models.tyre) {
      const { obj, size } = this._fitModel(this.models.tyre, 0.64);
      const inner = obj.children[0];
      const bb = new THREE.Box3().setFromObject(inner), sz = bb.getSize(V(0, 0, 0));
      // Lay flat on the ground.
      if (sz.y >= Math.min(sz.x, sz.z)) { if (sz.x < sz.z) obj.rotation.z = Math.PI / 2; else obj.rotation.x = Math.PI / 2; }
      obj.position.set(-2.7, Math.min(size.x, size.y, size.z) / 2, 1.6);
      obj.traverse((c) => { if (c.isMesh) { c.material = c.material.clone(); c.material.color.multiplyScalar(0.5); } });
      root.add(obj);
    }
    this._scorch(root, 7.5);
    this._collider(local(0, 0.7, 0), V(2.3, 0.7, 0.92), d.rot, 'metal');
    this._collider(local(-2.7, 0.12, 1.6), V(0.3, 0.12, 0.3), d.rot, 'dirt', 'rgba(0,0,0,0)');
    // Flames: licking out of the cabin windows/windshield, engine bay, and a pool under the chassis.
    site.flames.push(
      { p: local(-0.1, 0.6, 0.15), w: 1.5, h: 2.3, k: 1.0 },
      { p: local(-0.7, 0.55, -0.2), w: 1.3, h: 1.9, k: 0.9 },
      { p: local(0.45, 0.8, -0.25), w: 0.9, h: 1.4, k: 0.85 },
      { p: local(1.6, 0.78, 0.1), w: 1.1, h: 1.35, k: 0.85 },
      { p: local(1.25, 0.02, 0.9), w: 0.6, h: 0.6, k: 0.65 },
      { p: local(-1.5, 0.02, -0.9), w: 0.5, h: 0.45, k: 0.6 },
    );
    site.smokeAt = [local(-0.3, 2.0, 0), local(1.4, 1.5, 0)];
    site.lightPos = local(0.2, 1.7, 0);
    site.spread = 0.6; site.rate = 7; site.smokeCol = [0.07, 0.065, 0.06]; site.smokeEnd = [0.16, 0.15, 0.145]; site.size = 1.1;
  }

  /** Photoscanned burnt-out sedan (Sketchfab, CC-BY — see SOURCE.md), re-lit with our PBR pipeline. */
  _buildCarScan(root, d, local, site) {
    const src = this.models.car.scene.clone(true);
    src.updateMatrixWorld(true);
    src.traverse((o) => {
      if (!o.isMesh) return;
      const m0 = o.material;
      if (m0?.name?.includes('004')) { o.visible = false; return; } // stray ground quad in the scan
      // The scan ships unlit; give it a matte, slightly metallic burnt-steel response so sun/fire light it.
      const m = new THREE.MeshStandardMaterial({ name: 'amb_burnt_car', map: m0.map, roughness: 0.82, metalness: 0.25, color: new THREE.Color(0.92, 0.88, 0.85) });
      this.amb.unify(m);
      o.material = m;
      o.castShadow = true; o.receiveShadow = true;
      this.carMat = m;
    });
    const vis = new THREE.Box3();
    src.traverse((o) => { if (o.isMesh && o.visible) vis.union(new THREE.Box3().setFromObject(o)); });
    const sz = vis.getSize(V(0, 0, 0)), c = vis.getCenter(V(0, 0, 0));
    const longX = sz.x > sz.z;
    const scale = 5.25 / Math.max(sz.x, sz.z);
    const holder = new THREE.Group();
    holder.add(src);
    src.position.set(-c.x, -vis.min.y, -c.z);
    holder.scale.setScalar(scale);
    if (!longX) holder.rotation.y = Math.PI / 2; // our local frame: length along X
    root.add(holder);
    addMergedShadowProxy?.(holder, 6000);
    const L = Math.max(sz.x, sz.z) * scale, W = Math.min(sz.x, sz.z) * scale, H = sz.y * scale;
    if (this.models.tyre) {
      const { obj, size } = this._fitModel(this.models.tyre, 0.64);
      const inner = obj.children[0];
      const bb = new THREE.Box3().setFromObject(inner), s2 = bb.getSize(V(0, 0, 0));
      if (s2.y >= Math.min(s2.x, s2.z)) { if (s2.x < s2.z) obj.rotation.z = Math.PI / 2; else obj.rotation.x = Math.PI / 2; }
      obj.position.set(-L / 2 - 0.5, Math.min(size.x, size.y, size.z) / 2, W / 2 + 0.7);
      obj.traverse((o) => { if (o.isMesh) { o.material = o.material.clone(); o.material.color.multiplyScalar(0.5); } });
      root.add(obj);
      this._collider(local(-L / 2 - 0.5, 0.12, W / 2 + 0.7), V(0.3, 0.12, 0.3), d.rot, 'dirt', 'rgba(0,0,0,0)');
    }
    this._scorch(root, 7.5);
    this._collider(local(0, H / 2, 0), V(L / 2 - 0.1, H / 2, W / 2 - 0.05), d.rot, 'metal');
    const fy = H * 0.42;
    site.flames.push(
      { p: local(-0.15, fy, 0.12), w: 1.45, h: 2.2, k: 1.0 },
      { p: local(-0.8, fy, -0.2), w: 1.2, h: 1.8, k: 0.9 },
      { p: local(0.45, fy + 0.1, -0.25), w: 0.85, h: 1.3, k: 0.85 },
      { p: local(L * 0.33, H * 0.55, 0.1), w: 1.05, h: 1.25, k: 0.85 },
      { p: local(L * 0.28, 0.02, W / 2 + 0.05), w: 0.55, h: 0.55, k: 0.65 },
      { p: local(-L * 0.3, 0.02, -W / 2 - 0.05), w: 0.5, h: 0.45, k: 0.6 },
    );
    site.smokeAt = [local(-0.3, H + 0.9, 0), local(L * 0.3, H + 0.5, 0)];
    site.lightPos = local(0.2, H + 0.5, 0);
    site.spread = 0.6; site.rate = 7; site.smokeCol = [0.07, 0.065, 0.06]; site.smokeEnd = [0.16, 0.15, 0.145]; site.size = 1.1;
  }

  _uvScale(g, k) {
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * k, uv.getY(i) * k);
  }

  _buildBarrel(root, d, local, site) {
    let top = 0.88;
    if (this.models.stove) {
      const { obj, size } = this._fitModel(this.models.stove, 0.88, 'y');
      obj.position.y = size.y / 2;
      root.add(obj);
      top = size.y;
      this._collider(local(0, size.y / 2, 0), V(size.x / 2, size.y / 2, size.z / 2), d.rot, 'metal', 'rgba(210,215,220,0.3)');
    }
    this._scorch(root, 2.2);
    site.flames.push(
      { p: local(0, top - 0.2, 0), w: 0.8, h: 0.95, k: 0.85 },
      { p: local(0.12, top - 0.15, -0.08), w: 0.6, h: 0.75, k: 0.8 },
      { p: local(-0.12, top - 0.15, 0.08), w: 0.55, h: 0.65, k: 0.75 },
      { p: local(0.0, top - 0.1, 0.12), w: 0.45, h: 0.55, k: 0.7 },
    );
    site.smokeAt = [local(0, top + 0.9, 0)];
    site.lightPos = local(0, top + 0.6, 0);
    site.spread = 0.15; site.rate = 2.5; site.smokeCol = [0.16, 0.15, 0.14]; site.smokeEnd = [0.3, 0.29, 0.28]; site.size = 0.55;
  }

  _buildPile(root, d, local, site) {
    const beams = [];
    for (let i = 0; i < 7; i++) {
      const len = rand(1.3, 2.3), a = (i / 7) * Math.PI + rand(-0.2, 0.2);
      const lean = rand(0.05, 0.35);
      const g = uvBox(len, rand(0.12, 0.2), rand(0.12, 0.2), 1.6);
      place(g, rand(-0.25, 0.25), 0.12 + lean * 0.6 + (i % 3) * 0.08, rand(-0.25, 0.25), rand(-0.1, 0.1), a, lean);
      beams.push(g);
    }
    this._mesh(beams, this.mats.charWood, root);
    const rubble = [];
    for (let i = 0; i < 6; i++) {
      const s = rand(0.18, 0.4), a = rand(0, Math.PI * 2), r = rand(0.8, 1.3);
      rubble.push(place(uvBox(s * 1.4, s * 0.6, s), Math.cos(a) * r, s * 0.3, Math.sin(a) * r, 0, rand(0, 3), 0));
    }
    this._mesh(rubble, this.mats.char, root);
    this._scorch(root, 4.2);
    this._collider(local(0, 0.3, 0), V(0.95, 0.3, 0.75), d.rot, 'wood');
    site.flames.push(
      { p: local(0, 0.1, 0), w: 1.9, h: 2.5, k: 1.0 },
      { p: local(0.5, 0.05, 0.3), w: 1.2, h: 1.6, k: 0.85 },
      { p: local(-0.55, 0.05, -0.2), w: 1.1, h: 1.4, k: 0.85 },
      { p: local(0.1, 0.05, -0.5), w: 0.7, h: 0.9, k: 0.7 },
    );
    site.smokeAt = [local(0, 2.4, 0)];
    site.lightPos = local(0, 1.4, 0);
    site.spread = 0.5; site.rate = 5; site.smokeCol = [0.13, 0.115, 0.1]; site.smokeEnd = [0.25, 0.235, 0.22]; site.size = 1.0;
  }

  // ------------------------------------------------------------------ flames
  _buildFlameMesh() {
    const MAX = 32;
    const geo = new THREE.InstancedBufferGeometry();
    const plane = new THREE.PlaneGeometry(1, 1, 1, 4); plane.translate(0, 0.5, 0);
    geo.index = plane.index;
    geo.setAttribute('position', plane.attributes.position);
    geo.setAttribute('uv', plane.attributes.uv);
    this.fBase = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
    this.fSize = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4); // w, h, intensity, seed
    geo.setAttribute('iBase', this.fBase); geo.setAttribute('iSize', this.fSize);
    geo.instanceCount = 0;
    this.flameGeo = geo;
    this.flameMat = makeFlameMaterial();
    this.flameMesh = new THREE.Mesh(geo, this.flameMat);
    this.flameMesh.frustumCulled = false;
    this.flameMesh.renderOrder = 11;
    this.scene.add(this.flameMesh);
  }

  _writeFlames() {
    let n = 0;
    for (const s of this.sites) for (const f of s.flames) {
      if (n >= 32) break;
      f.seed ??= Math.random() * 10;
      this.fBase.setXYZ(n, f.p.x, f.p.y, f.p.z);
      this.fSize.setXYZW(n, f.w * 1.6, f.h * 1.35, f.k, f.seed);
      n++;
    }
    this.fBase.needsUpdate = this.fSize.needsUpdate = true;
    this.flameGeo.instanceCount = n;
  }

  // ------------------------------------------------------------------ runtime
  nearest(pos) {
    let best = null, bd = 1e9;
    for (const s of this.sites) { const d = s.lightPos.distanceTo(pos); if (d < bd) { bd = d; best = s; } }
    return { site: best, dist: bd };
  }

  update(dt, ctx) {
    this.time += dt;
    const t = this.time, wind = ctx.wind, k = ctx.particleScale;
    this.flameMat.uniforms.time.value = t;
    this.flameMat.uniforms.wind.value.copy(wind);
    syncFog(this.flameMat, this.scene);
    for (const s of this.sites) {
      const d = s.def, ph = s.phase;
      // Flicker: layered sines + jitter; lights sway slightly so shadows/highlights crawl.
      const fl = 0.78 + 0.12 * Math.sin(t * 9.1 + ph) + 0.08 * Math.sin(t * 23.7 + ph * 2) + 0.07 * (Math.random() - 0.5);
      if (s.light) {
        s.light.intensity = d.light * fl;
        s.light.position.set(s.lightPos.x + Math.sin(t * 5.3 + ph) * 0.12, s.lightPos.y + Math.sin(t * 7.1) * 0.1, s.lightPos.z + Math.cos(t * 4.7 + ph) * 0.12);
      }
      // Smoke.
      s.smokeAcc += dt * s.rate * k;
      while (s.smokeAcc >= 1) {
        s.smokeAcc -= 1;
        const at = s.smokeAt[(Math.random() * s.smokeAt.length) | 0], sp = s.spread, sz = s.size;
        this.smoke.spawn({
          x: at.x + rand(-sp, sp), y: at.y + rand(-0.2, 0.3), z: at.z + rand(-sp, sp),
          vx: rand(-0.3, 0.3), vy: rand(1.6, 2.6), vz: rand(-0.3, 0.3),
          life: rand(9, 15), size0: 0.7 * sz, size1: rand(6, 9) * sz, alpha: rand(0.5, 0.7), fadeIn: 0.04,
          color: s.smokeCol, color1: s.smokeEnd, colorSpan: 0.6,
          emissive: [0.9, 0.3, 0.07], emissiveSpan: 0.035,
          drag: 0.18, gravity: -0.05, wind: 0.9, turb: 0.25, rotV: rand(-0.25, 0.25),
        });
      }
      // Embers.
      s.emberAcc += dt * (s.rate * 2.2) * k;
      s.burstT -= dt;
      let burst = 0;
      if (s.burstT <= 0) { s.burstT = rand(4, 11); burst = (12 + Math.random() * 14) | 0; }
      while (s.emberAcc >= 1 || burst > 0) {
        if (burst > 0) burst--; else s.emberAcc -= 1;
        const f = s.flames[(Math.random() * s.flames.length) | 0];
        const sp = burst > 0 ? 3 : 1;
        this.embers.spawn({
          x: f.p.x + rand(-0.3, 0.3) * f.w, y: f.p.y + rand(0.2, 0.7) * f.h, z: f.p.z + rand(-0.3, 0.3) * f.w,
          vx: rand(-0.6, 0.6) * sp, vy: rand(1.2, 3.2) * (burst > 0 ? 1.6 : 1), vz: rand(-0.6, 0.6) * sp,
          life: rand(1.4, 3.6), size0: rand(0.012, 0.024), alpha: 1,
          color: [4.5, rand(1.2, 2.0), 0.35], drag: 0.6, gravity: -0.15, wind: 0.8, turb: 2.4,
        });
      }
    }
    const em = 1.6 + 0.5 * Math.sin(t * 1.3) + 0.25 * Math.sin(t * 4.1);
    if (this.mats) { this.mats.char.emissiveIntensity = em * 0.7; this.mats.charWood.emissiveIntensity = em; }
    this.smoke.update(dt, wind, ctx.camera, this.scene, ctx.light);
    this.embers.update(dt, wind, ctx.camera, this.scene, null);
  }
}
