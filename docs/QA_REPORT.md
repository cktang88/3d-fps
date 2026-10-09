# QA report — Ironline

Owner: QA lead. Suite lives in `tools/qa/suites/` (see "How to run" below). Results: `tools/qa/results/<id>/`.

**Last run:** 2026-10-09 02:02 UTC: `e_keyart` 1791509573464 (snapshot 01:54), `core` 1791505200331 (01:13). Next `core` queued. Perf budget: ≤400 calls, ≤1.2M tris per view, ≤20 s fresh load (owner: perf a06576c27e6a80553).

## Pass / fail by area

| Area | Suite | Status | Notes |
| --- | --- | --- | --- |
| Boot + menu, console errors | `core.json` | PASS | zero console errors/warnings on fresh boot (01:14). Load 226 s under queue contention (20 s idle). Intermittent three.js shadow "null state" boot error not seen in the last 3 fresh boots |
| TDM: spawn, bots, kills/score, NaNs | `core.json` | PASS | 120 s sim, kills and score progress, no NaN/stuck/fallen |
| Weapons logic (fire modes, burst, tac +1, empty reload, ADS, sprint lockout, switch, tracers/decals) | `core.json` | PASS | 11/11. Decal check now counts add() calls (pools saturate after long sims) |
| Weapons visual (hip / ADS / fire / reload / sprint x 11) | `c_weapons_visual_{a,b}.json` | FAIL (batch A) | gunmetal colour OK, red dot + holo reticles OK; AK irons no sight picture; optic housings low-poly octagons; ACOG lens washed; AK reload unreadable; RPK = AK (no drum) |
| Movement (speeds, jump, slide, vault, mantle, stairs, spawn/fall) | `core.json` | PASS* | walk 4.37 / sprint 6.46 / crouch 1.9 / jump 1.05; vault, dock climb, catwalk stairs OK; slide OK in west lane (8.3 m/s). *Courtyard lane x=0 stops a sprint at z≈13.7 (investigating). Fall probe: no falls at 37 points |
| Key art per area + perf | `e_keyart.json` | FAIL | 01:54: hook/balloon gone, tower wood fixed, warehouse shelves dressed, office tiled ceiling. Open: office ceiling rays (e07), debug FPS overlay visible by default, FP gun looks LOD-simplified. Perf: tris 0.46–0.89M (OK) but calls 457–777 (regressed, geos 186→633). Boot 404 from missing PVS bake |
| FFA | `f_ffa_hang.json` | PASS (00:19) | 120 s FFA with and without ambience: 28 kills, no NaN, no hang, no throw after the dt fix. The 21:51 hang did not reproduce |
| HUD / menus / UI flow | `core.json` | PASS | kills/medals/tally, low ammo, cook + drop on death, death card, respawn 1.6/4.5 s, damage arcs, pause opens on home, bullets hit bot, end screen |
| Bot animation jank metrics | `core.json` L4 | FAIL (improving) | 01:13: pops 7–74/min (was 60–125), fire aim p90 2.3–4.6° (was 5.5–7.5°), yaw rate ≤489°/s OK, death displacement OK; open: support palm 0.08–0.27 m off grip (team 1 worse), muzzle-on-aim while moving 3–6° on 4 bots, death ground time 1.3–1.5 s (spec 0.7–1.1); foot metrics being fixed (model swap LOD) |

## Open issues

| # | Area | Owner | Issue | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | Weapons | weapons aaa99af0f174ee393 | Full-auto rpm quantised to frame rate (cooldown discarded remainder) | cd_logic 1791484432104 | VERIFIED fixed 21:08 |
| 2 | Movement | gameplay a9c1ad23de29b1b81 | Slide does not start from sprint + crouch tap (sprint 6.46 m/s > threshold) | cd_logic 1791484432104 `slideStarted:false` | VERIFIED fixed 21:20 |
| 3 | Movement/level | gameplay / level | No vault at low brick wall x=-34, no mantle onto dock (x=9,z=-24.5); player ends beyond both without mantle event | cd_logic 1791484432104 | VERIFIED fixed 21:08 |
| 4 | Movement/level | level a338aa036921e6327 / gameplay | Warehouse stairs: climb to y=3.58 at z≈-41.4 then fall to ground at z≈-43.6 (stairs ended 4 m short of deck) | cd_logic trace | VERIFIED fixed 21:08 |
| 5 | HUD | gameplay a9c1ad23de29b1b81 | HUD/death card bleed through end-of-match screen | 1791477665095_gameplay/end.png | VERIFIED fixed 21:20 |
| 7 | Boot | art lead a03eed672de8192c8 / weapons | Console errors: models/fp/<id>.glb 404 for all FP_IDS (dir missing) | any result logs | VERIFIED fixed 21:11 |
| 8 | Level | level a338aa036921e6327 | Warehouse: large brown blob/hook meshes floating under roof (hangLamp row?) | e_keyart e04, e06 | VERIFIED fixed 01:54 |
| 9 | Level | level (finished) → coordinator | Office ceiling white rays/streaks at top of frame persist after the HDR-pass-order fix | e_keyart 1791509573464 e07 | open |
| 10 | Level | level | Guard tower parapet flat saturated orange wood | e_keyart e13 | VERIFIED fixed 01:54 |
| 11 | UI | gameplay a9c1ad23de29b1b81 | Menu at 960x540: TDM label wraps, briefing + profile clipped | ab_boot a1_menu | VERIFIED fixed 21:11 |
| 12 | HUD | gameplay | Intro banner overlaps minimap; killfeed over scoreboard panel | ab_boot b1, b4 | VERIFIED fixed 21:20 |
| 13 | Movement | gameplay | 1.1 m brick wall measured as 1.16 ledge -> mantle instead of vault | cd_logic 1791490511815 | VERIFIED fixed 21:08 |
| 14 | Weapons | weapons aaa99af0f174ee393 | AK irons ADS: no front post, receiver/glove block lower half | c_wvis_a ak_2ads | reported |
| 15 | Weapons | weapons / asset scout | Red dot / holo / ACOG housings are 8-sided flat-shaded tubes, dominate ADS view | c_wvis_a m4/mp5/scar ADS | reported |
| 16 | Weapons | weapons | ACOG PiP lens washed out; AK tac reload hands cluster + grey unlit polygon; RPK has no drum | c_wvis_a | reported |
| 19 | Core loop | coordinator / gameplay | src/main.js dt has no lower bound: first rAF can give dt of -1 to -3 s, so physics and the KCC step backwards (player falls through the world, y=-44, "Fall damage" death after load), game.time goes negative, and HUD.drawMinimap throws "arc radius negative" every frame, skipping render | fallprobe 1791500269172 fp1; ffa_hang 1791500388869 | VERIFIED fixed 00:19 (fall probe: y=0.004 after teleport, no falls at 37 points x 2 dt) |
| 20 | Render | perf / level | 48x WebGL "GL_INVALID_OPERATION: Mismatch between texture format and sampler type" during key-art renders | e_keyart 1791493511219 logs | VERIFIED fixed 01:54 (0 warnings at full quality) |
| 21 | Bots | bots a77d0883019b11e4c | Jank metrics fail: weight pops, barrel/aim error, support palm off grip, yaw-rate spike, death displacement | core 1791497381991 L4 | owner fixed, re-measure pending |
| 22 | Ambience | QA (applied at coordinator's request) | Unbounded per-frame accumulator loops could spin forever on non-finite input (DistantBattle, Fires, Weather bolt, AmbAudio) | code review after worker hangs | FIXED 01:10 (clamped + capped), no hang in 1028 s core run |
| 23 | Runner/game | QA / coordinator | Intermittent page hangs (900 s timeouts: fprig film 23:30, bots film 00:52) | runner log | watchdog now captures JS stack on hang, none since 01:00 |
| 24 | Physics hang | coordinator (Player.js) | Page hang inside Rapier world.step() (captured stack), likely NaN player collider translation via Player._syncBody; proposed 8-line finite guard (QA edit blocked by permissions) | runner log 01:50 fprig_cov | reported, awaiting fix |
| 25 | Perf | perf a06576c27e6a80553 | Draw calls regressed 218–678 → 457–777; boot 404 (PVS bake missing); debug FPS overlay on by default; FP gun appears LOD'd | e_keyart 1791509573464 | reported |
| 6 | Perf | perf a06576c27e6a80553 | ~1600 calls / 3.5M tris, 75 s load vs budget 400 / 1.2M / 20 s | coordinator | open |
| 17 | UI | gameplay a9c1ad23de29b1b81 | Pause menu opened on last-visited page (Credits) | g_hud_ui g12b_pause | VERIFIED fixed 01:31 |
| 18 | Weapons/FP art | art lead a03eed672de8192c8 | AK irons still no front post at ADS on fresh build | c_optics o3_ak_irons_ads | open |

## How to run

    node tools/qa/submit.mjs qa tools/qa/suites/<suite>.json            # blocks, prints result.json
    node tools/qa/submit.mjs qa tools/qa/suites/<suite>.json --nowait   # enqueue only
    node tools/qa/suites/gen.mjs                                        # regenerate weapon-visual / key-art suites

Suites use `setupFiles: ["tools/qa/suites/lib.js"]`, which installs `window.__qa` helpers (fast no-render `sim`,
input `press/down/tap`, `place`, `loadout`, `fx`, `nanScan`, `perf`, `matchSim`, `lookAtBot`, `hudOverlaps`).
Logic tests simulate with rendering disabled, so they cost seconds even on SwiftShader.
