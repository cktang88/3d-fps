# Dev tools

- `node tools/shot.mjs <scenario> [outDir]` — headless Chromium (SwiftShader WebGL) playtest.
  Env: `PORT` (default 5199, use a unique port per concurrent run), `W`/`H` viewport,
  `VIEWS` = JSON array of `{name,pos:[x,y,z],yaw,pitch,weapon,ads,fire,reload,sprint,frames,eval}`;
  `eval` is a JS string run in the page (`window.__game` is the Game instance).
  Screenshots land in `tools/shots/` (gitignored).
- `python3 tools/cut_foley.py <in> <out>` / `tools/trim_onset.py <dir>` — audio prep.

## Shared QA runner (use this instead of launching your own browser)
One runner serves the whole team (one Chromium, one static server, serial jobs against a fresh `vite build`
snapshot of the shared tree):

    node tools/qa/runner.mjs            # coordinator keeps this running
    node tools/qa/submit.mjs <owner> '{"views":[{"name":"hip","pos":[0,0,0],"yaw":0,"frames":20,"read":"window.__game.player.health"}]}'

`submit` blocks until done and prints `result.json`: screenshot paths (tools/qa/results/<id>/*.png),
console errors, `read`/`script` data, draw stats, build errors. Default 960x540.

QA runner timing model: frames advance on a fixed 50 ms step (`window.__qaFixedDt`); GPU rendering is skipped
(`window.__qaSkipRender`) except the final frame before each screenshot. `shot:false` views and `script`s don't render
unless the job sets `renderScript:true`. Use `fresh:true` to force a clean page load.

## Fast iteration rules (read before testing)
1. **Logic first, pixels second.** Check behaviour with `shot:false` views + `read` expressions or a `script` (no GPU
   work, fixed 50 ms step → hundreds of frames in seconds). Only screenshot what needs eyes.
2. **`lofi:true`** for functional screenshots (quality Low, 0.5 render scale). Full quality only for art review.
3. **Batch** everything into one job per iteration; warm pages make follow-up jobs skip the ~60 s load
   (use `fresh:true` only if you need a clean boot).
4. **Isolated labs for art** (e.g. viewmodel lab with a tiny scene) render ~10× faster than the full map —
   build one for your area if you iterate visually a lot.
5. **Don't wait idle**: `submit.mjs ... --nowait` returns a job id; keep coding, then read
   `tools/qa/results/<id>/result.json`.
6. Runner backend: headful Chromium on Xvfb + Mesa llvmpipe (~1.4× SwiftShader). Restart with `tools/qa/restart.sh`.
