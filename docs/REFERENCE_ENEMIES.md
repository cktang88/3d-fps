# Enemy soldier reference: how bots hold, aim, move with, fire and reload weapons

> **Status:** current spec. Its measurable rules are the thresholds of `tools/qa/suites/h_bot_jank.json`. The
> reference images it cites (`$R`) are copyrighted study material that was never committed; the scratchpad path below
> was session-local and no longer resolves.

This is the visual spec for third-person bots (`src/game/bots/Character.js`, Mixamo-named skeleton). It describes
how trained shooters actually stand and move, and how top-tier shooters present them. Every rule comes with a number
QA can measure on a filmstrip. First-person framing is a separate contract (`docs/FP_FRAMING.md`). Distances here are
**real-world metres on a 1.80 m soldier**; scale them with the character's height (`k = height / 1.80`).

Conventions: the character faces +Z, +Y is up and +X is the character's left (three.js / Mixamo). Joint angles are
**interior angles** (180° = straight limb), and lean is measured from vertical. The right hand is the firing hand.
Bone names drop the `mixamorig` prefix.

## 0. Reference set (127 images plus doctrine pages; about 80 curated into the topic sheets; private study only)

All images are in the scratchpad, not the repo: `/tmp/claude-0/-home-user-3d-fps/8eb28a25-1b2d-5f63-b839-4dfb66034c06/scratchpad/refs_enemies/`
(below called `$R`).

* **Games (58 full-resolution shots picked from 193 Steam store screenshots, `$R/full/*.jpg`; ~45 used in the sheets):** Arma 3, Arma Reforger, Squad,
  Insurgency: Sandstorm, Ready or Not, Ground Branch, Escape from Tarkov, Gray Zone Warfare, Six Days in Fallujah,
  CoD MWII/MWIII, Battlefield 2042, Battlefield 6, Hunt: Showdown 1896, TLOU Part II, Ghost Recon Wildlands and
  Breakpoint. Fetch them with `store.steampowered.com/api/appdetails?appids=<id>`. **Copyrighted: never commit or redistribute them.**
* **Real-world (69 photos, `$R/real/*.jpg`; ~30 used in the sheets):** US DoD and allied training photos from Wikimedia Commons and from
  Flickr via Openverse (public domain / PDM, some CC-BY). Licences and source URLs are in `$R/real/_meta.tsv`.
* **Doctrine:** US Army **TC 3-22.9 *Rifle and Carbine*** (May 2016, public domain), ch. 6 carry and firing
  positions, ch. 8 workspace. Rendered pages: `$R/real/tc_*.jpg`.

| Topic | Contact sheet (`$R/sheets/`) | Best single references |
|---|---|---|
| Shouldered aim, stance | `01_shouldered_aim.jpg` | sandstorm_07/09 (clean side view), cod_03, eft_16, squad_18, `tc_stand_kneel` |
| Moving while aimed | `02_moving_aimed.jpg` | gb_07 (shoot-and-move line), cod_09, gb_01 (stack), eft_00, arma3_06 |
| Ready/carry/sprint | `03_ready_carry_sprint.jpg` | cod_00 (low ready), ov_patrol_5, ov_mout_3, bf2042_01, squad_06, TC low/high/collapsed ready |
| Crouch/kneel | `04_crouch_kneel.jpg` | ov_kneelfire_0/3, kneel_3, bf2042_09, grwl_00, squad_19 |
| Pistol | `05_pistol.jpg` | ov_pistol_2 (side isosceles), ov_pistol_4, tlou2_01, bf2042_09 (one-hand) |
| Reload | `06_reload.jpg` | ov_reload3_0 (workspace and cant), ov_reload4_2, ov_reload3_1, kneel_1 |
| Hits/deaths | `07_hits_deaths.jpg` | gzw_04 (rest poses), squad_04, bf6_07, grwl_00 (Hollywood throw-back, **do not copy**) |

Triage sheets for all 193 Steam shots: `$R/triage_{a,b,c,d}.jpg`.

## 1. What the references agree on

1. **The rifle comes to the head; the head does not go down to the rifle** (TC 3-22.9 §6-2). The neck stays nearly
   upright, the cheek rests on the stock, and the eye sits on the sight line. Every AAA reference keeps the face
   *behind* the optic, not beside it.
2. **The buttstock lives in the shoulder pocket**, inboard of the deltoid on the plate carrier, not on the
   upper arm and not floating in front of the chest. The stock touches the body in every aiming frame.
3. **Aggressive forward posture**: nose over toes, knees unlocked, weight on the balls of the feet. Nobody in a modern
   reference leans back.
4. **Modern elbows are tucked, not chicken-winged.** The firing elbow sits 35–55° below horizontal (sandstorm_07,
   cod_03/09, gb_01, eft_16). The support arm is long and reaches far out on the handguard.
5. **When the legs move, the gun does not.** The pelvis takes the gait, and spine counter-rotation keeps the
   shoulders and muzzle quiet (gb_07, cod_09).
6. **Out of the aim, the muzzle is always deliberately placed**: 30–45° down (low ready), pulled into the chest
   (collapsed), or ≥45° up (high ready). It never droops at a random angle.

## 2. Pose specs

### 2.1 Shouldered aim, standing (TC "ready/up", the default combat pose)

| Element | Target | Bone / implementation note |
|---|---|---|
| Feet | shoulder width (heel centres 0.30–0.40 m apart); firing foot 0.15–0.30 m behind the support foot | `RightFoot` behind `LeftFoot` along the aim |
| Body angle to the gun-target line | **standing 30–45°** (TC: ≈45°); CQB/modern "squared" 15–25°. Default **30°** | `Hips` yaw +30° to the firing side of the aim |
| Shoulder line vs hips | shoulders square up to 10–20° from the aim line (spine absorbs 10–20°) | twist split Spine 0.2 / Spine1 0.35 / Spine2 0.45 |
| Knees | 10–20° flexion (interior 160–170°), never locked | `LeftLeg`/`RightLeg` |
| Torso lean | **8–15° forward** from vertical; shoulders 5–10 cm ahead of the hips over the feet | pitch split Spine 0.3 / Spine1 0.35 / Spine2 0.35 |
| Stock | buttplate centre in the shoulder pocket: 3–6 cm medial to the `RightArm` head, 3–6 cm below the top of the shoulder, on the vest surface (allow 3–5 cm for armour) | **gap from buttplate to body ≤ 1 cm**; `RightShoulder` (clavicle) raised 5–8° and protracted 5–10° to form the pocket |
| Bore line height | ≈ eye height − 0.065 m for an M4 with irons or a red dot (AK irons ≈ −0.05 m; scope ≈ −0.07 to −0.08 m) | derive from each gun's sight height, not a constant |
| Cheek weld / head | head pitched down 5–12°, rolled toward the stock 5–10°, yaw ≈ the aim; neck pitch ≤ 10° | `Neck` 40% / `Head` 60%. The eye must lie on the sight axis (±1 cm) |
| Eye relief | nose 2–5 cm behind the charging handle; eye 6–10 cm behind an iron rear aperture, 10–25 cm behind a red dot, 7–9 cm behind a magnified scope's ocular | |
| Firing upper arm | **elbow 35–55° below horizontal** (abduction 35–55°), elbow under or slightly outside the gun's line | `RightArm`. Chicken-wing (≈ horizontal, 80–90°) only for a stylised/Hunt-era look |
| Firing elbow | interior 65–90° | `RightForeArm`; wrist neutral, web high on the grip |
| Support hand | **far forward**: on an M4 the palm is 0.28–0.38 m ahead of the trigger (end of the handguard); AK 0.25–0.30 m (lower handguard); MP5 at the handguard front | `LeftHand` IK to the `GripL` / support socket; contact error ≤ 1 cm |
| Support grip style | default **thumb-over-bore / C-clamp-lite**: thumb on top or side, fingers wrapped under at 7–9 o'clock. Variant: palm under the handguard or on the VFG | per-bot choice, see §5 |
| Support elbow | interior **140–165°** (nearly straight, not locked); elbow points down-out, **20–40° below horizontal** ("slightly outward", TC) | `LeftForeArm`; pole target below and outside the elbow |
| Gun roll | 0° ± 2° (level). Never rolled into the face | |

Measured from the references (side views): Sandstorm 07/09 firing elbow ≈ 40–50° below horizontal, support elbow ≈ 150°;
CoD 09 support elbow ≈ 160° with the hand at the muzzle end; Ground Branch 01 support arm almost straight. The kneeling
TC figure gives a 30° body angle.

### 2.2 Ready and carry positions (TC 3-22.9 §6-12…6-28)

| Position | When bots use it | Spec |
|---|---|---|
| **Low ready** (default alert idle/patrol) | contact possible, scanning | Stock **stays in the shoulder**, muzzle **30–45° below the aim line**, pointed at the sector. Head upright, eyes over the optic (head pitch ≈ 0 to −5°). Firing elbow drops to 55–70° below horizontal; support hand stays on the handguard |
| **Collapsed low ready** | indoors, in stacks, near friendlies | Stock slides from the shoulder to the armpit or ribs, the gun is drawn in so the magwell is 0.15–0.25 m in front of the navel, muzzle 45–70° down. Elbows tucked to the ribs (cqb_0, ov_mout_3, sdif_02) |
| **High ready** | overhead sectors, climbing stairs | Stock in the armpit, **muzzle ≥45° up**. The support hand may leave the gun |
| **Ready/up** | contact imminent or firing | §2.1 |
| **Patrol / safe hang** | relaxed, no threat | Firing hand on the grip, gun on the sling diagonally across the chest, muzzle 50–70° down toward the support-side foot, support hand light on the handguard or free (ov_patrol_5, ov_run_2) |

Transitions: low ready ↔ up 0.20–0.35 s (trained) with ease-out. Up comes from a rotation about the shoulder pocket,
not a translation of the whole gun. Collapsed ↔ up 0.35–0.5 s.

### 2.3 Moving with the weapon

| Gait | Speed (m/s) | Cadence (steps/min) | Step length (m) | Knee (stance, flexion) | Torso lean | Gun |
|---|---|---|---|---|---|---|
| **Aimed walk** ("combat glide") fwd | 0.8–1.3 | 95–115 | 0.45–0.65 | **20–30° held through stance, never < 15°** | 10–15° | shouldered |
| Aimed strafe | 0.7–1.1 | 95–110 | 0.40–0.55 | 20–30° | 10–15° | shouldered; hips turn ≤45° toward travel and the spine keeps the aim |
| Aimed backpedal | 0.5–0.9 | 95–110 | 0.35–0.50 | 20–30°, toe-first contact | 10–15° | shouldered |
| Tactical jog | 2.0–3.5 | 150–165 | 0.8–1.2 | 35–45° | 15–20° | low ready or collapsed, muzzle 20–40° down |
| Combat run | 3.5–5.0 | 160–175 | 1.2–1.6 | 40–50° | 15–20° | low ready / port |
| Sprint | 5.5–7.0 | 175–195 | 1.6–2.1 | 45–55° | 15–25° | sprint carry (§2.4) |
| Crouch walk | 0.6–1.0 | 85–100 | 0.35–0.50 | 60–90° | 20–30° | shouldered or low ready |

**Combat glide rules** (gb_07, cod_09, eft_00, gb_01):
* Pelvis 5–10 cm below neutral standing height; heel-to-toe rolling contact; feet on two tracks 0.15–0.25 m
  apart (wider than a casual walk's ~0.10 m). No crossover steps.
* **Vertical head bob ≤ 2 cm** (a casual walk bobs 4–5 cm). Pelvis yaw ±5–8° and roll ±3° per step;
  shoulder yaw ≤ ±2°.
* **Muzzle stability while walking aimed: angular jitter ≤ 1°, position jitter ≤ 1.5 cm.** Implement it by solving the
  aim after the locomotion pose: spine counter-rotation absorbs the pelvis motion, the gun stays locked to the aim
  ray, and the arms follow by IK.
* The stride is driven by distance travelled (already done: `GAIT` table); **foot slide during stance ≤ 2 cm**.
* In a file or stack, bots keep 1–1.5 m spacing and shift their muzzles toward different sectors (gb_01, squad_14).

### 2.4 Sprint carry

* Two hands on the gun. Rifle diagonal across the chest, muzzle **down 35–50° and swung 30–40° toward the support
  side** (down-left), stock near the firing-side hip or ribs. This matches the FP sprint spec (muzzle down-left,
  30–60° cant).
* Alternative (BF/Squad look, bf2042_01, squad_06): the firing hand holds the grip with the gun hanging along the
  firing side, muzzle forward-down 30–45°, and the support arm pumps freely. Use it for at most ~30% of bots.
* The gun rocks with the shoulders: roll ±6°, yaw ±4°, opposite to the pelvis. Torso lean 15–25°; the head stays level
  and looks ahead.
* Sprint → aim: 0.25–0.35 s (gun up, then the feet decelerate over 2 steps). Never pop.

### 2.5 Crouch and kneel

| Pose | Spec |
|---|---|
| **Kneeling, unsupported** (TC fig. 6-12; kneel_3, ov_kneelfire_0) | Firing-side knee on the ground, buttock on or near the firing heel. Support foot flat 0.35–0.5 m ahead, shin within 10° of vertical, support knee ~90°. Support **triceps on or just ahead of the knee, elbow not on the kneecap**, so the support elbow sits under the gun. Firing elbow tucked. Lean 10–20° forward. **Body ~30° to the gun-target line.** Bore ≈ 1.05–1.15 m above the ground |
| **High kneel / combat crouch** (game crouch idle; gb_02, reforger_03, bf2042_09) | Both feet planted, hips 0.55–0.70 m above the ground (pelvis drop 30–40 cm), knees 80–110°, torso 20–30° forward, gun shouldered or low ready. The firing knee may touch down |
| **Squat** (TC fig. 6-11) | Feet shoulder width, squat as low as possible, back of the triceps on the knees |

Stand ↔ crouch takes 0.30–0.45 s. The pelvis leads, the gun stays on the aim line throughout (±2°), and the knees must
never pass through the ground.

### 2.6 Pistol

| Element | Spec (ov_pistol_2/4, tlou2_01) |
|---|---|
| Stance (isosceles, default) | feet shoulder width, squared (0–15° blade), knees 10–20°, **torso 10–15° forward**, shoulders slightly rolled forward |
| Arms | both arms extended, elbows **160–175°** (unlocked); arms form a symmetric triangle with the apex at the gun; arms 0–5° below horizontal |
| Gun | brought **up to the eye line**: rear sight 0.55–0.65 m in front of the dominant eye; head upright (pitch ≤ 5°), never dropped to the gun |
| Grip | firing hand high on the backstrap; support palm fills the gap on the grip's support side, both thumbs forward along the frame; support wrist cammed down 10–20° |
| Weaver (variant, Hunt) | bladed 30–45°, firing arm straight, support elbow bent 90–110° and pointing down, push-pull tension |
| Compressed ready (sul / retention) | gun 0.15–0.25 m in front of the sternum, muzzle forward-down 10–30°, elbows to the ribs |
| One-handed (bf2042_09) | firing arm straight and level, gun canted 0–20° inward, support hand balled at the chest |
| Recoil | wrist and elbow flip 3–6° per shot; recover in 100–150 ms |

**Transition, rifle → pistol (slung rifle):** release the rifle, which drops on the sling to hang muzzle-down at the chest
(0.15 s, with a pendulum swing ±10° that damps over 0.6 s). Firing hand to the holster on the firing-side thigh or hip
(0.25 s), draw, and push out to isosceles (0.35 s). First shot ≈ 1.0–1.4 s total. Bots without a sling physically
holster or drop the rifle; the rifle must never vanish.

### 2.7 Firing

* Per shot (5.56/5.45): an additive kick of 1–2 cm back at the shoulder pocket and 1–3° muzzle rise, plus 0.5° random yaw.
  Recover in 80–120 ms. The head moves **with** the gun (the weld holds).
* Full auto: shoulders rock back 1–2 cm with cumulative climb of up to 4–6°. The torso leans **into** the gun (+2–3°)
  and never back.
* While moving: recoil is upper-body additive only, and the legs keep cadence.
* Turning to engage: the eyes and head lead by 50–100 ms, then gun and torso together, then the feet. The spine absorbs
  up to ±35–45° of yaw from the pelvis before a pivot step. Upper-body yaw rate is **≤ 360–540°/s for a snap** and
  90–180°/s for tracking, with ease-in/out. A 180° turn takes **0.4–0.6 s** with a pivot step. No same-frame snaps.

### 2.8 Reload choreography (rifle)

Real timings: elite AR emergency reload 1.5–2.2 s; trained soldier 2–3 s; tactical with retention 3–4.5 s.
AAA shooters use roughly 2.0–2.4 s (tactical) and 2.6–3.2 s (empty). **Bot targets: tactical 2.3 s, empty 2.9 s**,
±8% per bot.

Workspace (TC 3-22.9 §8-10): a 0.30–0.45 m sphere centred ~0.30 m in front of the chin. All manipulation happens there,
**eyes up and toward the threat, with only a brief glance at the magwell**.

| t (empty, 2.9 s) | Phase (`RELOAD_PHASES` key) | Gun | Support hand path | Head |
|---|---|---|---|---|
| 0.00–0.30 | (start) | stock stays in the shoulder or slides to the armpit; gun drops 10–20° muzzle-down and rolls **20–35° toward the support side** (magwell toward the eyes, ejection port up); magwell ends 0.25–0.35 m ahead of the chin and 0.15–0.25 m below it | leaves the handguard and moves back along the gun to the magwell | pitch −10 to −20° (glance) |
| 0.30–0.55 | `reach` 0.12 | still | grips the old mag. AR: firing index presses the release and the mag drops (empty) or is stripped (tac). AK: thumb on the paddle, rock forward and out | |
| 0.55–1.05 | `stow` 0.42 | holds the cant | **down-back arc ~0.20 m** to the front mag pouch on the plate carrier (sternum to navel height, 0.05–0.10 m support-side of centre). Tac: old mag goes into the dump pouch or a back pocket | back on the threat |
| 1.05–1.55 | `acquire` 0.53 | holds | draws the fresh mag up and forward, bullets forward, index finger along the mag's front edge | glance |
| 1.55–2.20 | `seat` 0.77 | 1–2 cm up/back jolt on insertion | "index" (mag's rear edge to the magwell rear), then a firm upward push of 4–6 cm, plus a push-pull tug | |
| 2.20–2.60 | `action` 0.91 (empty only) | AR: support palm slaps the bolt catch on the left, or the thumb presses it. AK: support hand goes **over** the receiver to the right-side charging handle and pulls 8–10 cm back. Gun rolls back to 0° | | |
| 2.60–2.90 | (return) | re-shoulders on the §2.1 ready/up path | back to the handguard grip | weld |

Tactical reload: drop the `action` row; the timeline scales to 2.3 s. Pistol, empty 1.8 s / tac 1.5 s: gun to the
compressed ready, canted 20–30° inward; the thumb drops the mag (it falls under gravity). Support hand to the belt pouch
on the support-side front hip (0.35–0.45 m drop), index finger on the mag, insert, palm-seat, then thumb the slide
release or rack overhand.

Hard rules: the magazine is a separate object that **leaves the gun** (it drops or is stowed) and **a new one comes from
a pouch**. Never pop. The support hand is in contact with the mag or the gun ±1 cm at every key frame. The gun never
leaves the workspace while the bot is in a firefight.

### 2.9 Hit reactions and deaths

Physical fact: a rifle bullet carries ~2 N·s of momentum (5.56: 4 g × ~900 m/s, less what passes through). That is
roughly a firm shove, so **bullets do not throw people backwards**. A hit person either keeps functioning (a flinch,
sometimes a stumble) or loses muscle tone and collapses *under gravity*. Ghost Recon's arms-up throw-back (grwl_00) is
the look to avoid.

**Non-lethal hit** (additive, 150–300 ms in, 300–500 ms out):
* Spine flexes 5–12° away from the hit direction. The shoulder on the hit side is pulled back 10–20°, the head flinches
  5–10°, and the aim is knocked off 3–8° and re-acquired.
* Leg hit: hips drop 5–10 cm and the bot takes one stumble step on the hit leg. Repeated hits within 0.5 s scale the
  flinch by 0.6× (no machine-gun twitching).
* Wounded but alive (optional state): hunched, firing-side hand on the gun, support hand toward the wound; then it
  moves to cover.

**Death:**
1. **Collapse, 70%** ("strings cut"): the knees buckle first (hip drop 0.3–0.5 m in 0.25 s), then the torso folds
   forward or sideways in the direction the body was already moving or leaning. The arms do **not** break the fall.
   Head and torso reach the ground in **0.7–1.1 s**.
2. **Twist fall, 20%**: hit-side shoulder driven back, 45–120° spin about the planted foot, then the fall on that side.
3. **Back fall, ≤ 10%**: only when stationary with heels planted; one stagger step back, then the fall.
4. Hand-off to ragdoll (or a powered ragdoll) **0.15–0.35 s** after the hit, keeping the animated velocity. Joint limits
   are anatomic: no bone stretching, knee and elbow never hyperextend, neck ≤ 60°. Displacement from the hit is
   **≤ 0.3 m**.
5. Weapon: on a sling it stays with the body and lands beside the torso or hip. Otherwise it is dropped as a physics prop
   carrying the hand's velocity, and it stays in the world.
6. Rest pose (gzw_04, squad_04): asymmetric, with one knee bent, an arm under or beside the torso and the head turned.
   The whole body is in contact with the ground (no part > 3 cm above it unless resting on an object). No T-poses or
   symmetric "snow angels". Settle and sleep within 2–3 s; no jitter afterwards.

## 3. Mistakes that make NPCs look fake (and the limit QA checks)

| Mistake | Limit |
|---|---|
| Floating gun: stock in front of the chest, under the arm, or off the body | buttplate-to-shoulder-pocket gap ≤ 1 cm while aiming; in collapsed ready, stock in contact with the armpit or ribs |
| Gun not on the eye line: head beside, above or below the sight | eye within ±1 cm of the sight axis when shouldered |
| Hands off the gun | firing palm ≤ 0.5 cm from the grip; support hand ≤ 1 cm from its socket (except during reload, which follows §2.8) |
| Arms or fingers through the gun, gun through the vest | 0 visible penetration at 3 m; the gun must not clip the plate carrier at any aim pitch from −60° to +60° |
| Chicken-wing default (elbow horizontal) or T-rex arms (support hand at the magwell) | firing elbow 35–55° below horizontal; support hand on the front third of the handguard |
| Stiff spine: the whole body rotates as a block to aim | aim yaw split over hips/spine (§2.1); aim pitch split ~30/35/35 across Spine/Spine1/Spine2 plus 0.4/0.6 across Neck/Head |
| Upright locked knees, leaning back, weight on the heels | knees ≥ 10°; torso lean 8–15° forward; the head is never behind the hips in a side view |
| Sliding or skating feet; moonwalking strafes | stance foot slide ≤ 2 cm; clip phase follows ground distance; strafing hips turn ≤ 45° |
| Bouncy walk with a wobbling muzzle | head bob ≤ 2 cm; muzzle jitter ≤ 1° while walking aimed |
| Robotic or instant rotation | upper-body yaw rate ≤ 540°/s; pivot steps beyond ±45°; ease-in/out on every turn |
| Synchronized squads (same phase, same pose, same timing) | per-bot random phase 0–1; cadence ±5%; stance width ±10%; reload time ±8%; three or more idle variants |
| Dead-still idle | breathing 12–20 /min (chest ±1 cm); gun sway 0.3–0.6° figure-8 at 0.3–0.5 Hz; weight shift every 4–10 s |
| Muzzle at random angles, e.g. drooping 20° while "aiming" | when not aiming, the muzzle is in one defined carry (§2.2) and pointed in the sector |
| Teleporting magazine, reload with no hand contact | §2.8 hard rules |
| Hollywood deaths (flying back, arms up), pancake ragdolls, guns vanishing | §2.9 |
| Crouch stand-up pops | 0.30–0.45 s pelvis-led blend |

## 4. QA filmstrip checklist

Capture with `tools/shot.mjs` at 1/30 s per frame: **side (90°)**, front-quarter (45°) and rear-quarter (135°) at
3–4 m, and **top-down** for body angles. Compare against the sheets in `$R/sheets/`.

- [ ] **Aim, side view:** stock in the pocket (gap ≤ 1 cm), eye on the sight line, head upright with a slight tilt,
      torso 8–15° forward, knees bent, firing elbow 35–55° below horizontal, support arm 140–165° with the hand far forward.
      Compare to sandstorm_07/09 and cod_09.
- [ ] **Aim, top view:** hips ~30° to the gun line (kneeling ~30°, CQB 15–25°); firing foot back 0.15–0.30 m.
- [ ] **Low ready:** muzzle 30–45° down, stock still in the shoulder, eyes over the optic. **Collapsed:** stock at the
      armpit, gun in close. Compare to the TC pages and cod_00.
- [ ] **Walk aimed (2 s strip):** foot slide ≤ 2 cm, head bob ≤ 2 cm, muzzle jitter ≤ 1°, stance knee never < 15°,
      no crossover. Compare to gb_07 and cod_09.
- [ ] **Strafe and backpedal:** feet do not cross, hips ≤ 45° to the travel, aim steady.
- [ ] **Sprint:** muzzle down-left 35–50°, torso lean 15–25°, gun rocking ±6°; sprint→aim in 0.25–0.35 s with no pop.
- [ ] **Crouch and kneel:** support elbow under the gun and not on the kneecap; no knee through the floor; transition
      0.30–0.45 s.
- [ ] **Pistol:** isosceles arms 160–175°, gun at the eye line, torso forward; compressed ready at the sternum.
- [ ] **Reload (every 0.1 s):** cant 20–35° toward the support side, magwell in the workspace, old mag leaves, hand goes
      to the pouch, new mag seats, bolt action on empty only; tac ≈ 2.3 s, empty ≈ 2.9 s; the hand never floats.
- [ ] **Fire:** kick 1–3° with recovery ≤ 120 ms, head locked to the stock, no backward lean in auto.
- [ ] **Turns:** a 90° re-aim takes ≥ 0.17 s; turns past 45° include a pivot step; there are no single-frame snaps.
- [ ] **Hits:** flinch away from the hit, aim re-acquired in ≤ 0.5 s, no stacking twitch.
- [ ] **Deaths:** most deaths buckle at the knees; ground in 0.7–1.1 s; displacement ≤ 0.3 m; weapon stays in the
      world; rest pose asymmetric and fully grounded; no jitter after 3 s.
- [ ] **Squad of 4 in one frame:** no two bots in the same pose or phase.
- [ ] **No clipping** of arms, gun or vest at aim pitches −60…+60°, for every weapon class.

## 5. Variation per bot (avoid clones)

Pick per bot at spawn: body angle 20–40°; support grip (C-clamp 50% / under-handguard 30% / VFG 20%, the last only if
the gun has one); firing elbow 35–55°; stance width 0.30–0.40 m; cadence ±5%; reload speed ±8%; sprint carry (two-hand
70% / one-hand 30%); idle variant (3 or more). Seeded from the bot id so filmstrips are reproducible.
