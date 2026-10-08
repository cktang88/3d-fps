# Dev tools

- `node tools/shot.mjs <scenario> [outDir]` — headless Chromium (SwiftShader WebGL) playtest.
  Env: `PORT` (default 5199, use a unique port per concurrent run), `W`/`H` viewport,
  `VIEWS` = JSON array of `{name,pos:[x,y,z],yaw,pitch,weapon,ads,fire,reload,sprint,frames,eval}`;
  `eval` is a JS string run in the page (`window.__game` is the Game instance).
  Screenshots land in `tools/shots/` (gitignored).
- `python3 tools/cut_foley.py <in> <out>` / `tools/trim_onset.py <dir>` — audio prep.
