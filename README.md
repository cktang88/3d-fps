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
  animation clips from Quaternius Universal Animation Library 1 & 2 (Standard) — CC0 (https://quaternius.com), retargeted at load.
- **Shotgun model**: by Harry_L — CC BY (https://sketchfab.com/models/53b158b0d5a54b4491b09d1fb3058e29), via Mugen87/dive.
- **First-person rigs** (`public/assets/models/fp/`, built by `tools/blender/`, see `docs/FP_FRAMING.md`). All are CC BY 4.0
  unless noted. Modifications: re-posed, re-rigged, rescaled, maker markings removed, textures re-encoded (WebP),
  AO baked.
  - Gloved arms: "Fps arms" by bumstrum (DJMaesen) (https://sketchfab.com/3d-models/fps-arms-9452ce4cddde4110a4fd73e555a8e412).
  - Arm rig and grip templates by ccransh: "FPS AK-74m animations" (https://sketchfab.com/3d-models/fps-ak-74m-animations-94be8385c402474cacd39bc096c6ca14),
    "FPS pistol animations" (https://sketchfab.com/3d-models/fps-pistol-animations-0d7a343dcb6f401197a73c91aee93f6d),
    "FPS animations sniper rifle" (https://sketchfab.com/3d-models/fps-animations-sniper-rifle-c15ae8393d824f5b929e3f69691cdd31).
  - Remington 870 pump shotgun: "FPS Arms remington (shotgun)" by ccransh, with the 870 by tris09 (https://sketchfab.com/3d-models/fps-arms-remington-shotgun-e68ef617fe8a48cca8610d016ffd5881).
  - SCAR-L: "FN Scar-L Assault Rifle" by Hitansh_3DArtist (https://sketchfab.com/3d-models/fn-scar-l-assault-rifle-ea1823de59684fd596d9f6726382f948).
  - MP5: "MP5 Submachine Gun" by Rotuma (https://sketchfab.com/3d-models/mp5-submachine-gun-a73b61932a0e4eecb5db5c63c158aa24).
  - VSS: "Special Sniper Rifle VSS Vintorez" by ArmsMuseum, CC0 (https://sketchfab.com/3d-models/special-sniper-rifle-vss-vintorez-4d5d8c1b7b79429abfa4816f18330089).
  - M24: "M24 Bounty Hunter Sniper Rifle" by Naudaff3D (https://sketchfab.com/3d-models/m24-bounty-hunter-sniper-rifle-d40e74e2259549f5b025807163f1028c).
  - AWM: "AWM" by erhanmatur (https://sketchfab.com/3d-models/awm-bacc05ad5c074c9daa3aa7ca02766a6c).
  - P226: "Sig Sauer P226" by Alexcanot (https://sketchfab.com/3d-models/sig-sauer-p226-e3d4f1ab22f342f4a0891743353c114c).
  - M1911: "M1911 pistol" by egorbelous (https://sketchfab.com/3d-models/m1911-pistol-80a0b8a6c4314da4a7b3a7cfe6cec1d4).
- **Optics** (`optics.glb`). All are CC BY 4.0, and logos and markings were removed.
  - Red dot: "Generic Red Dot Scope / Rifle Attachment Lowpoly" by valterjherson1.
  - Holographic sight: "EoTech EXPS3-0 Holographic Weapon Sight Lowpoly" by valterjherson1.
  - 4x scope: "Advanced Combat Optical Gunsight | Game Ready" by Argentavisss.
  - Sniper scope: "Nightforce ATACR 4-20x50 F1 Riflescope" by ense7en (Sketchfab).
- **First-person rifle animations**: retargeted from the Free FPS Template Blender source files (Fab), used under its
  licence (controller shapes by Helindu).
- **Gunshot & firearm foley**: The Free Firearm Sound Library (CC0) — https://github.com/buddingmonkey/FreeFirearmsSFXLibrary
  and edits from operation-steel-tide.
- **Footsteps / impacts / UI / explosions**: Kenney Impact Sounds, Interface Sounds and Sci-Fi Sounds — CC0 (https://kenney.nl).
- **PBR textures**: ambientCG and Poly Haven — CC0 (via Tiddybub/3d-assets and operation-steel-tide).
- **Props**: Poly Haven — CC0 (old_military_crate, concrete_road_barrier(_02), Barrel_01/02, barrel_03, ammo_box,
  cardboard_box_01, old_tyre, exterior_aircon_unit, street_lamp_01, security_light, utility_box_01/02, metal_trash_can,
  water_manhole_cover, covered_car, trashbag, metal_jerrycan_green, propane_tank, portable_generator,
  hanging_industrial_lamp, mounted_fluorescent_lights, modular_industrial_pipes_01,
  wooden_crate_02, cement_bag, rusted_wheel_rim_01, WetFloorSign_01, barrel_stove), simplified and
  re-encoded (webp) with gltf-transform.
- **HDRI**: Poly Haven "Bambanani Sunset" (Dimitrios Savva, Jarod Guest) — CC0.
- **Level textures added**: ambientCG Ground110, Fence006 (chain-link), MetalWalkway013 (grating), Leaking003 (wall
  streaks) — CC0.
- **Ambience**: "Destroyed Ford Crown Vic" by alexdelker and "Sikorsky UH-60 Black Hawk" by helijah — CC BY 4.0 (Sketchfab;
  simplified/re-lit, see `public/assets/ambience/models/*/SOURCE.md`); Unity Labs VFX flipbooks Explosion01, WispySmoke02 & Flame03 — CC0;
  Poly Haven rusty_metal_04 — CC0.
- Design references: Mugen87/dive & Yuka (bot architecture), Quake/Source movement, CS/Valorant recoil design,
  F.E.A.R. & Killzone bot AI talks.
- Fonts: Rajdhani, Barlow Condensed (SIL OFL) via Fontsource.
