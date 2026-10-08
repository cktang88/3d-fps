import * as THREE from 'three';
import { glowTex } from '../../render/ProcTex.js';
import { rand } from '../../core/MathUtil.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

function rotorDiscMat(blades, alpha) {
  return new THREE.ShaderMaterial({
    uniforms: { rot: { value: 0 }, alpha: { value: alpha }, tint: { value: new THREE.Color(0.05, 0.05, 0.045) } },
    vertexShader: 'varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: /* glsl */`
      uniform float rot; uniform float alpha; uniform vec3 tint; varying vec2 vP;
      void main() {
        float r = length(vP);
        if (r > 1.0) discard;
        float a = atan(vP.y, vP.x) - rot;
        // Motion-blurred blades: sharp leading edge, smeared trailing wake.
        float ph = fract(a * ${blades.toFixed(1)} / 6.2831853);
        float blade = exp(-ph * 7.0) * 0.8 + 0.2;
        float disc = smoothstep(1.0, 0.92, r) * smoothstep(0.06, 0.16, r);
        float tipRing = smoothstep(0.88, 0.97, r) * (1.0 - smoothstep(0.97, 1.0, r)) * 0.4;
        gl_FragColor = vec4(tint, (blade * disc + tipRing) * alpha);
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
}

/** Utility helicopter built from primitives (UH-1 style silhouette), ~13 m long. */
function buildHeli(unify) {
  const g = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({ name: 'amb_heli', color: 0x353a2c, roughness: 0.55, metalness: 0.35 });
  const dark = new THREE.MeshStandardMaterial({ name: 'amb_heli_dark', color: 0x1a1c18, roughness: 0.6, metalness: 0.4 });
  const glass = new THREE.MeshStandardMaterial({ name: 'amb_heli_glass', color: 0x0d1012, roughness: 0.08, metalness: 0.9 });
  unify(body); unify(dark); unify(glass);
  const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0, s) => {
    const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(rx, ry, rz);
    if (s) m.scale.set(...s);
    m.castShadow = true; g.add(m); return m;
  };
  // Fuselage (local: +z forward, +y up).
  add(new THREE.CapsuleGeometry(1.0, 2.6, 6, 14), body, 0, 0, 0, Math.PI / 2, 0, 0, [0.95, 1, 1.05]);
  add(new THREE.SphereGeometry(1.0, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), glass, 0, 0.12, 1.9, Math.PI / 2 - 0.35, 0, 0, [0.88, 0.95, 0.85]);
  add(new THREE.BoxGeometry(1.7, 1.25, 2.2), body, 0, -0.05, -0.2);
  // Doors open: dark cabin recess.
  add(new THREE.BoxGeometry(1.75, 0.95, 1.3), dark, 0, 0.0, -0.1);
  // Engine housing + exhaust.
  add(new THREE.CapsuleGeometry(0.45, 1.6, 4, 10), body, 0, 1.05, -0.6, Math.PI / 2);
  add(new THREE.CylinderGeometry(0.22, 0.26, 0.6, 10), dark, 0, 1.1, -1.75, Math.PI / 2);
  // Tail boom (tapered) + fins.
  const boom = new THREE.CylinderGeometry(0.2, 0.42, 6.4, 10); boom.rotateX(Math.PI / 2);
  add(boom, body, 0, 0.45, -4.6, -0.05);
  add(new THREE.BoxGeometry(0.1, 1.5, 0.9), body, 0, 1.15, -7.6, 0.45);
  add(new THREE.BoxGeometry(1.9, 0.06, 0.45), body, 0, 0.45, -6.0);
  // Skids.
  for (const s of [-1, 1]) {
    const skid = new THREE.CylinderGeometry(0.05, 0.05, 3.8, 6); skid.rotateX(Math.PI / 2);
    add(skid, dark, s * 1.05, -1.35, 0.1);
    for (const z of [-0.9, 0.9]) add(new THREE.CylinderGeometry(0.04, 0.04, 0.85, 6), dark, s * 0.85, -0.95, z, 0, 0, s * 0.45);
  }
  // Mast + hub.
  add(new THREE.CylinderGeometry(0.1, 0.12, 0.6, 8), dark, 0, 1.6, -0.2);
  add(new THREE.CylinderGeometry(0.25, 0.25, 0.14, 10), dark, 0, 1.9, -0.2);
  // Rotor discs + two visible blades (thin) for silhouette when edge-on.
  const disc = new THREE.Mesh(new THREE.CircleGeometry(7.2, 48), rotorDiscMat(2, 0.7));
  disc.rotation.x = -Math.PI / 2; disc.position.set(0, 1.95, -0.2); g.add(disc);
  const tdisc = new THREE.Mesh(new THREE.CircleGeometry(1.25, 24), rotorDiscMat(2, 0.6));
  tdisc.rotation.y = Math.PI / 2; tdisc.position.set(0.18, 1.3, -7.75); g.add(tdisc);
  const blades = new THREE.Group(); blades.position.set(0, 1.97, -0.2);
  const bl = new THREE.Mesh(new THREE.BoxGeometry(14.2, 0.04, 0.32), dark); blades.add(bl);
  g.add(blades);
  // Nav / anti-collision lights.
  const glow = glowTex();
  const light = (col, x, y, z, s) => {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: col, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false }));
    sp.position.set(x, y, z); sp.scale.setScalar(s); g.add(sp); return sp;
  };
  const navR = light(new THREE.Color(6, 0.3, 0.2), -1.0, 0.1, 0.6, 0.6);
  const navG = light(new THREE.Color(0.3, 6, 0.6), 1.0, 0.1, 0.6, 0.6);
  const beacon = light(new THREE.Color(9, 0.6, 0.3), 0, 1.45, -1.6, 1.2);
  const strobe = light(new THREE.Color(10, 10, 10), 0, 1.9, -7.8, 1.4);
  return { group: g, disc, tdisc, blades, navR, navG, beacon, strobe };
}

/** Fast jet silhouette (~16 m) with afterburner glow. */
function buildJet(unify) {
  const g = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({ name: 'amb_jet', color: 0x4a4f55, roughness: 0.5, metalness: 0.45 });
  unify(body);
  const add = (geo, x, y, z, rx = 0, ry = 0, rz = 0) => { const m = new THREE.Mesh(geo, body); m.position.set(x, y, z); m.rotation.set(rx, ry, rz); g.add(m); return m; };
  const fus = new THREE.CylinderGeometry(0.75, 0.9, 11, 12); fus.rotateX(Math.PI / 2); add(fus, 0, 0, -0.5);
  const nose = new THREE.ConeGeometry(0.75, 4, 12); nose.rotateX(Math.PI / 2); add(nose, 0, 0, 7);
  const wing = new THREE.BufferGeometry();
  wing.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 3, -5.5, 0, -3, 0, 0, -4, 0, 0, 3, 0, 0, -4, 5.5, 0, -3], 3));
  wing.computeVertexNormals();
  const w = new THREE.Mesh(wing, body); body.side = THREE.DoubleSide; g.add(w);
  const tail = new THREE.BufferGeometry();
  tail.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -3.5, 0, 3.2, -6.2, 0, 0, -6.2], 3));
  tail.computeVertexNormals();
  g.add(new THREE.Mesh(tail, body));
  const stab = new THREE.BufferGeometry();
  stab.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -4.2, -2.6, 0, -6.4, 2.6, 0, -6.4], 3));
  stab.computeVertexNormals();
  g.add(new THREE.Mesh(stab, body));
  const burner = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex(), color: new THREE.Color(8, 4, 1.6), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false }));
  burner.position.set(0, 0, -6.6); burner.scale.setScalar(3.2); g.add(burner);
  return { group: g, burner };
}

/**
 * Periodic flyovers: a utility helicopter low over the compound (rotor-blur disc, nav lights,
 * doppler rotor audio heard from its retarded position) and occasional fast-mover pairs high up.
 */
export class Flyover {
  constructor(amb) {
    this.amb = amb;
    this.scene = amb.scene;
    this.time = 0;
    const unify = (m) => amb.unify(m);
    this.heli = buildHeli(unify);
    this.heli.group.visible = false;
    this.scene.add(this.heli.group);
    this.jets = [buildJet(unify), buildJet(unify)];
    for (const j of this.jets) { j.group.visible = false; this.scene.add(j.group); }
    this.active = null;
    this.nextHeli = rand(18, 30);
    this.nextJet = rand(70, 110);
  }

  /**
   * Swap the primitive heli for the photoreal UH-60 (Sketchfab, CC-BY, see SOURCE.md) when it loads:
   * static rotor blades are hidden and replaced by our motion-blur discs at the real hub positions.
   */
  async load(assets) {
    const g = await assets.model('amb_uh60', 'ambience/models/uh60/uh60.glb');
    if (!g) return;
    const root = g.scene;
    root.updateMatrixWorld(true);
    const box = (o) => new THREE.Box3().setFromObject(o);
    let blades = null, tail = null, nose = null;
    const meshes = [];
    root.traverse((o) => { if (o.isMesh) meshes.push(o); });
    for (const m of meshes) {
      const n = m.material?.name || '', b = box(m), sz = b.getSize(V(0, 0, 0));
      if (n.includes('mainrotor') && (!blades || Math.max(sz.x, sz.z) > Math.max(...box(blades).getSize(V(0, 0, 0)).toArray()))) blades = m;
      if (n === 'DefaultWhite') tail = m;
      if (n.includes('instr1')) nose = m;
    }
    if (!blades) return;
    const bb = box(blades), bsz = bb.getSize(V(0, 0, 0)), hub = bb.getCenter(V(0, 0, 0));
    const scale = 16.4 / Math.max(bsz.x, bsz.z);
    // Hide static blades (and the blade-root ring) and the static tail rotor.
    for (const m of meshes) {
      const n = m.material?.name || '', b = box(m), sz = b.getSize(V(0, 0, 0));
      if (n.includes('mainrotor') && Math.max(sz.x, sz.z) > Math.max(bsz.x, bsz.z) * 0.3) m.visible = false;
      if (m === tail) m.visible = false;
      if (n.includes('Material.004')) m.visible = false;
      m.castShadow = true; m.receiveShadow = true;
      if (m.material) this.amb.unify(m.material);
    }
    const tb = tail ? box(tail) : null;
    const fuse = new THREE.Box3();
    for (const m of meshes) if (m.visible) fuse.union(box(m));
    const fc = fuse.getCenter(V(0, 0, 0));
    // Forward = from fuselage centre towards the cockpit instruments (horizontal).
    const fwd = (nose ? box(nose).getCenter(V(0, 0, 0)) : fuse.min.clone()).sub(fc).setY(0).normalize();
    const yaw = Math.atan2(fwd.x, fwd.z); // rotate model so fwd -> +z
    const holder = new THREE.Group();
    holder.add(root);
    root.position.sub(V(hub.x, fuse.min.y + (fuse.max.y - fuse.min.y) * 0.4, hub.z));
    holder.rotation.y = -yaw;
    holder.scale.setScalar(scale);
    const group = new THREE.Group();
    group.add(holder);
    group.updateMatrixWorld(true);
    // World positions of hub / tail rotor in group space.
    const hubL = holder.localToWorld(V(0, bb.max.y - (fuse.min.y + (fuse.max.y - fuse.min.y) * 0.4), 0));
    const disc = new THREE.Mesh(new THREE.CircleGeometry(8.2, 64), rotorDiscMat(4, 0.62));
    disc.rotation.x = -Math.PI / 2; disc.position.copy(hubL).add(V(0, 0.05, 0)); group.add(disc);
    let tdisc = this.heli.tdisc;
    if (tb) {
      const tc = holder.localToWorld(tb.getCenter(V(0, 0, 0)).sub(V(hub.x, fuse.min.y + (fuse.max.y - fuse.min.y) * 0.4, hub.z)));
      const ts = tb.getSize(V(0, 0, 0));
      tdisc = new THREE.Mesh(new THREE.CircleGeometry(Math.max(ts.x, ts.y, ts.z) * scale * 0.5, 32), rotorDiscMat(4, 0.6));
      tdisc.position.copy(tc); tdisc.rotation.y = Math.PI / 2; group.add(tdisc);
    }
    const fs = fuse.getSize(V(0, 0, 0)).multiplyScalar(scale);
    const len = Math.max(fs.x, fs.z), half = Math.min(fs.x, fs.z) / 2;
    const glow = this.heli.navR.material.map;
    const light = (col, x, y, z, s) => {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: col, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false }));
      sp.position.set(x, y, z); sp.scale.setScalar(s); group.add(sp); return sp;
    };
    const navR = light(new THREE.Color(6, 0.3, 0.2), -half * 0.9, 0, len * 0.12, 0.7);
    const navG = light(new THREE.Color(0.3, 6, 0.6), half * 0.9, 0, len * 0.12, 0.7);
    const beacon = light(new THREE.Color(9, 0.6, 0.3), 0, hubL.y - 0.6, -2.2, 1.3);
    const strobe = light(new THREE.Color(10, 10, 10), 0, hubL.y - 0.4, -len * 0.55, 1.5);
    const blades2 = new THREE.Group(); // keep API: thin blade proxy hidden (disc carries the read)
    group.visible = false;
    this.scene.remove(this.heli.group);
    this.scene.add(group);
    this.heli = { group, disc, tdisc, blades: blades2, navR, navG, beacon, strobe };
  }

  /** Smooth path across the compound: P0 far out → over the map → far out the other side. */
  _path(alt, offset, dist) {
    const a = rand(0, Math.PI * 2);
    const dir = V(Math.cos(a), 0, Math.sin(a)), side = V(-dir.z, 0, dir.x);
    const p0 = dir.clone().multiplyScalar(-dist).addScaledVector(side, rand(-60, 60)).setY(alt + rand(10, 25));
    const p1 = side.clone().multiplyScalar(offset).setY(alt);
    const p2 = dir.clone().multiplyScalar(dist).addScaledVector(side, rand(-120, 120)).setY(alt + rand(5, 30));
    return new THREE.CatmullRomCurve3([p0, p0.clone().lerp(p1, 0.5).setY(alt + 8), p1, p1.clone().lerp(p2, 0.5), p2], false, 'catmullrom', 0.5);
  }

  start(kind) {
    if (this.active) return;
    if (kind === 'heli') {
      const curve = this._path(rand(32, 48), rand(-35, 35), 520);
      this.active = { kind, curve, u: 0, speed: 42 / curve.getLength(), voice: this.amb.audio.vehicle('heli'), t: 0, prev: curve.getPoint(0) };
      this.heli.group.visible = true;
    } else {
      const curve = this._path(rand(160, 240), rand(-80, 80), 1400);
      this.active = { kind, curve, u: 0, speed: 230 / curve.getLength(), voice: this.amb.audio.vehicle('jet'), t: 0, prev: curve.getPoint(0) };
      for (const j of this.jets) j.group.visible = true;
    }
  }

  update(dt, ctx) {
    this.time += dt;
    if (!this.active) {
      if ((this.nextHeli -= dt) <= 0) { this.start('heli'); this.nextHeli = rand(110, 170); }
      else if ((this.nextJet -= dt) <= 0) { this.start('jet'); this.nextJet = rand(150, 240); }
      return;
    }
    const A = this.active;
    A.t += dt;
    A.u = Math.min(1, A.u + A.speed * dt);
    const p = A.curve.getPointAt(A.u), tan = A.curve.getTangentAt(Math.min(0.999, A.u + 0.001));
    const tan2 = A.curve.getTangentAt(Math.min(0.999, A.u + 0.03));
    const vel = p.clone().sub(A.prev).divideScalar(Math.max(1e-4, dt));
    A.prev.copy(p);
    // Bank into the turn, nose slightly down in forward flight.
    const turn = Math.atan2(tan.x * tan2.z - tan.z * tan2.x, tan.x * tan2.x + tan.z * tan2.z);
    const yaw = Math.atan2(tan.x, tan.z);
    // Fade in/out at the ends of the path (far beyond the fog anyway).
    const fade = Math.min(1, A.u * 12, (1 - A.u) * 12);
    if (A.voice) { A.voice.fade = fade; A.voice.set(this.time, p, vel); }
    if (A.kind === 'heli') {
      const h = this.heli;
      A.bank = THREE.MathUtils.damp(A.bank ?? 0, THREE.MathUtils.clamp(-turn * 18, -0.45, 0.45), 2, dt);
      h.group.position.copy(p).add(V(0, Math.sin(this.time * 0.8) * 0.4, 0));
      h.group.rotation.set(0, 0, 0);
      h.group.rotateY(yaw); h.group.rotateX(0.12 + Math.sin(this.time * 0.6) * 0.02); h.group.rotateZ(A.bank);
      h.disc.material.uniforms.rot.value = this.time * 5.3;
      h.tdisc.material.uniforms.rot.value = this.time * 23;
      h.blades.rotation.y = this.time * 31.4;
      const blink = (Math.sin(this.time * 7.5) > 0.85) ? 1 : 0;
      h.beacon.material.opacity = (this.time % 1.2) < 0.12 ? 1 : 0.0;
      h.strobe.material.opacity = blink;
    } else {
      this.jets.forEach((j, i) => {
        const off = V(i ? 22 : 0, i ? -6 : 0, i ? -30 : 0).applyAxisAngle(V(0, 1, 0), yaw);
        j.group.position.copy(p).add(off);
        j.group.rotation.set(0, 0, 0);
        j.group.rotateY(yaw); j.group.rotateZ(THREE.MathUtils.clamp(-turn * 40, -0.7, 0.7));
        j.burner.material.opacity = 0.75 + 0.25 * Math.random();
      });
    }
    if (A.u >= 1) {
      A.voice?.stop();
      this.heli.group.visible = false;
      for (const j of this.jets) j.group.visible = false;
      this.active = null;
    }
  }
}
