# Quality bar ("game dev bible")

Every change to Ironline is held to these principles:

1. **Intention and taste in every detail** — cohesive art direction (cf. Intravenous, Hades). Nothing default-looking.
2. **Meticulous, spare no expense** — check every weapon, every room, every state transition.
3. **Labor of love** — polish the parts players touch every second: movement, aim, shooting, sound, feedback.
4. **Satisfaction / dopamine loop** — crisp hit feedback, rewarding kills, medals, streaks, readable progress.
5. **Basics done exceedingly well** — no jank: no clipping, popping, sliding feet, z-fighting, light leaks,
   stuck movement, UI overlap, abrupt cuts or missing sounds. Nothing should look like a prototype.

Verification: every visual change is checked with the headless screenshot harness (`tools/shot.mjs`) before it lands.
