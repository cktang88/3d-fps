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
