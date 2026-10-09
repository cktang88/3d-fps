# QA report — Ironline

Owner: QA lead. Suite lives in `tools/qa/suites/` (see "How to run" below). Results: `tools/qa/results/<id>/`.

**Last full run:** 2026-10-09 10:10 UTC: `e_keyart` 1791540168505 (clean, 0 console messages), `core` 1791538990595 (09:43, all PASS). Perf budget: MET.
**Since then:** `h_bot_jank` 1791546261592 (11:44, all 11 bots pass, 0 fails; stance-foot-slide warnings only, an unvalidated metric). Later jobs were first-person rig (pistol viewmodel) iterations. `core` / `e_keyart` / `c_visual_all` have not been
re-run since 10:10, so the bot (813a8b5), viewmodel-probe (c2f2659) and pistol-viewmodel (382c1d8) commits still need a
full pass.

## Pass / fail by area

| Area | Suite | Status | Notes |
| --- | --- | --- | --- |
| Boot + menu, console errors | `core.json` | PASS | 03:07: zero console errors/warnings on fresh boot; load 20.6 s |
| TDM: spawn, bots, kills/score, NaNs | `core.json` | PASS | 120 s sim, kills and score progress, no NaN/stuck/fallen |
| Weapons logic (fire modes, burst, tac +1, empty reload, ADS, sprint lockout, switch, tracers/decals) | `core.json` | PASS | 11/11. Decal check now counts add() calls (pools saturate after long sims) |
| Weapons visual (hip / ADS / fire / reload / sprint x 11 + optics + switch) | `c_visual_all.json` | PASS (minor) | 09:08: muzzle-flash freeze frames show flash + gun light; AK irons now show rear notch + front post; M870 ghost-ring ADS and shell reload readable; reloads canted and readable; red dot/holo OK. Minor: M4 red-dot ADS shows a red glow on the rail under the optic; P226 ADS support glove still large on the left |
| Movement (speeds, jump, slide, vault, mantle, stairs, spawn/fall) | `core.json` | PASS | 05:58: all checks incl. dock climb at new x=13 |
| Key art per area + perf | `e_keyart.json` | PASS | 05:19: 14 views 168–287 calls / 0.28–0.58M tris, 0 console messages, visuals OK (new detailed FP M4) |
| Recoil / spray (tuned feature) | `w_spray.json` + `l_pistol_tap.script.js` (in `m_pistol_cov.json`) | PASS | 09:20: relaxed taps fully recover (M4/P226/M1911 MPI < 1 cm at 25 m); sights true; bursts/strings still need pull-down by design |
| FFA | `f_ffa.json` | PASS | 06:48: spawn, 120 s sim, scoreboard, bot close-up; no NaN, no console messages |
| HUD / menus / UI flow | `core.json` | PASS | kills/medals/tally, low ammo, cook + drop on death, death card, respawn 1.6/4.5 s, damage arcs, pause opens on home, bullets hit bot, end screen |
| Bot animation jank metrics | `h_bot_jank.json` | PASS | 11:44: all 11 bots pass. 08:32: toe slip fwd 0.02/0.10, strafe 0.01/0.34 m/s (p50/p90), per-bot p50 ≤0.02; palm 1.3–2.2 cm; aim OK; yaw ≤433°/s; 0 pops; deaths 2/10 > 0.45 m. Minor: rare backpedal residual (0.2% of samples, p90 2.2 m/s) |

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
| 14 | Weapons | weapons aaa99af0f174ee393 | AK irons ADS: no front post, receiver/glove block lower half | c_wvis_a ak_2ads | VERIFIED fixed 09:08 (front post visible) |
| 15 | Weapons | weapons / asset scout | Red dot / holo / ACOG housings are 8-sided flat-shaded tubes, dominate ADS view | c_wvis_a m4/mp5/scar ADS | improved: creased normals + new detailed FP rigs/optics (09:08 shots read round); residual minor |
| 16 | Weapons | weapons | ACOG PiP lens washed out; AK tac reload hands cluster + grey unlit polygon; RPK has no drum | c_wvis_a | ACOG lens fixed by weapons; AK reload readable 09:08; RPK drum present (below frame at hip, not a bug). CLOSED |
| 19 | Core loop | coordinator / gameplay | src/main.js dt has no lower bound: first rAF can give dt of -1 to -3 s, so physics and the KCC step backwards (player falls through the world, y=-44, "Fall damage" death after load), game.time goes negative, and HUD.drawMinimap throws "arc radius negative" every frame, skipping render | fallprobe 1791500269172 fp1; ffa_hang 1791500388869 | VERIFIED fixed 00:19 (fall probe: y=0.004 after teleport, no falls at 37 points x 2 dt) |
| 20 | Render | perf / level | 48x WebGL "GL_INVALID_OPERATION: Mismatch between texture format and sampler type" during key-art renders | e_keyart 1791493511219 logs | VERIFIED fixed 01:54 (0 warnings at full quality) |
| 21 | Bots | bots a77d0883019b11e4c | After Match.start runs a second time (rematch), bots 0–2 hold the gun 12–30° off the aim ray and never set lGripWorld | core 1791514719140 L4 | CLOSED 04:16: hidden-LOD bots skip IK by design; with hidden frames excluded all 11 bots pass |
| 22 | Ambience | QA (applied at coordinator's request) | Unbounded per-frame accumulator loops could spin forever on non-finite input (DistantBattle, Fires, Weather bolt, AmbAudio) | code review after worker hangs | FIXED 01:10 (clamped + capped), no hang in 1028 s core run |
| 23 | Runner/game | QA / coordinator | Intermittent page hangs (900 s timeouts: fprig film 23:30, bots film 00:52) | runner log | CLOSED: CPU starvation, not hangs (runner now has liveness check) |
| 24 | Physics hang | coordinator (Player.js) | Page hang inside Rapier world.step() (captured stack), likely NaN player collider translation via Player._syncBody; proposed 8-line finite guard (QA edit blocked by permissions) | runner log 01:50 fprig_cov | guard applied 02:15; investigation found no real Rapier hang (CPU starvation); step-skip when nothing dynamic VERIFIED 09:43. CLOSED |
| 25 | Perf | perf a06576c27e6a80553 | Draw calls regressed (transmission glass + zoning, fixed by owner); PVS 404 (VERIFIED gone 03:07); FPS overlay intentional (user); chunky FP gun = dynamic res at 85% (disabled under QA) | e_keyart 1791509573464 | VERIFIED fixed 03:37 |
| 26 | Runner | coordinator / render | "Renders nothing" 04:48 was a WebGL context loss at ~04:21 that made Chrome block 3D for the origin; not a code bug. Runner now passes --disable-domain-blocking-for-3d-apis and QA added context-loss detection plus browser recycle | c_optics 1791519443222 | RESOLVED 04:58 (smoke clean) |
| 27 | Bots | bots a77d0883019b11e4c | Moonwalk / skating / yaw spikes FIXED 08:32. Residual: rare backpedal slip (0.2% of samples) | h_jank 1791534734653 | VERIFIED fixed 11:44 (h_jank 1791546261592: 0 fails) |
| 28 | FP rig | FP viewmodel r2 ae2dabb5f9b0dd692 | M870 reload at 45%: gun out of frame; P226 ADS: oversized support glove, pistol tiny/low | c_wvis_b 1791523688692 | VERIFIED improved 09:08 (M870 reload readable; P226 glove smaller but still large, minor) |
| 29 | Render | FP viewmodel r2 ae2dabb5f9b0dd692 | 1160-call / 2.3M-tri frame on the first render after a weapon switch (≈ full light-probe refresh); the shot frame itself is a normal 248 calls | k_m24_spike 1791525779216 | VERIFIED fixed 09:02 (259 calls on the swap frame) |
| 30 | Weapons | coordinator | Pistol zero true; relaxed taps used to leave a permanent climb. Coordinator changed settleFrac to 1 for single shots | pistol 1791537366175 | VERIFIED fixed 09:20 (6 relaxed taps: aim drift 0.003°, MPI < 1 cm at 25 m) |
| 31 | FP rig | coordinator | P226 reload centre-box coverage 16–20% is intentional (pistol tilts up for the mag swap). New criterion: gun and right hand ≤ ~25% of the centre box, support forearm never in it (docs/FP_FRAMING.md) | pistol 1791537366175 | PASS under new criterion (≤20.1%, forearm 0/18 frames) |
| 32 | Runner | coordinator | Browser wedged 09:24–09:42 (2 fresh boots never reached menu, Chrome at 250% CPU, no code change); restart fixed it. Runner now recycles the browser after a boot timeout | core 1791537868756, smoke 1791538426589 | RESOLVED 09:43 |
| 33 | Bots | bots (finished) | Death hips displacement > 0.45 m in about 30% of deaths across the last 3 runs (10/33), right at the allowance | core 1791538990595 L4 | watch |
| 6 | Perf | perf a06576c27e6a80553 | ~1600 calls / 3.5M tris, 75 s load vs budget 400 / 1.2M / 20 s | coordinator | VERIFIED: budget met 03:37 |
| 17 | UI | gameplay a9c1ad23de29b1b81 | Pause menu opened on last-visited page (Credits) | g_hud_ui g12b_pause | VERIFIED fixed 01:31 |
| 18 | Weapons/FP art | art lead a03eed672de8192c8 | AK irons still no front post at ADS on fresh build | c_optics o3_ak_irons_ads | VERIFIED fixed 09:08 (front post visible) |

## How to run

    node tools/qa/submit.mjs qa tools/qa/suites/<suite>.json            # blocks, prints result.json
    node tools/qa/submit.mjs qa tools/qa/suites/<suite>.json --nowait   # enqueue only
    node tools/qa/suites/gen.mjs                                        # regenerate weapon-visual / key-art suites

Suites use `setupFiles: ["tools/qa/suites/lib.js"]`, which installs `window.__qa` helpers (fast no-render `sim`,
input `press/down/tap`, `place`, `loadout`, `fx`, `nanScan`, `perf`, `matchSim`, `lookAtBot`, `hudOverlaps`).
Logic tests simulate with rendering disabled, so they cost seconds even on SwiftShader.

Suites: `core.json` (boot, menus, TDM sim, movement, weapons logic, spawn/fall probe, bot jank, HUD flow; lofi),
`e_keyart.json` (14 key-art views + perf budget, full quality), `c_visual_all.json` (all weapons hip/ADS/fire/reload/
sprint + optics + switch), `h_bot_jank.json` (bot animation metrics, thresholds from docs/REFERENCE_ENEMIES.md),
`f_ffa.json`, `w_spray.json` (recoil), `m_pistol_cov.json` (pistol tap zero + reload arm coverage), `k_m24_spike.json`
(per-pass draw capture), `r_smoke.json` (fast render sanity), `j_fall_probe.json`, `f_ffa_hang.json`,
`perf_profile.json` / `perf_cpu.json` / `perf_visual.json` / `perf_pvs_check.json` / `perf_shadowcache.json` (see
`docs/PERF.md`), `bench_smoke.json` (graphics benchmark), `fsr_compare*.json` (upscaling A/B), `level_audit.json`.
Runner behaviour (warm pages, watchdog, browser recycling, `timeoutS`): `tools/README.md`.
Tools: `summarize.mjs <id>` (errors, grouped logs, perf budget, script fails), `contact.py <dir>` (contact sheets),
`arm_coverage.py <dir>` (FP arm coverage on mask shots), `requeue.mjs <id> <suite>` (refresh a queued job).
