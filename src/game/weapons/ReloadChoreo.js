/**
 * Hand-authored reload choreography for the first-person rigs (docs/FP_FRAMING.md, "Reload").
 *
 * Rifles keep the Free FPS Template's support-hand and magazine tracks (FPAnims, timing: grab 0.084, pouch 0.25,
 * seat 0.6, hand back 0.79) but get their own gun pose: the rifle tilts in and rises a little so the magazine well
 * is on screen (x 50-65 %, y 60-85 %), jolts when the old magazine is stripped, dips and slaps up when the new one
 * seats and, on an empty reload, presents the bolt release (M4 / SCAR) or the charging handle (AK / MP5 / VSS).
 * Pistols are fully procedural (magazine drops free, support hand fetches a new one, palm slap, slide release).
 *
 * Gun keys: [u, x, y, z (cm, camera space, pivot = firing grip), pitch, yaw, roll (deg; + = muzzle up, muzzle
 * left, top left)]. Segments ease in-out, so a repeated value is a hold and a short segment is a snap.
 */

// Tactical rifle reload (template timeline unchanged).
export const RIFLE_TAC = [
  [0.00, 0, 0, 0, 0, 0, 0],
  [0.10, -3.0, 3.0, -1.0, 7, 8, -28], // tilt in: magazine well rolled toward the eye and lifted into frame
  [0.15, -3.0, 2.0, -1.0, 5, 8, -33], // old magazine stripped: the gun is tugged down
  [0.24, -3.3, 3.2, -1.0, 8, 9, -30],
  [0.50, -3.5, 3.5, -1.0, 9, 9, -31],
  [0.565, -3.5, 2.5, -1.0, 7, 9, -33], // new magazine pushed up into the well
  [0.60, -3.5, 4.4, -1.0, 10.5, 9, -28], // seat: slap jolts the gun up
  [0.68, -3.2, 3.3, -0.8, 8, 8, -27],
  [0.82, -0.3, 0.3, 0, 1, 1, -3],
  [0.92, 0, 0, 0, 0, 0, 0],
];

/** Empty rifle reload: template part compressed into [0, SEAT_E], then the bolt action. */
export const SEAT_E = 0.56; // u where the template's seated frame (tpl 0.62) is reached
export const TPL_SEAT = 0.62;
const head = RIFLE_TAC.filter((k) => k[0] <= 0.6).map((k) => [k[0] * (SEAT_E / TPL_SEAT), ...k.slice(1)]);

export function rifleEmptyKeys(action, rackRoll = 12) {
  if (action === 'rack') {
    const r = rackRoll;
    return [...head,
      [0.62, -3.0, 3.2, -1.0, 8, 7, (r - 30) / 2],
      [0.66, -2.8, 3.0, -1.0, 7, 6, r],
      [0.71, -2.5, 2.7, 0.2, 6, 6, r], // handle run back: the rifle is tugged toward the shoulder
      [0.735, -2.7, 4.0, -1.0, 9, 6, r * 0.9], // released: bolt slams home
      [0.79, -2.4, 2.8, -0.8, 7, 5, r * 0.6],
      [0.90, -0.3, 0.3, 0, 1, 1, -1],
      [0.97, 0, 0, 0, 0, 0, 0],
    ];
  }
  return [...head, // bolt release
    [0.61, -3.2, 3.3, -1.0, 8, 10, -34],
    [0.655, -3.2, 2.7, -1.0, 7, 11, -36],
    [0.675, -3.2, 4.2, -1.0, 10, 10, -31], // palm hits the release: bolt slams home
    [0.74, -2.8, 3.0, -0.8, 7, 7, -25],
    [0.86, -0.3, 0.3, 0, 1, 1, -3],
    [0.95, 0, 0, 0, 0, 0, 0],
  ];
}

/** Empty-reload hand / bolt phases (u). */
export const BOLT_PHASE = {
  rack: { reach: [SEAT_E, 0.655], pull: [0.66, 0.71], snap: [0.712, 0.728], back: [0.745, 0.9] },
  release: { reach: [SEAT_E, 0.64], pull: [0.645, 0.668], snap: [0.664, 0.678], back: [0.70, 0.88] },
};

// Pistol gun keys (same layout).
export const PISTOL_TAC = [
  [0.00, 0, 0, 0, 0, 0, 0],
  [0.09, -3.0, 2.8, 0, 4, 10, -42], // tilt in: butt swung toward the support hand, magazine well in frame
  [0.13, -3.0, 3.3, 0, 6, 10, -46], // thumb on the release, magazine drops
  [0.40, -3.2, 3.2, 0, 5, 11, -47],
  [0.52, -3.2, 2.6, 0, 4, 11, -48], // new magazine pushed in
  [0.575, -3.2, 4.2, 0, 8, 11, -42], // palm slap
  [0.66, -2.8, 3.0, 0, 5, 9, -36],
  [0.82, -0.2, 0.2, 0, 0.5, 0.5, -2],
  [0.90, 0, 0, 0, 0, 0, 0],
];
export const PISTOL_EMPTY = [
  ...PISTOL_TAC.slice(0, 7),
  [0.705, -2.2, 2.4, 0.2, 4, 7, -26],
  [0.73, -2.0, 3.4, 0.6, 9, 6, -22], // slide release: slide slams forward
  [0.80, -1.0, 1.2, 0.2, 3, 3, -10],
  [0.92, 0, 0, 0, 0, 0, 0],
];
/** Pistol phases: magazine out / gone / new one in hand / seated; hand path keys (offsets, see ViewModel). */
export const PISTOL_PHASE = { drop: [0.11, 0.3], fetch: [0.14, 0.33], bring: [0.33, 0.47], insert: [0.47, 0.565], slap: [0.565, 0.6], home: [0.6, 0.76], slide: [0.712, 0.73] };

const ease = (t) => t * t * (3 - 2 * t);

/** Sample eased keys at u into out[0..5]. */
export function sampleKeys(keys, u, out = new Array(6)) {
  if (u <= keys[0][0]) { for (let j = 0; j < 6; j++) out[j] = keys[0][j + 1]; return out; }
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (u <= b[0]) {
      const t = ease((u - a[0]) / Math.max(1e-6, b[0] - a[0]));
      for (let j = 0; j < 6; j++) out[j] = a[j + 1] + (b[j + 1] - a[j + 1]) * t;
      return out;
    }
  }
  const z = keys[keys.length - 1]; for (let j = 0; j < 6; j++) out[j] = z[j + 1];
  return out;
}

/** 0..1 ramp of u over [a, b], eased. */
export function phase(u, ab) { return ease(Math.min(1, Math.max(0, (u - ab[0]) / (ab[1] - ab[0])))); }

/**
 * Weapon inspect (I): swing in and turn the left side to the eye, then roll over to show the right side (ejection
 * port / markings), and settle back. Same key layout as the reload keys.
 */
export const INSPECT_RIFLE = [
  [0.00, 0, 0, 0, 0, 0, 0],
  [0.16, -5.5, 4.5, 2.5, 9, -38, 20],
  [0.24, -5.8, 4.2, 2.5, 8, -42, 17], // settle into the hold (weight)
  [0.44, -6.2, 4.8, 2.8, 10, -46, 16],
  [0.60, -4.0, 4.0, 2.0, 14, 22, -62], // roll over
  [0.66, -4.2, 3.7, 2.0, 13, 25, -66],
  [0.84, -4.6, 4.3, 2.2, 15, 28, -70],
  [1.00, 0, 0, 0, 0, 0, 0],
];
export const INSPECT_PISTOL = [
  [0.00, 0, 0, 0, 0, 0, 0],
  [0.16, -4, 3.5, 2, 12, -40, 25],
  [0.24, -4.2, 3.2, 2, 11, -44, 22],
  [0.44, -4.5, 3.8, 2.2, 13, -48, 20],
  [0.60, -3.0, 3.2, 1.8, 16, 25, -65],
  [0.66, -3.2, 2.9, 1.8, 15, 28, -70],
  [0.84, -3.5, 3.4, 2, 17, 30, -72],
  [1.00, 0, 0, 0, 0, 0, 0],
];
