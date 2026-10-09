# Art pipeline — how every asset is made to belong

Ironline's look: **stormy golden hour just after rain** at the edge of a war zone. Photoreal CC0 scans
(Poly Haven / ambientCG) only look like one world if they share one material response, one weathering
layer, one light and one grade. This file is the contract; follow it for anything you add.

## 1. Sourcing & import
- World art: CC0 photoreal PBR sources (Poly Haven models/HDRIs, ambientCG materials). Weapons, characters and
  vehicles may be CC BY (licence rules in `docs/QUALITY_BAR.md`). Record every shipped asset in the README credits.
- Props: download the 1k glTF, then optimise into a single `.glb`:
  `gltf-transform optimize in.gltf out.glb --compress false --texture-compress webp --texture-size 1024 --simplify true --simplify-ratio <r>`
  (target ≤ ~8k tris for anything placed more than a few times). Put it in `public/assets/models/props/<id>/`.
- Level surface sets live in `public/assets/textures/<Set>/{Color,NormalGL,Roughness}.webp`
  (alpha sets: `ColorA.webp`). Bake ambient occlusion into Color for ground sets. 1K is the budget
  (`tools/perf/compress_textures.py` converts JPGs to WebP and caps the size).
- Level geometry uses world-space UVs (`Geo.worldBox`, `Level.mesh(..., {worldUV})`, `Level.cyl` length-correct UVs),
  so texel density is constant (~2 m per tile on walls, 3–5 m on ground).

## 2. The unify pass (`Materials.applyUnify(mat, preset)`)
One shader patch applied to **every lit material** (level, props, bots; viewmodel with the `viewmodel` preset).
`Level.applyInteriorOcclusion()` runs it over the whole world scene after load, so new world content gets it for free;
call it yourself for anything spawned later (`game.materials.applyUnify(mat, 'prop' | 'character')`).
It does, in order:
1. **Normalisation** — albedo luminance clamped to a PBR band (≈0.02–0.70 linear), saturation pulled to the palette,
   roughness remapped into `[rmin, 1]` (nothing plastic or chalky), normal-map intensity clamped to a common band.
2. **Shared weathering** — world-space triplanar grime/tint variation (breaks tiling, ties surfaces together),
   ground-contact dirt band on vertical faces (bottom ~0.9 m, incl. props and boots), dust on indoor floors.
3. **Global wetness** (`Materials.unify.uWet`) — exposed up-facing surfaces darken and gloss, walls get rain streaks,
   ground sets (`puddle: 1`) collect mirror puddles in low areas of a world noise field. Indoors stays dry.
   `Materials.unify.uRain` (0..1) adds animated ripple rings in puddles if it is raining.
4. **Indoor IBL attenuation** — inside the building volumes the sky light is reduced so interiors read darker and
   practical lights (sodium / fluorescent) carry them.

Presets: `level`, `prop`, `character`, `viewmodel` (`Materials.PRESETS`), or pass an object
`{ grime, wet, puddle, rmin, sat, contact, streaks }`. Transparent materials are skipped unless `alphaOK`.

## 3. Grounding
- Every prop/container/sandbag/pallet placed on the ground gets a soft contact blob (`Level.blob`), N8AO adds
  small-scale contact occlusion; rain-streak decals (`leakDecal`) run down walls under roofs and windows.
- Nothing floats: `Level.prop()` rests the (tilted) bounding box on `y`; use `mount: true` for wall/ceiling fixtures.

## 4. Light
- One HDRI (Poly Haven *Bambanani Sunset*) re-oriented at load so its sun sits SSW; the same image drives the sky
  (GroundedSkybox) and the IBL (sun-clamped copy, so the IBL never double-lights shadowed areas).
- One shadowed directional sun on the same azimuth (raised to ~14° for readable long shadows), warm; cool sky fill.
- Height fog (global `ShaderChunk` override in `LevelEnv.installAtmosphere`): thick near the ground, thinning with
  height, coloured from the HDRI horizon and glowing toward the sun. Every fogged material shares it.
- Practicals: warm sodium (warehouse, wall lamps, street lights), cool fluorescents (office, one flickering).
  Keep the number of real PointLights small (each one costs every lit fragment); fake the rest with emissive.
- Fake volumetrics: crossed additive cards through sunlit openings + dust motes (`LevelEnv.buildLightShafts/buildDust`).

## 5. Post (Renderer.js) — the final glue
HDR (before the viewmodel pass, which clears depth): god rays from the sun (masked by depth) → bloom (threshold > 1, wide mip blur, low intensity: only genuinely
bright things glow) → lens (dirt lit by bloom; sun glare only when the sun disc is on screen and unoccluded).
Display: ACES filmic tonemap → grade (split toning: teal shadows / warm highlights, lift/gamma/gain, filmic S-curve,
saturation) → vignette (barely there at rest, deepens with damage/low health/ADS) → chromatic aberration (edges,
damage only) → fine grain 2% → SMAA on the display-referred image → CAS sharpening (upscaling off) or FSR 1
EASU + RCAS (upscaling on, `render/Fsr.js`).
Each effect can be disabled from settings keys: `fxBloom`, `fxGodRays`, `fxLens`, `fxCA`, `fxGrain`.

## 6. Performance rules
- Static level boxes merge per material and zone; props are one `BatchedMesh` per material part (per-instance
  culling and LOD). Details and budgets: `docs/PERF.md`.
- Small props (< ~0.3 m) don't cast shadows; glass/decals never do.
- Verify with the QA runner (`tools/qa/suites/perf_profile.json`): draw calls and triangles per pass. After moving
  level geometry or props, re-bake the PVS and navmesh (`tools/README.md`, "Bakes").
