import * as THREE from 'three';
import { init as recastInit, NavMeshQuery, Crowd, importNavMesh, exportNavMesh } from '@recast-navigation/core';
import { threeToSoloNavMesh } from '@recast-navigation/three';

/** Recast navmesh (generated at load from level geometry) + Detour crowd for bot movement. */
export class Navigation {
  static async create(level) {
    await recastInit();
    const nav = new Navigation(level);
    // Perf: load the baked navmesh (tools/perf/bake_nav.mjs) when the nav input geometry hash matches;
    // otherwise build at boot as before.
    if (!(await nav.loadBaked())) nav.build();
    return nav;
  }

  /** Hash of the navmesh input (rounded positions of level.navGeos), so a stale bake is never used. */
  inputHash() {
    let h = 0x811c9dc5;
    const mix = (v) => { h ^= v; h = Math.imul(h, 16777619); };
    for (const g of this.level.navGeos) {
      const p = g.attributes.position.array;
      for (let i = 0; i < p.length; i++) mix(Math.round(p[i] * 100) | 0);
      mix(g.index ? g.index.count : -1);
    }
    return (h >>> 0).toString(16);
  }

  async loadBaked(url = './assets/nav/level') {
    const t0 = performance.now();
    try {
      const meta = await (await fetch(url + '.json')).json();
      if (meta.hash !== this.inputHash()) { console.warn('navmesh bake is stale (level changed); building at boot. Run node tools/perf/bake_nav.mjs'); return false; }
      const bin = new Uint8Array(await (await fetch(url + '.bin')).arrayBuffer());
      const { navMesh } = importNavMesh(bin);
      this._init(navMesh);
      this.buildTime = performance.now() - t0;
      this.baked = true;
      return true;
    } catch (e) { return false; }
  }

  /** For the bake tool: serialised navmesh + input hash. */
  exportBaked() { return { hash: this.inputHash(), bin: exportNavMesh(this.navMesh) }; }

  _init(navMesh) {
    this.navMesh = navMesh;
    this.query = new NavMeshQuery(navMesh);
    this.crowd = new Crowd(navMesh, { maxAgents: 24, maxAgentRadius: 0.6 });
    this.halfExtents = { x: 2, y: 3, z: 2 };
  }

  constructor(level) {
    this.level = level;
  }

  build() {
    const meshes = this.level.navGeos.map((g) => new THREE.Mesh(g));
    const cs = 0.2, ch = 0.15;
    const t0 = performance.now();
    const { success, navMesh, error } = threeToSoloNavMesh(meshes, {
      cs, ch,
      walkableSlopeAngle: 45,
      walkableHeight: Math.ceil(1.7 / ch),
      walkableClimb: Math.floor(0.42 / ch),
      walkableRadius: Math.ceil(0.35 / cs),
      maxEdgeLen: 12 / cs,
      maxSimplificationError: 1.3,
      minRegionArea: 16,
      mergeRegionArea: 40,
      maxVertsPerPoly: 6,
      detailSampleDist: 6,
      detailSampleMaxError: 1,
      bounds: [[-60, -1, -60], [60, 12, 60]],
    });
    if (!success) throw new Error('navmesh failed: ' + error);
    this._init(navMesh);
    this.buildTime = performance.now() - t0;
    console.info(`navmesh built in ${this.buildTime.toFixed(0)}ms`);
  }

  addAgent(pos) {
    return this.crowd.addAgent(pos, {
      radius: 0.4, height: 1.8, maxAcceleration: 9, maxSpeed: 4.4, // human-like starts/stops/reversals
      collisionQueryRange: 2.5, pathOptimizationRange: 12, separationWeight: 1.5,
      updateFlags: 0x1 | 0x2 | 0x4 | 0x8 | 0x10, // anticipate turns, obstacle avoidance, separation, optimize vis, optimize topo
      obstacleAvoidanceType: 3,
    });
  }

  removeAgent(agent) { this.crowd.removeAgent(agent); }

  update(dt) { this.crowd.update(Math.min(dt, 0.05)); }

  closest(p) {
    const r = this.query.findClosestPoint({ x: p.x, y: p.y, z: p.z }, { halfExtents: this.halfExtents });
    if (!r.success) return null;
    return new THREE.Vector3(r.point.x, r.point.y, r.point.z);
  }

  randomPointAround(p, radius) {
    const near = this.query.findNearestPoly({ x: p.x, y: p.y, z: p.z }, { halfExtents: this.halfExtents });
    if (!near.success) return null;
    const r = this.query.findRandomPointAroundCircle({ x: p.x, y: p.y, z: p.z }, radius, { startRef: near.nearestRef });
    if (!r.success) return null;
    const v = new THREE.Vector3(r.randomPoint.x, r.randomPoint.y, r.randomPoint.z);
    if (Math.abs(v.y - p.y) > 3.5) return null;
    return v;
  }

  randomPatrolPoint(bot) {
    const pts = this.level.patrolPoints;
    // Prefer points not too close, with some randomness; weighted toward map centre & enemy side.
    for (let i = 0; i < 6; i++) {
      const p = pts[(Math.random() * pts.length) | 0];
      if (p.distanceTo(bot.position) > 8) return this.closest(p) ?? p.clone();
    }
    return null;
  }

  /** Debug mesh of the navmesh polygons. */
  debugMesh() {
    const [positions, indices] = this.navMesh.getDebugNavMesh();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setIndex(indices);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x00ffaa, wireframe: true, transparent: true, opacity: 0.4 }));
    m.position.y = 0.05;
    return m;
  }
}
