"""Per-weapon FP rig specs (grip markers + framing). Coordinates: canonical gun frame of the prepped gun
GLB (K-space: +Y muzzle, +Z up, GUN_K x real metres) for targets; real metres in the extracted template
frame for templates. Markers were read off the gridded orthographic renders (tools/blender/zoom.py).

  web   (y, z)  top of the backstrap where the web of the firing hand sits
  rake  deg     backstrap angle from vertical (bottom toward the stock = positive)
  trig  (y, z)  trigger blade
  sup   y       support-hand station along the handguard / pump (palm centre); 'pump' = Pump node centre
  tpl           grip template (see extract_templates.py)
  cls           framing class (docs/FP_FRAMING.md)
"""

TPL = {
    'rifle': dict(web=(-0.199, -0.045), rake=25.9, trig=(-0.137, -0.047)),
    'pistol': dict(web=(-0.002, 0.088), rake=16.7, trig=(0.068, 0.075)),
    'bolt': dict(web=(0.040, 0.075), rake=15.5, trig=(0.115, 0.035)),
    'shotgun': dict(web=(0.010, 0.066), rake=16.0, trig=(0.105, 0.045)),
}
# Left-hand template per grip template (bolt template holds a vertical foregrip: use the rifle cup instead).
LEFT_TPL = {'rifle': 'rifle', 'bolt': 'rifle', 'shotgun': 'shotgun', 'pistol': 'pistol'}

RIGS = {
    'm4a1': dict(vgrip=0.5, tpl='rifle', cls='rifle', web=(-0.213, -0.080), rake=26.6, trig=(-0.110, -0.090), sup=0.42),
    'ak47': dict(vgrip=0.92, tpl='rifle', cls='rifle', web=(0.172, -0.095), rake=16.0, trig=(0.315, -0.120), sup=0.80),
    'scarl': dict(vgrip=0.36, tpl='rifle', cls='rifle', web=(-0.262, -0.025), rake=30.0, trig=(-0.150, -0.050), sup=0.25),
    'mp5a5': dict(vgrip=0.5, tpl='rifle', cls='smg', web=(-0.110, 0.020), rake=34.0, trig=(0.000, -0.020), sup=0.43),
    'vss': dict(vgrip=0.2, tpl='rifle', cls='rifle', web=(-0.350, -0.040), rake=8.0, trig=(-0.205, -0.060), sup=0.15),
    'm24': dict(tpl='bolt', cls='sniper', web=(-0.585, 0.005), rake=36.0, trig=(-0.470, -0.070), sup=0.10),
    'awm': dict(tpl='rifle', cls='sniper', web=(-0.575, -0.050), rake=11.0, trig=(-0.430, -0.110), sup=0.15),
    'shotgun': dict(tpl='shotgun', cls='shotgun', web=(-0.505, 0.052), rake=16.0, trig=(-0.335, -0.030), sup='pump'),
    'p226': dict(tpl='pistol', cls='pistol', web=(-0.160, 0.060), rake=12.0, trig=(-0.005, 0.020)),
    'm1911': dict(tpl='pistol', cls='pistol', web=(-0.165, 0.045), rake=20.0, trig=(-0.035, 0.035)),
}

# Hip framing per class, REAL metres in view-camera space (x right, y forward, z up), applied to the
# "bore point above the web marker" of each gun; rot = (pitch, yaw, roll) degrees
# (pitch + = muzzle up, yaw + = muzzle toward screen centre, roll + = top of the gun cants left).
FRAMING = {
    # Solved from the reference screenshots (docs/FP_FRAMING.md): rifle rear sight ~(64%, 60%), front sight
    # ~(57-60%, 52%) of the screen at viewmodel vFOV 52 -> web of the grip ~0.20 m ahead of the eye.
    'rifle': dict(pos=(0.085, 0.200, -0.080), rot=(0.5, 0.5, 3.0)),
    'smg': dict(pos=(0.082, 0.195, -0.078), rot=(0.5, 0.5, 3.0)),
    'sniper': dict(pos=(0.090, 0.215, -0.088), rot=(0.5, 0.5, 2.0)),
    'shotgun': dict(pos=(0.085, 0.200, -0.082), rot=(0.5, 0.5, 3.0)),
    'pistol': dict(pos=(0.065, 0.260, -0.072), rot=(1.0, 2.0, 2.0)),
}
# Shoulders (UpArm heads) in view-camera space, REAL metres; elbow pole targets likewise.
SHOULDER = {'R': (0.19, -0.04, -0.21), 'L': (-0.17, 0.00, -0.21)}
POLE = {'R': (0.45, 0.05, -0.75), 'L': (-0.30, 0.25, -0.75)}
