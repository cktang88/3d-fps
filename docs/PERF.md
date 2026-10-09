# Performance (draw calls, triangles, load)

Owner: perf engineering. Budget at the default **High** quality, typical view, 960x540, including shadows:

| metric | budget |
|---|---|
| draw calls / frame (all passes) | **≤ 400** |
| triangles / frame (all passes) | **≤ 1.2 M** |
| load to menu (fast connection) | **≤ 20 s** |
| frame rate | stable 60 fps on a mid-range GPU |

Low/Medium must be meaningfully cheaper (see *Quality presets*).

## Tools

* **`src/render/Perf.js`** (exposed as `window.__perf`, created in `Game.init`):
  * `await __perf.capture({ detail })` resolves with the next rendered frame's per-pass cost:
    `world`, `shadow`, `ao_transparency` (N8AO's transparent re-render), `viewmodel`, `pip_scope`, `vm_light_probe`,
    `post_*`. With `detail: true`, every draw is attributed to `pass | owner | object`
    (`Perf.summarize(frame.objects)`).
  * `__perf.census()` returns scene counts by owner (`level`, `ambience`, `effects+viewmodel`, `bots`): meshes, instances,
    draw items, triangles, in-view, shadow casters, lights, materials. Owners are tagged in `Game.init` after each phase.
  * `__perf.top(n)` returns the biggest geometries (tris x instances) and textures (texels).
  * `__perf.loadTimeline()` returns init phase marks (`renderer → physics → assets loaded → level built → ambience → navmesh →
    shaders compiled`) plus a per-resource fetch timeline (Resource Timing).
* **QA job** `tools/qa/suites/perf_profile.json` (script `perf_profile.script.js`, 320x180; counts don't depend on
  resolution). Views: courtyard, sun, warehouse, containers, office, scope ADS (SCAR + ACOG), and courtyard with
  `window.__perfLegacy = true` (old shadow-map behaviour, for A/B).

      node tools/qa/submit.mjs perf tools/qa/suites/perf_profile.json

* **`src/render/Lod.js`**: runtime LOD built on meshoptimizer's simplifier (`three/addons/libs/meshopt_simplifier`,
  WASM, ~100 ms for 100k tris; Game.init awaits `lodReady`):
  * `simplifiedGeometry(geo, maxTris, error)` returns an index-only simplification. It shares all vertex attributes
    (skinning, UV seams), so it drops into a SkinnedMesh unchanged. Cached per source.
  * `simplifyObject(root, maxTris)` applies a whole-object budget.
  * `rigidLodTemplate(src, maxTris, error, drop)` builds a cached third-person LOD of a rigid model: simplified, with
    parts merged per material.
  * `addMergedShadowProxy(root, maxTris)` creates **one** simplified shadow-only caster for a multi-part object
    (rigid, or skinned parts sharing bones). The visible meshes stop casting.
  * `DistanceLod` swaps geometry by `distance * tan(fov/2)` (zoom-aware) with hysteresis.
  * Shadow-only layer (`SHADOW_PROXY_LAYER = 3`): three tests shadow casters against the *viewing* camera's layers
    after the main render list is built. `installShadowProxyLayer(renderer)` enables the layer only for the duration
    of `shadowMap.render`.
* **`__perf.cpuProfile(frames, render)`** gives main-thread ms per frame per subsystem (bots AI, Character, HUD,
  viewmodel, physics, ambience, …) at a fixed 60 Hz step. QA job: `tools/qa/suites/perf_cpu.json`.
* **`tools/perf/compress_textures.py [--delete] [--max N]`** converts PBR JPGs to WebP (q88, normal maps q90).

## Findings (baseline, before this pass)

Measured by the QA runner (SwiftShader/llvmpipe), one frame at High: **~1600 draw calls / 3.5 M tris**, load 48–100 s.
See the *Results* table for per-view numbers.

1. **The shadow map was rendered 3–4x per frame.** `shadowMap.autoUpdate` re-renders every shadow map on *every*
   `renderer.render(scene)`: the world pass, N8AO's two transparency passes (`transparencyAware` auto-detected), and
   the PiP scope. Shadow pass cost: ~170 calls / 735k tris, each time.
2. **Bot guns were full first-person assets.** `ak47.glb` alone is **97k tris** across 11 meshes. Every bot drew it in
   the world pass *and* the shadow pass, with `frustumCulled = false`. With 10 bots that is ~2M tris.
3. **Bots: 11 skinned parts (later 7 on soldier_tac) per body.** Each part was its own shadow draw. Full detail at any
   distance.
4. **The viewmodel light probe** (added during this pass) rendered the *whole* scene into one 32 px cube face every
   frame: 150–310 calls / 0.75–1.08M tris, as much as the main world pass.
5. **Props**: one InstancedMesh per prop part with a bounding sphere around *all* instances, so it is never culled and
   always draws every instance at full detail in world and shadow passes (crate ~87k, cardboard ~77k tris per pass).
6. **Load**: 50.6 MB of level PBR textures as high-quality JPEG (1–2 MB each at 1K), a 5.7 MB single JS chunk, the
   3.1 MB / 85k-tri UH-60 loaded before the menu, and ambience loading duplicate .gltf copies of three props with JPGs.
7. Point lights: 12 in the main scene (4 level interior, 3 fire, 1 flare, 4 muzzle-flash pool). Every lit fragment
   loops all of them, even at intensity 0.

## Fixes

| # | change | where | effect |
|---|---|---|---|
| 1 | Shadow maps render **once per frame**: `autoUpdate=false` + `needsUpdate=true` before the composer. | `Renderer.render` | -2 to -3 shadow passes per frame (scope, AO transparency) |
| 2 | Sun shadow-map size per quality (Low 1024 / Medium 2048 / High+ 4096), applied live from the menu. | `Renderer.applySettings`, `Level.setupEnvironment` | Low/Med cheaper; High unchanged |
| 3 | Bot gun: cached third-person LOD (≤ 3k tris, error 0.6%), SpareMagazine dropped, parts merged per material, normal frustum culling, merged shadow proxy (≤ 600 tris). | `Character.attachWeapon` + `Lod.rigidLodTemplate` | AK: 97k → ~5k tris, 11 → ~4 draws, 1 shadow draw |
| 4 | Bot body: one merged, simplified skinned shadow proxy (≤ 2k tris) instead of 7–11 shadow draws. Tiny rigid parts (eyes) no longer cast. | `Character` ctor + `Lod.addMergedShadowProxy` | bots shadow: ~10 → 2 draws per bot |
| 5 | Bot body distance LOD: ~30% mesh beyond `d*tan(fov/2) > 24` (~20 m at hip FOV; zoom-aware). | `Character` + `Lod.DistanceLod` | bots in view: ~30k → ~9k tris each |
| 6 | Props → `BatchedMesh` per part: still one (multi-)draw, but per-instance frustum culling (main, scope, shadow cameras) and a per-instance ~30% LOD beyond `d*tan(fov/2) > 28`. | `Level.finalizeProps` | prop tris scale with what's visible |
| 7 | Light probe draws only static level geometry, sky and lights (layer 4), one face every 2nd frame (High) / 4th (Medium), far 30 m. | `ViewModel` (viewmodel owner) | ~1M → ~100k tris, amortised |
| 8 | PiP scope RT per quality (256/384/512/768). It only renders while ADS (already the case) and is skipped on QA sim-only frames. | `ViewModel` | |
| 9 | Muzzle-flash light pool: 2 on Low, 4 otherwise. | `Effects` | -2 point lights on Low |
| 10 | Level textures JPEG → WebP at the same resolution: **50.6 MB → 13.7 MB** (normal maps q90, mean angular error ~4.5°, equal to a q90 JPEG re-encode). | `public/assets/textures`, `Assets.materialSet`, `Materials` | download -37 MB |
| 11 | Vite: vendor split into `three`, `postfx` (postprocessing + n8ao), `rapier`, `nav` (recast), plus game code (~400 kB). Separately cacheable chunks that load in parallel. | `vite.config.js` (`codeSplitting.groups`) | |
| 12 | UH-60 lazy-loaded after the menu (primitive heli as fallback), heli casts no shadow, burnt car uses a merged shadow proxy, ambience reuses the level's prop GLBs (ambience owner). | `Ambience`, `Flyover`, `Fires` | -3.1 MB before menu |
| 13 | Level: GroundedSkybox 96 → 48 segments, props re-simplified (level owner). | `Level` | |
| 14 | Props: shadow-only LOD (~12%, 2% error) chosen in `onBeforeShadow`; main-camera LOD in `onBeforeRender`, both chained in front of BatchedMesh's own culling hooks. | `Level.finalizeProps` | prop shadow tris roughly /3 |
| 15 | Bot occlusion culling: 6 rays per bot against thick static boxes only (fences, glass and grates never occlude). Hidden after 2 blocked frames; the merged shadow proxy keeps casting. | `render/Occlusion.js`, `Game.update` | ~15 draws saved per hidden bot |
| 16 | Point-light pool: every logical PointLight moves to a non-rendered layer, and N physical lights (Low 3 / Med 4 / High 6 / Ultra 8) mirror the most relevant lit, in-frustum ones. Fixed count, so no recompiles; fade-out 0.12 s. | `render/LightPool.js`, `Game` | lit-fragment light loop 12+ → ≤ 6 |
| 17 | Sun shadow map primed at init (`Renderer.primeShadows`), and a quality change no longer disposes it. Fixes `GL_INVALID_OPERATION ... sampler type` (three r186's array shadow sampler falls back to a compare-less empty depth texture). | `Renderer`, `Game.init` | correctness |
| 18 | Dynamic resolution (coordinator's `_updateDynRes`) made vsync-aware and oscillation-free: step down on misses; after 3 s at refresh rate, probe +5%; a failed probe is undone, its scale becomes a ceiling, and the next probe waits 4 s → 8 → … → 60 s. | `Renderer._updateDynRes` | converges; recovers after load drops |
| 19 | First-boot quality from the GPU tier (`WEBGL_debug_renderer_info`): integrated (Intel/UHD/Iris, Radeon iGPU) → Medium, software/mobile → Low, discrete → High. Applies only until the player picks a quality (`settings.qualityAuto`). | `Renderer.autoQuality`, `Menu` | |

## Results

(QA runner, High, warm page; `calls / tris` for the whole frame including shadow, AO, viewmodel, PiP, post.)

RESULTS_TABLE

## Quality presets (what each level costs)

| | Low | Medium | High | Ultra |
|---|---|---|---|---|
| pixel ratio cap | 0.75 | 1 | 1.25 | 2 |
| sun shadow map | 1024 | 2048 | 4096 | 4096 |
| N8AO | off | Low, half-res | Medium, half-res | High, full-res |
| bloom / god rays | off | on (32 samples) | on (48) | on (48) |
| PiP scope RT | 256 | 384 | 512 | 768 |
| viewmodel light probe | off | 1 face / 4 frames | 1 face / 2 frames | 1 face / 2 frames |
| muzzle-flash lights | 2 | 4 | 4 | 4 |
| ambience particles / rain | 0.4x / 500 | 0.65x / 2200 | 1x / 4000 | 1.25x / 6000 |

## Rules for new content

* **Repeated props** go through `Level.prop()` (BatchedMesh, culled, LOD'd). Never add per-instance `Mesh`es.
* **Multi-part movers** (characters, vehicles, guns) get `addMergedShadowProxy(root, budget)`, i.e. one shadow draw.
* **Heavy GLBs**: ≤ 15k tris for a hero prop, ≤ 5k for scattered props, ≤ 3k for third-person guns. Use
  `npx gltf-transform weld` + `simplify --ratio R --error 0.002`, or the runtime `Lod.js` helpers.
* **Textures**: 1K for props and surfaces, 2K only where it matters (ground, hero weapon). WebP, not JPEG
  (`tools/perf/compress_textures.py`).
* **Anything that renders the main scene from another camera** (probes, mirrors, scopes) must use a layer subset,
  render at a reduced rate, and never update shadow maps (`autoUpdate` stays false; `Renderer.render` owns `needsUpdate`).
* **Point lights**: every one costs every lit fragment. Pool them, keep the count fixed (changing it recompiles
  programs), and scale the pool by quality.
* Non-critical assets (flyovers, distant spectacle) load **after** the menu shows.
* Check with `perf_profile` before and after.
