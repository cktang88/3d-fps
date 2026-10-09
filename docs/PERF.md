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

Per-pass capture (`perf_profile`, fresh page, warm frame first). The light-probe frames (every 2nd frame on High)
add about 35 calls / 105k tris on top of the numbers below.

| view | baseline (20:24, before) | after (job `1791484000041_perf_profile`) | shadow pass | PiP scope |
|---|---|---|---|---|
| courtyard | 788 / 3.11 M | **343 / 1.01 M** | 36 / 349k | – |
| looking at sun | 609 / 2.26 M | **363 / 0.89 M** | 35 / 346k | – |
| warehouse | 840 / 3.29 M | **249 / 1.06 M** | 34 / 343k | – |
| containers | 766 / 3.04 M | **252 / 0.92 M** | 35 / 346k | – |
| office | 604 / 2.28 M | **259 / 0.88 M** | 34 / 343k | – |
| scope ADS (SCAR, ACOG) | – | **356 / 1.37 M** (over on tris) | 35 / 346k | 101 / 346k |

Full-res 960x540 screenshot job `tools/qa/suites/perf_visual.json` (`1791484000040_perf_visual`), renderer.info after one
frame: courtyard 318 / 0.98 M, sun 358 / 0.87 M, warehouse 249 / 1.03 M, containers 332 / 0.98 M, office 256 / 0.85 M,
bot close-up 187 / 0.56 M, bot far 329 / 0.81 M, scope 258 / 1.01 M.

Shadow pass: ~170 calls / 735k tris x 3–4 renders per frame → **35 calls / ~345k tris x 1**.

Load (QA runner, contended llvmpipe, local server): 48–100 s → **13–23 s to menu**. Init marks for the last run:
assets 5.9 s → level built 10.0 s → ambience 10.4 s → navmesh 10.8 s → shaders 12.7 s. Network payload before
the menu: JS 6.5 MB (split into 5 chunks; rapier's base64 WASM is 4.2 MB of it), HDR 6.3 MB, GLB 36.6 MB (30 MB of it
FP rigs, see open items), WebP 23 MB, audio 1.2 MB.

CPU (`perf_cpu`, live TDM, 11 bots fighting, fixed 60 Hz, container CPU): **game.update 2.75 ms/frame**. Bots AI
1.1 ms, Character animation 0.8 ms, HUD 0.37 ms, viewmodel 0.30 ms, physics 0.28 ms, ambience 0.21 ms, player 0.12 ms,
occlusion 0.11 ms, nav 0.10 ms. Expect 2–3x on a mid laptop (~6–8 ms). Render submission (~340 draws plus 34 post
passes) is the other main-thread cost.

### Open items (owners notified)
* FP rigs (`models/fp`, FP art lead): 30 MB, `ak47` 130k tris, the arms textures duplicated in every file, no meshopt.
  Lazy-load the non-equipped rigs after the menu (viewmodel owner).
* Scope ADS is over on tris (1.37 M): the PiP re-renders the scene (346k). Options: PiP every 2nd frame on Medium,
  or a PiP-only far LOD.
* `models/weapons/ak47.glb` (97k tris) is still the player viewmodel source where no FP rig exists.
* QA warm pages: `FPCamera.fovCurrent` can carry a huge value between jobs (seen 2e33), which corrupts warm per-view
  numbers. perf jobs use `fresh: true`. Reported to the QA lead.

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

## Round 2: bake, cache, amortise, occlude

### Baked / cached (shipped as assets, or cached client-side)
| what | how | tool / file | effect |
|---|---|---|---|
| Navmesh | Recast navmesh serialised (`exportNavMesh`) and imported at boot when the FNV hash of `level.navGeos` matches; otherwise built as before | `node tools/perf/bake_nav.mjs` → `public/assets/nav/level.{bin,json}`; `Navigation.loadBaked` | 280 ms build → ~90 ms import |
| PVS | 4 m cells x 3 storeys; 15 eye points per cell ray-test samples on every level zone + prop instance; only thick static boxes occlude; each cell is dilated with its 8 neighbours (conservative) | `node tools/perf/bake_pvs.mjs [--jobs 6 --prio]` (runs in-game through the QA runner, ~20 s per job) → `public/assets/pvs/level.json` (70 KB, 342 targets, 1079 unique rows); runtime `src/render/Pvs.js` | culls hidden zones and prop instances; disables itself on a level-hash mismatch |
| Static sun shadow | Static casters (consolidated level + props) are drawn into the 4096 map **once**, and the depth is cached in a private RT. Each frame: three clears → a zero-draw "blitter" (first in traversal) `blitFramebuffer`s the cached depth back → dynamic casters draw on top. Re-bakes on resize or quality change. Same single map, so no shader changes | `src/render/ShadowCache.js` | shadow pass 35 calls / ~345k tris → ~33 calls / ~100k tris (only dynamic casters); pixel-identical (`perf_shadowcache.json` A/B) |
| Runtime LODs | meshopt results are persisted to IndexedDB, keyed by a content hash (positions + index + budget) and reused on later boots | `Lod.lodCacheLoad/lodCacheSave` | ~310–430 ms of simplification skipped from the 2nd boot on (verified: 86 entries stored) |
| Shaders | `compileAsync` (KHR_parallel_shader_compile) for both scenes during loading | `Game.init` | parallel compile; still all warmed before the menu |

### Amortised
* Bots (bots owner): perception/LOS ~8 Hz staggered, decisions 0.4–0.6 s, path requests only on target change or a 1.5 s repath. Animation rate-LOD by k=dist·tan(fov/2), off-screen and occluded. IK is skipped when off-screen or occluded.
* Bot occlusion: visible bots are re-tested every 2nd frame (alternating halves), hidden bots every frame, so a bot is never drawn late.
* Light pool: selection every 3rd frame, or immediately when a light turns on (muzzle flash). Values and positions are copied every frame.
* Prop LOD distances: recomputed every 3rd frame.
* HUD minimap: 15 Hz wall-clock (was every 2nd frame). DOM writes were already change-gated.
* Ambience (ambience owner): fires beyond 40 m or out of frustum tick every 3rd frame; DistantBattle smoke sim/sort every 2nd frame.
* Scope PiP: every 2nd frame on Medium/Low (always on the first ADS frame).
* FP rigs (FP art lead): only the loadout's primary and secondary load before the menu, the rest in the background. AK decimated 110k → 33k. Arms maps are shared. `MeshoptDecoder` is enabled in `Assets` for meshopt-compressed GLBs.

### Level zoning (for culling)
`Level.finalize` splits each material batch into zones: one per interior volume (warehouse, office, shed), the
exterior (`E`), and a global zone for pieces > 30 m. A first attempt with a 24 m grid produced 369 chunks and 1000+ draws.
Exterior splits cost more draws than they save, so the exterior is one zone.

### Bugs found and fixed this round
* **Two tiny GLB glasses with `KHR_materials_transmission`** (generator gauge, hanging-lamp glass) made three render
  every opaque object a second time into a transmission buffer **every frame**, which doubled world-pass draw calls. `Assets.model` now converts
  transmission to plain alpha glass.
* Dynamic resolution ran during the 1-fps headless page load, ratcheted down to 85%, and stayed there in QA shots
  ("chunky" viewmodel). It's off and reset to 100% under `navigator.webdriver` / `__qaFixedDt`.
* PVS/nav fallbacks log with `console.info` (no warnings). The baked files are shipped, so there are no 404s.

### Results (fresh page, High, warm frame first; calls / tris incl. shadow, AO, viewmodel, post)

| view | round 1 end (`…041`) | round 2 start (`…050`) | **now (`…064`)** |
|---|---|---|---|
| courtyard | 343 / 1.01 M | 217 / 0.76 M | **181 / 0.24 M** |
| sun | 363 / 0.89 M | 441 / 1.37 M | **368 / 0.70 M** |
| warehouse | 249 / 1.06 M | 247 / 1.01 M | **222 / 0.40 M** |
| containers | 252 / 0.92 M | 325 / 1.00 M | **244 / 0.37 M** |
| office | 259 / 0.88 M | 259 / 0.84 M | **213 / 0.38 M** |
| scope ADS | 356 / 1.37 M | 375 / 1.33 M | **314 / 0.54 M** |

Full-res 960x540 screenshot run (`…066_perf_visual`): courtyard 280 / 0.45 M, sun 230 / 0.35 M, warehouse 214 / 0.42 M,
containers 216 / 0.45 M, office 211 / 0.37 M, bot close 179 / 0.29 M, bot far 205 / 0.34 M, scope 221 / 0.44 M.

Shadow pass: 35 / ~345k → **~33 / ~100k** (static depth cached; only dynamic casters drawn).

PVS popping check (`perf_pvs_check.json`): 23 positions strafing past the warehouse door, along the office front and
across the warehouse interior, each rendered with the PVS off and on. Pixel diffs show only HUD/killfeed/viewmodel
sway; no geometry differs.

CPU (`perf_cpu`, live TDM, 60 Hz step): game.update **2.86 ms/frame**. physics 0.39, viewmodel 0.29, ambience 0.25,
occlusion 0.19, player 0.14, HUD 0.10 (was 0.37), nav 0.08; bots ≈1.3 ms for 11.

Load (shared llvmpipe runner, fresh page, contended): 18.8–28.6 s to menu (**init done in 9.2 s** in the cleanest
run: assets 3.9 s, level 4.9 s, ambience 5.3 s, navmesh 5.5 s (baked), shaders 9.2 s).

### Not done this round (and why)
* **Baked AO / lightmaps / irradiance grid:** this needs a lightmap-UV + raytrace bake pipeline for the procedural
  level, so it's a project of its own. N8AO already runs half-res on High. The viewmodel light probe now renders only static
  level geometry (layer 4), one cube face every 2nd frame (~35 calls / 100k tris on those frames). It's the obvious
  consumer of a baked irradiance grid later.
* **Separate tight dynamic cascade:** with the static map cached and blitted, dynamic casters cost ~33 calls /
  100k tris. A second cascade would add a second shadow sampler to every lit material variant for little gain.
* **GPU occlusion queries:** the PVS plus the bot ray-occlusion covers the static map. Queries add a frame of latency
  (popping) for small extra gains.
