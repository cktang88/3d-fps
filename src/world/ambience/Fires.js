import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { AmbParticles } from './AmbParticles.js';
import { NOISE, FOG, syncFog } from './glsl.js';
import { smokeAtlas, glowTex, scorchTex } from '../../render/ProcTex.js';
import { rand } from '../../core/MathUtil.js';

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
    this.embers = new AmbParticles(this.scene, { max: 500, texture: glowTex(), additive: true, stretch: 0.06, fogScale: 1, nearFade: 0.2 });

    this._buildFlameMesh();
  }

  async load() {
    const a = this.game.assets;
    const P = 'ambience/';
    const [stove, rim, tyre, diff, nor, arm] = await Promise.all([
      a.model('amb_barrel_stove', P + 'models/barrel_stove/barrel_stove.gltf'),
      a.model('amb_rim', P + 'models/rusted_wheel_rim_01/rusted_wheel_rim_01.gltf'),
      a.model('amb_tyre', P + 'models/old_tyre/old_tyre.gltf'),
      a.texture(P + 'textures/rusty_metal_04_diff_1k.jpg', true),
      a.texture(P + 'textures/rusty_metal_04_nor_gl_1k.jpg', false),
      a.texture(P + 'textures/rusty_metal_04_arm_1k.jpg', false),
    ]);
    this.models = { stove, rim, tyre };
    this.ember = emberTex();
    this.mats = {
      burnt: new THREE.MeshStandardMaterial({
        name: 'amb_burnt_metal', map: diff, normalMap: nor, roughnessMap: arm, metalnessMap: arm,
        color: new THREE.Color(0.42, 0.36, 0.33), roughness: 0.95, metalness: 0.85, normalScale: new THREE.Vector2(1.2, 1.2),
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
        name: 'amb_scorch', map: scorchTex(), transparent: true, depthWrite: false, polygonOffset: true,
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
    const ext = [], int = [];
    // Floor pan + sills (sits on the rims: tyres burnt away).
    ext.push(place(uvBox(4.3, 0.12, 1.66), 0, 0.26, 0));
    // Lower side panels with wheel arches; full-length upper belt.
    for (const s of [-1, 1]) {
      const z = s * 0.86;
      ext.push(place(uvBox(1.15, 0.3, 0.05), -0.05, 0.42, z, 0, 0, 0));
      ext.push(place(uvBox(0.45, 0.3, 0.05), 1.98, 0.42, z));
      ext.push(place(uvBox(0.5, 0.3, 0.05), -1.96, 0.42, z));
      ext.push(place(uvBox(4.3, 0.26, 0.05), 0, 0.7, z, s * 0.04, 0, 0));
      // Door gaps/creases read as thin dark strips.
      for (const x of [0.75, -0.35]) int.push(place(uvBox(0.02, 0.5, 0.06), x, 0.58, z));
    }
    // Front: hood popped & buckled, engine bay, bumper drooping.
    const hood = uvBox(1.25, 0.04, 1.62);
    hood.translate(0.62, 0, 0);
    ext.push(place(hood, 0.92, 0.84, 0, 0.05, 0, 0.24));
    int.push(place(uvBox(0.9, 0.42, 1.2), 1.55, 0.55, 0));
    ext.push(place(uvBox(0.06, 0.45, 1.62), 2.15, 0.58, 0));
    ext.push(place(uvBox(0.16, 0.2, 1.74), 2.2, 0.36, 0.06, 0.12, 0, -0.06));
    // Rear: trunk lid ajar, tail panel, bumper.
    ext.push(place(uvBox(0.95, 0.04, 1.6), -1.72, 0.86, 0, 0, 0, -0.1));
    ext.push(place(uvBox(0.06, 0.48, 1.62), -2.15, 0.6, 0));
    ext.push(place(uvBox(0.16, 0.2, 1.74), -2.2, 0.36, 0));
    // Greenhouse: roof (sagging) + A/B/C pillars, glass gone.
    ext.push(place(uvBox(1.55, 0.045, 1.3), -0.22, 1.33, 0, 0.03, 0, 0.03));
    for (const s of [-1, 1]) {
      ext.push(strut(V(0.98, 0.84, s * 0.8), V(0.56, 1.33, s * 0.64), 0.07, 0.08));
      ext.push(strut(V(-0.2, 0.84, s * 0.83), V(-0.2, 1.33, s * 0.65), 0.08, 0.1));
      ext.push(strut(V(-1.28, 0.86, s * 0.8), V(-0.98, 1.33, s * 0.64), 0.09, 0.1));
    }
    // Dashboard, seat frames, steering wheel.
    int.push(place(uvBox(0.32, 0.22, 1.5), 0.78, 0.86, 0));
    for (const z of [-0.4, 0.4]) {
      int.push(place(uvBox(0.5, 0.12, 0.48), 0.05, 0.48, z));
      int.push(place(uvBox(0.1, 0.6, 0.46), -0.22, 0.78, z, 0, 0, 0.2));
    }
    int.push(place(uvBox(0.55, 0.12, 1.4), -0.95, 0.48, 0));
    int.push(place(uvBox(0.12, 0.55, 1.4), -1.22, 0.76, 0, 0, 0, 0.25));
    const sw = new THREE.TorusGeometry(0.17, 0.016, 6, 18);
    int.push(place(sw, 0.55, 0.98, 0.4, 0, Math.PI / 2, 0.55));
    this._mesh(ext, this.mats.burnt, root);
    this._mesh(int, this.mats.char, root);
    // Rims (no tyres) at the wheel arches; a scorched loose tyre nearby.
    if (this.models.rim) {
      for (const [x, z, tilt] of [[1.38, 0.8, 0.12], [1.38, -0.8, -0.05], [-1.38, 0.8, 0.02], [-1.38, -0.8, -0.1]]) {
        const { obj } = this._fitModel(this.models.rim, 0.44);
        const inner = obj.children[0];
        // Thin axis → lateral (z).
        const bb = new THREE.Box3().setFromObject(inner), s = bb.getSize(V(0, 0, 0));
        if (s.x < s.y && s.x < s.z) obj.rotation.y = Math.PI / 2;
        else if (s.y < s.x && s.y < s.z) obj.rotation.x = Math.PI / 2;
        const w = new THREE.Group(); w.add(obj);
        w.position.set(x, 0.2, z * 0.98); w.rotation.x = tilt;
        root.add(w);
      }
    }
    if (this.models.tyre) {
      const { obj, size } = this._fitModel(this.models.tyre, 0.64);
      const inner = obj.children[0];
      const bb = new THREE.Box3().setFromObject(inner), s = bb.getSize(V(0, 0, 0));
      // Lay flat on the ground.
      if (s.y >= Math.min(s.x, s.z)) { if (s.x < s.z) obj.rotation.z = Math.PI / 2; else obj.rotation.x = Math.PI / 2; }
      obj.position.set(-2.6, Math.min(size.x, size.y, size.z) / 2, 1.7);
      obj.traverse((c) => { if (c.isMesh) { c.material = c.material.clone(); c.material.color.multiplyScalar(0.55); } });
      root.add(obj);
    }
    this._scorch(root, 7.5);
    this._collider(local(0, 0.7, 0), V(2.3, 0.7, 0.92), d.rot, 'metal');
    this._collider(local(-2.6, 0.12, 1.7), V(0.3, 0.12, 0.3), d.rot, 'dirt', 'rgba(0,0,0,0)');
    // Flames: cabin (two), engine bay, under-chassis lick.
    site.flames.push(
      { p: local(-0.1, 0.55, 0.1), w: 1.5, h: 2.5, k: 1.0 },
      { p: local(-0.75, 0.5, -0.15), w: 1.25, h: 2.0, k: 0.9 },
      { p: local(1.45, 0.7, 0.0), w: 1.2, h: 1.55, k: 0.85 },
      { p: local(1.2, 0.02, 0.85), w: 0.55, h: 0.65, k: 0.7 },
      { p: local(0.4, 0.75, -0.3), w: 0.8, h: 1.3, k: 0.8 },
    );
    site.smokeAt = [local(-0.3, 2.2, 0), local(1.3, 1.6, 0)];
    site.lightPos = local(0.2, 1.7, 0);
    site.spread = 0.6; site.rate = 7; site.smokeCol = [0.07, 0.065, 0.06]; site.smokeEnd = [0.16, 0.15, 0.145]; site.size = 1.1;
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
      { p: local(0, top - 0.15, 0), w: 0.72, h: 1.15, k: 1.0 },
      { p: local(0.08, top - 0.12, -0.06), w: 0.5, h: 0.85, k: 0.9 },
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
    this.flameMat = new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 }, wind: { value: new THREE.Vector3() },
        fogColor: { value: new THREE.Color() }, fogDensity: { value: 0 }, fogScale: { value: 1 },
      },
      vertexShader: /* glsl */`
        attribute vec3 iBase; attribute vec4 iSize;
        uniform float time; uniform vec3 wind;
        varying vec2 vUv; varying float vInt; varying float vSeed; varying float vDepth;
        void main() {
          vec3 toCam = cameraPosition - iBase; toCam.y = 0.0;
          vec3 right = normalize(vec3(toCam.z, 0.0, -toCam.x) + vec3(1e-5));
          float h = iSize.y * (0.92 + 0.1 * sin(time * 2.7 + iSize.w * 7.0) + 0.05 * sin(time * 7.3 + iSize.w));
          vec3 p = iBase + right * position.x * iSize.x + vec3(0.0, position.y * h, 0.0);
          float k = position.y * position.y;
          p.xz += wind.xz * k * h * 0.11 + vec2(sin(time * 3.1 + iSize.w), cos(time * 2.3 + iSize.w * 3.0)) * k * 0.08 * h;
          vec4 mv = viewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          vUv = uv; vInt = iSize.z; vSeed = iSize.w; vDepth = -mv.z;
        }`,
      fragmentShader: /* glsl */`
        uniform float time;
        ${NOISE}
        ${FOG}
        varying vec2 vUv; varying float vInt; varying float vSeed; varying float vDepth;
        void main() {
          float x = (vUv.x - 0.5) * 2.0, y = vUv.y;
          float n1 = a_fbm(vec2(x * 1.8 + vSeed * 3.1, y * 2.2 - time * 2.1));
          float n2 = a_fbm(vec2(x * 4.2 - vSeed, y * 4.6 - time * 3.9));
          float sway = (n1 - 0.45) * 0.9 * y;
          float w = (1.0 - pow(y, 1.15)) * 0.8 + 0.06;
          float d = abs(x + sway) / w;
          float shape = (1.0 - smoothstep(0.25, 1.0, d)) * smoothstep(0.0, 0.1, y);
          float heat = shape * (0.45 + n2 * 1.0) + n1 * 0.35 - y * 0.75 - 0.08;
          heat = clamp(heat * 1.7, 0.0, 1.0);
          vec3 col = mix(vec3(0.5, 0.04, 0.0), vec3(1.0, 0.28, 0.03), smoothstep(0.0, 0.3, heat));
          col = mix(col, vec3(1.0, 0.62, 0.2), smoothstep(0.3, 0.65, heat));
          col = mix(col, vec3(1.0, 0.92, 0.72), smoothstep(0.72, 1.0, heat));
          float a = smoothstep(0.03, 0.32, heat) * (1.0 - a_fog(vDepth));
          // Soft fade at the base (no hard edge where it meets geometry).
          a *= smoothstep(0.0, 0.06, y);
          if (a < 0.004) discard;
          gl_FragColor = vec4(col * vInt * (0.9 + 2.6 * heat), a);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
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
      this.fSize.setXYZW(n, f.w, f.h, f.k * 1.15, f.seed);
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
          emissive: [1.6, 0.55, 0.14], emissiveSpan: 0.09,
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
