# First-person framing & FP rig contract

This is the spec the first-person rigs are built to (`tools/blender/`), and the targets QA checks them against
(in-game screenshots via `node tools/qa/submit.mjs fprig '<job>'`).

## 1. Reference set

34 gameplay screenshots (Steam store `appdetails` screenshots, 1920x1080) of hip-fire and ADS from Call of Duty
MWII/MWIII, Battlefield 4/2042/6, Insurgency + Insurgency: Sandstorm, Ready or Not, Squad, Hell Let Loose,
Counter-Strike 2, Hunt: Showdown 1896, Rainbow Six Siege, Arma Reforger, Gray Zone Warfare and Delta Force.
They were measured on a 10% grid. The images are not redistributed; `tools/blender/README.md` has the fetch
command. Measurements are given as % of screen width (x, from the left) and height (y, from the top), with the
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

### Rig framing (implemented, `tools/blender/rigs.py` FRAMING)

Placement is anchored at the bore point above the web of the grip marker. Rotations are pitch / yaw / roll in degrees.

| Class | Bore point at web (m) | Rotation (deg) | Result for the AK at hip |
|---|---|---|---|
| rifle | (0.085, 0.200, -0.080) | (0.5, 0.5, 3) | rear sight ~(64%, 62%), front sight ~(56%, 57%) |
| smg | (0.082, 0.195, -0.078) | (0.5, 0.5, 3) | |
| sniper | (0.090, 0.215, -0.088) | (0.5, 0.5, 2) | |
| shotgun | (0.085, 0.200, -0.082) | (0.5, 0.5, 3) | |
| pistol | (0.065, 0.260, -0.072) | (1, 2, 2) | |

Shoulders are camera-relative (R (0.19, -0.04, -0.21), L (-0.17, 0, -0.21)). When a hand is out of reach, the
shoulder slides toward it along the arm line, which keeps the open sleeve ends below the frame. Elbow pole targets
are below and outside the arms (R (0.45, 0.05, -0.75), L (-0.30, 0.25, -0.75)), which tucks the elbows.

## 4. Quality gates

* **Intersection.** For each rig, the automatic BVH check in `build_rig.py` reports the maximum penetration of hand,
  finger and forearm vertices into the gun. It uses nearest-face normals confirmed by an 8-ray exit vote, so
  single-sided decals do not count. The per-weapon numbers are in `tools/blender/out/rig_<id>.json`. Target:
  < 2 mm for anything visible from the FP camera. The authored ccransh templates themselves penetrate their own
  guns by 9–12 mm (self-test `build_rig.py tpl_rifle`), so the solver is required, not optional.
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
blender -b --python tools/blender/zoom.py -- <glb> <png> y0 y1 z0 z1 step    # gridded views for reading markers
python3 tools/blender/gridify.py <png>…                                      # draw the metric grid (system python + PIL)
blender -b --python tools/blender/build_rig.py -- <id> <sf> <work> <out.glb> # pose, solve, report, render, export
tools/blender/build_all.sh <blender> <sf> <work> <outdir>                    # all ten rigs
tools/blender/optimize.sh <outdir>                                           # gltf-transform: webp, prune, weld
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
| M4A1, AK-47 (unchanged meshes, re-rigged) | Operation Steel Tide (AetherRadar) | github.com/AetherRadar/operation-steel-tide | MIT |
