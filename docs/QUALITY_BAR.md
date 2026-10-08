# Quality bar ("game dev bible")

Every change to Ironline is held to these principles:

1. **Intention and taste in every detail** — cohesive art direction (cf. Intravenous, Hades). Nothing default-looking.
2. **Meticulous, spare no expense** — check every weapon, every room, every state transition.
3. **Labor of love** — polish the parts players touch every second: movement, aim, shooting, sound, feedback.
4. **Satisfaction / dopamine loop** — crisp hit feedback, rewarding kills, medals, streaks, readable progress.
5. **Basics done exceedingly well** — no jank: no clipping, popping, sliding feet, z-fighting, light leaks,
   stuck movement, UI overlap, abrupt cuts or missing sounds. Nothing should look like a prototype.

Verification: every visual change is checked with the headless screenshot harness (`tools/shot.mjs`) before it lands.
6. **Jaw-drop visuals** — would a player stop and stare? Every frame should read like key art.

## Art direction: "Ironline — edge of a live war zone"
Stormy golden hour after rain: a low warm sun breaks through dark storm clouds; wet asphalt and puddles mirror
fire and sodium light; haze glows toward the sun; god rays cut through warehouse windows. Beyond the walls a battle
rages — artillery flashes on the clouds, smoke columns, descending flares, tracer arcs, a helicopter sweeping by.
Inside the depot: burning wrecks, embers and ash drifting through light shafts. Cinematic grade: warm highlights,
cool teal shadows.

## Visual cohesion pipeline (no "random downloads" look)
All assets pass through one shared look: albedo/roughness/normal-intensity normalisation, consistent texel density,
a global weathering + wetness layer, contact grounding (AO + dirt decals), identical sun/IBL/fog, and a single
colour grade as the final glue. Details: `docs/ART_PIPELINE.md`.

## Asset sourcing
Curated, licence-verified catalogue: `docs/ASSET_SOURCES.md` (GitHub repos first, plus Sketchfab, Poly Haven,
ambientCG, OpenGameArt, itch.io, Kenney, Quaternius). Allowed: CC0 / CC-BY / CC-BY-SA or explicitly redistributable
in a public open-source game. Never: NC, ND, store licences, ripped commercial-game assets, raw Mixamo files.
Every shipped asset is credited in README.

## Process
- **Model policy:** all agents run on Claude Opus 5.5 (medium effort). Never Haiku.
- **QA lead** (dedicated agent) owns the regression suite (`tools/qa/suites/`), runs it against the shared tree via
  the single QA runner, reviews every screenshot against this bar, routes findings to owners, and keeps
  `docs/QA_REPORT.md` current. Engineers send it specific test requests.
