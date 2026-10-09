// Weapon & attachment data. Tuned for 100 HP, ~200-350ms body TTK (MW19 / Valorant band).
// Times are seconds, ranges metres.
//
// Recoil profile `rc` (degrees per shot, aimed + standing; see docs/RECOIL_RESEARCH.md). Each shot moves the
// real aim; the shooter must pull down, and only part of it returns once the trigger is released.
//   up    vertical climb per shot     first  multiplier on the first shot of a string (the "jump")
//   tail  climb multiplier once a long string has settled (shots 6+; <1 the gun settles, >1 it keeps building)
//   h     mean rightward drift per shot (right-handed shooter; negative = left)
//   wa/wp/ph  learnable horizontal wander: wa*sin(2*PI*i/wp + ph) per shot (the "S" of a spray pattern)
//   jit   uniform random horizontal +- per shot (grows ~50% over a long string)
//   vj    random vertical fraction    recS/recL  share of the climb that settles back after a 1-shot /
//         10+-shot string (the rest is the shooter's job)
export const SLOTS = ['optic', 'muzzle', 'barrel', 'underbarrel', 'magazine', 'laser'];

export const ATTACHMENTS = {
  // ---- Optics ----
  irons: { slot: 'optic', name: 'Iron Sights', zoom: 1.15, ads: 0 },
  reddot: { slot: 'optic', name: 'Red Dot Sight', zoom: 1.25, ads: 0.01, reticle: 'dot' },
  holo: { slot: 'optic', name: 'Holographic Sight', zoom: 1.4, ads: 0.02, reticle: 'holo' },
  acog: { slot: 'optic', name: '3.5x Combat Scope', zoom: 3.5, ads: 0.06, move: -0.02, reticle: 'chevron', scope: true },
  sniper: { slot: 'optic', name: '8x Sniper Scope', zoom: 8, ads: 0.1, reticle: 'mildot', scope: true, overlay: true, glint: true, variable: [4, 8] },
  // ---- Muzzle ----
  suppressor: { slot: 'muzzle', name: 'Suppressor', suppressed: true, range: -0.1, ads: 0.02, vRecoil: -0.08, flash: 0.15 },
  compensator: { slot: 'muzzle', name: 'Compensator', vRecoil: -0.15, hRecoil: 0.05, drift: -0.15, flash: 1.2 },
  flashhider: { slot: 'muzzle', name: 'Flash Hider', hRecoil: -0.1, flash: 0.35 },
  // Brake: vents sideways/up (AKM-style slant) -> cancels much of the rightward drift and some climb.
  brake: { slot: 'muzzle', name: 'Muzzle Brake', vRecoil: -0.08, hRecoil: -0.08, drift: -0.35, kick: -0.15, flash: 1.4 },
  // ---- Barrel ----
  longbarrel: { slot: 'barrel', name: 'Long Barrel', range: 0.2, ads: 0.03, spread: -0.1, velocity: 0.15, vRecoil: -0.04 },
  shortbarrel: { slot: 'barrel', name: 'Short Barrel', range: -0.15, adsMul: -0.08, move: 0.05, vRecoil: 0.08, hRecoil: 0.06 },
  // ---- Underbarrel ----
  vgrip: { slot: 'underbarrel', name: 'Vertical Foregrip', vRecoil: -0.12, ads: 0.02 },
  agrip: { slot: 'underbarrel', name: 'Angled Grip', adsMul: -0.1, recovery: 0.15, hRecoil: -0.05 },
  // Bipod: folded it only adds a little weight; crouched it counts as deployed/braced (see Weapon.recoilMods).
  bipod: { slot: 'underbarrel', name: 'Bipod', vRecoil: -0.03, hRecoil: -0.03, ads: 0.03, move: -0.03, braced: true },
  // ---- Magazine ----
  extmag: { slot: 'magazine', name: 'Extended Mag', magMul: 1.5, reload: 0.3, ads: 0.03, move: -0.03 },
  fastmag: { slot: 'magazine', name: 'Fast Mag', reloadMul: -0.25 },
  // ---- Laser ----
  laser: { slot: 'laser', name: 'Tac Laser', hipSpread: -0.25, sprintToFire: -0.05, beam: true },
};

export const WEAPONS = {
  m4: {
    name: 'M4A1', cls: 'Assault Rifle', slot: 'primary', model: 'm4a1', pose: 'm4a1',
    modes: ['auto', 'semi'], rpm: 780, damage: [28, 20], range: [30, 60], headMult: 1.5, pellets: 1,
    mag: 30, reserve: 210, tacReload: 2.1, emptyReload: 2.7, ads: 0.26, sprintToFire: 0.2, equip: 0.5,
    hipSpread: 2.5, adsSpread: 0.05, spreadPerShot: 0.35, spreadMax: 4, spreadRecovery: 6,
    rc: { up: 0.34, first: 1.3, tail: 0.85, h: 0.05, wa: 0.06, wp: 12, ph: 0, jit: 0.09, vj: 0.12, recS: 0.85, recL: 0.35 }, kick: 0.55, mobility: 0.95,
    velocity: 880, penetration: 2.5, closedBolt: true, sample: 'm4a1',
    sound: { punch: 130, crack: 1500, body: 1.1, tail: 0.28 },
    attachments: ['irons', 'reddot', 'holo', 'acog', 'suppressor', 'compensator', 'flashhider', 'longbarrel', 'shortbarrel', 'vgrip', 'agrip', 'extmag', 'fastmag', 'laser'],
    defaults: { optic: 'reddot', muzzle: 'flashhider', underbarrel: 'vgrip' },
  },
  ak: {
    name: 'AK-47', cls: 'Assault Rifle', slot: 'primary', model: 'ak47', pose: 'ak74',
    modes: ['auto', 'semi'], rpm: 600, damage: [34, 24], range: [25, 55], headMult: 1.5, pellets: 1,
    mag: 30, reserve: 180, tacReload: 2.3, emptyReload: 2.9, ads: 0.28, sprintToFire: 0.22, equip: 0.55,
    hipSpread: 2.7, adsSpread: 0.06, spreadPerShot: 0.4, spreadMax: 4.5, spreadRecovery: 5.5,
    rc: { up: 0.5, first: 1.4, tail: 0.95, h: 0.09, wa: 0.16, wp: 9, ph: 0.6, jit: 0.2, vj: 0.22, recS: 0.78, recL: 0.25 }, kick: 0.75, mobility: 0.93,
    velocity: 715, penetration: 2.8, closedBolt: true, sample: 'ak74',
    sound: { punch: 110, crack: 1150, body: 1.35, tail: 0.32 },
    attachments: ['irons', 'reddot', 'holo', 'acog', 'suppressor', 'compensator', 'brake', 'longbarrel', 'vgrip', 'agrip', 'extmag', 'fastmag', 'laser'],
    defaults: { optic: 'irons', muzzle: 'brake' },
  },
  scar: {
    name: 'SCAR-L', cls: 'Battle Rifle', slot: 'primary', model: 'scarl', pose: 'scarl',
    modes: ['burst', 'auto', 'semi'], burst: 3, burstRpm: 900, burstDelay: 0.24, rpm: 625, damage: [33, 25], range: [35, 70], headMult: 1.5,
    mag: 30, reserve: 180, tacReload: 2.2, emptyReload: 2.75, ads: 0.27, sprintToFire: 0.21, equip: 0.5,
    hipSpread: 2.4, adsSpread: 0.04, spreadPerShot: 0.3, spreadMax: 3.5, spreadRecovery: 6,
    rc: { up: 0.36, first: 1.2, tail: 0.85, h: 0.04, wa: 0.05, wp: 14, ph: 0, jit: 0.07, vj: 0.1, recS: 0.88, recL: 0.38 }, kick: 0.5, mobility: 0.94,
    velocity: 870, penetration: 2.6, closedBolt: true, sample: 'scarl',
    sound: { punch: 125, crack: 1450, body: 1.2, tail: 0.3 },
    attachments: ['irons', 'reddot', 'holo', 'acog', 'suppressor', 'compensator', 'flashhider', 'longbarrel', 'vgrip', 'agrip', 'extmag', 'laser'],
    defaults: { optic: 'acog', muzzle: 'compensator' },
  },
  mp5: {
    name: 'MP5A5', cls: 'SMG', slot: 'primary', model: 'mp5a5', pose: 'mp5a5',
    modes: ['auto', 'burst', 'semi'], burst: 3, burstRpm: 900, burstDelay: 0.2, rpm: 850, damage: [25, 16], range: [12, 30], headMult: 1.5,
    mag: 30, reserve: 240, tacReload: 1.9, emptyReload: 2.5, ads: 0.2, sprintToFire: 0.12, equip: 0.4,
    hipSpread: 2.0, adsSpread: 0.08, spreadPerShot: 0.25, spreadMax: 3.5, spreadRecovery: 8,
    rc: { up: 0.2, first: 1.1, tail: 0.8, h: 0.03, wa: 0.05, wp: 10, ph: 1, jit: 0.07, vj: 0.1, recS: 0.92, recL: 0.45 }, kick: 0.4, mobility: 1.0, adsMove: 0.65,
    velocity: 400, penetration: 1.5, closedBolt: true, sample: 'mp5a5',
    sound: { punch: 170, crack: 1900, body: 0.85, tail: 0.22 },
    attachments: ['irons', 'reddot', 'holo', 'suppressor', 'flashhider', 'shortbarrel', 'longbarrel', 'vgrip', 'agrip', 'extmag', 'fastmag', 'laser'],
    defaults: { optic: 'holo' },
  },
  vss: {
    name: 'VSS Vintorez', cls: 'Marksman SMG', slot: 'primary', model: 'vss', pose: 'vss',
    modes: ['semi', 'auto'], rpm: 750, damage: [38, 28], range: [25, 55], headMult: 1.8,
    mag: 20, reserve: 140, tacReload: 2.1, emptyReload: 2.6, ads: 0.25, sprintToFire: 0.16, equip: 0.45,
    hipSpread: 2.2, adsSpread: 0.03, spreadPerShot: 0.45, spreadMax: 4, spreadRecovery: 7,
    rc: { up: 0.48, first: 1.25, tail: 1.0, h: 0.07, wa: 0.12, wp: 7, ph: 0.3, jit: 0.16, vj: 0.2, recS: 0.85, recL: 0.3 }, kick: 0.6, mobility: 0.98, adsMove: 0.6,
    velocity: 290, penetration: 2.2, closedBolt: true, integralSuppressor: true, sample: 'vss',
    sound: { punch: 150, crack: 1300, body: 0.9, tail: 0.2 },
    // Fixed PSO-style scope (authored into the model): optic slot only selects its magnification.
    attachments: ['acog', 'vgrip', 'agrip', 'extmag', 'fastmag', 'laser'],
    defaults: { optic: 'acog' }, fixedOptic: 'acog',
  },
  m24: {
    name: 'M24 SWS', cls: 'Marksman Rifle', slot: 'primary', model: 'm24', pose: 'm24',
    modes: ['bolt'], rpm: 60, damage: [95, 80], range: [50, 120], headMult: 2.5, legMult: 0.75,
    mag: 5, reserve: 35, tacReload: 2.6, emptyReload: 3.2, boltTime: 0.85, ads: 0.36, sprintToFire: 0.3, equip: 0.6,
    hipSpread: 5, adsSpread: 0.0, spreadPerShot: 0, spreadMax: 0, spreadRecovery: 10,
    rc: { up: 3.0, first: 1, tail: 1, h: 0.2, wa: 0, wp: 1, ph: 0, jit: 0.25, vj: 0.1, recS: 0.93, recL: 0.93 }, kick: 3.0, mobility: 0.92, adsMove: 0.5,
    velocity: 850, penetration: 3.5, closedBolt: false, sample: 'm24',
    sound: { punch: 85, crack: 950, body: 2.0, tail: 0.6 },
    attachments: ['acog', 'sniper', 'suppressor', 'brake', 'bipod', 'extmag', 'laser'],
    defaults: { optic: 'acog' }, fixedOptic: 'acog',
  },
  awm: {
    name: 'AWM .338', cls: 'Sniper Rifle', slot: 'primary', model: 'awm', pose: 'awm',
    modes: ['bolt'], rpm: 45, damage: [130, 105], range: [70, 160], headMult: 3, legMult: 0.7,
    mag: 5, reserve: 30, tacReload: 2.8, emptyReload: 3.6, boltTime: 1.15, ads: 0.45, sprintToFire: 0.35, equip: 0.7,
    hipSpread: 6, adsSpread: 0.0, spreadPerShot: 0, spreadMax: 0, spreadRecovery: 10,
    rc: { up: 4.0, first: 1, tail: 1, h: 0.25, wa: 0, wp: 1, ph: 0, jit: 0.3, vj: 0.1, recS: 0.93, recL: 0.93 }, kick: 4.0, mobility: 0.88, adsMove: 0.4,
    velocity: 940, penetration: 4, closedBolt: false, sample: 'awm',
    sound: { punch: 70, crack: 850, body: 2.4, tail: 0.8 },
    attachments: ['sniper', 'acog', 'suppressor', 'brake', 'bipod', 'extmag'],
    defaults: { optic: 'sniper', muzzle: 'brake', underbarrel: 'bipod' }, fixedOptic: 'sniper',
    sway: 0.5,
  },
  rpk: {
    name: 'RPK-74', cls: 'LMG', slot: 'primary', model: 'ak47', pose: 'ak74', drum: true,
    modes: ['auto'], rpm: 650, damage: [32, 24], range: [35, 70], headMult: 1.5,
    mag: 75, reserve: 225, tacReload: 4.2, emptyReload: 4.8, ads: 0.4, sprintToFire: 0.3, equip: 0.75,
    hipSpread: 3.5, adsSpread: 0.1, spreadPerShot: 0.3, spreadMax: 5, spreadRecovery: 4,
    rc: { up: 0.3, first: 1.1, tail: 1.05, h: 0.06, wa: 0.05, wp: 18, ph: 0, jit: 0.08, vj: 0.08, recS: 0.8, recL: 0.3 }, kick: 0.6, mobility: 0.85, adsMove: 0.45,
    velocity: 960, penetration: 3, closedBolt: true, sample: 'ak74', samplePitch: 0.93,
    sound: { punch: 100, crack: 1050, body: 1.5, tail: 0.4 },
    attachments: ['irons', 'reddot', 'holo', 'acog', 'suppressor', 'brake', 'flashhider', 'vgrip', 'bipod', 'laser'],
    defaults: { optic: 'holo', underbarrel: 'bipod' },
    sway: 0.6, rpkScale: true,
  },
  m870: {
    name: 'M870 MCS', cls: 'Shotgun', slot: 'primary', model: 'shotgun', pose: 'shotgun',
    modes: ['pump'], rpm: 70, damage: [18, 6], range: [6, 20], headMult: 1.4, pellets: 8, pelletSpread: 5,
    mag: 6, reserve: 36, shellReload: 0.55, rackTime: 0.5, ads: 0.24, sprintToFire: 0.14, equip: 0.55,
    hipSpread: 1.0, adsSpread: 0.6, spreadPerShot: 0, spreadMax: 0, spreadRecovery: 10,
    rc: { up: 4.6, first: 1, tail: 1, h: 0.45, wa: 0, wp: 1, ph: 0, jit: 0.7, vj: 0.15, recS: 0.9, recL: 0.9 }, kick: 3.5, mobility: 0.96,
    velocity: 400, penetration: 1, closedBolt: false, tube: true, sample: 'shotgun',
    sound: { punch: 75, crack: 800, body: 2.0, tail: 0.55 },
    attachments: ['irons', 'reddot', 'holo', 'suppressor', 'brake', 'laser'],
    defaults: { optic: 'irons' },
  },
  p226: {
    name: 'P226', cls: 'Pistol', slot: 'secondary', model: 'p226', pose: 'p226',
    modes: ['semi'], rpm: 420, damage: [34, 22], range: [15, 35], headMult: 1.6,
    mag: 15, reserve: 90, tacReload: 1.35, emptyReload: 1.75, ads: 0.16, sprintToFire: 0.1, equip: 0.35,
    hipSpread: 1.5, adsSpread: 0.1, spreadPerShot: 0.6, spreadMax: 3, spreadRecovery: 8,
    rc: { up: 1.0, first: 1, tail: 1.1, h: 0.1, wa: 0.08, wp: 5, ph: 0, jit: 0.22, vj: 0.15, recS: 0.9, recL: 0.5 }, kick: 1.0, mobility: 1.05,
    velocity: 380, penetration: 1, closedBolt: true, pistol: true, sample: 'p226',
    sound: { punch: 180, crack: 2100, body: 0.9, tail: 0.25 },
    attachments: ['irons', 'reddot', 'suppressor', 'compensator', 'extmag', 'laser'],
    defaults: { optic: 'irons' },
  },
  m1911: {
    name: 'M1911A1', cls: 'Pistol', slot: 'secondary', model: 'm1911', pose: 'm1911',
    modes: ['semi'], rpm: 360, damage: [42, 30], range: [14, 32], headMult: 1.7,
    mag: 8, reserve: 56, tacReload: 1.45, emptyReload: 1.85, ads: 0.17, sprintToFire: 0.11, equip: 0.38,
    hipSpread: 1.7, adsSpread: 0.12, spreadPerShot: 0.9, spreadMax: 3.5, spreadRecovery: 7,
    rc: { up: 1.5, first: 1, tail: 1.1, h: 0.14, wa: 0.1, wp: 4, ph: 0.8, jit: 0.3, vj: 0.18, recS: 0.88, recL: 0.45 }, kick: 1.5, mobility: 1.04,
    velocity: 250, penetration: 1.2, closedBolt: true, pistol: true, sample: 'm1911',
    sound: { punch: 140, crack: 1700, body: 1.1, tail: 0.3 },
    attachments: ['irons', 'reddot', 'suppressor', 'compensator', 'extmag', 'laser'],
    defaults: { optic: 'irons' },
  },
};

export const PRIMARY_LIST = ['m4', 'ak', 'scar', 'mp5', 'vss', 'rpk', 'm870', 'm24', 'awm'];
export const SECONDARY_LIST = ['p226', 'm1911'];

/** Compute final stats for a weapon + attachment selection. */
export function computeStats(id, loadout) {
  const base = WEAPONS[id];
  const s = structuredClone(base);
  s.id = id;
  s.att = {};
  let vMul = 1, hMul = 1, rangeMul = 1, adsAdd = 0, adsMul = 1, moveAdd = 0, reloadAdd = 0, reloadMul = 1, magMul = 1;
  let hipMul = 1, spreadMul = 1, kickMul = 1, recMul = 1, s2fMul = 1, driftMul = 1;
  s.zoomLevel = ATTACHMENTS.irons.zoom; s.reticle = null; s.scope = false; s.overlay = false;
  s.suppressed = !!base.integralSuppressor; s.flash = base.integralSuppressor ? 0.15 : 1; s.beam = false; s.glint = false;
  for (const slot of SLOTS) {
    let aid = loadout?.[slot];
    if (slot === 'optic' && base.fixedOptic && (!aid || !base.attachments.includes(aid))) aid = base.fixedOptic;
    if (!aid || !base.attachments.includes(aid)) continue;
    const a = ATTACHMENTS[aid];
    s.att[slot] = aid;
    if (a.vRecoil) vMul += a.vRecoil;
    if (a.hRecoil) hMul += a.hRecoil;
    if (a.range) rangeMul += a.range;
    if (a.ads) adsAdd += a.ads;
    if (a.adsMul) adsMul += a.adsMul;
    if (a.move) moveAdd += a.move;
    if (a.reload) reloadAdd += a.reload;
    if (a.reloadMul) reloadMul += a.reloadMul;
    if (a.magMul) magMul = a.magMul;
    if (a.hipSpread) hipMul += a.hipSpread;
    if (a.spread) spreadMul += a.spread;
    if (a.kick) kickMul += a.kick;
    if (a.recovery) recMul += a.recovery;
    if (a.drift) driftMul += a.drift;
    if (a.braced) s.braced = true;
    if (a.sprintToFire) s2fMul += a.sprintToFire;
    if (a.zoom) { s.zoomLevel = a.zoom; s.reticle = a.reticle || null; s.scope = !!a.scope; s.overlay = !!a.overlay; s.variable = a.variable; s.glint = !!a.glint; }
    if (a.suppressed) s.suppressed = true;
    if (a.flash !== undefined) s.flash = a.flash;
    if (a.beam) s.beam = true;
  }
  s.vRecoilMul = vMul; s.hRecoilMul = hMul; s.driftMul = driftMul;
  s.range = base.range.map((r) => r * rangeMul);
  s.ads = (base.ads + adsAdd) * adsMul;
  s.mobility = base.mobility + moveAdd;
  s.tacReload = ((base.tacReload ?? 0) + reloadAdd) * reloadMul;
  s.emptyReload = ((base.emptyReload ?? 0) + reloadAdd) * reloadMul;
  if (base.shellReload) s.shellReload = base.shellReload * reloadMul;
  s.mag = Math.round(base.mag * (base.tube ? 1 : magMul));
  s.reserve = Math.round(base.reserve * (base.tube ? 1 : magMul));
  s.hipSpread = base.hipSpread * hipMul;
  s.adsSpread = base.adsSpread * spreadMul;
  s.kick = base.kick * kickMul;
  s.recoveryMul = recMul;
  s.sprintToFire = base.sprintToFire * s2fMul;
  s.sound = { ...base.sound, suppressed: s.suppressed };
  return s;
}
