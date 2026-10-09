# Recoil & spread research (Ironline weapon feel)

The goal is guns that climb up and slightly right the way real rifles do. Controlling that should take skill,
and taps and short bursts should beat spraying past about 15 m without the game ever feeling unfair. This
document collects what realistic and competitive shooters do, the real-world physics behind it, and how Ironline
maps both onto code (`src/game/weapons/WeaponDefs.js` `rc`, `Weapon.js`, `Recoil.js`, `Bot._recoilComp`).

> Source note: most studio pages (BI wiki, dev.arma3.com, joinsquad.com, ubisoft.com, thefirearmblog) were
> unreachable from the build sandbox. Findings below come from search-indexed excerpts of those pages and from
> community documentation. Claims marked *community* are player observations, not developer specs.

## 1. How the reference games model it

| Game | Vertical / horizontal | Recovery | First shot vs sustained | Free aim / sway | Visual vs real |
|---|---|---|---|---|---|
| **Insurgency: Sandstorm** | Per-weapon vertical + horizontal; hip-fire recoil reported ~2-3x ADS, horizontal much stronger at the hip (*community*) | Little auto-recovery; you pull down. The "Recoil Grip" reduces vertical recoil for follow-ups | Players report the first shots kick hardest and sustained auto settles slightly (*community*, disputed) | Free-aim at the hip: the gun moves inside the screen, and shots go where the *weapon* points. An optional "dead zone" (default off since 1.7) | The "November update" made *visual* recoil punchier separately from recoil values; 7.62 weapons retuned harder |
| **Arma 3** (`CfgRecoils`) | Each shot moves the muzzle to a random point in an ellipse (`muzzleOuter` x/y offset + a/b magnitude), so drift is biased and random | Split into **permanent** (muzzle rise you must compensate) and **temporary** (shake that returns) | `kickBack` random rearward force; `kickVisual` scales camera-only kick | Stance precision coefficients multiply sway. **Resting** cuts sway and recoil; a **deployed bipod** removes almost all. `recoilProneCoef` per weapon. Fatigue raises sway | `kickVisual` (camera) is separate from the muzzle displacement |
| **Squad** (ICO 2023, 10.4 2026) | "More detailed recoil system"; **bullets follow the barrel**, not the screen centre | n/a | Long firefights by design; suppression adds sway + flinch | Sway/steadiness rework; 10.4 makes sway *predictable*. Suppression blocks hold-breath | Barrel-following means visual sway is real aim error |
| **Escape from Tarkov** | Vertical + horizontal recoil stats; attachments (stocks, buttpads, grips, muzzles) cut each as a % | **Convergence** = how fast the weapon returns toward its start after each shot (an auto-compensation stat) | Community complains the first ~3 shots kick too hard | Ergonomics drives sway/stamina | **Camera recoil** is a separate stat (BSG cut it 20% globally) |
| **Hell Let Loose** | Per-weapon totals (MP40/STG/BAR lowered in patches) | n/a | MG hip fire is crawl-speed and inaccurate; deployed MG is the point | Suppression flinch; bipod deploy is the MG's role | n/a |
| **Ground Branch** | Realism-focused; per-weapon handling (MP5 "good recoil control") | n/a | n/a | n/a | n/a |
| **Rainbow Six Siege** | 2020+ multi-stage recoil: **bullet 1 goes exactly where you aim**; bullet 2 gets a left/right value; later bullets use other data sets. LMGs get the strongest vertical and lateral recoil after sustained fire | n/a | Recoil **intensifies with sustained fire** | n/a | Removed the camera offset because sights and world parallax disagreed: aim follows sights |
| **CS2** | Fixed, learnable pattern per weapon (AK: ~4-9 rounds near-vertical, then a left then right swing) + random inaccuracy layered on top | Pattern index decays back gradually after release; firing mid-recovery starts from the current index | First bullet = crosshair (inaccuracy only); 2-4 round bursts/taps advised at range | None (movement inaccuracy instead) | Viewpunch is visual; the spray pattern is real |
| **Battlefield** | Recoil up/left/right per weapon + **first-shot recoil multiplier** (BF4 M240B 0.5 → 1.4) | n/a | Spread increase per shot; BF6 (2026) increased deviation after the first shot to **push burst fire at range** | n/a | n/a |

Takeaways for us:
1. **The first bullet is honest** (R6, CS2, BF). It goes where the sights are, with only base inaccuracy.
2. **Recoil should be learnable but not a script.** It should be a deterministic per-weapon shape (CS2, R6) plus
   bounded randomness (Arma's ellipse, Insurgency's horizontal).
3. **Separate recoil into a permanent part you compensate and a transient part that returns** (Arma
   permanent/temporary, Tarkov convergence). Full auto-recovery (CoD/Valorant style) removes the skill.
4. **Visual kick is not aim change** (Arma `kickVisual`, Tarkov camera recoil, R6 removing camera offset).
   Bullets follow the weapon (Squad).
5. **Sustained fire gets worse** (R6, BF6 deviation, LMG penalties). Short bursts are the intended range technique.
6. **Stance and bracing matter more than attachments** (Arma resting/bipod, HLL deployed MG).

## 2. Real-world physics

**Why the muzzle climbs.** Recoil acts along the bore, which sits *above* the shoulder/grip contact. The
resulting moment rotates the muzzle up ([bore axis](https://en.wikipedia.org/wiki/Bore_axis)). The bigger the
bore-over-shoulder offset and the impulse, the more flip. A straight-line stock (AR-15/M4, SCAR) puts the
bore nearly in line with the shoulder. The AK's dropped stock plus the gas piston above the bore adds an
unbalanced moving mass and a sharper "rock".

**Why it drifts right (for a right-handed shooter).** The gun pivots up and *away from the support shoulder*,
so the direction depends on the dominant hand. The AK is famous for "up and to the right", which is why the AKM's
slant brake vents gas up-right to push the muzzle **down-left**. It is offset about 22 degrees for right-handed
full-auto fire ([TFB](https://www.thefirearmblog.com/blog/2018/03/26/why-is-the-akms-muzzle-brake-canted/)).
The AK also "jumps": its long-stroke piston and heavy carrier slam at each end of travel, so its horizontal
component is more erratic than an AR's buffer-tube push.

**Cyclic rate.** Above about 600 rpm the muzzle has not returned before the next round fires, so climb
accumulates. Trained shooters can control 400-600 rpm. In a right-handed 100 yd controllability test of an
M16-class rifle, round 2 landed about 1 ft up-right of round 1 and round 3 another 2 ft, and shooters needed until
about round 7 to force shots back (patents US5485776, US8899141). For a heavier recoiling 7.62 NATO rifle the
controllability problem "greatly worsens".

**Recoil per cartridge** (free recoil, computed with the SAAMI-style momentum formula, gas velocity 4000 fps for
rifles and 1.5x muzzle for pistols/shotgun; the impulse drives per-shot muzzle rise):

| Cartridge / gun (loaded mass) | Impulse N·s | Free recoil ft·lbf | Ironline `rc.up` (deg/shot ADS) |
|---|---|---|---|
| 9x19 124 gr / MP5 (6.6 lb), roller-delayed | 3.3 | 1.3 | 0.20 (softest; roller delay + low mass bolt) |
| 5.45x39 / RPK-74 (11 lb) | 5.1 | 1.9 | 0.30 (heavy gun, low impulse; builds over a long string) |
| 5.56x45 M855 / M4 (7.5 lb) | 5.8 | 3.6 | 0.34 |
| 5.56x45 / SCAR-L (7.3 lb) | 5.8 | ~3.7 | 0.36 (slower 625 rpm, cleaner) |
| 9x39 SP-5 / VSS (5.7 lb) | 4.9 | 3.4 | 0.48 (heavy slow bullet in a very light gun: bouncy on auto) |
| 7.62x39 M43 / AKM (8 lb) | 7.7 | 6.0 | 0.50 (+ high bore, piston: harshest rifle) |
| 9x19 / P226 (2.1 lb) | 3.0 | 3.5 | 1.0 (pistol flip, returns well) |
| .45 ACP / M1911 (2.4 lb) | 3.9 | 5.1 | 1.5 (slower, bigger push) |
| 7.62x51 M118LR / M24 (12 lb) | 12.5 | 10.4 | 3.0 |
| .338 LM / AWM (15 lb) | 21.7 | 25.5 | 4.0 (default brake + bipod) |
| 12 ga 00 buck / M870 (7.6 lb) | 15.6 | 26 | 4.6 |

Published comparisons agree: 5.56 is about 3-6 ft·lbf, 7.62x39 is about 30-40% more than 5.56, and .308 is
about 13-20 ft·lbf depending on load and rifle weight.

## 3. What Ironline does (implementation)

**Per-shot recoil** (`Weapon.recoilShape`, profile `rc` in `WeaponDefs.js`), in degrees, aimed and standing:
- vertical `up x shape(i) x (1 +- vj)`, where `shape` = `first` on shot 0 (the jump), climbing 1.04-1.2 over
  shots 1-5 (muzzle hasn't returned), then settling to `tail` (<1 the shooter "locks in", >1 the gun keeps
  building, e.g. RPK);
- horizontal `h x driftMul + wa x sin(2*pi*i/wp + ph) + jit x (1 + 0.05*min(i,10)) x rand(+-1)`: a mean
  rightward drift, a learnable left/right wander (the "S" of the pattern), and jitter that grows over a long string.

**Modifiers** (`Weapon.recoilMods`, `RECOIL_MOD`): hip 1.45x vertical and 2x horizontal (Insurgency hip
behaviour, scaled by ADS blend); crouch 0.85/0.8; **bipod only when crouched (braced)** 0.55/0.45 and half the
bloom; moving +15%/+40% at a full run; airborne 1.5x; attachments via `vRecoil`/`hRecoil` plus a new `drift`
(the brake cancels 35% of the mean drift like an AKM slant brake, the compensator 15%). Suppressor -8%
vertical, long barrel -4%, short barrel +8%/+6%.

**Aim side** (`Recoil.js` `AimRecoil`, player):
- each kick eases into the real aim over about 60 ms (no single-frame teleport);
- no recovery while the string continues, so the player pulls down;
- when the trigger pauses (>max(0.12 s, 1.2x the cyclic interval), capped at 0.3 s) only `recS` (1 shot) to
  `recL` (10+ shots) of the *uncompensated* climb settles back at 10/s. Mouse pull-down consumes the
  recoverable part first, so compensating never overshoots. Tap and burst shooters get most of their sight
  picture back; sprayers end up high and right.

**Visual only:** the camera kick spring (`FPCamera.addKick`) and the viewmodel flip (`ViewModel.onFire`) follow
the shot's direction but never change where bullets go. `Game._playerFire` now fires along the true aim
(`player.yaw/pitch`) instead of the camera quaternion, so the punch, shake and head-bob curves are felt rather
than acting as a hidden aim offset.

**Spread/bloom** (`Weapon.BLOOM`): each shot adds `spreadPerShot`. Bloom only begins to recover 0.1 s after the
last shot, so sustained fire keeps blooming; previously it recovered *during* auto fire, so ADS auto was a
laser. Aimed fire forgives the first 2 shots of a string and keeps 40% of the rest, capped at `spreadMax`.
The spread for a shot uses the bloom *before* that shot, so the first aimed round is exactly the sight picture
plus the weapon's base dispersion (honest), and movement still costs accuracy.

**Bots** (`Bot._recoilComp`): bots get the same shot.pitch/yaw. The part they fail to control (1-recoilCtl
vertical, 1-0.8·recoilCtl horizontal, plus misjudge noise that grows as skill drops) is a hidden muzzle offset
that their target-tracking loop cannot see. It stacks during a string and settles only between shots
(exp(-gap·(2+10·ctl))). Recruits climb off target on sustained fire; veterans barely move.

### Per-weapon profiles

| Weapon | up | first | tail | drift h | wander wa/wp | jit | vj | settle recS→recL | Character |
|---|---|---|---|---|---|---|---|---|---|
| M4A1 | 0.34 | 1.30 | 0.85 | +0.05 | 0.06 / 12 | 0.09 | 0.12 | 0.85→0.35 | Fast, smooth, gentle right drift; easy to learn |
| AK-47 | 0.50 | 1.40 | 0.95 | +0.09 | 0.16 / 9 | 0.20 | 0.22 | 0.78→0.25 | Harsh jump, erratic horizontal, keeps climbing (brake tames the drift) |
| SCAR-L | 0.36 | 1.20 | 0.85 | +0.04 | 0.05 / 14 | 0.07 | 0.10 | 0.88→0.38 | Clean, predictable; 3-round burst default |
| MP5A5 | 0.20 | 1.10 | 0.80 | +0.03 | 0.05 / 10 | 0.07 | 0.10 | 0.92→0.45 | Soft roller-delayed push, settles fast |
| VSS | 0.48 | 1.25 | 1.00 | +0.07 | 0.12 / 7 | 0.16 | 0.20 | 0.85→0.30 | Light gun, heavy bullet: bouncy, short wander period |
| RPK-74 | 0.30 | 1.10 | 1.05 | +0.06 | 0.05 / 18 | 0.08 | 0.08 | 0.80→0.30 | Steady but heavy, keeps building; bipod when crouched |
| M870 | 4.6 | - | - | +0.45 | - | 0.70 | 0.15 | 0.90 | Big shove per shell |
| M24 | 3.0 | - | - | +0.20 | - | 0.25 | 0.10 | 0.93 | Bolt; returns near zero |
| AWM | 4.0 | - | - | +0.25 | - | 0.30 | 0.10 | 0.93 | Bolt; heavy, brake + bipod |
| P226 | 1.0 | 1.0 | 1.10 | +0.10 | 0.08 / 5 | 0.22 | 0.15 | 0.90→0.50 | Snappy 9 mm flip |
| M1911 | 1.5 | 1.0 | 1.10 | +0.14 | 0.10 / 4 | 0.30 | 0.18 | 0.88→0.45 | Slower, bigger .45 push |

Tuning harness: `node tools/spray_sim.mjs` (headless, real Weapon/AimRecoil code; `--old <root>` for an older
tree). In-engine QA: `tools/qa/suites/w_spray.json` (+ `w_spray.lib.js`).

## 4. Not done yet (proposals)
- **Free-aim / deadzone at the hip** (Insurgency, Arma): the weapon moves inside the screen and bullets follow it.
  It needs viewmodel/crosshair work and a settings toggle, so it is not in this pass.
- **Idle ADS sway / breathing for all rifles** (Arma stance coefficients, Squad predictable sway); currently only
  the sniper overlay sways.
- **Resting on cover** (Arma) as an auto-brace when the muzzle is near a ledge; stock/buttpad attachment slot (Tarkov).
- **Suppression** flinch/sway (Squad, HLL).

## Sources
- Arma 3 CfgRecoils (BI wiki): https://community.bistudio.com/wiki/cfgRecoils
- Arma 3 ItemInfo config (recoilCoef / recoilProneCoef): https://community.bistudio.com/wiki/Arma_3_ItemInfo_Config_Reference
- Arma 3 OPREP weapon sway & fatigue: https://dev.arma3.com/post/oprep-weapon-sway-fatigue
- Arma 3 OPREP weapon inertia: https://dev.arma3.com/post/oprep-weapon-inertia
- Arma 3 Stamina: https://community.bistudio.com/wiki/Arma_3_Stamina
- Insurgency wiki, Aiming (free-aim): https://insurgency.fandom.com/wiki/Aiming
- Insurgency: Sandstorm Recoil Grip: https://insurgency.fandom.com/wiki/Recoil_Grip ; Compensator: https://insurgency.fandom.com/wiki/Compensator
- Sandstorm November update (visual recoil "punchy", 7.62 recoil): https://forums.focus-entmt.com/topic/31763/november-8th-update-now-live
- Sandstorm hip vs ADS recoil / third-shot reports (community): https://steamcommunity.com/app/581320/discussions/0/2644126542302193462 , https://forums.overclockers.co.uk/posts/33101888/
- Sandstorm dead zone (community): https://steamcommunity.com/app/581320/discussions/0/2520275467392867731
- Squad Infantry Combat Overhaul: https://joinsquad.com/archive/infantry-combat-overhaul-10b70 ; revisit: https://www.joinsquad.com/archive/revisiting-the-infantry-combat-overhaul-c0926
- Squad 10.4 patch notes: https://patched.gg/games/squad/squad-104-patch-notes
- Tarkov performance modifiers / recoil: https://escapefromtarkov.fandom.com/wiki/Performance_modifiers
- Tarkov recoil and camera recoil changes: https://afkgaming.com/esports/news/escape-from-tarkov-recoil-changes-more-latest-patch-notes , https://www.gamepressure.com/S013-amp.asp?ID=21656 , https://www.ggrecon.com/guides/escape-from-tarkov-0-13-0-2-patch-notes/
- Tarkov convergence (RU guide): https://vk.ru/@metadvijenie-otdacha-v-eft
- Rainbow Six Siege recoil rework: https://www.ubisoft.com/en-us/game/rainbow-six/siege/news-updates/2vKaDckg5VPV1ViA4p8KM
- CS2 recoil: https://refrag.gg/blog/spray-science-how-does-weapon-recoil-function-in-cs2 , https://csdb.gg/recoil-patterns/ , https://guildorder.com/games/csgo/guides/spray-control-theory
- Battlefield 4 M240B first-shot multiplier: https://battlefield.fandom.com/wiki/M240/Battlefield_4 ; BF6 gunplay changes: https://www.altchar.com/game-news/battlefield-6-details-major-gunplay-changes-ahead-of-next-update-ajOf56Z8oTIj
- Hell Let Loose changelog/MG discussion: https://steamcommunity.com/app/686810/discussions/0/2520275467400291173
- Ground Branch: https://imfdb.org/wiki/Ground_Branch , https://www.groundbranch.com/about/
- AKM slant brake: https://www.thefirearmblog.com/blog/2018/03/26/why-is-the-akms-muzzle-brake-canted/ ; https://army.ca/forums/threads/why-is-the-ak-47-barrel-cut.45303/post-397112
- Bore axis: https://en.wikipedia.org/wiki/Bore_axis ; AR vs AK recoil: https://gunmagwarehouse.com/blog/ar-vs-ak-one-guys-perspective/
- MP5 roller-delayed blowback: https://en.wikipedia.com/wiki/MP5 , https://historyrise.com/article/a-technical-breakdown-of-the-mp5s-blowback-operation-system/
- Cyclic rate vs controllability: https://patents.google.com/patent/US5485776 , https://patents.google.com/patent/US8899141
- Recoil energy references: https://snipercountry.com/?p=2348 , https://ammodotcom.substack.com/p/how-does-308-recoil-compare-to-other , https://www.sportsmans.com/recoil-table
- 1911 bore axis / .45 vs 9 mm: https://www.sportsmans.com/1911-collection/c/cat140923?page=1
