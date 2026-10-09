# First-person framing & FP rig contract

This is the spec the first-person rigs are built to (`tools/blender/`), and the targets QA checks them against
(in-game screenshots via `node tools/qa/submit.mjs fprig '<job>'`).

## 1. Reference set

34 gameplay screenshots (Steam store `appdetails` screenshots, 1920x1080) of hip-fire and ADS from Call of Duty
MWII/MWIII, Battlefield 4/2042/6, Insurgency + Insurgency: Sandstorm, Ready or Not, Squad, Hell Let Loose,
Counter-Strike 2, Hunt: Showdown 1896, Rainbow Six Siege, Arma Reforger, Gray Zone Warfare and Delta Force.
They were measured on a 10% grid. The images are not redistributed: fetch them again with
`https://store.steampowered.com/api/appdetails?appids=<id>&filters=screenshots`. Measurements are given as % of screen width (x, from the left) and height (y, from the top), with the
crosshair at (50%, 50%).

## 2. Camera

| | Value | Notes |
|---|---|---|
| Viewmodel camera | **vertical FOV 52°** (85° horizontal at 16:9), near 0.01 m | Separate pass. Independent of the world FOV (default 100° horizontal). The menu "Viewmodel FOV" slider moves it from 40° to 70°. |
| ADS | viewmodel vFOV drops 10° (`Weapon.vmAdsFovDrop`) | The world camera zooms by the optic magnification |
| Scale | guns and arms at **real size** (rig GLBs are authored at K = 2 x real; WeaponRoot scale = 1/K) | The hands are 0.18 m from wrist to index tip; every gun matches its real length |

Framing is purely angular: scaling the whole viewmodel about the eye changes nothing on screen. Only the pose
relative to the eye matters, so all targets below are given as camera-space positions (metres, x right, y
forward, z up) plus the screen positions they produce at vFOV 52°.

## 3. Measured targets per class (hip)

| Class | Rear sight / optic | Front sight / muzzle | Gun silhouette | Firing hand | Support hand / forearm | Bore line |
|---|---|---|---|---|---|---|
| **Rifle** (Sandstorm, Insurgency, BF4, R6, Arma, Gray Zone) | x 60–68%, y 52–62% | x 55–63%, y 50–55% | right ~40% of the screen, cut by the bottom-right corner | partly visible at the bottom-right (x 70–100%, y 80–100%) or just off-screen | glove and wrist visible under the handguard at x 45–65%, y 62–85%; forearm enters from the bottom edge | converges on the crosshair (the muzzle points within ~5% of centre) |
| **SMG** | x 60–66%, y 52–60% | x 56–60%, y 50–54% | shorter, so more of the support hand shows | as rifle | x 48–62%, y 62–80% | as rifle |
| **Sniper / marksman** | scope body x 62–85%, y 35–55% (Gray Zone, Sandstorm) | barrel x 52–60%, y 48–53% | long barrel reaches close to the crosshair | as rifle | further forward and smaller, x 50–60%, y 60–75% | as rifle |
| **Shotgun** | rib or bead x 60–66%, y 55–60% | x 55–60%, y 50–54% | as rifle | as rifle | on the pump, x 50–60%, y 62–78% | as rifle |
| **Pistol** (Hunt, Delta Force, CS2) | slide rear x 62–70%, y 55–65% | muzzle x 60–66%, y 52–57% | small, right of centre, both hands wrapped | both hands visible, wrists rising from the bottom (x 58–80%, y 70–100%) | thumbs-forward two-hand grip | slight inward cant |

**ADS:** the sight axis is the screen centre (exact, computed per optic). A red dot or holo housing spans 10–20%
of the screen width (R6: 17%). A magnified scope ring spans 28–40% of the width (Squad: 28%). Irons put the rear
aperture or notch 0.26–0.34 m from the eye.

**Sprint:** the gun is lowered and canted 30–60°, muzzle down-left, and mostly leaves frame through the bottom-right.
Pistols tip up and in toward the chest.

**Reload:** the gun rolls 15–25° toward the support hand and rises slightly, so the magazine well comes into frame
(x 50–65%, y 60–85%). The support hand has to be visible for the whole magazine swap.

### Professional reference: Free FPS Template (Fab) rifle set

These numbers were measured in headless Blender from `Animations/Animations_Assault_Rifle.blend`
(`tools/blender/extract_template_anims.py`). In the template the camera is CHILD_OF the `head` bone, the weapon follows
`ik_hand_gun`, it runs at 30 fps, and the gun is a 0.75 m AAC Honey Badger. The listing assumes UE's 90° horizontal
FOV, which is close to our viewmodel vFOV 52° (85° horizontal at 16:9).

| Pose | Grip (`ik_hand_gun`) relative to the eye: right / forward / down (cm) | Gun orientation | Screen (vFOV 52°) |
|---|---|---|---|
| Idle (hip) | 5.8 / 14.4 / 9.8 | parallel to the view axis, about 5° cant (top to the left) | rear sight about (72%, 50%), front sight about (57%, 52%) |
| Aim (ADS) | 0.0 / 9.6 / 9.9 | exactly on axis | sight on the crosshair |
| Support hand (idle, gun space) | 4.6 left / 14.5 ahead of the grip / 0.2 below | | forearm enters diagonally from the bottom-left |
| Support elbow (camera space) | 15 left / 8 forward / 17 down | | |

| Clip | Length | Shape (measured on the gun) |
|---|---|---|
| Idle loop | 3.73 s | breathing 0.32 cm / 0.5° |
| Walk loop (2 steps) | 1.10 s | 0.44 cm / 0.5° (aimed 0.25 cm / 0°) |
| Run loop (2 steps) | 1.00 s | sprint carry: 43° rotation, 7.3 cm |
| Fire (hip / aimed) | 0.80 s | peak at frame 1 (33 ms): 1.8 cm / 2.7° hip, 2.2 cm / 0.7° aimed, then a slow settle |
| Reload (tactical) | 3.17 s (95 f) | hand reaches the magazine f0–8; magazine out f8; pouch at f24 (39 cm away); back in by f57 (seated); hand on the handguard by f75; gun rolls up to 64° |
| Equip | 1.07 s | from 68° / 15.8 cm below, ease-out |
| Holster | 0.73 s | to 68° / 15.8 cm below |

How these numbers are used in the game:
* **Hip framing** (`rigs.py` FRAMING) is matched to the template idle. The bore point above the grip is at
  (6.8, 14.4, -5.2) cm with 5° cant. That is 1.4 cm higher than the template after the side-by-side QA, because our
  models carry their sights lower above the grip. The left shoulder and elbow pole come from the template, giving the
  diagonal support forearm.
* **Animation:** all clips are retargeted at effector level (`tools/blender/retarget_template.py` →
  `public/assets/anims/fp_rifle_anims.json`, 43 KB) and drive every rifle-family FP rig (`src/game/weapons/FPAnims.js`,
  `ViewModel._applyTemplate` / `_tplReload`):
  - the gun gets camera-space deltas from the template's base pose;
  - the support hand follows the template's gun-space path, re-anchored from its handguard grip and magazine well
    onto each gun's GripL and magazine well, and solved by our arm IK;
  - the magazine follows the template magazine track.
  Pistols and the pump shotgun's shell loading keep their own animation.
* **Reload art direction (from user feedback).** The template reload tips the muzzle about 25° up with up to 53° roll.
  In our camera that swings the support forearm across the screen centre. The retarget keeps the template's
  timing and envelope (grab f8, magazine seated f57, hand back f75) but rebuilds the rifle pose about the grip:
  - 2.5 cm down, 2.5 cm inboard, 2 cm forward;
  - muzzle 4° down;
  - cant at most 30°, with the magazine well turned toward the eyes;
  - yaw halved.
  The sprint carry (template Run loop) gets the same treatment. It keeps the timing and rotation but pivots about
  the grip, carries the rifle 8 cm lower and 2 cm inboard, and caps the cant at 35°. Our full-length stocks
  otherwise swing the receiver into the top-right of the frame.
  The procedural reload carries for pistols and the shotgun's shell-by-shell loading are lowered the same way
  (`FP_TUNE.reloadPos/reloadRot`). Target: arm and hand pixels under 25% of the screen at peak, and nothing in the
  central 20% box for more than a few frames. This is measured by `tools/qa/arm_coverage.py` on QA mask shots, where
  the arms are rendered flat magenta. Setting `window.__vmProcAnims = true`
  restores the procedural set for A/B comparison.

### Rig framing (implemented, `tools/blender/rigs.py` FRAMING)

Placement is anchored at the bore point above the web of the grip marker. Rotations are pitch / yaw / roll in degrees.

| Class | Bore point at web (m) | Rotation (deg) |
|---|---|---|
| rifle | (0.068, 0.144, -0.052) | (0, 0, 5) |
| smg | (0.072, 0.180, -0.056) | (0, 0, 5) (SMG sights sit right over the grip, so the gun goes further out) |
| sniper | (0.070, 0.150, -0.058) | (0, 0, 4) |
| shotgun | (0.068, 0.144, -0.054) | (0, 0, 5) |
| pistol | (0.050, 0.220, -0.035) | (1, 1, 2) (matched to Hunt: Showdown / Delta Force pistol references) |

Shoulders are camera-relative (R (0.19, -0.04, -0.21), L (-0.29, -0.15, -0.12) from the template). When a hand is out of reach, the
shoulder slides toward it along the arm line, which keeps the open sleeve ends below the frame. Elbow pole targets
are below and outside the arms (R (0.45, 0.05, -0.75), L (-0.32, 0.12, -0.32)), which tucks the elbows.

## 4. Quality gates

* **Intersection.** For each rig, the automatic BVH check in `build_rig.py` reports the maximum penetration of hand,
  finger and forearm vertices into the gun. It uses nearest-face normals confirmed by an 8-ray exit vote, so
  single-sided decals do not count. The per-weapon JSON report is written to `<work>/rig_<id>.json`. Target:
  < 2 mm. The authored ccransh templates themselves penetrate their own guns by 9–12 mm (self-test
  `build_rig.py tpl_rifle`), so the solver is required, not optional.

  Solver stages: (1) the template hand is transferred by grip markers; (2) a rigid 6-DOF least-squares palm fit plus a
  snug slide-back; (3) arm IK with forearm twist distributed over three twist bones; (4) per-finger
  de-penetration and wrap-to-contact; (5) a corrective contact pass baked into the rest pose. That last pass
  projects residual vertices onto the surface plus 0.3 mm, with a 12 mm cosine falloff to neighbours.

  | Weapon | Hands after pose solve (mm) | Forearms after pose solve (mm) | **Final (exported), mm** | Vertical-grip variant, mm |
  |---|---|---|---|---|
  | M4A1 | 5.77 | 0.00 | **1.89** | 4.01 |
  | AK-47 / RPK | 3.60 | 0.00 | **0.10** | 4.64 |
  | SCAR-L | 7.89 | 0.00 | **0.15** | 3.30 |
  | MP5A5 | 9.98 | 0.00 | **0.09** | 3.48 |
  | VSS | 10.93 | 0.00 | **0.19** | 4.05 |
  | M24 | 8.63 | 0.00 | **0.15** | – |
  | AWM | 16.13 | 2.41 | **0.19** | – |
  | M870 (Remington) | 13.91 | 14.89 | **0.22** | – |
  | P226 | 10.97 | 0.00 | **1.85** | – |
  | M1911 | 4.15 | 0.00 | **0.65** | – |

  The vertical-grip variant (`grip_vgrip` pose clip) is bone-only, so the corrective vertex pass does not apply
  to it yet. That is why those numbers are 3–5 mm.
* **In game.** Hip, ADS, sprint and reload-midpoint screenshots for every weapon must show zero visible clipping
  between the arms and the gun or its attachments.

## 5. FP rig GLB node contract (`public/assets/models/fp/<id>.glb`)

glTF frame: +Y up, muzzle toward **-Z**, units = K x real metres (K = 2, `FP_K`).

```
FP_<id>                      root (identity). extras.fp = JSON {K, cls, hip:{pos,rot,boreRef}, boreZ, web, trig, maxPenetrationMm}
├─ Gun_<id>                  the gun (GunModels.src[<id>] uses this subtree)
│  ├─ Body…                  static meshes
│  ├─ Magazine               detachable magazine (pivot = top centre of the mag)
│  │  └─ MagazineGripSocket  where the support hand holds it during reloads
│  ├─ ChargingHandle         part that cycles when firing (slide / bolt carrier / bolt)
│  ├─ Pump                   (shotgun) fore-end that racks
│  ├─ Glass…                 scope lens meshes (material name contains "glass"; hidden in game)
│  ├─ MuzzleSocket           bore exit (flash / tracer origin)
│  └─ EjectionPort           brass exit
│  (m4a1 / ak47 keep the steel-tide node set: RearIronSight, FrontIronSight, OpticRailSocket, Suppressor, Foregrip…)
├─ GripR                     firing-hand marker (web of the hand, rotated to the grip rake)
├─ GripL                     support-hand marker (palm centre under the handguard / pump)
└─ FPRig                     armature; rest pose = authored hold
   ├─ _rootJoint/Root/UpArm_*/Forearm_*/BoneTwist_0{1,2,3}.*   arm chain (twist distributed)
   ├─ IK_Hand_Cntrl_{L,R} → Hand_{L,R} → Bone_{L,R}.004–.022  hands + fingers (thumb = .020–.022)
   └─ FPArms                 skinned glove + sleeve mesh (DJMaesen arms, ccransh rig)
```

Runtime (`src/game/weapons/FPRig.js`): the right hand rides the gun rigidly. The left arm is re-solved with an
analytic two-bone IK (`UpArm_L` → `Forearm_L` → wrist, keeping the authored elbow plane) when the support hand
leaves its grip: pump strokes, magazine swaps (the hidden reload clip drives the hand target) and shell loading.

## 6. Pipeline (re-run any step headless; one Blender at a time)

```
blender -b --python tools/blender/extract_templates.py -- <sf> <work>        # grip templates from the ccransh packs
blender -b --python tools/blender/prep_guns.py -- <sf> <work> [ids]          # normalise guns (canonical frame, K x real)
blender -b --python tools/blender/blank_marks.py -- <work>/gun_<id>.glb <id>  # erase maker roll-marks (trademarks)
blender -b --python tools/blender/measure_sights.py -- <work>                # iron sight line + rail -> FP_TUNE
blender -b --python tools/blender/prep_optics.py -- <sf> <out optics.glb>     # optics in the steel-tide contract
blender -b --python tools/blender/review_fp.py -- <fp.glb> <prefix>          # re-measure + render an exported rig
blender -b --python tools/blender/zoom.py -- <glb> <png> y0 y1 z0 z1 step    # gridded views for reading markers
python3 tools/blender/gridify.py <png>…                                      # draw the metric grid (system python + PIL)
blender -b --python tools/blender/build_rig.py -- <id> <sf> <work> <out.glb> # pose, solve, report, render, export
tools/blender/build_all.sh <blender> <sf> <work> <outdir>                    # all ten rigs
tools/blender/optimize.sh <outdir> public/assets/models/fp                  # gltf-transform: dedup, prune, 1K, weld, quantize, webp
# then list the ids in public/assets/models/fp/manifest.json (GunModels only requests listed rigs)
```

The export step also bakes **ambient occlusion** with Cycles: one 1K atlas per rig on a dedicated UV set, covering
gun and arms together so the grip-in-hand contact and magazine wells darken. It is wired as glTF `occlusionTexture`
and loaded by three.js as `aoMap`.

Note on rig sizes: 1.8–5.2 MB each, 29 MB for all ten. Textures from the many-material sources dominate (VSS,
AK, P226). They can be cut further by atlasing.

```
```

## 7. Credits (CC-BY 4.0 unless noted; modifications: re-posed, re-rigged, rescaled, re-textured to webp)

| Asset | Author | Source | Licence |
|---|---|---|---|
| Fps arms (glove/sleeve mesh) | bumstrum (DJMaesen) | sketchfab.com/3d-models/fps-arms-9452ce4cddde4110a4fd73e555a8e412 | CC-BY 4.0 |
| FPS AK-74m animations (arm rig + rifle grip template) | ccransh | sketchfab.com/3d-models/fps-ak-74m-animations-94be8385c402474cacd39bc096c6ca14 | CC-BY 4.0 |
| FPS pistol animations (pistol grip template) | ccransh | sketchfab.com/3d-models/fps-pistol-animations-0d7a343dcb6f401197a73c91aee93f6d | CC-BY 4.0 |
| FPS animations sniper rifle (bolt grip template) | ccransh | sketchfab.com/3d-models/fps-animations-sniper-rifle-c15ae8393d824f5b929e3f69691cdd31 | CC-BY 4.0 |
| FPS Arms remington (Remington 870 pump + grip template) | ccransh (870 by tris09) | sketchfab.com/3d-models/fps-arms-remington-shotgun-e68ef617fe8a48cca8610d016ffd5881 | CC-BY 4.0 |
| FN Scar-L Assault Rifle | Hitansh_3DArtist | sketchfab.com/3d-models/fn-scar-l-assault-rifle-ea1823de59684fd596d9f6726382f948 | CC-BY 4.0 |
| MP5 Submachine Gun | Rotuma | sketchfab.com/3d-models/mp5-submachine-gun-a73b61932a0e4eecb5db5c63c158aa24 | CC-BY 4.0 |
| Special Sniper Rifle VSS Vintorez | ArmsMuseum | sketchfab.com/3d-models/special-sniper-rifle-vss-vintorez-4d5d8c1b7b79429abfa4816f18330089 | CC0 |
| M24 Bounty Hunter Sniper Rifle | Naudaff3D | sketchfab.com/3d-models/m24-bounty-hunter-sniper-rifle-d40e74e2259549f5b025807163f1028c | CC-BY 4.0 |
| AWM | erhanmatur | sketchfab.com/3d-models/awm-bacc05ad5c074c9daa3aa7ca02766a6c | CC-BY 4.0 |
| Sig Sauer P226 | Alexcanot | sketchfab.com/3d-models/sig-sauer-p226-e3d4f1ab22f342f4a0891743353c114c | CC-BY 4.0 |
| M1911 pistol | egorbelous | sketchfab.com/3d-models/m1911-pistol-80a0b8a6c4314da4a7b3a7cfe6cec1d4 | CC-BY 4.0 |
| First-person rifle animations (idle, walk, run, fire, reload, equip, holster), effector-retargeted | Free FPS Template (Fab) Blender source files; controller shapes by Helindu | Fab listing | used under its licence |
| M4A1, AK-47 (unchanged meshes, re-rigged) | Operation Steel Tide (AetherRadar) | github.com/AetherRadar/operation-steel-tide | MIT |
| Generic Red Dot Scope (red dot) | valterjherson1 | sketchfab.com/3d-models/generic-red-dot-scope-rifle-attachment-lowpoly-8bf2794c30d04fa0aed1e3df92cd8a9e | CC-BY 4.0 |
| EoTech EXPS3-0 Holographic Weapon Sight (holo; logos removed) | valterjherson1 | sketchfab.com/3d-models/eotech-exps3-0-holographic-weapon-sight-lowpoly-45e4fcdfb1b34756ab9e866564a12f66 | CC-BY 4.0 |
| Advanced Combat Optical Gunsight (4x scope) | Argentavisss | sketchfab.com/3d-models/advanced-combat-optical-gunsight-game-ready-4675fc83ccc54c018d4d03ee1709e8f5 | CC-BY 4.0 |
| Nightforce ATACR 4-20x50 F1 Riflescope (sniper; markings removed) | ense7en | sketchfab.com/3d-models/nightforce-atacr-4-20x50-f1-riflescope-2ae2ddbc7ee049e3afcc3117f4ce6aa5 | CC-BY 4.0 |
