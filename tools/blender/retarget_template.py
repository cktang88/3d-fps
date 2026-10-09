"""Effector-level retarget of the Free FPS Template rifle animations onto the game's FP rigs.

  python3 tools/blender/retarget_template.py <template_anims.json> <out fp_rifle_anims.json>

Input: samples written by extract_template_anims.py (camera, weapon, bones per frame).
Output (three.js conventions: camera space x right / y up / -z forward; gun space x right / y up / -z muzzle;
metres; quaternions [x, y, z, w]):
  clips.<name>.gun   [p(3), q(4)] per frame: camera-space DELTA from the template base pose (Idle_Pose for hip
                     clips, Aim_Pose for *_Aimed) -> applied on top of the game's hip / ADS pose.
  clips.Reload.handL [dg(3), dw(3), w, dq(4)] per frame: support-hand path in gun space, as offsets from the
                     template's handguard grip (dg) and magazine well (dw), blend weight w (0 = grip, 1 = well)
                     and gun-space rotation delta dq from the idle hand -> re-anchored onto each gun's GripL /
                     magazine well and solved by the arm IK.
  clips.Reload.mag   [dp(3), dq(4)] per frame: magazine delta about its own pivot (gun space).
  clips.<Fire>.bolt  [dz] per frame: bolt carrier travel (m, + = rearward).
Retargeting effectors (not bone rotations) keeps every arm/gun pair intact: the game re-solves the arm with IK
for whatever gun is in the hands.
"""
import json, math, sys
import numpy as np

D = json.load(open(sys.argv[1]))
OUT = sys.argv[2]
FPS = D['fps']


def M(a):
    m = np.array(a, dtype=float).reshape(4, 4).copy()
    for i in range(3):
        m[:3, i] /= np.linalg.norm(m[:3, i])
    return m


F = np.diag([-1., -1., 1., 1.])             # template weapon local -> canonical gun (x right, y fwd, z up)
C2 = np.array([[1, 0, 0, 0], [0, 0, -1, 0], [0, 1, 0, 0], [0, 0, 0, 1.]])  # blender camera -> canonical cam
P = np.array([[1, 0, 0], [0, 0, 1], [0, -1, 0.]])  # canonical (x, y fwd, z up) -> three (x, y up, -z fwd)
P4 = np.eye(4); P4[:3, :3] = P


def gun_cam(fr):
    return C2 @ np.linalg.inv(M(fr['cam'])) @ M(fr['gun']) @ F


def in_gun(fr, m):
    return np.linalg.inv(M(fr['gun']) @ F) @ m


def to3(m):
    return P4 @ m @ P4.T


def quat(R):
    t = np.trace(R)
    if t > 0:
        s = math.sqrt(t + 1) * 2; w = 0.25 * s; x = (R[2, 1] - R[1, 2]) / s; y = (R[0, 2] - R[2, 0]) / s; z = (R[1, 0] - R[0, 1]) / s
    else:
        i = int(np.argmax(np.diag(R)))
        if i == 0:
            s = math.sqrt(1 + R[0, 0] - R[1, 1] - R[2, 2]) * 2; w = (R[2, 1] - R[1, 2]) / s; x = 0.25 * s; y = (R[0, 1] + R[1, 0]) / s; z = (R[0, 2] + R[2, 0]) / s
        elif i == 1:
            s = math.sqrt(1 + R[1, 1] - R[0, 0] - R[2, 2]) * 2; w = (R[0, 2] - R[2, 0]) / s; x = (R[0, 1] + R[1, 0]) / s; y = 0.25 * s; z = (R[1, 2] + R[2, 1]) / s
        else:
            s = math.sqrt(1 + R[2, 2] - R[0, 0] - R[1, 1]) * 2; w = (R[1, 0] - R[0, 1]) / s; x = (R[0, 2] + R[2, 0]) / s; y = (R[1, 2] + R[2, 1]) / s; z = 0.25 * s
    q = np.array([x, y, z, w]); q /= np.linalg.norm(q)
    return q


def r(v, n=5):
    return [round(float(x), n) for x in v]


A = D['actions']
base = {'hip': to3(gun_cam(A['A_FP_AssaultRifle_Idle_Pose']['frames'][0])),
        'ads': to3(gun_cam(A['A_FP_AssaultRifle_Aim_Pose']['frames'][0]))}
CLIPS = {
    'Idle': ('A_FP_AssaultRifle_Idle_Loop', 'hip', True), 'IdleAimed': ('A_FP_AssaultRifle_Idle_Loop_Aimed', 'ads', True),
    'Walk': ('A_FP_AssaultRifle_Walk_F_Loop', 'hip', True), 'WalkAimed': ('A_FP_AssaultRifle_Walk_F_Loop_Aimed', 'ads', True),
    'Run': ('A_FP_AssaultRifle_Run_Loop', 'hip', True), 'Fire': ('A_FP_AssaultRifle_Fire', 'hip', False),
    'FireAimed': ('A_FP_AssaultRifle_Fire_Aimed', 'ads', False), 'Reload': ('A_FP_AssaultRifle_Reload', 'hip', False),
    'Equip': ('A_FP_AssaultRifle_Equip', 'hip', False), 'Holster': ('A_FP_AssaultRifle_Holster', 'hip', False),
}
out = {'source': 'Free FPS Template (Fab) rifle animations, effector-retargeted (tools/blender/retarget_template.py)',
       'fps': FPS, 'clips': {}, 'metrics': {}}
idle0 = A['A_FP_AssaultRifle_Idle_Pose']['frames'][0]
hand_idle = to3(in_gun(idle0, M(idle0['b']['hand_l'])))
for name, (act, b, loop) in CLIPS.items():
    frs = A[act]['frames']
    Binv = np.linalg.inv(base[b])
    gun = []
    for f in frs:
        Dm = to3(gun_cam(f)) @ Binv
        gun.append(r([*Dm[:3, 3], *quat(Dm[:3, :3])]))
    clip = {'n': len(frs), 'dur': round(len(frs) / FPS, 4), 'loop': loop, 'base': b, 'gun': gun}
    if 'w' in frs[0] and act.endswith(('Reload', 'Fire')):
        bolt0 = to3(in_gun(frs[0], M(frs[0]['w']['Bolt'])))[:3, 3]
        clip['bolt'] = [round(float(to3(in_gun(f, M(f['w']['Bolt'])))[2, 3] - bolt0[2]), 5) for f in frs]
    if name == 'Reload':
        mag_home = to3(in_gun(frs[0], M(frs[0]['w']['Magazine'])))
        grab = None
        hand, mag = [], []
        Hs = [to3(in_gun(f, M(f['b']['hand_l']))) for f in frs]
        Ms = [to3(in_gun(f, M(f['w']['Magazine']))) for f in frs]
        # grab frame: first frame the magazine leaves its seat
        gi = next(i for i, m in enumerate(Ms) if np.linalg.norm(m[:3, 3] - mag_home[:3, 3]) > 0.003)
        reach = np.linalg.norm(Hs[gi][:3, 3] - hand_idle[:3, 3])
        for H, Mg in zip(Hs, Ms):
            p = H[:3, 3]
            w = min(1.0, np.linalg.norm(p - hand_idle[:3, 3]) / reach)
            w = w * w * (3 - 2 * w)
            dq = quat(H[:3, :3] @ hand_idle[:3, :3].T)
            hand.append(r([*(p - hand_idle[:3, 3]), *(p - mag_home[:3, 3]), w, *dq]))
            mag.append(r([*(Mg[:3, 3] - mag_home[:3, 3]), *quat(Mg[:3, :3] @ mag_home[:3, :3].T)]))
        seat = next(i for i in range(gi + 5, len(Ms)) if np.linalg.norm(Ms[i][:3, 3] - mag_home[:3, 3]) < 0.002)
        back = next((i for i in range(seat, len(Hs)) if np.linalg.norm(Hs[i][:3, 3] - hand_idle[:3, 3]) < 0.004), len(Hs) - 1)
        clip.update(handL=hand, mag=mag, events={'grab': round(gi / len(frs), 3), 'seat': round(seat / len(frs), 3), 'handBack': round(back / len(frs), 3)})
        out['metrics']['reload'] = {'grabFrame': gi, 'seatFrame': seat, 'handBackFrame': back,
                                    'magFarthestCm': round(max(np.linalg.norm(m[:3, 3] - mag_home[:3, 3]) for m in Ms) * 100, 1)}
    # metrics: max displacement / rotation, time of peak
    ds = [np.linalg.norm(g[:3]) for g in gun]; angs = [2 * math.degrees(math.acos(min(1, abs(g[6])))) for g in gun]
    out['metrics'][name] = {'dur_s': clip['dur'], 'maxDispCm': round(max(ds) * 100, 2), 'maxRotDeg': round(max(angs), 1),
                            'peakFrame': int(np.argmax(angs if max(angs) > 2 else ds))}
    out['clips'][name] = clip
# ---- Reload reshaping (art direction): the template tips the muzzle ~25 deg UP with up to 53 deg roll, which in
# our camera brings the support forearm across the screen centre. Keep its timing / envelope, but rebuild the gun
# pose about the grip: rifle comes DOWN and slightly inboard, muzzle low and forward, cant <= 27 deg (magwell turned
# toward the eyes), support hand path unchanged (gun space).
def euler_yxz(R):
    pitch = math.asin(-max(-1, min(1, R[1, 2]))); yaw = math.atan2(R[0, 2], R[2, 2]); roll = math.atan2(R[1, 0], R[1, 1])
    return pitch, yaw, roll
def rot_yxz(pitch, yaw, roll):
    cy, sy, cx, sx, cz, sz = math.cos(yaw), math.sin(yaw), math.cos(pitch), math.sin(pitch), math.cos(roll), math.sin(roll)
    Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]]); Rx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]]); Rz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
    return Ry @ Rx @ Rz
def qmat(q):
    x, y, z, w = q
    return np.array([[1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)], [2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)], [2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)]])
RESHAPE = dict(off=(-0.025, -0.055, -0.02), pitch=math.radians(-6), roll_k=0.5, roll_max=math.radians(27), yaw_k=0.5)
g0 = base['hip'][:3, 3]
rl = out['clips']['Reload']
angs = [2 * math.acos(min(1, abs(f[6]))) for f in rl['gun']]
amax = max(angs)
new = []
for f, a in zip(rl['gun'], angs):
    env = a / amax
    env = env * env * (3 - 2 * env)
    pitch, yaw, roll = euler_yxz(qmat(f[3:]))
    Rn = rot_yxz(RESHAPE['pitch'] * env, yaw * RESHAPE['yaw_k'], max(-RESHAPE['roll_max'], min(RESHAPE['roll_max'], roll * RESHAPE['roll_k'])))
    gn = g0 + np.array(RESHAPE['off']) * env
    t = gn - Rn @ g0                     # D = T(gn) R T(-g0)
    new.append(r([*t, *quat(Rn)]))
rl['gun'] = new
rl['reshaped'] = {k: (round(math.degrees(v), 1) if 'pitch' in k or 'max' in k else v) for k, v in RESHAPE.items()}
out['metrics']['Reload_reshaped'] = RESHAPE | {'pitch': -6, 'roll_max': 27}
# Base poses (for docs): template gun grip in camera space.
for b in ('hip', 'ads'):
    m = base[b]
    out['metrics']['base_' + b] = {'gripCam_m': r(m[:3, 3], 4), 'q': r(quat(m[:3, :3]), 4)}
json.dump(out, open(OUT, 'w'), separators=(',', ':'))
print(json.dumps(out['metrics'], indent=1))
