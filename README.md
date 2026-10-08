# IRONLINE — realistic browser FPS

A tactical first-person shooter that runs in the browser: **three.js r186** rendering, **Rapier** physics,
**Recast/Detour** navigation for bots and **pmndrs/postprocessing + N8AO** for the image pipeline.

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static build in dist/
```

## Features

- **Movement** (Source-style accel/friction): walk, sprint, tactical sprint (double-tap Shift), crouch, slide,
  jump, **vault** over low cover and **mantle** onto ledges, lean Q/E, slow-walk (Alt), fall damage.
- **Camera feel**: spring-driven recoil kick, trauma-based shake, head bob, landing dip, lean/slide roll, sprint FOV,
  ADS zoom with zoom-relative sensitivity.
- **Weapons (11)**: M4A1, AK-47, SCAR-L (burst), MP5A5, VSS Vintorez, RPK-74, M870, M24, AWM, P226, M1911.
  Fire modes auto / burst / semi / pump / bolt, learnable recoil patterns + recovery, spread bloom, sprint-to-fire,
  **tactical vs empty reloads** (+1 in the chamber), shell-by-shell shotgun loading, bolt cycling, inspect, melee, frags.
- **Gunsmith**: optics (red dot, holo, 3.5× picture-in-picture scope, 8× sniper), suppressor, compensator, brake,
  flash hider, barrels, grips, bipod, extended / fast mags, laser — all with stat changes.
- **Authored first-person arms** with per-weapon reload animations; magazines follow the support hand.
- **Ballistics**: projectile bullets with drop and travel time, damage falloff, headshots, wall penetration
  through wood / plaster / thin metal, tracers, near-miss whiz + suppression.
- **Effects**: muzzle flashes + dynamic light, surface-specific impacts (sparks, dust, chips, blood), bullet-hole decals
  with normal maps, brass casings with physics, explosions, smoke.
- **Bots**: perception (vision cone + LOS + hearing), memory, utility-scored goals (patrol, engage, investigate,
  cover, reload, grenade), difficulty-based aim (reaction time, tightening aim error, recoil control), strafing,
  navmesh pathing with crowd avoidance, animated soldiers with layered upper/lower-body animation.
- **Modes**: Team Deathmatch and Free-For-All, CoD-style spawn logic, kill feed, medals, UAV streak, scoreboard.
- **HUD**: ammo / fire mode, segmented health, compass, rotating minimap, dynamic crosshair, hitmarkers,
  damage direction, scope overlay, death cam.

## Controls

| Key | Action |
| --- | --- |
| WASD / Mouse | Move / look |
| LMB / RMB | Fire / aim down sights |
| Shift | Sprint (double tap: tactical sprint; hold breath when scoped) |
| Space | Jump / vault / mantle |
| C / Ctrl | Crouch, slide while sprinting |
| Q / E | Lean |
| R | Reload |
| B | Fire mode |
| 1 / 2 / wheel | Switch weapon |
| V / G | Melee / frag grenade |
| I / L | Inspect / laser |
| Tab / Esc | Scoreboard / pause |

## Code map

```
src/core      Input, Physics (Rapier wrapper), Audio (WebAudio + procedural synth), Assets, math/springs
src/render    Renderer (post stack), Effects (particles, tracers, decals, shells), ProcTex (procedural textures)
src/world     Level (Ironline Depot), Materials (PBR library + macro variation + indoor IBL), Geo
src/game      Game loop, Player controller, FPCamera, Ballistics, Match
src/game/weapons  WeaponDefs/Weapon (logic), GunModels/ViewModel (presentation)
src/game/bots     Bot (AI), Character (animation), Navigation (recast)
src/ui        HUD, Menu (settings, gunsmith), CSS
tools/        headless playtest harness + audio prep scripts
```

## Credits & licences

Code is original except where noted. Third-party assets:

- **Weapon models** (M4A1, AK-47, MP5A5, VSS, M24, AWM, P226, M1911, optics) and the first-person
  arm-pose / reload-timing data: [AetherRadar/operation-steel-tide](https://github.com/AetherRadar/operation-steel-tide)
  (MIT for project work; underlying meshes CC0 — nisu, taradavies, Quaternius "Ultimate Guns").
- **SCAR-L**: "ScarL" by AdamKokrito — CC BY 3.0 (https://poly.pizza/m/ab1V8RlPDc), adapted by Operation Steel Tide.
- **First-person arms & reload animations**: "fps animated smg" by DJMaesen — CC BY 4.0
  (https://sketchfab.com/3d-models/fps-animated-smg-ea3dad7478624495a5a46f40127b0579), adapted by Operation Steel Tide.
- **Soldier (bots)**: "Military tactical suit (LowPolyGameReady)" by 1799danly — CC BY 4.0
  (https://sketchfab.com/3d-models/ef698ce36b1545a78ce592dd3db4c7ed); textures re-encoded (WebP), meshes merged.
  Animation rig/clip source: "FREE [Military Soldier] RIGGED" by BAMEN — CC BY 4.0
  (https://sketchfab.com/3d-models/free-military-soldier-rigged-e9c56308a67d4a3db62e914fafa4d198), fallback body;
  animation clips from Quaternius Universal Animation Library — CC0, retargeted at load.
- **Shotgun model**: by Harry_L — CC BY (https://sketchfab.com/models/53b158b0d5a54b4491b09d1fb3058e29), via Mugen87/dive.
- **Gunshot & firearm foley**: The Free Firearm Sound Library (CC0) — https://github.com/buddingmonkey/FreeFirearmsSFXLibrary
  and edits from operation-steel-tide.
- **Footsteps / impacts**: Kenney Impact Sounds — CC0.
- **PBR textures**: ambientCG and Poly Haven — CC0 (via Tiddybub/3d-assets and operation-steel-tide).
- **Props**: Poly Haven — CC0 (old_military_crate, concrete_road_barrier(_02), Barrel_01/02, barrel_03, ammo_box,
  cardboard_box_01, old_tyre, exterior_aircon_unit, street_lamp_01, security_light, utility_box_01/02, metal_trash_can,
  water_manhole_cover, covered_car, trashbag, metal_jerrycan_green, propane_tank, portable_generator,
  hanging_industrial_lamp, mounted_fluorescent_lights, modular_airduct_circular_01, modular_industrial_pipes_01,
  wooden_crate_02, cement_bag, rusted_wheel_rim_01, WetFloorSign_01, barrel_stove, overhead_crane), simplified and
  re-encoded (webp) with gltf-transform.
- **HDRI**: Poly Haven "Bambanani Sunset" (Dimitrios Savva, Jarod Guest) — CC0.
- **Level textures added**: ambientCG Ground110, Fence006 (chain-link), MetalWalkway013 (grating), Leaking003 (wall
  streaks) — CC0.
- Design references: Mugen87/dive & Yuka (bot architecture), Quake/Source movement, CS/Valorant recoil design,
  F.E.A.R. & Killzone bot AI talks.
- Fonts: Rajdhani, Barlow Condensed (SIL OFL) via Fontsource.
