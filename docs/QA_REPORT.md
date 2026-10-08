# QA report — Ironline

Owner: QA lead. Suite lives in `tools/qa/suites/` (see "How to run" below). Results: `tools/qa/results/<id>/`.

**Last run:** 2026-10-08 20:32 UTC (`cd_logic`, `ab_boot_tdm`, `e_keyart`); remaining suites queued (runner backlog). Perf budget: ≤400 calls, ≤1.2M tris per view, ≤20 s fresh load (owner: perf a06576c27e6a80553).

## Pass / fail by area

| Area | Suite | Status | Notes |
| --- | --- | --- | --- |
| Boot + menu, console errors | `ab_boot_tdm.json` | FAIL | console: 404 + 'model failed' for every models/fp/*.glb; menu text wraps/clips at 960x540; fresh load 48 s |
| TDM: spawn, bots, kills/score, NaNs | `ab_boot_tdm.json` | PASS | 11 bots (5v6+player), 120 s sim: 55 kills, 29-26, no NaN/stuck/fallen; intro banner overlaps minimap |
| Weapons logic (fire modes, burst, tac +1, empty reload, ADS, sprint lockout, switch, FX counts) | `cd_logic.json` | PASS (1 bug fixed, re-verify queued) | all 11 weapons pass; auto rpm was fps-quantised (M4 600 rpm @30fps) — fixed by weapons, re-check queued |
| Weapons visual (hip / ADS / fire / reload / sprint x 11) | `c_weapons_visual_{a,b}.json` | pending | |
| Movement (speeds, jump, slide, vault, mantle, stairs) | `cd_logic.json` + `d_diag.json` | FAIL (investigating) | walk 4.37 / sprint 6.46 / crouch 1.9 / jump apex 1.05 OK; slide never starts; no vault/mantle events at brick wall / dock; stairs top drops player to ground at z≈-43.6 |
| Key art per area + perf | `e_keyart.json` | FAIL | warehouse floating brown ceiling props; office ceiling white streaks + placeholder furniture; tower wood flat orange; perf 530-880 calls / 1.9-3.6M tris every view (budget 400/1.2M) |
| FFA | `f_ffa.json` | pending | |

## Open issues

| # | Area | Owner | Issue | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | Weapons | weapons aaa99af0f174ee393 | Full-auto rpm quantised to frame rate (cooldown discarded remainder) | cd_logic 1791484432104 | fixed by owner, re-verify queued |
| 2 | Movement | gameplay a9c1ad23de29b1b81 | Slide does not start from sprint + crouch tap (sprint 6.46 m/s > threshold) | cd_logic 1791484432104 `slideStarted:false` | diag queued (d_diag) |
| 3 | Movement/level | gameplay / level | No vault at low brick wall x=-34, no mantle onto dock (x=9,z=-24.5); player ends beyond both without mantle event | cd_logic 1791484432104 | diag queued |
| 4 | Movement/level | level a338aa036921e6327 / gameplay | Warehouse stairs: climb to y=3.58 at z≈-41.4 then fall to ground at z≈-43.6 (gap before catwalk?) | cd_logic trace | diag queued |
| 5 | HUD | gameplay a9c1ad23de29b1b81 | HUD/death card bleed through end-of-match screen | 1791477665095_gameplay/end.png | reported |
| 7 | Boot | art lead a03eed672de8192c8 / weapons | Console errors: models/fp/<id>.glb 404 for all FP_IDS (dir missing) | any result logs | reported |
| 8 | Level | level a338aa036921e6327 | Warehouse: large brown blob/hook meshes floating under roof (hangLamp row?) | e_keyart e04, e06 | reported |
| 9 | Level | level | Office: white streak artifacts on ceiling; placeholder black-box desks, bare walls | e_keyart e07, e08 | reported |
| 10 | Level | level | Guard tower parapet flat saturated orange wood | e_keyart e13 | reported |
| 11 | UI | gameplay a9c1ad23de29b1b81 | Menu at 960x540: TDM label wraps, briefing + profile clipped | ab_boot a1_menu | reported |
| 12 | HUD | gameplay | Intro banner overlaps minimap; killfeed over scoreboard panel | ab_boot b1, b4 | reported |
| 13 | Movement | gameplay | 1.1 m brick wall measured as 1.16 ledge -> mantle instead of vault | cd_logic 1791490511815 | reported |
| 6 | Perf | perf a06576c27e6a80553 | ~1600 calls / 3.5M tris, 75 s load vs budget 400 / 1.2M / 20 s | coordinator | open |

## How to run

    node tools/qa/submit.mjs qa tools/qa/suites/<suite>.json            # blocks, prints result.json
    node tools/qa/submit.mjs qa tools/qa/suites/<suite>.json --nowait   # enqueue only
    node tools/qa/suites/gen.mjs                                        # regenerate weapon-visual / key-art suites

Suites use `setupFiles: ["tools/qa/suites/lib.js"]`, which installs `window.__qa` helpers (fast no-render `sim`,
input `press/down/tap`, `place`, `loadout`, `fx`, `nanScan`, `perf`, `matchSim`, `lookAtBot`, `hudOverlaps`).
Logic tests simulate with rendering disabled, so they cost seconds even on SwiftShader.
