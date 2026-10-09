# QA report — Ironline

Owner: QA lead. Suite lives in `tools/qa/suites/` (see "How to run" below). Results: `tools/qa/results/<id>/`.

**Last run:** 2026-10-09 09:05 UTC: `pistol` 1791536340869, `m24spike` 1791536340923, `core` + `e_keyart` 1791535319934/989 (08:45). Perf budget: MET.

## Pass / fail by area

| Area | Suite | Status | Notes |
| --- | --- | --- | --- |
| Boot + menu, console errors | `core.json` | PASS | 03:07: zero console errors/warnings on fresh boot; load 20.6 s |
| TDM: spawn, bots, kills/score, NaNs | `core.json` | PASS | 120 s sim, kills and score progress, no NaN/stuck/fallen |
| Weapons logic (fire modes, burst, tac +1, empty reload, ADS, sprint lockout, switch, tracers/decals) | `core.json` | PASS | 11/11. Decal check now counts add() calls (pools saturate after long sims) |
| Weapons visual (hip / ADS / fire / reload / sprint x 11) | `c_weapons_visual_{a,b}.json` | FAIL | 05:41 batch B: M870 shell reload gun out of frame; P226 ADS support glove fills 40% of screen; AWM scope OK; draw-call spike 1166 on M24 shot frame |
| Movement (speeds, jump, slide, vault, mantle, stairs, spawn/fall) | `core.json` | PASS | 05:58: all checks incl. dock climb at new x=13 |
| Key art per area + perf | `e_keyart.json` | PASS | 05:19: 14 views 168–287 calls / 0.28–0.58M tris, 0 console messages, visuals OK (new detailed FP M4) |
| Recoil / spray (tuned feature) | `w_spray.json` | BASELINE 04:10 | 25 m: tapC 100% torso on every rifle (median 2–4 cm); autoC torso 37–65%; burst3C 53–100%. Pistols tapC land 10–16 cm low at 25 m (p226 MPI −10 cm, m1911 −16 cm), possible sight zeroing |
| FFA | `f_ffa.json` | PASS | 06:48: spawn, 120 s sim, scoreboard, bot close-up; no NaN, no console messages |
| HUD / menus / UI flow | `core.json` | PASS | kills/medals/tally, low ammo, cook + drop on death, death card, respawn 1.6/4.5 s, damage arcs, pause opens on home, bullets hit bot, end screen |
| Bot animation jank metrics | `h_bot_jank.json` | PASS | 08:32: toe slip fwd 0.02/0.10, strafe 0.01/0.34 m/s (p50/p90), per-bot p50 ≤0.02; palm 1.3–2.2 cm; aim OK; yaw ≤433°/s; 0 pops; deaths 2/10 > 0.45 m. Minor: rare backpedal residual (0.2% of samples, p90 2.2 m/s) |

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
| 9 | Level | level (finished) → coordinator | Office ceiling white rays/streaks at top of frame persist after the HDR-pass-order fix | e_keyart 1791509573464 e07 | VERIFIED fixed 03:37 |
| 10 | Level | level | Guard tower parapet flat saturated orange wood | e_keyart e13 | VERIFIED fixed 01:54 |
| 11 | UI | gameplay a9c1ad23de29b1b81 | Menu at 960x540: TDM label wraps, briefing + profile clipped | ab_boot a1_menu | VERIFIED fixed 21:11 |
| 12 | HUD | gameplay | Intro banner overlaps minimap; killfeed over scoreboard panel | ab_boot b1, b4 | VERIFIED fixed 21:20 |
| 13 | Movement | gameplay | 1.1 m brick wall measured as 1.16 ledge -> mantle instead of vault | cd_logic 1791490511815 | VERIFIED fixed 21:08 |
| 14 | Weapons | weapons aaa99af0f174ee393 | AK irons ADS: no front post, receiver/glove block lower half | c_wvis_a ak_2ads | reported |
| 15 | Weapons | weapons / asset scout | Red dot / holo / ACOG housings are 8-sided flat-shaded tubes, dominate ADS view | c_wvis_a m4/mp5/scar ADS | reported |
| 16 | Weapons | weapons | ACOG PiP lens washed out; AK tac reload hands cluster + grey unlit polygon; RPK has no drum | c_wvis_a | reported |
| 19 | Core loop | coordinator / gameplay | src/main.js dt has no lower bound: first rAF can give dt of -1 to -3 s, so physics and the KCC step backwards (player falls through the world, y=-44, "Fall damage" death after load), game.time goes negative, and HUD.drawMinimap throws "arc radius negative" every frame, skipping render | fallprobe 1791500269172 fp1; ffa_hang 1791500388869 | VERIFIED fixed 00:19 (fall probe: y=0.004 after teleport, no falls at 37 points x 2 dt) |
| 20 | Render | perf / level | 48x WebGL "GL_INVALID_OPERATION: Mismatch between texture format and sampler type" during key-art renders | e_keyart 1791493511219 logs | VERIFIED fixed 01:54 (0 warnings at full quality) |
| 21 | Bots | bots a77d0883019b11e4c | After Match.start runs a second time (rematch), bots 0–2 hold the gun 12–30° off the aim ray and never set lGripWorld | core 1791514719140 L4 | CLOSED 04:16: hidden-LOD bots skip IK by design; with hidden frames excluded all 11 bots pass |
| 22 | Ambience | QA (applied at coordinator's request) | Unbounded per-frame accumulator loops could spin forever on non-finite input (DistantBattle, Fires, Weather bolt, AmbAudio) | code review after worker hangs | FIXED 01:10 (clamped + capped), no hang in 1028 s core run |
| 23 | Runner/game | QA / coordinator | Intermittent page hangs (900 s timeouts: fprig film 23:30, bots film 00:52) | runner log | watchdog now captures JS stack on hang, none since 01:00 |
| 24 | Physics hang | coordinator (Player.js) | Page hang inside Rapier world.step() (captured stack), likely NaN player collider translation via Player._syncBody; proposed 8-line finite guard (QA edit blocked by permissions) | runner log 01:50 fprig_cov | guard applied by coordinator 02:15; origin hunt re-runs queued |
| 25 | Perf | perf a06576c27e6a80553 | Draw calls regressed (transmission glass + zoning, fixed by owner); PVS 404 (VERIFIED gone 03:07); FPS overlay intentional (user); chunky FP gun = dynamic res at 85% (disabled under QA) | e_keyart 1791509573464 | VERIFIED fixed 03:37 |
| 26 | Runner | coordinator / render | "Renders nothing" 04:48 was a WebGL context loss at ~04:21 that made Chrome block 3D for the origin; not a code bug. Runner now passes --disable-domain-blocking-for-3d-apis and QA added context-loss detection plus browser recycle | c_optics 1791519443222 | RESOLVED 04:58 (smoke clean) |
| 27 | Bots | bots a77d0883019b11e4c | Moonwalk / skating / yaw spikes FIXED 08:32. Residual: rare backpedal slip (0.2% of samples) | h_jank 1791534734653 | minor |
| 28 | FP rig | FP viewmodel r2 ae2dabb5f9b0dd692 | M870 reload at 45%: gun out of frame; P226 ADS: oversized support glove, pistol tiny/low | c_wvis_b 1791523688692 | reported |
| 29 | Render | FP viewmodel r2 ae2dabb5f9b0dd692 | 1160-call / 2.3M-tri frame on the first render after a weapon switch (≈ full light-probe refresh); the shot frame itself is a normal 248 calls | k_m24_spike 1791525779216 | VERIFIED fixed 09:02 (259 calls on the swap frame) |
| 30 | Weapons | coordinator (design) | Pistol "low zero" was a w_spray compensation artifact: sights true (MPI within 2 cm at 25 m when re-centred). Design question: relaxed taps leave a permanent climb (P226 +0.09°, M1911 +0.17°, M4 +0.06° per shot) | pistol 1791536340869 | reported |
| 31 | FP rig | coordinator (FP r2 finished) | P226 reload: arms/gun cover 16–20% of the centre box from 6% to 78% of tac and empty reloads (was 0%) | pistol 1791536340869 + arm_coverage.py | reported |
| 6 | Perf | perf a06576c27e6a80553 | ~1600 calls / 3.5M tris, 75 s load vs budget 400 / 1.2M / 20 s | coordinator | VERIFIED: budget met 03:37 |
| 17 | UI | gameplay a9c1ad23de29b1b81 | Pause menu opened on last-visited page (Credits) | g_hud_ui g12b_pause | VERIFIED fixed 01:31 |
| 18 | Weapons/FP art | art lead a03eed672de8192c8 | AK irons still no front post at ADS on fresh build | c_optics o3_ak_irons_ads | open |

## How to run

    node tools/qa/submit.mjs qa tools/qa/suites/<suite>.json            # blocks, prints result.json
    node tools/qa/submit.mjs qa tools/qa/suites/<suite>.json --nowait   # enqueue only
    node tools/qa/suites/gen.mjs                                        # regenerate weapon-visual / key-art suites

Suites use `setupFiles: ["tools/qa/suites/lib.js"]`, which installs `window.__qa` helpers (fast no-render `sim`,
input `press/down/tap`, `place`, `loadout`, `fx`, `nanScan`, `perf`, `matchSim`, `lookAtBot`, `hudOverlaps`).
Logic tests simulate with rendering disabled, so they cost seconds even on SwiftShader.
