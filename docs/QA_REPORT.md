# QA report — Ironline

Owner: QA lead. Suite lives in `tools/qa/suites/` (see "How to run" below). Results: `tools/qa/results/<id>/`.

**Last run:** 2026-10-08 21:55 UTC. NOTE: runner snapshot bug, fixed 21:49. Jobs 20:10-21:03 ran on snapshot 1791490059096 and 21:06-21:49 on 1791493580852, so the PASS/VERIFIED marks below were verified against code as of ~21:04 and are being re-run on fresh snapshots now. Perf budget: ≤400 calls, ≤1.2M tris per view, ≤20 s fresh load (owner: perf a06576c27e6a80553).

## Pass / fail by area

| Area | Suite | Status | Notes |
| --- | --- | --- | --- |
| Boot + menu, console errors | `ab_boot_tdm.json` | PASS | zero console errors on fresh boot; compact menu at 960x540 OK; fresh load 20.1 s (budget 20 s) |
| TDM: spawn, bots, kills/score, NaNs | `ab_boot_tdm.json` | PASS | 120 s sim: 53 kills, 31-21, no NaN/stuck/fallen |
| Weapons logic (fire modes, burst, tac +1, empty reload, ADS, sprint lockout, switch, tracers/decals) | `cd_logic.json` | PASS | all 11 weapons; auto rpm now matches spec |
| Weapons visual (hip / ADS / fire / reload / sprint x 11) | `c_weapons_visual_{a,b}.json` | FAIL (batch A) | gunmetal colour OK, red dot + holo reticles OK; AK irons no sight picture; optic housings low-poly octagons; ACOG lens washed; AK reload unreadable; RPK = AK (no drum) |
| Movement (speeds, jump, slide, vault, mantle, stairs) | `cd_logic.json` + `d_diag.json` | PASS* | slide OK (8.2 m/s), wall x=-34 vaults, dock climb to y=1.2, stairs reach catwalk y=4.02; *one walk sample 0.9 m/s after warm-page reuse (player left crouched) — test hardened |
| Key art per area + perf | `e_keyart.json` | FAIL | warehouse floating brown ceiling props; office ceiling white streaks + placeholder furniture; tower wood flat orange; perf 530-880 calls / 1.9-3.6M tris every view (budget 400/1.2M) |
| FFA | `f_ffa.json` | queued | |
| HUD / menus / UI flow (1280x720) | `g_hud_ui.json` | PASS | menus, killfeed/medals/tally, low ammo, cook + drop on death, death card, respawn 1.6/4.5 s, damage arcs, pause/resume, end screen + XP; pause opened on last page (fixed by owner) |
| Bot animation jank metrics | `h_bot_jank.json` | queued | thresholds from docs/REFERENCE_ENEMIES.md §3 |

## Open issues

| # | Area | Owner | Issue | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | Weapons | weapons aaa99af0f174ee393 | Full-auto rpm quantised to frame rate (cooldown discarded remainder) | cd_logic 1791484432104 | VERIFIED fixed 21:08 |
| 2 | Movement | gameplay a9c1ad23de29b1b81 | Slide does not start from sprint + crouch tap (sprint 6.46 m/s > threshold) | cd_logic 1791484432104 `slideStarted:false` | VERIFIED fixed 21:20 |
| 3 | Movement/level | gameplay / level | No vault at low brick wall x=-34, no mantle onto dock (x=9,z=-24.5); player ends beyond both without mantle event | cd_logic 1791484432104 | VERIFIED fixed 21:08 |
| 4 | Movement/level | level a338aa036921e6327 / gameplay | Warehouse stairs: climb to y=3.58 at z≈-41.4 then fall to ground at z≈-43.6 (stairs ended 4 m short of deck) | cd_logic trace | VERIFIED fixed 21:08 |
| 5 | HUD | gameplay a9c1ad23de29b1b81 | HUD/death card bleed through end-of-match screen | 1791477665095_gameplay/end.png | VERIFIED fixed 21:20 |
| 7 | Boot | art lead a03eed672de8192c8 / weapons | Console errors: models/fp/<id>.glb 404 for all FP_IDS (dir missing) | any result logs | VERIFIED fixed 21:11 |
| 8 | Level | level a338aa036921e6327 | Warehouse: large brown blob/hook meshes floating under roof (hangLamp row?) | e_keyart e04, e06 | owner fixed, re-verify queued |
| 9 | Level | level | Office: white streak artifacts on ceiling; placeholder black-box desks, bare walls | e_keyart e07, e08 | owner fixed, re-verify queued |
| 10 | Level | level | Guard tower parapet flat saturated orange wood | e_keyart e13 | owner fixed, re-verify queued |
| 11 | UI | gameplay a9c1ad23de29b1b81 | Menu at 960x540: TDM label wraps, briefing + profile clipped | ab_boot a1_menu | VERIFIED fixed 21:11 |
| 12 | HUD | gameplay | Intro banner overlaps minimap; killfeed over scoreboard panel | ab_boot b1, b4 | VERIFIED fixed 21:20 |
| 13 | Movement | gameplay | 1.1 m brick wall measured as 1.16 ledge -> mantle instead of vault | cd_logic 1791490511815 | VERIFIED fixed 21:08 |
| 14 | Weapons | weapons aaa99af0f174ee393 | AK irons ADS: no front post, receiver/glove block lower half | c_wvis_a ak_2ads | reported |
| 15 | Weapons | weapons / asset scout | Red dot / holo / ACOG housings are 8-sided flat-shaded tubes, dominate ADS view | c_wvis_a m4/mp5/scar ADS | reported |
| 16 | Weapons | weapons | ACOG PiP lens washed out; AK tac reload hands cluster + grey unlit polygon; RPK has no drum | c_wvis_a | reported |
| 6 | Perf | perf a06576c27e6a80553 | ~1600 calls / 3.5M tris, 75 s load vs budget 400 / 1.2M / 20 s | coordinator | open |
| 17 | UI | gameplay a9c1ad23de29b1b81 | Pause menu opened on last-visited page (Credits) | g_hud_ui g12b_pause | owner fixed, re-verify queued |
| 18 | Weapons/FP art | art lead a03eed672de8192c8 | AK irons still no front post at ADS on fresh build | c_optics o3_ak_irons_ads | open |

## How to run

    node tools/qa/submit.mjs qa tools/qa/suites/<suite>.json            # blocks, prints result.json
    node tools/qa/submit.mjs qa tools/qa/suites/<suite>.json --nowait   # enqueue only
    node tools/qa/suites/gen.mjs                                        # regenerate weapon-visual / key-art suites

Suites use `setupFiles: ["tools/qa/suites/lib.js"]`, which installs `window.__qa` helpers (fast no-render `sim`,
input `press/down/tap`, `place`, `loadout`, `fx`, `nanScan`, `perf`, `matchSim`, `lookAtBot`, `hudOverlaps`).
Logic tests simulate with rendering disabled, so they cost seconds even on SwiftShader.
