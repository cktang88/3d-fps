# QA report — Ironline

Owner: QA lead. Suite lives in `tools/qa/suites/` (see "How to run" below). Results: `tools/qa/results/<id>/`.

**Last run:** _pending — first full suite queued 2026-10-08 18:34 UTC_

## Pass / fail by area

| Area | Suite | Status | Notes |
| --- | --- | --- | --- |
| Boot + menu, console errors | `ab_boot_tdm.json` | pending | |
| TDM: spawn, bots, kills/score, NaNs | `ab_boot_tdm.json` | pending | |
| Weapons logic (fire modes, burst, tac +1, empty reload, ADS, sprint lockout, switch, FX counts) | `cd_logic.json` | pending | |
| Weapons visual (hip / ADS / fire / reload / sprint x 11) | `c_weapons_visual_{a,b}.json` | pending | |
| Movement (speeds, jump, slide, vault, mantle, stairs) | `cd_logic.json` | pending | |
| Key art per area + perf | `e_keyart.json` | pending | |
| FFA | `f_ffa.json` | pending | |

## Open issues

| # | Area | Owner | Issue | Evidence | Status |
| --- | --- | --- | --- | --- | --- |

## How to run

    node tools/qa/submit.mjs qa tools/qa/suites/<suite>.json            # blocks, prints result.json
    node tools/qa/submit.mjs qa tools/qa/suites/<suite>.json --nowait   # enqueue only
    node tools/qa/suites/gen.mjs                                        # regenerate weapon-visual / key-art suites

Suites use `setupFiles: ["tools/qa/suites/lib.js"]`, which installs `window.__qa` helpers (fast no-render `sim`,
input `press/down/tap`, `place`, `loadout`, `fx`, `nanScan`, `perf`, `matchSim`, `lookAtBot`, `hudOverlaps`).
Logic tests simulate with rendering disabled, so they cost seconds even on SwiftShader.
