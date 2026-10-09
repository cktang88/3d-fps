import * as THREE from 'three';

/**
 * Perf instrumentation (owned by perf engineering; see docs/PERF.md).
 *
 *   window.__perf.capture()            -> per-pass draw calls / triangles of the NEXT rendered frame (promise)
 *   window.__perf.census()             -> scene census by owner (meshes, materials, lights, shadow casters, tris)
 *   window.__perf.top(n)               -> biggest geometries (tris x instances) and textures (texels)
 *   window.__perf.loadTimeline()       -> init phase marks + per-resource fetch timeline (Resource Timing)
 *
 * Owners are tagged at init time (Game.init calls perf.tag(scene, owner) after each phase), so census is
 * independent of file names in the minified build.
 */
export class Perf {
  constructor(game) {
    this.game = game;
    this.marks = [];
    this.t0 = performance.now();
    this._frame = null;
    this._waiters = [];
    this.lastFrame = null;
  }

  mark(label) { this.marks.push({ label, t: Math.round(performance.now()) }); }

  /** Tag every not-yet-tagged object under `root` (default: scene top level) with an owner name. */
  tag(root, owner) {
    for (const c of root.children) {
      if (c.userData.perfOwner) continue;
      c.traverse((o) => { if (!o.userData.perfOwner) o.userData.perfOwner = owner; });
    }
  }

  /** Wrap WebGLRenderer.render / shadowMap.render so each pass's cost can be attributed. */
  install() {
    const R = this.game.renderer, r = R.renderer, self = this;
    if (r.__perfWrapped) return;
    r.__perfWrapped = true;
    const info = r.info.render;
    const origRender = r.render.bind(r);
    let depth = 0;
    r.render = function (scene, camera) {
      const f = self._frame;
      if (!f || depth > 0) { depth++; try { return origRender(scene, camera); } finally { depth--; } }
      const c0 = info.calls, t0 = info.triangles, sc0 = f.shadow.calls, st0 = f.shadow.tris;
      const tm = performance.now();
      depth++;
      self._pass = self._label(scene, camera, r.getRenderTarget());
      try { return origRender(scene, camera); } finally {
        self._pass = null;
        depth--;
        const label = self._label(scene, camera, r.getRenderTarget());
        const p = (f.passes[label] ||= { calls: 0, tris: 0, n: 0, ms: 0 });
        p.calls += info.calls - c0 - (f.shadow.calls - sc0);
        p.tris += info.triangles - t0 - (f.shadow.tris - st0);
        p.n++;
        p.ms += performance.now() - tm;
      }
    };
    const sm = r.shadowMap, origShadow = sm.render.bind(sm);
    sm.render = function (lights, scene, camera) {
      const f = self._frame;
      if (!f) return origShadow(lights, scene, camera);
      const c0 = info.calls, t0 = info.triangles;
      const willRender = sm.enabled && (sm.autoUpdate || sm.needsUpdate) && lights.length > 0;
      self._inShadow = true;
      try { origShadow(lights, scene, camera); } finally { self._inShadow = false; }
      f.shadow.calls += info.calls - c0;
      f.shadow.tris += info.triangles - t0;
      if (willRender) f.shadow.n++;
    };
    // Per-object attribution (capture({ detail: true })): which owner/object issues each draw in each pass.
    const origRBD = r.renderBufferDirect.bind(r);
    r.renderBufferDirect = function (camera, scene, geometry, material, object, group) {
      const f = self._frame;
      if (f?.objects) {
        const c0 = info.calls, t0 = info.triangles;
        origRBD(camera, scene, geometry, material, object, group);
        let ow = 'untagged';
        for (let p = object; p; p = p.parent) { if (p.userData?.perfOwner) { ow = p.userData.perfOwner; break; } if (self._botRoots?.has(p)) { ow = 'bots'; break; } }
        const key = (self._inShadow ? 'shadow' : self._pass || 'other') + ' | ' + ow + ' | ' + (object.name || object.type);
        const e = (f.objects[key] ||= { calls: 0, tris: 0 });
        e.calls += info.calls - c0; e.tris += info.triangles - t0;
        return;
      }
      return origRBD(camera, scene, geometry, material, object, group);
    };
    // Hook the whole game frame (the PiP scope renders during viewmodel.update, before Renderer.render).
    const G = this.game, origFrame = G.update.bind(G);
    G.update = function (...a) {
      if (!self._waiters.length) return origFrame(...a);
      const detail = self._waiters.some((w) => w.detail);
      self._frame = { passes: {}, shadow: { calls: 0, tris: 0, n: 0 }, objects: detail ? {} : null };
      if (detail) self._botRoots = new Set((G.bots || []).flatMap((b) => [b.model?.root, b.spareModel?.root]).filter(Boolean));
      const tm = performance.now();
      try { return origFrame(...a); } finally {
        const f = self._frame; self._frame = null;
        f.cpuMs = Math.round(performance.now() - tm);
        f.total = Object.values(f.passes).reduce((t, p) => ({ calls: t.calls + p.calls, tris: t.tris + p.tris }), { calls: f.shadow.calls, tris: f.shadow.tris });
        for (const p of Object.values(f.passes)) p.ms = Math.round(p.ms);
        self.lastFrame = f;
        const w = self._waiters; self._waiters = [];
        for (const fn of w) fn(f);
      }
    };
  }

  _label(scene, camera, target) {
    const R = this.game.renderer, vm = this.game.viewmodel;
    if (scene === R.scene) {
      if (vm && camera === vm.scopeCam) return 'pip_scope';
      if (vm?.probeCams?.includes(camera)) return 'vm_light_probe';
      if (camera === R.camera) return target && this._aoTargets().has(target) ? 'ao_transparency' : 'world';
      return 'world_other_cam';
    }
    if (scene === R.viewScene) return 'viewmodel';
    if (scene?.isMesh) return 'post_quad';
    return 'post_' + (scene?.name || scene?.type || 'scene');
  }

  _aoTargets() {
    const ao = this.game.renderer.aoPass;
    return new Set([ao?.transparencyRenderTargetDWFalse, ao?.transparencyRenderTargetDWTrue].filter(Boolean));
  }

  /** Resolves with per-pass stats for the next frame that goes through Renderer.render. */
  capture(opt = {}) {
    this.install();
    return new Promise((res) => { res.detail = !!opt.detail; this._waiters.push(res); });
  }

  /** Collapse capture({detail:true}).objects into per pass|owner totals + the top N objects. */
  static summarize(objects, n = 30) {
    const byOwner = {};
    for (const [k, v] of Object.entries(objects || {})) {
      const [pass, ow] = k.split(' | ');
      const e = (byOwner[pass + ' | ' + ow] ||= { calls: 0, tris: 0 });
      e.calls += v.calls; e.tris += v.tris;
    }
    const top = Object.entries(objects || {}).sort((a, b) => b[1].calls - a[1].calls).slice(0, n).map(([k, v]) => `${k}: ${v.calls}c ${Math.round(v.tris / 1000)}kt`);
    const topTris = Object.entries(objects || {}).sort((a, b) => b[1].tris - a[1].tris).slice(0, n).map(([k, v]) => `${k}: ${v.calls}c ${Math.round(v.tris / 1000)}kt`);
    return { byOwner: Object.fromEntries(Object.entries(byOwner).sort((a, b) => b[1].calls - a[1].calls).map(([k, v]) => [k, `${v.calls}c ${Math.round(v.tris / 1000)}kt`])), top, topTris };
  }

  // ------------------------------------------------------------------ CPU
  /**
   * Per-subsystem main-thread CPU time over `frames` simulated frames (fixed dt, GPU render skipped unless
   * `render`). Wraps the per-frame entry points of each subsystem temporarily. Returns ms/frame (mean + p95).
   */
  async cpuProfile(frames = 120, render = false) {
    const g = this.game, timers = {};
    const wrap = (obj, fn, label) => {
      if (!obj?.[fn]) return null;
      const orig = obj[fn];
      obj[fn] = function (...a) {
        const t = performance.now();
        try { return orig.apply(this, a); } finally { (timers[label] ||= []).push(performance.now() - t); }
      };
      return () => { obj[fn] = orig; };
    };
    const undo = [
      wrap(g, 'update', 'TOTAL game.update'),
      wrap(g.match, 'update', 'match'),
      wrap(g.player, 'update', 'player'),
      wrap(g.nav, 'update', 'nav'),
      wrap(g.ballistics, 'update', 'ballistics'),
      wrap(g.physics, 'step', 'physics.step'),
      wrap(g.fpcam, 'update', 'fpcam'),
      wrap(g.viewmodel, 'update', 'viewmodel'),
      wrap(g.effects, 'update', 'effects'),
      wrap(g.ambience, 'update', 'ambience'),
      wrap(g.hud, 'update', 'hud'),
      wrap(g.botOcclusion, 'update', 'botOcclusion'),
      wrap(g.audio, 'updateListener', 'audio'),
      wrap(g.renderer, 'render', 'renderer.render (JS+GL submit)'),
      ...(g.bots || []).map((b) => wrap(b, 'update', 'bots (AI+anim)')),
      ...(g.bots || []).map((b) => wrap(b.model, 'update', 'bots: Character.update')),
      ...(g.currentWeapon ? [wrap(g.currentWeapon, 'update', 'weapon')] : []),
    ].filter(Boolean);
    const wasSkip = window.__qaSkipRender, wasDt = window.__qaFixedDt;
    window.__qaFixedDt = 1 / 60;
    window.__qaSkipRender = !render;
    try {
      for (let i = 0; i < frames; i++) await new Promise((r) => requestAnimationFrame(() => r()));
    } finally {
      for (const u of undo) u();
      window.__qaSkipRender = wasSkip; window.__qaFixedDt = wasDt;
    }
    const n = timers['TOTAL game.update']?.length || 1;
    const out = {};
    for (const [k, arr] of Object.entries(timers)) {
      const sum = arr.reduce((a, b) => a + b, 0);
      // Sum of all calls per frame (bots: 11 calls/frame), p95 over per-call samples.
      const sorted = [...arr].sort((a, b) => a - b);
      out[k] = { msPerFrame: +(sum / n).toFixed(3), callsPerFrame: +(arr.length / n).toFixed(1), p95call: +sorted[Math.floor(sorted.length * 0.95)]?.toFixed(3) };
    }
    return Object.fromEntries(Object.entries(out).sort((a, b) => b[1].msPerFrame - a[1].msPerFrame));
  }

  // ------------------------------------------------------------------ census
  census() {
    const g = this.game, scene = g.renderer.scene;
    const botRoots = new Set((g.bots || []).map((b) => b.model?.root).filter(Boolean));
    const owners = {};
    const own = (o) => {
      for (let p = o; p; p = p.parent) { if (botRoots.has(p)) return 'bots'; if (p.userData?.perfOwner) return p.userData.perfOwner; }
      return 'untagged';
    };
    const mats = new Map(), lights = [];
    scene.updateMatrixWorld();
    const sun = g.level?.sun;
    let shadowFrustum = null;
    if (sun) {
      sun.shadow.updateMatrices(sun);
      shadowFrustum = sun.shadow.getFrustum();
    }
    const camFrustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(g.renderer.camera.projectionMatrix, g.renderer.camera.matrixWorldInverse));
    const sph = new THREE.Sphere();
    scene.traverseVisible((o) => {
      const ow = own(o);
      const O = (owners[ow] ||= { meshes: 0, instanced: 0, instances: 0, skinned: 0, points: 0, drawItems: 0, tris: 0, inView: 0, inViewTris: 0, casters: 0, casterTris: 0, castersInShadowFrustum: 0, lights: 0, shadowLights: 0, materials: new Set(), transparent: 0 });
      if (o.isLight) { O.lights++; if (o.castShadow) O.shadowLights++; lights.push({ type: o.type, owner: ow, castShadow: o.castShadow, intensity: +o.intensity.toFixed(2), dist: o.distance }); return; }
      if (!(o.isMesh || o.isPoints || o.isLine || o.isSprite)) return;
      const geo = o.geometry; if (!geo) return;
      const matsArr = Array.isArray(o.material) ? o.material : [o.material];
      const items = Array.isArray(o.material) ? Math.max(1, geo.groups.length) : 1;
      const cnt = o.isInstancedMesh ? o.count : o.isBatchedMesh ? (o._instanceInfo?.filter((x) => x.active && x.visible).length ?? 1) : 1;
      const prim = geo.index ? geo.index.count : geo.attributes.position?.count ?? 0;
      const range = Math.min(prim, geo.drawRange.count);
      const tris = (o.isMesh ? range / 3 : 0) * (geo.isInstancedBufferGeometry ? (geo.instanceCount === Infinity ? 1 : geo.instanceCount) : 1) * cnt;
      O.meshes++; if (o.isInstancedMesh) { O.instanced++; O.instances += cnt; } if (o.isSkinnedMesh) O.skinned++; if (o.isPoints) O.points++;
      O.drawItems += items; O.tris += tris;
      for (const m of matsArr) { O.materials.add(m); mats.set(m, (mats.get(m) || 0) + 1); if (m.transparent) O.transparent++; }
      if (!geo.boundingSphere) geo.computeBoundingSphere();
      let bs = geo.boundingSphere;
      if (o.isInstancedMesh || o.isBatchedMesh) { if (!o.boundingSphere) o.computeBoundingSphere(); bs = o.boundingSphere; }
      sph.copy(bs).applyMatrix4(o.matrixWorld);
      const inView = !o.frustumCulled || camFrustum.intersectsSphere(sph);
      if (inView) { O.inView += items; O.inViewTris += tris; }
      if (o.castShadow && o.isMesh) {
        O.casters += items; O.casterTris += tris;
        if (shadowFrustum && (!o.frustumCulled || shadowFrustum.intersectsSphere(sph))) O.castersInShadowFrustum += items;
      }
    });
    for (const O of Object.values(owners)) { O.materials = O.materials.size; O.tris = Math.round(O.tris); O.inViewTris = Math.round(O.inViewTris); O.casterTris = Math.round(O.casterTris); }
    const ri = g.renderer.renderer.info;
    return {
      owners, lights,
      uniqueMaterials: mats.size,
      programs: ri.programs?.length,
      memory: { ...ri.memory },
      shadowMapSize: sun ? sun.shadow.mapSize.x : 0,
      viewScene: this._sceneSummary(g.renderer.viewScene),
    };
  }

  _sceneSummary(scene) {
    let meshes = 0, tris = 0;
    scene.traverseVisible((o) => { if (o.isMesh && o.geometry) { meshes++; const geo = o.geometry; tris += (geo.index ? geo.index.count : geo.attributes.position.count) / 3; } });
    return { meshes, tris: Math.round(tris) };
  }

  /** Biggest geometries (by total rendered tris) and textures (by texels) in both scenes. */
  top(n = 25) {
    const g = this.game, geos = new Map(), texs = new Map();
    const addTex = (t, where) => {
      if (!t?.isTexture) return;
      const img = t.image; const w = img?.width || img?.data?.width || 0, h = img?.height || img?.data?.height || 0;
      const k = texs.get(t) || { name: t.name || (img?.currentSrc || img?.src || '').split('/assets/').pop() || t.constructor.name, w, h, users: new Set() };
      k.users.add(where); texs.set(t, k);
    };
    for (const scene of [g.renderer.scene, g.renderer.viewScene]) {
      scene.traverse((o) => {
        if (!o.geometry || !(o.isMesh || o.isPoints)) return;
        const geo = o.geometry; const cnt = o.isInstancedMesh ? o.count : 1;
        const t = (geo.index ? geo.index.count : geo.attributes.position?.count ?? 0) / 3;
        const e = geos.get(geo) || { name: o.name || o.parent?.name || geo.type, owner: o.userData.perfOwner || (o.isSkinnedMesh ? 'bots?' : ''), tris: Math.round(t), uses: 0, instances: 0, cast: false };
        e.uses++; e.instances += cnt; e.cast ||= o.castShadow; geos.set(geo, e);
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          if (!m) continue;
          for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap', 'bumpMap']) addTex(m[k], m.name || o.name);
          for (const u of Object.values(m.uniforms || {})) addTex(u?.value, m.name || o.name);
        }
      });
    }
    const G = [...geos.values()].map((e) => ({ ...e, total: e.tris * e.instances })).sort((a, b) => b.total - a.total).slice(0, n);
    const T = [...texs.values()].map((e) => ({ name: e.name, w: e.w, h: e.h, mpx: +((e.w * e.h) / 1e6).toFixed(2), users: e.users.size, eg: [...e.users].slice(0, 3).join(',') }))
      .sort((a, b) => b.mpx - a.mpx);
    const texTotalMpx = +T.reduce((s, t) => s + t.mpx, 0).toFixed(1);
    return { geometries: G, textures: T.slice(0, n), textureCount: T.length, texTotalMpx };
  }

  loadTimeline() {
    const res = performance.getEntriesByType('resource').map((e) => ({
      name: e.name.split('/assets/').pop().split('/').slice(-2).join('/'),
      start: Math.round(e.startTime), end: Math.round(e.responseEnd), kb: Math.round((e.encodedBodySize || e.transferSize || 0) / 1024),
    }));
    const byType = {};
    for (const r of res) { const ext = (r.name.match(/\.(\w+)$/) || [, 'other'])[1]; const b = (byType[ext] ||= { n: 0, kb: 0 }); b.n++; b.kb += r.kb; }
    return {
      marks: this.marks, resources: res.length, byType,
      slowest: [...res].sort((a, b) => (b.end - b.start) - (a.end - a.start)).slice(0, 15),
      largest: [...res].sort((a, b) => b.kb - a.kb).slice(0, 20),
      lastResourceEnd: Math.max(0, ...res.map((r) => r.end)),
    };
  }
}
