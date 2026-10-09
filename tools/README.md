# Dev tools

All Node scripts are ES modules; run them from the repo root. Browser automation uses Playwright's Chromium
(`/opt/pw-browsers/chromium` in the dev container).

## Shared QA runner (use this instead of launching your own browser)

One runner serves the whole team: one Chromium, one static server, and a `vite build` snapshot of the shared tree.
Jobs are JSON files queued in `tools/qa/requests/`; results land in `tools/qa/results/<id>/` (all gitignored).

    node tools/qa/runner.mjs                       # coordinator keeps one running (or tools/qa/restart.sh)
    node tools/qa/submit.mjs <owner> tools/qa/suites/core.json
    node tools/qa/submit.mjs <owner> '{"views":[{"name":"hip","pos":[0,0,0],"yaw":0,"frames":20,"read":"window.__game.player.health"}]}'
    node tools/qa/submit.mjs <owner> <job> --nowait   # prints the job id and returns

`submit` blocks until done (env `QA_TIMEOUT`, default 25 min) and prints `result.json`: screenshot paths, console
errors/warnings, `read` / `script` data, draw stats, load time, build errors. Each result dir also holds `job.json`, so
any job can be resubmitted with `node tools/qa/submit.mjs <owner> tools/qa/results/<id>/job.json`.

**Job fields** (see the header of `submit.mjs`): `views` (`name, pos, yaw, pitch, weapon, ads, fire, reload, sprint,
forward, keys, release, frames, sim, eval, read, shot`), `match` (`'tdm'` default, `'ffa'`, or `false` to stay in the
menu), `setup` / `setupFiles` (e.g. `tools/qa/suites/lib.js`, which installs the `window.__qa` helpers), `script` /
`scriptFile` (an async expression; logic only unless `renderScript: true`), `w` / `h` (default 960x540), `lofi`,
`fresh`, `timeoutS`, `noExtend`, `verbose`, `tag`.

**How the runner works** (`runner.mjs`):

- **Snapshots**: a new `vite build` only when `src/`, `index.html` or `public/assets/` changed (reused for up to 5 min
  otherwise); the last four snapshots are kept so in-flight jobs stay consistent.
- **Workers**: `QA_WORKERS` (default 2) run jobs in parallel. **Warm pages**: each worker keeps its loaded game and
  resets it between jobs (settings, match, input), skipping the ~60 s boot; a page is recycled after 6 reuses, on any
  error, or when the job sets `fresh: true`.
- **Timing model**: frames advance on a fixed 50 ms step (`window.__qaFixedDt`), and GPU rendering is skipped
  (`window.__qaSkipRender`) except on the final frame before each screenshot. `shot: false` views and `script`s never
  render unless the job sets `renderScript: true`. A view's `sim: <seconds>` fast-forwards game time without rendering.
- **`lofi: true`**: quality Low and 0.5 render scale for cheap functional screenshots.
- **Backend**: headful Chromium on a private Xvfb display with Mesa llvmpipe (about 1.4x faster than SwiftShader);
  `QA_BACKEND=swiftshader` forces headless SwiftShader. `QA_PORT` (default 5300) sets the static server port.
- **Watchdog**: each job gets `timeoutS` (default 900 s). At the deadline the runner checks liveness: a view completed
  in the last 3 min, or game frames / physics steps advanced over 5 s (sampled under CDP `Debugger.pause`). A live
  page gets up to two 300 s extensions (`noExtend: true` disables them). A job that still times out is reported as
  either "page hung" or "still alive, too slow for its timeoutS", with the JS stack, the physics ring buffer
  (`hangTrace.json`) and a physics replay bundle (`physRepro.json`).
- **Browser recycling**: on WebGL context loss (Chrome would otherwise block 3D for the origin), on a boot that never
  reaches the menu (boot timeout 480 s), or when a page never booted before its deadline. A job that loses its browser
  mid-run is re-queued (up to 2 retries).
- **Restart**: `tools/qa/restart.sh` stops the runner cleanly, reaps orphaned Chromium/Xvfb processes and starts a new
  one (log: `$QA_LOG`, default `/tmp/qa_runner.log`). Jobs that were running are re-queued automatically.

**Other QA tools**:

- `node tools/qa/summarize.mjs <id|dir> [...]`: one-screen summary (errors, grouped console messages, perf-budget
  violations at 400 calls / 1.2 M tris / 20 s load, script `fails`).
- `node tools/qa/requeue.mjs <request-id> <suite.json>`: refresh a still-queued job from its suite file (keeps its id
  and queue position).
- `python3 tools/qa/contact.py <result dir> [cols]`: contact sheets of a result's screenshots.
- `python3 tools/qa/arm_coverage.py <result dir>`: first-person arm screen coverage on mask shots.
- `node tools/qa/suites/gen.mjs` / `gen_film.mjs`: regenerate the weapon-visual / key-art and bot filmstrip suites.
- Suites and what they cover: `docs/QA_REPORT.md` ("How to run").

**Physics debugging** (the "Rapier hangs" of 2026-10-09 turned out to be CPU starvation, not hangs; `Physics.step`
now also skips `world.step()` while there are no dynamic bodies):

- `node tools/qa/phys_replay.mjs tools/qa/results/<id>/physRepro.json`: deterministic offline replay of a saved
  physics bundle in a worker; reports the frame and sub-step that stops returning, and checks replay fidelity against
  later checkpoints.
- `nice -n 19 node tools/qa/phys_stress.mjs <world.json> [seeds=8] [frames=200000]`: stress test on the game's real
  collider set (teleports, crouch/stand height changes, the player's step-up probes, dt spikes, multi-step frames).
  `<world.json>` is a `physRepro.json` or `JSON.stringify(__physRepro())` from the page.

### Fast iteration rules

1. **Logic first, pixels second.** Check behaviour with `shot: false` views plus `read` expressions or a `script`
   (no GPU work; hundreds of frames in seconds). Only screenshot what needs eyes.
2. **`lofi: true`** for functional screenshots. Full quality only for art review.
3. **Batch** everything into one job per iteration; warm pages make follow-up jobs skip the boot.
4. **Isolated labs for art** (a tiny scene around the thing under review) render far faster than the full map.
5. **Don't wait idle**: `--nowait`, keep working, then read `tools/qa/results/<id>/result.json`.
6. Give long jobs a realistic `timeoutS` rather than relying on extensions.

## Bakes (re-run when the level changes)

Both run inside the game through the shared QA runner (they need the real level and physics) and write shipped
assets. At runtime each bake is checked against a hash of its input and ignored (with a `console.info`) if stale, so a
stale bake costs performance, not correctness.

- `node tools/perf/bake_pvs.mjs [--jobs 8] [--prio]` → `public/assets/pvs/level.json` (precomputed visibility, see
  `src/render/Pvs.js`). Re-run after any change to level geometry or prop placement. `--prio` sorts the jobs ahead in
  the queue.
- `node tools/perf/bake_nav.mjs` → `public/assets/nav/level.{bin,json}` (Recast navmesh, see
  `src/game/bots/Navigation.js`). Re-run after any change to walkable level geometry.

## Asset pipelines

- **First-person rigs** (Blender 4.2, headless, one Blender at a time): `tools/blender/build_all.sh <blender> <sf>
  <work> <outdir>` builds all ten rigs with `build_rig.py`; `tools/blender/optimize.sh <outdir>
  public/assets/models/fp` atlases (`atlas_fp.mjs`), compresses and meshopt-encodes them and moves the shared arm maps
  out (`share_arms_textures.py` → `fp/arms_*.webp`); then list the ids in `public/assets/models/fp/manifest.json`. Gun prep (`prep_guns.py`, `blank_marks.py`, `measure_sights.py`), optics
  (`prep_optics.py`, `smooth_optics.py`) and the rifle animation set (`extract_template_anims.py` →
  `retarget_template.py` → `public/assets/anims/fp_rifle_anims.json`) are documented step by step in
  `docs/FP_FRAMING.md` §6. Per-gun sources and credits: `tools/blender/guns.py`.
- **Bot mocap** (`tools/bots_mocap/`): `build.mjs` extracts and retargets 100STYLE gait cycles, `addclips.mjs` appends
  them to `soldier.glb` (instructions in the file headers).
- **Textures**: `python3 tools/perf/compress_textures.py [--delete] [--max N] [dirs]` converts PBR JPGs to WebP.
- **Audio**: `python3 tools/cut_foley.py <in> <out>` (first transient of a field recording → OGG),
  `python3 tools/trim_onset.py <dir> [maxlen]` (trim leading silence from gunshots).

## Other

- `node tools/spray_sim.mjs [--json] [--runs N] [--weapons m4,ak] [--old <root>]`: headless spray test on the real
  Weapon / AimRecoil code (group sizes at 10 / 25 / 50 m). In-engine counterpart: `tools/qa/suites/w_spray.json`.
- `node tools/shot.mjs <scenario> [outDir]`: legacy standalone screenshot harness (its own headless Chromium on
  SwiftShader; env `PORT`, `W`/`H`, `VIEWS`). Output in `tools/shots/` (gitignored). Prefer the QA runner.
- `tools/bench/bench.mjs` + `bench.html`: compares Chromium GL backends (SwiftShader, Mesa GL/EGL/Vulkan) on this
  host. `tools/gltest.mjs`: prints the WebGL2 version and renderer string.
