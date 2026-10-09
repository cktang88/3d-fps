import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

// Collision groups: upper 16 bits = membership, lower 16 bits = filter.
export const G = {
  WORLD: 1 << 0,
  PLAYER: 1 << 1,
  BOT: 1 << 2,
  DEBRIS: 1 << 3,
  GLASS: 1 << 4,
};
export const groups = (member, filter) => ((member & 0xffff) << 16) | (filter & 0xffff);

export class Physics {
  static async create() {
    await RAPIER.init();
    return new Physics();
  }

  constructor() {
    this.R = RAPIER;
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = 1 / 60;
    this.accum = 0;
    this.colliderData = new Map(); // collider handle -> { material, object }
    this.dynamicLinks = []; // { body, object }
    this._ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
  }

  step(dt) {
    this.accum += Math.min(dt, 0.1);
    let steps = 0;
    while (this.accum >= this.world.timestep && steps < 8) {
      this.world.step();
      this.accum -= this.world.timestep;
      steps++;
    }
    for (const l of this.dynamicLinks) {
      const p = l.body.translation();
      const q = l.body.rotation();
      l.object.position.set(p.x, p.y, p.z);
      l.object.quaternion.set(q.x, q.y, q.z, q.w);
    }
  }

  tag(collider, data) {
    this.colliderData.set(collider.handle, data);
    return collider;
  }

  dataOf(collider) { return this.colliderData.get(collider.handle); }

  addStaticBox(center, half, quat, data = {}, group = G.WORLD) {
    const body = this.world.createRigidBody(
      this.R.RigidBodyDesc.fixed().setTranslation(center.x, center.y, center.z)
        .setRotation(quat ? { x: quat.x, y: quat.y, z: quat.z, w: quat.w } : { x: 0, y: 0, z: 0, w: 1 }),
    );
    const c = this.world.createCollider(
      this.R.ColliderDesc.cuboid(half.x, half.y, half.z).setCollisionGroups(groups(group, 0xffff)),
      body,
    );
    return this.tag(c, data);
  }

  // Static collider that exactly matches a mesh's oriented bounding box.
  addMeshBox(mesh, data = {}) {
    mesh.updateWorldMatrix(true, false);
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox;
    const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3();
    mesh.matrixWorld.decompose(pos, quat, scl);
    const localCenter = bb.getCenter(new THREE.Vector3());
    const size = bb.getSize(new THREE.Vector3()).multiply(scl).multiplyScalar(0.5);
    const center = localCenter.multiply(scl).applyQuaternion(quat).add(pos);
    return this.addStaticBox(center, size, quat, data);
  }

  addTrimesh(mesh, data = {}) {
    mesh.updateWorldMatrix(true, false);
    let g = mesh.geometry.index ? mesh.geometry : mesh.geometry;
    const posAttr = g.attributes.position;
    const verts = new Float32Array(posAttr.count * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < posAttr.count; i++) {
      v.fromBufferAttribute(posAttr, i).applyMatrix4(mesh.matrixWorld);
      verts[i * 3] = v.x; verts[i * 3 + 1] = v.y; verts[i * 3 + 2] = v.z;
    }
    let idx;
    if (g.index) idx = new Uint32Array(g.index.array);
    else { idx = new Uint32Array(posAttr.count); for (let i = 0; i < idx.length; i++) idx[i] = i; }
    const body = this.world.createRigidBody(this.R.RigidBodyDesc.fixed());
    const c = this.world.createCollider(
      this.R.ColliderDesc.trimesh(verts, idx).setCollisionGroups(groups(G.WORLD, 0xffff)), body);
    return this.tag(c, data);
  }

  addDynamicBox(object, half, mass = 1, velocity, angVel, group = G.DEBRIS) {
    const body = this.world.createRigidBody(
      this.R.RigidBodyDesc.dynamic()
        .setTranslation(object.position.x, object.position.y, object.position.z)
        .setRotation(object.quaternion)
        .setLinearDamping(0.1).setAngularDamping(0.4)
        .setCcdEnabled(true),
    );
    if (velocity) body.setLinvel(velocity, true);
    if (angVel) body.setAngvel(angVel, true);
    this.world.createCollider(
      this.R.ColliderDesc.cuboid(half.x, half.y, half.z).setMass(mass).setRestitution(0.35).setFriction(0.8)
        .setCollisionGroups(groups(group, G.WORLD | G.DEBRIS)),
      body,
    );
    const link = { body, object };
    this.dynamicLinks.push(link);
    return link;
  }

  removeDynamic(link) {
    const i = this.dynamicLinks.indexOf(link);
    if (i >= 0) this.dynamicLinks.splice(i, 1);
    this.world.removeRigidBody(link.body);
  }

  /**
   * Raycast against world geometry. Returns { point, normal, distance, collider, data } or null.
   * mask selects which membership groups are hit.
   */
  raycast(origin, dir, maxDist, mask = G.WORLD, exclude) {
    this._ray.origin = origin;
    this._ray.dir = dir;
    const hit = this.world.castRayAndGetNormal(
      this._ray, maxDist, true, undefined, groups(0xffff, mask), exclude,
    );
    if (!hit) return null;
    const t = hit.timeOfImpact;
    return {
      point: new THREE.Vector3(origin.x + dir.x * t, origin.y + dir.y * t, origin.z + dir.z * t),
      normal: new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z),
      distance: t,
      collider: hit.collider,
      data: this.dataOf(hit.collider) || {},
    };
  }

  // Cheap line-of-sight check used by AI.
  lineOfSight(a, b) {
    const d = new THREE.Vector3().subVectors(b, a);
    const len = d.length();
    if (len < 1e-4) return true;
    d.divideScalar(len);
    return !this.raycast(a, d, len - 0.05, G.WORLD);
  }
}
