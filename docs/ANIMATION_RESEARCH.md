# Bot animation research: making third-person soldiers move and shoot like people

Research pass, 2026-10-08. Scope: `src/game/bots/Character.js` and `src/game/bots/Bot.js` on three.js r186, the Bamen
soldier (Mixamo-named skeleton) and the retargeted Quaternius UAL clips. Every licence below was checked against the
source's own LICENSE file, README or API metadata on this date. Anything marked **unverified** was not.

---

## 0. Where we are today (read before changing anything)

`Character.js` already does more than most open-source web shooters:

| Already in place | Notes |
|---|---|
| Upper/lower split (`splitClip`) | The hips belong to the lower body |
| Distance-driven shared gait phase (a "stride wheel") | `gait` table, `gaitPhase += speed*dt/stride`. Feet do not slide at any blend speed. **Keep this.** |
| Body yaw from velocity, spine twist toward the aim (3 bones), lean into turns and acceleration | This is orientation warping, but done on the whole root, with a twist of up to ±100° |
| Additive hit flinch (`makeClipAdditive`), procedural directional jerk, fire kick | Linear decay (`hitJerk -= dt*4.5`), so there is no overshoot or settle |
| Left-hand two-bone IK onto the support grip | Holden's analytic solver (`_twoBoneIK`) |
| Gun placed at the right palm, oriented by the aim | The right hand is **not** IK'd: the gun pivots in the palm, and the recoil push moves the gun out of the hand |
| Death: authored fall, or a procedural knee-buckle topple, plus knockback, weapon drop and ground settle | Good, cheap, already tuned |
| Animation LOD (update at 1/8 to 1/30 s by distance and facing) | Any new pass must tolerate `dt` up to 0.25 s |

Where the clips come from: `operation-steel-tide/scripts/blender/build_animated_bamen_operator.py` retargets
**UAL1/UAL2 *Standard*** (the free tier, 43 clips each). In that tier:

- There are **no rifle clips at all.** `aim_idle` is `Pistol_Aim_Neutral` re-posed into a rifle hold by
  `author_rifle_hold`. `aim_walk/run/sprint/crouch_*` are the unarmed `Walk_Loop`, `Jog_Fwd_Loop`, `Sprint_Loop` and
  `Crouch_*` legs under that held pose. `reload` is `Pistol_Reload` and `shoot` is `Pistol_Shoot`.
- There is **forward locomotion only**: no strafe, backpedal, turn-in-place or start/stop clips.
- `Pistol_Aim_Up` and `Pistol_Aim_Down` exist in the free tier but are unused.

Most of the remaining robotic look comes from five things:

1. ADAD strafing with a 0.3–0.9 s timer and an 18 m/s² agent acceleration. The legs flip between forward and
   backward gait and the root spins.
2. Strafes are faked by running forward or backward with up to 100° of spine twist, which reads as a corkscrewed
   torso.
3. Only the left hand is attached to the gun. The gun floats in the right palm, and recoil moves the gun but not the
   arms.
4. Discrete switches pop: backpedal flip, one-shot entry and exit, death entry.
5. On stairs and slopes the feet float or sink, because the root follows the navmesh, which models steps as a ramp.

---

## 1. Prioritised plan (biggest realism gain per engineering hour first)

| # | Item | Gain | Cost (eng) | CPU per bot | Assets / licence |
|---|---|---|---|---|---|
| **P0-1** | Smooth the locomotion intent (agent acceleration, strafe timing, plant-and-reverse) | ★★★★★ | 1–2 h | 0 | none |
| **P0-2** | Weapon drives both hands: a weapon pose from a shoulder anchor, two-hand IK, spring recoil through the IK | ★★★★★ | 0.5–1 d | ~0.02 ms | none |
| **P0-3** | Dead blending (inertialization) on every discrete switch | ★★★★ | 0.5 d | ~0.01 ms | MIT ideas (Holden) |
| **P1-4** | Real strafe and backpedal clips: an 8-way blend space, with the twist limited to ±45° | ★★★★★ | 1–2 d | ≈0 (more actions at weight 0 are skipped) | UAL1 **Pro** ($9.99, **CC0**) or **100STYLE** (CC-BY 4.0) |
| **P1-5** | Foot IK on stairs and slopes, plus foot locking | ★★★★ | 1 d | 2 raycasts (near bots only) | none |
| **P1-6** | Turn-in-place with clips and root-yaw extraction (replaces the "shuffle walk") | ★★★ | 0.5–1 d | 0 | UAL1 Pro `Turn90_L/R` (CC0) or Rocketbox `m_turn_*` (MIT) |
| **P2-7** | Spring hit reactions, directional and per-part (head, shoulder L/R, stomach, legs) | ★★★ | 0.5 d | ~0 | UAL1 Pro `Hit_*` (CC0) |
| **P2-8** | Idle life: aim sway, breathing, weight shift; footstep audio synced to foot contacts | ★★ | 2–4 h | ~0 | none |
| **P2-9** | Starts, stops and pivots (plant the foot, decelerate, lean back) | ★★ | 1 d | 0 | Rocketbox `m_walk/run_start/stop` (MIT), UAL Pro `Sprint_Enter/Exit` |
| **P3-10** | Rapier ragdoll for deaths: near bots only, at most 3 at once, blended from the death pose | ★★★ | 2–3 d | 11 bodies for ≈3 s | Rapier (Apache-2.0, already a dependency) |
| P4 | Motion matching | ★★★★ (with good data) | weeks | 0.1–0.5 ms | Code MIT (Holden); **no clean shooter dataset exists**; LAFAN1 is NC-ND |

Recommended order: **P0-1, P0-2, P0-3 this week. Buy UAL1 Pro and do P1-4 and P1-6 together. Then P1-5.** Each step
can ship and be tested on its own.

---

## 2. Techniques: why, how in three.js, reuse and cost

All snippets are allocation-free sketches written against the existing `Character` fields (`this.bones`, `_rotateW`,
`_refreshW`, `_twoBoneIK`, `damp`, `clamp`, `wrapPi`). They are not drop-in code.

### P0-1. Locomotion intent that a human body could produce (Bot.js / Navigation.js)

**Why.** No animation system can make a 180° velocity reversal every 0.3 s look human. People commit to a strafe
for about 0.8–2 s. To reverse, they plant the outside foot: decelerate, pause for about 0.1 s, then push off.
Starts take about 0.3 s and stops about 0.25 s. In Bobby Anguelov's GDC 2012 talk (below), animation constraints
drive navigation for the same reason.

**How.**
- `Navigation.addAgent`: change `maxAcceleration: 18` to about **8–10** for bots. The player stays as is. A
  3.2 m/s → −3.2 m/s reversal then takes about 0.7 s.
- `Bot.update` (engage): change `strafeTimer = rand(0.3, 0.9)` to `rand(0.7, 1.8)`. Add a 25% chance of a
  "hold and fire" segment of 0.4–1.0 s with zero lateral velocity, so the bots plant and shoot. Keep crouch-peeks.
- Pre-brake: when `strafeDir` flips, request zero velocity for 0.12 s first (plant), then the new direction.
- Feed the animation the **agent's smoothed velocity**, not the finite difference of positions
  (`this.velocity = (pos - prev)/dt`), which is noisy under crowd avoidance. Use `agent.velocity()`, or damp
  `bot.velocity` with `damp(…, 10, dt)`.

**Cost.** Free. This one change probably removes more "bot-ness" than anything below it.

---

### P0-2. The weapon drives the hands (aim pose, two-hand IK, recoil through IK)

**Why.** In every AAA third-person shooter (Lyra, ALS overlays, Unity FPSSample) the weapon pose is computed first,
from the aim. The hands are then IK'd onto grip sockets, and the shoulders and spine only take part of the aim. Our
code does the opposite: the right palm from the clip sets the gun position and only the left hand follows. As a
result:
- The right wrist and the gun disagree whenever pitch or twist differs from the authored pose.
- The recoil push (`fireKick*0.045` along the barrel) slides the gun **out of the right hand**.
- Pitch must be carried entirely by bending the spine (±70° over 3 bones), which looks like a hunchback when aiming
  down.

**How (three.js).**
1. **Weapon root transform**, computed in world space each animated frame, after the spine twist and pitch pass and
   before hand IK:
   - Pivot = `spine2` world position, plus `right·0.17 + up·0.10 + fwd·0.08` (the shoulder pocket; tune per body).
   - Orientation = aim yaw and pitch (as today), plus spring recoil and sway.
   - Place the gun so that its **stock butt** (from the gun bbox +Z end, or a new `stock` entry in `POSES`) sits at
     the pivot. With ADS (`wantAim`), slide it up and inboard so the sight line passes through the head-bone eye
     point (`eye = head + headFwd·0.09 + up·0.07`): a cheek weld.
   - Only a fraction of the pitch goes to the spine, about 40% (`share` sums to 0.4 instead of 1). The rest is
     rotation of the weapon about the pivot, which the arms absorb through IK.
2. **Two-hand IK.** The right hand goes to `primary` and the left hand to `support` (both already in `POSES`). After
   each `_twoBoneIK`, **set the hand's world rotation** from the grip socket. The offsets are captured once from the
   authored hold pose, so finger curls stay valid:

   ```js
   // once per weapon (in attachWeapon), with the rest/aim pose evaluated and the gun placed the old way:
   //   offR = inverse(gunWorldQ) * rHandWorldQ ; posR = gripR in gun space (wrist-to-palm corrected)
   this.handOffQ.r.copy(gunQ).invert().multiply(b.rHand.getWorldQuaternion(_q1));
   // per frame:
   _t.copy(this.gripR).applyMatrix4(wrap.matrixWorld);           // world target for the wrist
   this._twoBoneIK(b.rArm, b.rFore, b.rHand, _t, 1);
   this._elbowHint(b.rArm, b.rFore, b.rHand, _hintR);            // optional, see below
   _q1.copy(wrap.getWorldQuaternion(_q2)).multiply(this.handOffQ.r); // desired hand world rotation
   setWorldQuat(b.rHand, _q1);                                    // bone.quaternion = inv(parentWorldQ) * q
   // same for the left hand with gripL / handOffQ.l
   ```
3. **Elbow (pole) hint.** Holden's solver keeps the elbow in the plane of the animated pose. That is fine at small
   offsets, but at steep pitch the elbows flip. After solving, rotate the upper arm about the shoulder→wrist axis by
   the angle that brings the elbow closest to a hint point (right elbow: down and out, `pivot + right·0.25 −
   up·0.25`):

   ```js
   _elbowHint(A, B, C, hint) {
     const a = A.getWorldPosition(_a), b = B.getWorldPosition(_b), c = C.getWorldPosition(_c);
     const axis = _ax.subVectors(c, a).normalize();
     const pb = _pb.subVectors(b, a).projectOnPlane(axis), ph = _ph.subVectors(hint, a).projectOnPlane(axis);
     if (pb.lengthSq() < 1e-8 || ph.lengthSq() < 1e-8) return;
     const ang = Math.atan2(_cr.crossVectors(pb, ph).dot(axis), pb.dot(ph));
     this._rotateW(A, _q.setFromAxisAngle(axis, ang * 0.7)); // 0.7: keep some animated character
     B.updateMatrixWorld(true);
   }
   ```
4. **Recoil as springs on the weapon root, not the spine.** Keep a small spine share for body follow-through.
   Holden's exact critically-damped spring from Spring-It-On (MIT) is stable at our LOD `dt` of up to 0.25 s:

   ```js
   const halflifeToDamping = (h) => (4 * Math.LN2) / (h + 1e-5);
   function springDamperExact(s, goal, halflife, dt) {          // s = { x, v }
     const y = halflifeToDamping(halflife) / 2, j0 = s.x - goal, j1 = s.v + j0 * y, e = Math.exp(-y * dt);
     s.x = e * (j0 + j1 * dt) + goal; s.v = e * (s.v - j1 * y * dt);
   }
   // onFire(stats): impulses scaled per weapon class
   this.rc.pitch.v += stats.recoilV * (0.8 + 0.4 * Math.random());   // rad/s, e.g. 2.5 rifle, 6 shotgun
   this.rc.yaw.v   += (Math.random() * 2 - 1) * stats.recoilH;
   this.rc.back.v  += 1.2;                                            // m/s along -barrel
   // per frame, before building the weapon root:
   for (const k of ['pitch', 'yaw', 'back']) springDamperExact(this.rc[k], 0, 0.07, dt);
   ```
   For a visible overshoot ("muzzle settles back past centre"), use the under-damped `spring_damper_exact` from the
   same article, or two critically-damped springs in series. Because the hands are IK'd to the gun, the arms and
   shoulders now recoil with it.

**Reuse.** `three/addons/animation/CCDIKSolver.js` is not needed: analytic two-bone IK is cheaper and already in the
file. For further reading on hand IK, see THREE.IK (MIT, FABRIK, old but readable) and ALS-Refactored's hand IK and
"overlay" layering (MIT, C++ to port as ideas). Spring maths: Holden, *Spring-It-On* (MIT code).

**Cost.** One extra two-bone IK (about 30 vector ops) per animated frame. Negligible.

---

### P0-3. Dead blending: inertialization without evaluating two poses

**Why.** The current transitions are either instantaneous (the backpedal flip reverses gait direction and spins the
body target by 180°) or linear weight cross-fades (one-shots: 0.15 s in and 0.25 s out; death: 0.12 s). These produce
pops or a mushy average. Inertialization (Bollo, *Gears of War*, GDC 2018) cuts to the new animation instantly and
decays the pose offset. **Dead blending** (Holden, 2023) is the simplest variant. At the switch, record the *output*
pose and its velocity. Keep extrapolating it with decaying velocity, and smoothstep-crossfade from that ghost to the
live pose over about 0.15–0.25 s. Only the current pose is needed, which fits `AnimationMixer` exactly.

**How (three.js).** Run it on local bone quaternions plus the hips position, **after `mixer.update()` and before the
procedural layers**. The mixer rewrites every animated bone each update, so procedural edits never leak into the
velocity estimate.

```js
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _w = new THREE.Vector3();
function quatToScaledAxis(q, out) {               // log map, shortest path
  const s = Math.hypot(q.x, q.y, q.z), w = q.w < 0 ? -1 : 1;
  if (s < 1e-8) return out.set(2 * q.x * w, 2 * q.y * w, 2 * q.z * w);
  const ang = 2 * Math.atan2(s, Math.abs(q.w));
  return out.set(q.x, q.y, q.z).multiplyScalar((w * ang) / s);
}
function scaledAxisToQuat(v, out) {               // exp map
  const a = v.length();
  if (a < 1e-8) return out.set(v.x * 0.5, v.y * 0.5, v.z * 0.5, 1).normalize();
  const s = Math.sin(a * 0.5) / a;
  return out.set(v.x * s, v.y * s, v.z * s, Math.cos(a * 0.5));
}

export class DeadBlend {
  constructor(bones, halflife = 0.05) {          // bones: body only (skip fingers): ~24 for Mixamo
    this.bones = bones; this.halflife = halflife; this.t = Infinity; this.dur = 0.2;
    this.prev = bones.map((b) => b.quaternion.clone());
    this.vel = bones.map(() => new THREE.Vector3());
    this.extQ = bones.map(() => new THREE.Quaternion());
    this.extV = bones.map(() => new THREE.Vector3());
  }
  trigger(dur = 0.2) {                            // call on the frame of a discrete switch
    for (let i = 0; i < this.bones.length; i++) { this.extQ[i].copy(this.prev[i]); this.extV[i].copy(this.vel[i]); }
    this.t = 0; this.dur = dur;
  }
  apply(dt) {                                     // right after mixer.update(dt)
    const blending = this.t < this.dur;
    let alpha = 1, decay = 1;
    if (blending) {
      this.t += dt; const x = Math.min(1, this.t / this.dur); alpha = x * x * (3 - 2 * x);
      decay = Math.exp((-Math.LN2 * dt) / this.halflife);
    }
    const idt = 1 / Math.max(dt, 1 / 120);
    for (let i = 0; i < this.bones.length; i++) {
      const q = this.bones[i].quaternion;
      if (blending) {
        const v = this.extV[i].multiplyScalar(decay);
        scaledAxisToQuat(_w.copy(v).multiplyScalar(dt), _q);
        this.extQ[i].premultiply(_q);               // integrate in parent space
        q.slerpQuaternions(this.extQ[i], q, alpha); // three's slerp takes the short path
      }
      // track the output velocity for the next trigger: v = log(q * inv(prev)) / dt
      _q2.copy(this.prev[i]).invert().premultiply(q);
      quatToScaledAxis(_q2, this.vel[i]).multiplyScalar(idt);
      this.prev[i].copy(q);
    }
  }
}
```

**Triggers:** `backward` flip; one-shot start and end (then set `osw` to a step and let dead blending smooth it); death
start (replaces the 0.12 s fade); turn-in-place start; crouch toggle when `|Δcrouch|` exceeds 0.5 in one LOD tick;
jump start and land; spawn (no trigger, just reset `prev`). Use a halflife of about 0.05 s and a duration of
0.15–0.25 s. Holden's "switching sides" note matters only for ghosts near 180° apart; three's
`slerpQuaternions` already picks the shortest arc per frame. If jitter appears, port his `quat_slerp_via` (track
the chosen hemisphere).

**LOD note.** With `dt` = 0.125 s the extrapolation is coarse but still decays. For bots updated at ≤15 Hz, use
`trigger(0.25)`.

**Reuse.** The algorithm comes from *Dead Blending* (theorangeduck.com/page/dead-blending) and *Spring-Roll-Call*
(inertializers). Holden's code (Spring-It-On, Motion-Matching) is MIT, but the snippet above is a fresh JS port and
needs no notice. Background: Bollo, GDC 2018.

**Cost.** About 24 bones × (1 slerp + 1 log + 1 exp) only during blends, plus 24 × (1 log) for velocity tracking. Well
under 0.02 ms. Velocity tracking can be skipped for LOD-throttled bots, which then trigger with zero velocity.

---

### P1-4. Real strafing: an 8-way blend space with limited orientation warping

**Why.** Orientation warping alone (rotating the legs toward the velocity and counter-twisting the spine) is what we
do now, but with a ±100° range. UE's and ALS's warping is only credible to about ±45–60°. Beyond that, a human
side-steps or cross-steps. That needs lateral clips.

**Clip sources (licence-checked, see §3):**
- **UAL1 Pro** (itch.io, $9.99, **CC0**). Per Quaternius' Animation Viewer it has `Jog_Fwd/Fwd_L/Fwd_R/Left/Right/
  Bwd/Bwd_L/Bwd_R`, `Crouch_` in the same 8 directions, `Walk_Bwd`, `Jog_Fwd_LeanL/R`, `Turn90_L/R`,
  `Sprint_Enter/Exit`, `Hit_Head/Shoulder_L/Shoulder_R/Stomach`, `Death02`, `Dodge_*` and `Crawl_*`. v3.0 (June 2026)
  says *"Fixed steps 8 directional animations being de-synced, now all start with left foot"*, so they phase-sync
  with our gait wheel out of the box. It also ships `_RM` root-motion variants, from which each clip's ground speed
  can be measured automatically. Same rig family as the clips we already retarget. **This is the cheapest high-impact
  purchase available.** Because the content is CC0, buying once lets us commit the retargeted clips publicly.
- **100STYLE** (Mason et al., **CC BY 4.0**, verified via the Zenodo record metadata `cc-by-4.0`). This is Xsens
  mocap at 60 fps. Every one of its 100 styles has `FW`, `BW`, `FR`, `BR`, `SW` (sidestep walk), `SR` (sidestep run),
  `ID` (idle) and `TR*` (transitions). Relevant styles: **`Neutral`, `Swat`, `Crouched`, `BentKnees`,
  `OnToesCrouched`, `Rushed`, `InTheDark`, `StartStop`, `LimpLeft/LimpRight`** (the last two for wounded bots).
  Real mocap legs look clearly better than keyframed ones. You have to trim the T-poses (`Frame_Cuts.csv`), cut
  loops, and retarget.

**How (three.js).** Treat the lower body as a 2D blend space over (direction relative to the *torso*, speed tier).
Every directional clip shares `gaitPhase`, and each clip's `time = phase * duration`.

```js
// DIRS in CCW order (+angle = movement to the bot's left, matching moveYaw = atan2(-vx, -vz))
const DIRS = ['F', 'FL', 'L', 'BL', 'B', 'BR', 'R', 'FR'];
function dirWeights(rel /* wrapPi(moveYaw - torsoYaw) */, out /* Float32Array(8) */) {
  const a = ((rel / (Math.PI / 4)) % 8 + 8) % 8, i0 = Math.floor(a) % 8, i1 = (i0 + 1) % 8, k = a - Math.floor(a);
  out.fill(0); out[i0] = 1 - k; out[i1] = k; return out;
}
// in _animate: torsoYaw = aimYaw - clamp(twist, ±45°); feetYaw = torsoYaw (legs no longer chase velocity)
// tier weights as today (idle/walk/jog/sprint by speed), then W[tier][dir] = Wtier * Wdir
// stride for the phase = sum(W * clip.stride); clip.stride measured from the _RM variant: rootDistance / loops
```

- **Sprint** stays forward-only. Bots sprint only when `|rel| < 30°`, otherwise drop to jog. Sprint direction = the
  velocity; the torso stops aiming (`ready_sprint` pose, which already exists).
- **Residual warp.** With 8 clips the residual is at most ±22.5°, and the blend covers it. If only F/B/L/R are
  available (100STYLE without diagonals), rotate `hips` by the residual (≤45°) about world up and counter-rotate
  `spine` and `spine1` by the same amount, split 60/40. That is the orientation warping in UE's
  `OrientationWarping` node and in ALS.
- **Foot-phase compatibility.** 100STYLE clips do not share a start foot. Measure each loop's left-foot-forward phase
  offset (we already store `offset` in the gait table) and add it per clip.
- Keep the existing `backward` hysteresis only as a fallback when the lateral clips are missing.

**Cost.** 8–16 extra `AnimationAction`s per bot. three's mixer skips zero-weight actions cheaply, but setting `time`
on all of them is still a loop; set it only when the weight is above 0. The mixer cost scales with the number of
**active** actions, which stays at 2–4.

---

### P1-5. Foot IK on stairs and slopes, and foot locking

**Why.** The root follows the navmesh, which turns stairs into ramps, while the clips assume flat ground. Feet then
sink into steps or hover over them. While turning in place, both soles also slide.

**How (three.js and Rapier).** For bots within 25 m only, at full update rate:

```js
_footIK(bot, dt) {
  const b = this.bones, phys = bot.game.physics, rootY = bot.position.y;
  if (bot.jumpY > 0) { this.pelvisOff = damp(this.pelvisOff, 0, 12, dt); return; }
  let minOff = 0;
  for (const s of FEET) {                                       // FEET = [['lUp','lLeg','lFoot'], ['rUp','rLeg','rFoot']]
    const foot = b[s[2]];
    foot.getWorldPosition(this.footAnim[s]);                    // animated foot, before pelvis shift
    _o.set(this.footAnim[s].x, rootY + 0.5, this.footAnim[s].z);
    const hit = phys.raycastFast(_o, DOWN, 1.0, G.WORLD);       // add an allocation-free variant to Physics.js
    const off = hit ? clamp(rootY + 0.5 - hit.toi - rootY, -0.45, 0.45) : 0;
    this.footOff[s] = damp(this.footOff[s], off, 18, dt);
    if (hit) this.footN[s].lerp(hit.normal, 1 - Math.exp(-dt * 15));
    minOff = Math.min(minOff, this.footOff[s]);
  }
  this.pelvisOff = damp(this.pelvisOff, minOff, 10, dt);
  // lower the pelvis (world Y) in hips-parent space: the model carries tpl.scale
  b.hips.position.y += this.pelvisOff / this.model.scale.y;
  b.hips.updateMatrixWorld(true);
  for (const s of FEET) {
    const [up, leg, foot] = s.map((k) => b[k]);
    _t.copy(this.footAnim[s]); _t.y += this.footOff[s];
    if (this.lock[s].w > 0) _t.lerp(this.lock[s].pos, this.lock[s].w);   // foot locking, below
    this._twoBoneIK(up, leg, foot, _t, this.footIKW);
    // tilt the sole to the surface (limit about 30°)
    _q.setFromUnitVectors(UP, this.footN[s]); _q2.identity().slerp(_q, 0.8 * this.contactW[s]);
    this._rotateW(foot, _q2);
  }
}
```

- **Knee hint.** Legs rarely flip, but apply the elbow-hint routine with `hint = knee + fwd·0.3` if they do.
- **Foot locking** (ALS-Refactored `FeetState` lock, and Holden's contact handling in *Motion-Matching*
  `controller.cpp`, MIT). Precompute **contact windows in phase space** for each gait clip offline: foot height
  < 4 cm and foot speed relative to the root under 0.3 m/s. At runtime the contact weight is the blend of the active
  clips' windows. On contact start, `lock.pos = foot world pos`. While in contact the IK target is `lock.pos`. On
  lift-off, or if `|anim − lock| > 0.25 m`, fade `lock.w` to 0 over 0.1 s. Idle and turn-in-place get permanent
  contact, so the existing "turn shuffle" becomes visible planted pivots plus steps (see P1-6).
- Run the foot pass **before** the spine and weapon pass, since hips changes move the whole upper body.

**Reuse.** three.js has no foot-IK addon. For the method, see Holden *Simple Two Joint IK* (already used),
ALS-Refactored `AlsAnimationInstance` foot and pelvis offsets (MIT, port the ideas), and the Lyra/UE "Leg IK + Foot
Placement" docs (ideas only; Epic content is UE-only).

**Cost.** Two Rapier `castRayAndGetNormal` calls (a few µs each) plus 2 two-bone IKs per near bot. Skip all of it
beyond 25 m or under LOD.

---

### P1-6. Turn-in-place

**Why.** Idle bots that track a target slowly rotate on the spot, which today is driven by the walk cycle.
Real soldiers twist the upper body first, about ±60° (spine and head), then step-turn once with a 90° or 180°
pivot, and the legs catch up.

**How.**
- Keep `_idleBodyYaw`'s dead zone, but trigger when `|aim − feet| > 70°`, or `> 45°` held for 1.0 s.
- Pick `Turn90_L/R` (UAL1 Pro), or Rocketbox `m_turn_left/right_60/90/120/180` (MIT), by the remaining angle.
- **Root-yaw extraction at load.** For each turn clip, decompose the hips quaternion into swing and twist about the
  up axis expressed in hips-parent space. Store `yaw(t)` and strip the twist from the keys, so the clip turns in
  place and the game owns the rotation:

  ```js
  function extractYaw(clip, hipsName, upLocal /* (0,1,0) in hips-parent space */) {
    const tr = clip.tracks.find((t) => t.name === hipsName + '.quaternion');
    const n = tr.times.length, yaw = new Float32Array(n), q = new THREE.Quaternion(), tw = new THREE.Quaternion();
    for (let i = 0; i < n; i++) {
      q.fromArray(tr.values, i * 4);
      const d = q.x * upLocal.x + q.y * upLocal.y + q.z * upLocal.z;
      tw.set(upLocal.x * d, upLocal.y * d, upLocal.z * d, q.w).normalize();      // twist about up
      yaw[i] = 2 * Math.atan2(d, q.w);
      // swing only (exact for q = twist*swing; for an upright pelvis the order difference is negligible)
      q.premultiply(tw.invert()).toArray(tr.values, i * 4);
    }
    return { times: tr.times, yaw, total: yaw[n - 1] - yaw[0] };
  }
  // runtime: bodyYaw += (yawAt(t1) - yawAt(t0)) * (neededAngle / clip.total); trigger DeadBlend on entry
  ```
- With foot locking on, the planted foot stays put while the root yaws. That is the main visual win.
- Cheaper alternative with no clips: **procedural stepping**. Lock both feet. When a foot's yaw error exceeds 35°,
  move its IK target along an arc (lift 6 cm, 0.25 s) to the new rest spot. This is the Overgrowth or "IK Rig"
  approach (Rosen, GDC 2014; Bereznyak, GDC 2016).

**Cost.** Zero runtime beyond one more action.

---

### P2-7. Hit reactions: springs plus directional additives

**Why.** `hitJerk` decays linearly from one axis, and the `hit` additive is a single `Hit_Chest`. Real hits show a
fast deflection, an overshoot, and a recovery that depends on the hit location: head snaps, a shoulder spins the
torso, a leg hit dips the hips and buckles the knee.

**How.**
- Give each of `spine1`, `spine2`, `neck`, `head`, `lArm` and `rArm`, plus a hips Y offset, a small angular spring
  state (axis-angle `x`/`v` in world space; use the spring from P0-2 with halflife 0.08–0.12 s). In `onHit(info)`,
  add angular velocity about `axis = cross(UP, bulletDir)`, weighted by the hit part. The `info.part` value already
  exists in the hitbox list.

  | Part | Spring impulses (rad/s) | Additive clip (UAL1 Pro, CC0) |
  |---|---|---|
  | head | neck 3, head 6 | `Hit_Head` |
  | torso (upper) | spine1 2, spine2 4, plus a yaw kick by side | `Hit_Chest` |
  | torso (lower) | spine 3, pelvis −3 cm | `Hit_Stomach` |
  | arms | that clavicle/arm 5, spine2 yaw ±2 | `Hit_Shoulder_L/R` |
  | legs | pelvis −6 cm, knee flex via foot-IK target −8 cm for 0.3 s | — |
- Add the springs with `_rotateW` in the existing procedural pass. They decay on their own, with no linear ramps.
- Combine this with the weapon spring (P0-2): a hit also kicks the weapon's yaw and pitch, so tracers wander.

**Cost.** Six springs per bot.

---

### P2-8. Idle life, aim sway and footstep sync

- **Aim sway**: two summed sines or value noise on weapon-root yaw and pitch. Amplitude 0.3° crouched, 0.6° standing,
  1.5° just after a sprint (decays over 2 s); frequency about 0.35 Hz.
- **Breathing**: `spine2` pitch ±0.6° at 0.25 Hz (0.5 Hz after a sprint) and clavicle ±0.4°.
- **Weight shift in idle**: hips X ±1.5 cm at 0.1 Hz, with foot locking keeping the feet still.
- **Footsteps**: `Bot.update` triggers footstep audio every 1.7 m of travel. Use the contact-start events from P1-5's
  phase windows instead, so the audio matches the visible foot plants. Pass `foot` (L/R) for panning.

Cost: zero.

---

### P2-9. Starts, stops, pivots

- Speed-weighted blending covers the basics, but real stops include a braking step and a backward lean, and real
  starts include a forward lean plus a push-off.
- Cheap version: the existing `fwdLean` from acceleration, plus a **stop pose**. When decelerating from more than
  2.5 m/s to 0, play the lower-body `m_run_stop` (Rocketbox, MIT) or `Sprint_Exit` (UAL1 Pro) as a dead-blended
  one-shot, with distance matching: set its playback so the clip's remaining root travel equals the agent's remaining
  stopping distance `v²/(2a)`. That is the "distance matching" idea from Lyra and Paragon, reimplemented.
- Pivots (≥120° direction change at speed): Rocketbox `m_turn_*_to_walk`, or keep the plant-and-reverse from P0-1.

---

### P3-10. Ragdoll deaths (Rapier)

**Why.** The authored fall plus procedural topple are good and cheap, but bodies never drape over cover, slide down
stairs, or react to a blast's direction with full-body physics.

**How (Rapier 0.21, already in `package.json`).**
- Build 11 dynamic bodies from the bone world transforms at the death frame: pelvis (hips), chest (spine2),
  head, upper and lower arms, thighs and shins. Use capsules sized from bone lengths and the `hitboxes()` radii.
  Initial linear velocity = `(pos − prevPos)/dt` from the last animated frame, plus the bullet impulse
  (`applyImpulseAtPoint`) on the hit body.
- Joints: `JointData.spherical` for neck, shoulders, hips and waist, and `JointData.revolute` with `setLimits`
  (0 to 2.4 rad) for knees and elbows. In rapier.js 0.21, spherical joints expose per-axis **motors**
  (`configureMotorPosition`) but **no cone limits**. Use angular damping of about 2–4 to stop flailing. A brief
  motorised phase (stiffness fading 1 → 0 over 0.2 s, targeting the death-clip pose) gives a "powered ragdoll"
  look.
- Collision groups: ragdoll ↔ WORLD only (not bots or other ragdolls). Use CCD only on the chest.
- Write back each frame: `boneWorldQ = bodyQ · offsetQ` (offset captured at creation), then
  `bone.quaternion = inv(parentWorldQ) · boneWorldQ`. The hips also take the position. Non-simulated bones (spine,
  spine1, hands, feet) keep their last animated local rotation. For spine and spine1, slerp between the pelvis and
  chest rotations.
- Budget: at most **3** active ragdolls, near the camera (under 30 m) only. Others use the existing procedural
  death. Put a ragdoll to sleep (or after 4 s), freeze its pose, and remove its bodies. The existing `_groundCorpse`
  and late-sink logic still apply.

**Reuse.** Rapier ragdoll examples: `pmndrs/react-three-rapier` (MIT) has a ragdoll demo, and Isaac Mason's
`sketches` (MIT) has Rapier character sketches. Both are reference only (React and R3F), not drop-in. Rapier itself
is Apache-2.0.

**Cost.** Bodies and joints step inside the existing world. With 3 ragdolls, that is about 33 bodies for 4 s, which
is fine on 4 cores. **Risk:** tuning time and occasional explosions. Ship behind a quality setting.

---

### P4. Motion matching (not now)

Holden's `Motion-Matching` (MIT code; database search in `database.h`, controller in `controller.cpp`) plus the
learned variant are the state of the art (Clavet, *For Honor*, GDC 2016). The bottleneck is data. The demo's
database is **LAFAN1 (CC BY-NC-ND 4.0)**, which is unusable here. No permissive shooter locomotion dataset exists.
100STYLE could feed an unarmed lower-body matcher, but a blend space with the same clips plus foot locking gets
about 80% of the result for about 5% of the cost. Revisit if we ever capture our own data (§3.4).

---

## 3. Free animation sources, licence-verified

### 3.1 Usable

| Source | Licence (how verified) | What is in it for us | Retarget |
|---|---|---|---|
| **Quaternius UAL1/UAL2 Standard** (in use) | CC0 (`LICENSE.txt` in the pack; itch "Asset license: CC0") | 43 clips each. Gun clips: **only** `Pistol_Aim_Neutral/Up/Down`, `Pistol_Idle_Loop`, `Pistol_Reload`, `Pistol_Shoot`. No rifle, strafe or turn clips. UAL2: `OverhandThrow`, `Hit_Knockback`, `Slide_*`, `ClimbUp_1m`, `LayToIdle` | Existing Blender script |
| **Quaternius UAL1 Pro / Source** ($9.99 / $14.99 on itch) | CC0 (same page and licence; paying buys tier access, not a different licence) | 120+ clips: **8-dir jog and crouch**, `Walk_Bwd`, `Turn90_L/R`, `Sprint_Enter/Exit`, `Jog_Fwd_LeanL/R`, `Hit_Head/Shoulder_L/R/Stomach`, `Death02`, `Dodge_*`, `Crawl_*` (4-dir), `Idle_LookAround`, `Idle_Tired`; `_RM` root-motion versions. Still **no rifle upper body**, so keep the procedural and IK rifle hold | Same script. **Check the bone names**: v2.0 renamed the rig ("new rig naming scheme"), so update `BONE_MAP` |
| **100STYLE** (Mason, Starke, Komura 2022) | **CC BY 4.0** (Zenodo record 8127870 metadata `license: cc-by-4.0`; project page says the same) | Xsens mocap at 60 fps, 100 styles × {FW, BW, FR, BR, SW, SR, ID, TR}. Use `Neutral`, `Swat`, `Crouched`, `BentKnees`, `OnToesCrouched`, `Rushed`, `InTheDark`, `StartStop`, `LimpLeft/Right` | BVH (Hips/Chest/…/LeftHip/LeftKnee/LeftAnkle/LeftToe) → Blender BVH import → the same direction-matching retarget. The zip is 1.47 GB; extract only the styles needed (HTTP-range "remote zip" or a one-off download into scratch). Credit: "100STYLE dataset by Ian Mason et al., CC BY 4.0" in credits plus `docs/ASSET_SOURCES.md` |
| **Microsoft Rocketbox** | **MIT** (`LICENSE.md`; already logged in `ASSET_SOURCES.md`) | 471 FBX clips, mocap-quality. Useful: `m_walk_start/stop`, `m_run_start/stop`, `m_walk_to_run`, `m_run_to_walk`, `m_turn_left/right_60/90/120/180` (+`_to_walk`), `m_crouch_in/out/idle`, `m_idle_look_around_*`, `m_run_injured`, `m_walk_injured` | 3ds Max Biped skeleton → Blender retarget. Use the lower body only |
| **CMU Graphics Lab mocap** | Custom terms (verified via mirrors; mocap.cs.cmu.edu is blocked from this box): *"free for use in research… you may include this data in commercially-sold products, but you may not resell this data directly, even in converted form."* | General locomotion, a few crouch, sneak and "soldier"-like trials; noisy. Committing retargeted clips inside a game is generally treated as inclusion, not resale. **Ask the team before adopting** (redistributing in a public repo is a grey area) | BVH (cgspeed conversions) → Blender |

### 3.2 Not usable (or code and ideas only)

| Source | Licence | Verdict |
|---|---|---|
| Ubisoft **LAFAN1** | CC BY-NC-ND 4.0 (`license.txt`) | ✗ data. NC and ND |
| Ubisoft learned-motion-matching / Holden *Motion-Matching* | Code MIT (Holden); data LAFAN1 | Code OK, data ✗ |
| **Bandai Namco Research Motion dataset 1/2** | CC BY-NC 4.0 (README) | ✗ NC |
| AI4Animation (Starke) | README: *"research or education purposes… not freely available for commercial use or redistribution"*; mocap CC BY-NC 4.0 | ✗ |
| **Unreal Lyra / Game Animation Sample (GASP)** | Epic Content EULA: UE projects only | ✗ assets. Ideas only (distance matching, stride and orientation warping, turn-in-place root-yaw offset) |
| **ALS-Community / ALS-Refactored** | MIT (`LICENSE`, `LICENSE.md`) | Code and logic portable with an MIT notice. Its animations come from the UE mannequin (Epic EULA), so ✗ |
| Unity **FPSSample** | Unity Companion License (Unity-only) | ✗ code. Ideas only (weapon "drag", aim layers) |
| Godot **tps-demo** | Code MIT, assets CC-BY 3.0 | Robot rig, not humanoid. Reference for the AnimationTree aim blend only |
| GDQuest godot-4-3d-third-person-controller | Code MIT, art **CC-BY-NC-SA** | ✗ art |
| Kevin Iglesias *Human Soldier Animations* (itch, $30; free lite) | Proprietary single-entity licence | ✗ for a public repo (best rifle set on the market, though) |
| Sketchfab "rifle walk/aim" uploads (`094a698e…` Marine, alexferrart3D, slagperch3d…) | "CC Attribution" labels, but the descriptions say **"rigged and animated with Mixamo"** | ✗ Mixamo laundering |
| Mixamo, ActorCore, Rokoko library, AI motion generators | Not redistributable / unclear rights | ✗ (matches `ASSET_SOURCES.md` policy) |
| Quaternius *Toon Shooter Game Kit* | CC0 | 17 clips on a chibi rig (`Run_Gun`/`Walk_Shoot`-style). Proportions too stylised to retarget well. Low value |

### 3.3 Retarget pipeline (recommended: offline in Blender 4.2)

`operation-steel-tide/scripts/blender/build_animated_bamen_operator.py` already implements a rest-pose-independent
retarget. For each frame it aligns every mapped target bone's world **direction** to the source bone's, scales hips
translation by height ratio, then bakes. To add clips:

1. Add `"ual1pro": UAL1_Pro.glb` and map clip names in `ACTION_SOURCES` (e.g. `"jog_l": ("ual1pro", "Jog_Left_Loop",
   True)`). Run `AIM_LOCOMOTION_SOURCES` over them so they carry the rifle-hold upper body. Fix `BONE_MAP` if the v2+
   rig names differ (inspect with `tools/blender/inspect.py`).
2. For BVH (100STYLE, CMU), import with `bpy.ops.import_anim.bvh(filepath, axis_forward='-Z', axis_up='Y',
   global_scale=0.01 /* cm→m for Xsens */, use_fps_scale=True)`. Add a `BVH_MAP` (`Hips→Hips`, `Chest→Spine`,
   `Chest2→Spine1`, `Chest3/4→Spine2`, `LeftHip→LeftUpLeg`, `LeftKnee→LeftLeg`, `LeftAnkle→LeftFoot`,
   `LeftToe→LeftToeBase`, …; check the actual joint names in the file header). Trim with `Frame_Cuts.csv`, cut a
   seamless loop (Holden, *Creating Looping Animations from Motion Capture*: pick the frame pair with the lowest pose
   and velocity cost, then apply an inertialized offset across the seam), and resample to 30 fps.
3. Export lower-body-only clips: drop `UPPER` tracks at export, or let `splitClip` do it at load.
4. Measure stride and speed per clip for the gait table. From `_RM` variants: root travel ÷ duration. From mocap:
   hips horizontal travel. Also record the left-foot-forward phase `offset` and the contact windows for P1-5.
5. Runtime retarget with `SkeletonUtils.retargetClip` (r186) works too, but it resamples every track at a fixed fps
   on load (CPU and memory at startup) and needs a hand-made name map plus `hip` options. **Prefer offline baking.**
   The in-file `retargetClips` (Mixamo→Mixamo) stays for swapping bodies.

Run Blender headless (`blender -b -P script.py -- args`) one job at a time; it is single-threaded enough for the
4-core box.

### 3.4 Make our own rifle mocap (optional, high value)

No permissive rifle-handling mocap exists. Options that produce data **we own** (licensable CC0 or CC-BY by us):
- **FreeMoCap** (AGPL-3.0 *software*; the recordings we capture are ours). Two or three webcams and a broomstick
  "rifle": low-ready walk, tactical reload, peek, grenade throw, death falls. Clean up in Blender. Rifle hand
  placement is then corrected by P0-2's IK anyway.
- Keyframe the upper-body one-shots (rifle reload, mag check, cover-peek) in Blender on the Bamen rig, about 1–2 h
  each. Lower-body realism matters more and comes from 100STYLE and UAL Pro.

---

## 4. Projects and talks worth reading (and what to take from each)

| Reference | Licence | Take-away for us |
|---|---|---|
| Holden, *Simple Two Joint IK* (theorangeduck.com/page/simple-two-joint) | Article | Already our `_twoBoneIK`. Add the pole and elbow hint (§P0-2) |
| Holden, *Dead Blending* (…/page/dead-blending), *Spring-Roll-Call* (…/page/spring-roll-call) | Article; code MIT (Spring-It-On) | §P0-3 transitions, §P0-2 springs |
| Holden, *Code vs Data Driven Displacement* (…/page/code-vs-data-driven-displacement), *Motion-Matching* repo | MIT code; LAFAN data NC-ND | Simulation-object vs character-root separation (we do it: agent = sim, character = visual), foot-locking code in `controller.cpp`, adjustment springs |
| Holden, *Creating Looping Animations from Motion Capture* | Article | Cutting 100STYLE loops |
| Bollo, *Inertialization: High-Performance Animation Transitions in Gears of War* (GDC 2018, gdcvault 1025331) | Talk | Why to cut instantly and decay the offset |
| Rosen, *Animation Bootcamp: An Indie Approach to Procedural Animation* (GDC 2014, gdcvault 1020583) | Talk | Few keyposes plus springs plus stride wheel. Our gait phase is this idea; add procedural step-turns |
| Clavet, *Motion Matching and The Road to Next-Gen Animation* (GDC 2016, *For Honor*, gdcvault 1023280) | Talk | Future P4; trajectory prediction from AI intent |
| Bereznyak, *IK Rig: Procedural Pose Animation* (GDC 2016, gdcvault 1022984) | Talk | Procedural locomotion and turning from IK goals; weapon-driven arms |
| Anguelov, *Animation Driven Locomotion for Smoother Navigation* (GDC 2012, gdcvault 1015614) | Talk | §P0-1: make AI movement respect animation limits |
| ALS-Refactored (github.com/Sixze/ALS-Refactored) | MIT | Foot locking with pelvis offset, rotation modes (velocity vs aim direction), lean from local acceleration, turn-in-place thresholds and playrates, overlay layering for rifle and pistol |
| pmndrs/ecctrl | MIT | Physics character controller with a simple animation FSM. Little to reuse here; we already exceed it |
| pixiv/three-vrm | MIT | `VRMLookAt` (yaw and pitch range maps, saccades). Port the eye and head look-at curves idea; no IK inside |
| Mugen87/yuka and dive | MIT (code) | Yuka is already a dependency (AI). Dive's character animation is basic cross-fades. Its soldier and rifle are not clean (see `ASSET_SOURCES.md`) |
| three.js examples: `webgl_animation_skinning_blending` (crossFade, `syncWith`, warp), `webgl_animation_skinning_additive_blending` (`makeClipAdditive`, used), `webgl_animation_skinning_ik` (`CCDIKSolver`), `webgpu_animation_retargeting` (`SkeletonUtils.retargetClip`), `webgl_loader_bvh` | MIT | API references for the above |
| jsantell/THREE.IK | MIT | FABRIK chains with constraints. Reference only (old three API) |

---

## 5. Implementation notes and pitfalls specific to `Character.js`

- **Pass order per animated frame** (target): `mixer.update` → `DeadBlend.apply` → foot IK and pelvis → spine
  twist and pitch (reduced share) → hit springs → head look → weapon root (aim, recoil springs, sway) → right-hand
  IK and orientation → left-hand IK and orientation → `root.updateMatrixWorld`. Today the weapon is placed after the
  spine from the right palm; invert that.
- **The `twist` clamp**: `±100°` → `±45°` once lateral clips exist (`±60°` before that).
- **The one-shot gun-in-hand path** (`handRelQ`) still works under P0-2: during reload and throw, weight the hand IK
  to 0 and let the gun ride the right hand as today.
- **LOD**: keep foot IK, foot locking and dead-blend velocity tracking for the "every frame" band (< 15 m) only.
  Spring states must use exact integrators (they are) because `dt` reaches 0.25 s.
- **Hitboxes** read bone matrices, so foot IK and pelvis changes automatically move the leg capsules. Good.
- **Allocation**: `Physics.raycast` allocates two `Vector3`s per hit. Add a `raycastInto(origin, dir, max, mask,
  out)` variant before calling it 2× per bot per frame.
- **Testing** (QA runner, no own browser): add a `shot:false` script view that logs per-bot foot-height error vs
  ground (`foot.y − groundRay`) on the stairs, and the max per-frame bone angular jump (pop detector: flag > 25°/frame
  at 20 Hz). Both are cheap numerical checks before any screenshot.

---

## 6. Top 10 (summary)

1. **Calm the AI's feet first** (P0-1): `maxAcceleration` 18 → 8–10, strafe segments 0.7–1.8 s, a plant before
   reversing, and smoothed agent velocity into the animation. Free; the largest single de-robotising change.
2. **Weapon drives hands** (P0-2): build the weapon pose from a shoulder anchor and the aim, IK *both* hands to the
   `POSES` grips with wrist orientation and an elbow hint, and move pitch from the spine (100%) to the weapon and
   arms (~60%).
3. **Spring recoil through IK** (P0-2): Holden's exact spring (MIT) on weapon pitch, yaw and pushback. The arms and
   shoulders recoil with the gun, and the gun no longer leaves the palm.
4. **Dead blending** (P0-3): about 60 lines of JS on local quaternions after `mixer.update`. Trigger it on the
   backpedal flip, one-shots, death, turns and jumps. Removes pops at about 0.01 ms per bot.
5. **Buy Quaternius UAL1 Pro ($9.99, CC0)**: 8-direction jog and crouch, `Walk_Bwd`, `Turn90_L/R`, sprint
   enter/exit, directional hits, left-foot-synced loops, and root-motion variants for auto stride measurement.
   Retarget with the existing Blender script.
6. **8-way lower-body blend space** (P1-4) on the shared gait phase, with the spine twist cut from ±100° to ±45°.
   Orientation warping covers only the residual.
7. **Foot IK, pelvis drop and foot locking** (P1-5): 2 Rapier rays per near bot, contact windows precomputed in
   phase space. Fixes stairs and slopes and the sliding soles during turns.
8. **Turn-in-place clips with root-yaw extraction** (P1-6, UAL Pro `Turn90` or Rocketbox `m_turn_*` MIT) instead
   of the walk-cycle shuffle.
9. **100STYLE (CC BY 4.0) mocap** for a second, more natural locomotion set: the `Neutral`, `Swat` and `Crouched`
   styles, each with forward, backward, sidestep, run, idle and transition takes. Also Rocketbox (MIT)
   starts/stops. Avoid LAFAN1, Bandai Namco, AI4Animation, Lyra/GASP, Kevin Iglesias and Mixamo-derived Sketchfab
   uploads (licences verified as unusable).
10. **Then polish**: spring hit reactions by body part, aim sway and breathing, footsteps from foot contacts, and
    finally a capped Rapier ragdoll (≤3 near bots, Apache-2.0, motors but no cone limits in rapier.js 0.21). Leave
    motion matching for later: the MIT code exists, but no permissively licensed shooter data does.
