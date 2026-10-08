"""Author one first-person rig: gun + DJMaesen/ccransh gloved arms posed onto that gun.

  blender -b --python tools/blender/build_rig.py -- <id> <sketchfab_dir> <work_dir> [export.glb|-] [--fast]

Pipeline (all in the gun's canonical K-space frame, +Y muzzle, +Z up):
 1. import the prepped gun (prep_guns.py) and the base rigged arms (ccransh AK-74M pack), scale the arms so
    the hand matches the reference hand size;
 2. transfer the right/left hand + finger pose from the grip template via grip markers (rigs.py);
 3. place the gun at its class hip pose in view-camera space; shoulders/elbow poles are camera-relative,
    UpArm->Forearm->twist chain solved with IK, forearm twist distributed over the twist bones;
 4. contact solver: push palms out of the gun, open fingers that penetrate, curl wrap fingers to contact;
 5. intersection report (max penetration per region, mm real) + FP-camera / side / close-up renders;
 6. bake the pose as the rest pose and export one GLB (gun nodes + skinned arms + contract markers).
"""
import sys, os, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fp_lib import *
from rigs import TPL, LEFT_TPL, RIGS, FRAMING, SHOULDER, POLE
from guns import GUNS

K = GUN_K
A = args()
GID, SFDIR, WORK = A[0], A[1], A[2]
OUT = A[3] if len(A) > 3 else '-'
FAST = '--fast' in A
SELFTEST = GID.startswith('tpl_')
if SELFTEST:  # rig a template's own gun with identity markers: measures inherent template penetration
    _t = GID[4:]
    SPEC = dict(tpl=_t, cls='rifle' if _t != 'pistol' else 'pistol', web=tuple(x * GUN_K for x in TPL[_t]['web']), rake=TPL[_t]['rake'],
                trig=tuple(x * GUN_K for x in TPL[_t]['trig']))
    if _t != 'pistol':
        _B = {n: Matrix(m) for n, m in load_json(os.path.join(A[2], 'templates.json'))[LEFT_TPL[_t]]['bones'].items()}
        _h = _B['Hand_L'].translation; _kn = [_B[f'Bone_L.{i}'].translation for i in ('005', '009', '013', '017')]
        SPEC['sup'] = ((_h + sum(_kn, Vector()) / 4) / 2).y * GUN_K
else:
    SPEC = RIGS[GID]
TPLS = load_json(os.path.join(WORK, 'templates.json'))
HIDDEN = re.compile(r'Spare|Suppressor|Foregrip|OpticMount|OpticRail|Glass')
SIDES = 'RL'
FINGERS = [('004', '005', '006', '007'), ('008', '009', '010', '011'), ('012', '013', '014', '015'),
           ('016', '017', '018', '019'), ('020', '021', '022')]
REPORT = {'id': GID}
t0 = time.time()


def log(*a):
    print('[rig]', GID, f'{time.time() - t0:6.1f}s', *a, flush=True)


# ------------------------------------------------------------------ 1. gun
reset()
if SELFTEST:
    gobjs = import_glb(os.path.join(WORK, f'tpl_{GID[4:]}_gun.glb'))
    gun_root = bpy.data.objects.new('Gun_' + GID, None); bpy.context.scene.collection.objects.link(gun_root)
    for o in gobjs:
        if o.parent is None: o.parent = gun_root
    gun_root.scale = (K, K, K)
    gobjs.append(gun_root)
    bpy.context.view_layer.update()
else:
    gobjs = import_glb(os.path.join(WORK, f'gun_{GID}.glb'))
    gun_root = [o for o in gobjs if o.name.startswith('Gun_')][0]


def hidden_obj(o):
    p = o
    while p:
        if HIDDEN.search(p.name):
            return True
        p = p.parent
    return False


for o in gobjs:
    if o.type == 'MESH' and hidden_obj(o):
        o.hide_render = True
coll = [o for o in gobjs if o.type == 'MESH' and not o.hide_render]
bpy.context.view_layer.update()
gun_bvh, gun_bm = bvh_of(coll)
gun_pts = evaluated_verts(coll)


def slab(pts, y, half, xc=None, xw=None):
    return [p for p in pts if abs(p.y - y) < half and (xc is None or abs(p.x - xc) < xw)]


def underside(pts, y, half, xw):
    s = slab(pts, y, half)
    xs = [p.x for p in s]
    xc = (min(xs) + max(xs)) / 2 if xs else 0.0
    s2 = [p for p in s if abs(p.x - xc) < xw]
    return xc, (min(p.z for p in s2) if s2 else 0.0)


bore_front = max(p.y for p in gun_pts)
fr = [p for p in gun_pts if p.y > bore_front - 0.02 * K]
BORE_Z = (min(p.z for p in fr) + max(p.z for p in fr)) / 2
log('bore z', round(BORE_Z, 4), 'front', round(bore_front, 3))

# ------------------------------------------------------------------ 2. base arms
before = set(bpy.data.objects)
bpy.ops.import_scene.gltf(filepath=os.path.join(SFDIR, 'cc_ak74/model.glb'), guess_original_bind_pose=False, bone_heuristic='TEMPERANCE')
new = [o for o in bpy.data.objects if o not in before]
arm = [o for o in new if o.type == 'ARMATURE'][0]
arm.animation_data_clear()  # the importer assigns a clip; it would override the authored pose at render/export
for act in list(bpy.data.actions):
    bpy.data.actions.remove(act)
arms_mesh = [o for o in new if o.type == 'MESH' and any(m and m.name == 'arms' for m in o.data.materials)][0]
for o in new:
    if o not in (arm, arms_mesh):
        bpy.data.objects.remove(o, do_unlink=True)
bpy.context.view_layer.update()
# Flatten transforms: unparent (keep world), apply.
for o in (arms_mesh, arm):
    mw = o.matrix_world.copy(); o.parent = None; o.matrix_world = mw
bpy.context.view_layer.objects.active = arm
for o in bpy.data.objects: o.select_set(o in (arm, arms_mesh))
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
arms_mesh.parent = arm
mod = [m for m in arms_mesh.modifiers if m.type == 'ARMATURE'][0]
mod.object = arm
arm.data.pose_position = 'REST'
bpy.context.view_layer.update()

# Clean bones + rename to canonical names.
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode='EDIT')
eb = arm.data.edit_bones
for b in list(eb):
    if re.match(r'(PBody|Rif|Trigger|Safety|Pmag|Head_Cam|IK_PoleTrgt)', canon(b.name)):
        eb.remove(b)
for b in eb:
    if canon(b.name).startswith('UpArm'):
        b.use_connect = False
bpy.ops.object.mode_set(mode='OBJECT')
for b in arm.data.bones:
    n = canon(b.name)
    vg = arms_mesh.vertex_groups.get(b.name)
    if vg: vg.name = n
    b.name = n
arm.name = 'FPRig'; arm.data.name = 'FPRig'; arms_mesh.name = 'FPArms'; arms_mesh.data.name = 'FPArms'


def chain_len_rest(side):
    bs = arm.data.bones
    return sum(bs[f'Bone_{side}.{i}'].length for i in ('004', '005', '006', '007'))


def chain_len_tpl(B, side):
    h = [B[f'Bone_{side}.{i}'].translation for i in ('004', '005', '006', '007', '007_end')]
    return sum((h[i + 1] - h[i]).length for i in range(4))


TB = {k: {n: Matrix(m) for n, m in v['bones'].items()} for k, v in TPLS.items()}
L_REF = chain_len_tpl(TB['rifle'], 'R')
sc = K * L_REF / chain_len_rest('R')
for o in (arm, arms_mesh):
    o.select_set(True)
arms_mesh.parent = None
arm.scale = (sc, sc, sc); arms_mesh.scale = (sc, sc, sc)
bpy.context.view_layer.update()
bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
arms_mesh.parent = arm
mod.object = arm
log('arms scale', round(sc, 4), 'hand chain', round(L_REF, 4))

# Dominant bone per vertex (for region reports and per-finger solving).
gname = {g.index: g.name for g in arms_mesh.vertex_groups}
DOM = []
for v in arms_mesh.data.vertices:
    best = max(v.groups, key=lambda g: g.weight, default=None)
    DOM.append(gname.get(best.group) if best else None)


if os.environ.get('FP_DEBUG'):
    from collections import Counter
    cnt = Counter(DOM)
    log('DOM groups', sorted(cnt.items(), key=lambda x: -x[1])[:60])
    for side in SIDES:
        idx = [i for i, n in enumerate(DOM) if n == f'Hand_{side}']
        co = [arms_mesh.data.vertices[i].co for i in idx]
        if co: log('rest hand verts', side, [round(sum(c[k] for c in co) / len(co), 3) for k in range(3)], 'bone head', [round(x, 3) for x in arm.data.bones[f'Hand_{side}'].head_local])


def verts_of(names):
    s = set(names)
    return [i for i, n in enumerate(DOM) if n in s]


# ------------------------------------------------------------------ 3. template transfer
def tpl_scan(tkey):
    """Template gun points (template units) for grip-centre / underside scans."""
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(WORK, f'tpl_{tkey}_gun.glb'))
    new = [o for o in bpy.data.objects if o not in before]
    bpy.context.view_layer.update()
    pts = evaluated_verts([o for o in new if o.type == 'MESH'])
    for o in new:
        bpy.data.objects.remove(o, do_unlink=True)
    return pts


def grip_x(pts, y, z, half):
    s = [p for p in pts if abs(p.y - y) < half and z - 4 * half < p.z < z]
    xs = [p.x for p in s]
    return (min(xs) + max(xs)) / 2 if xs else 0.0


def palm_centre(B, side):
    h = B[f'Hand_{side}'].translation
    kn = [B[f'Bone_{side}.{i}'].translation for i in ('005', '009', '013', '017')]
    return (h + sum(kn, Vector()) / 4) / 2


tkey = SPEC['tpl']
lkey = LEFT_TPL[tkey]
TR, TL = TB[tkey], TB[lkey]
f_r = L_REF / chain_len_tpl(TR, 'R')
f_l = L_REF / chain_len_tpl(TL, 'L')
tpts_r = tpl_scan(tkey)
tw = TPL[tkey]
O_tpl = Vector((grip_x(tpts_r, tw['web'][0], tw['web'][1], 0.01), tw['web'][0], tw['web'][1]))
O_tgt = Vector((grip_x(gun_pts, SPEC['web'][0], SPEC['web'][1], 0.02), SPEC['web'][0], SPEC['web'][1]))
R_rake = Matrix.Rotation(math.radians(tw['rake'] - SPEC['rake']), 4, 'X')
M_R = Matrix.Translation(O_tgt) @ R_rake @ Matrix.Scale(K * f_r, 4) @ Matrix.Translation(-O_tpl)

if tkey == 'pistol':
    M_L = M_R
    f_l = f_r
else:
    tpts_l = tpts_r if lkey == tkey else tpl_scan(lkey)
    pc = palm_centre(TL, 'L')
    xc_t, uz_t = underside(tpts_l, pc.y, 0.012, 0.03)
    S_tpl = Vector((xc_t, pc.y, uz_t))
    if SPEC.get('sup') == 'pump':
        pump = bpy.data.objects.get('Pump')
        pp = evaluated_verts([c for c in pump.children_recursive if c.type == 'MESH'])
        sy = (min(p.y for p in pp) + max(p.y for p in pp)) / 2 + 0.02 * K
    else:
        sy = SPEC['sup']
    xc_g, uz_g = underside(gun_pts, sy, 0.02, 0.06)
    S_tgt = Vector((xc_g, sy, uz_g))
    M_L = Matrix.Translation(S_tgt) @ Matrix.Scale(K * f_l, 4) @ Matrix.Translation(-S_tpl)
    log('support', [round(x, 3) for x in S_tgt], 'tpl', [round(x, 3) for x in S_tpl])


def mapped(Mx, B, name):
    loc, rot, _ = B[name].decompose()
    out = Mx @ Matrix.Translation(loc)
    rl = (Mx.to_3x3().normalized() @ rot.to_matrix()).to_4x4()
    rl.translation = out.translation
    return rl


pb = arm.pose.bones
arm.data.pose_position = 'POSE'
for p in pb:
    p.matrix_basis = Matrix()
bpy.context.view_layer.update()


def hand_bones(side):
    names = [f'IK_Hand_Cntrl_{side}', f'Hand_{side}']
    for ch in FINGERS:
        names += [f'Bone_{side}.{i}' for i in ch]
    return names


def set_hand(side, Mx, B):
    for n in hand_bones(side):
        if n in B and n in pb:
            pb[n].matrix = mapped(Mx, B, n)
            bpy.context.view_layer.update()


set_hand('R', M_R, TR)
set_hand('L', M_L, TL)
for side in SIDES:
    idx = verts_of([f'Hand_{side}', f'Bone_{side}.008', f'Bone_{side}.012'])
    bpy.context.view_layer.update()
    e = arms_mesh.evaluated_get(bpy.context.evaluated_depsgraph_get()); me_ = e.to_mesh()
    cen = sum((arms_mesh.matrix_world @ me_.vertices[i].co for i in idx), Vector()) / len(idx)
    e.to_mesh_clear()
    log('hand mesh centroid', side, [round(x, 3) for x in cen], 'bone', [round(x, 3) for x in pb[f'Hand_{side}'].matrix.translation], 'dist', round((cen - pb[f'Hand_{side}'].matrix.translation).length, 3))
for side, Mx, B in (('R', M_R, TR), ('L', M_L, TL)):
    want = (Mx @ B[f'Hand_{side}']).translation
    got = (arm.matrix_world @ pb[f'Hand_{side}'].matrix).translation
    log('hand check', side, 'want', [round(x, 3) for x in want], 'got', [round(x, 3) for x in got], 'arm mw', arm.matrix_world.to_translation(), arm.matrix_world.to_scale())

# ------------------------------------------------------------------ 4. framing + IK
FR = dict(FRAMING[SPEC['cls']])
if os.environ.get('FP_FRAME'):
    v = [float(x) for x in os.environ['FP_FRAME'].split(',')]
    FR = dict(pos=tuple(v[:3]), rot=tuple(v[3:6]))
B_ref = Vector((0, SPEC['web'][0], BORE_Z))
p, y_, r = [math.radians(v) for v in FR['rot']]
ROT = Matrix.Rotation(y_, 4, 'Z') @ Matrix.Rotation(p, 4, 'X') @ Matrix.Rotation(-r, 4, 'Y')
G = Matrix.Translation(Vector(FR['pos']) * K) @ ROT @ Matrix.Translation(-B_ref)  # gun -> camera
Ginv = G.inverted()
CAM_W = Ginv @ FP_CAM  # camera object world matrix (the gun stays at identity)
for nm, pt in (('web', B_ref), ('muzzle', Vector((0, bore_front, BORE_Z)))):
    q = G @ pt
    log('cam-space', nm, [round(x / K, 3) for x in q], 'screen%', round(50 + 50 * q.x / q.y / (math.tan(math.radians(26)) * 16 / 9), 1), round(50 - 50 * q.z / q.y / math.tan(math.radians(26)), 1))
REPORT['hip'] = {'pos': list(FR['pos']), 'rot': list(FR['rot']), 'boreRef': [B_ref.x / K, B_ref.y / K, B_ref.z / K]}

poles = {}
for side in SIDES:
    sh = Ginv @ (Vector(SHOULDER[side]) * K)
    hand = pb[f'Hand_{side}'].matrix.translation
    up, fo = arm.data.bones[f'UpArm_{side}'], arm.data.bones[f'Forearm_{side}']
    reach = up.length + sum(arm.data.bones[f'BoneTwist_0{i}.{side}'].length for i in (3, 2, 1)) + 0.0
    reach = up.length + (arm.data.bones[f'BoneTwist_01.{side}'].tail_local - fo.head_local).length
    d = sh - hand
    if d.length > 0.96 * reach:
        sh = hand + d.normalized() * 0.96 * reach
        log('shoulder pulled in', side, 'reach', round(reach / K, 3))
    m = pb[f'UpArm_{side}'].matrix.copy(); m.translation = sh
    pb[f'UpArm_{side}'].matrix = m
    bpy.context.view_layer.update()
    e = bpy.data.objects.new(f'pole_{side}', None); bpy.context.scene.collection.objects.link(e)
    e.matrix_world = Matrix.Translation(Ginv @ (Vector(POLE[side]) * K))
    poles[side] = e


def solve_arm(side):
    tw1 = pb[f'BoneTwist_01.{side}']
    for n in (f'BoneTwist_03.{side}', f'BoneTwist_02.{side}', f'BoneTwist_01.{side}'):
        pb[n].lock_ik_x = pb[n].lock_ik_z = True
        pb[n].matrix_basis = Matrix()
    pb[f'Forearm_{side}'].matrix_basis = Matrix()
    rot0 = pb[f'UpArm_{side}'].matrix_basis.copy()
    best = None
    for ang in (0, 90, -90, 180):
        for c in list(tw1.constraints): tw1.constraints.remove(c)
        c = tw1.constraints.new('IK')
        c.target = arm; c.subtarget = f'Hand_{side}'; c.chain_count = 5; c.use_tail = True
        c.pole_target = poles[side]; c.pole_angle = math.radians(ang); c.iterations = 500
        bpy.context.view_layer.update()
        el = (arm.matrix_world @ pb[f'Forearm_{side}'].matrix).translation
        wr = (arm.matrix_world @ tw1.matrix @ Vector((0, tw1.length, 0)))
        err = (wr - pb[f'Hand_{side}'].matrix.translation).length
        score = (el - poles[side].matrix_world.translation).length + err * 10
        if best is None or score < best[0]:
            best = (score, ang, err)
    c.pole_angle = math.radians(best[1])
    bpy.context.view_layer.update()
    chain = [f'UpArm_{side}', f'Forearm_{side}', f'BoneTwist_03.{side}', f'BoneTwist_02.{side}', f'BoneTwist_01.{side}']
    mats = {n: pb[n].matrix.copy() for n in chain}
    tw1.constraints.remove(c)
    for n in chain:
        pb[n].matrix = mats[n]
        bpy.context.view_layer.update()
    # Distribute the hand's roll about the forearm over the twist bones (1/3 each, cumulative).
    hand = pb[f'Hand_{side}'].matrix.to_3x3()
    fa = pb[f'BoneTwist_01.{side}'].matrix.to_3x3()
    yax = fa.col[1].normalized()
    hx = hand.col[0] - yax * hand.col[0].dot(yax)
    fx = fa.col[0] - yax * fa.col[0].dot(yax)
    # Hand X vs forearm X in the rest pose, so only the posed deviation is distributed.
    rh = arm.data.bones[f'Hand_{side}'].matrix_local.to_3x3(); rf = arm.data.bones[f'BoneTwist_01.{side}'].matrix_local.to_3x3()
    ry = rf.col[1].normalized()
    rhx = rh.col[0] - ry * rh.col[0].dot(ry); rfx = rf.col[0] - ry * rf.col[0].dot(ry)
    rest_ang = math.atan2(rfx.cross(rhx).dot(ry), rfx.dot(rhx))
    ang = math.atan2(fx.cross(hx).dot(yax), fx.dot(hx)) - rest_ang
    ang = (ang + math.pi) % (2 * math.pi) - math.pi
    for n in (f'BoneTwist_03.{side}', f'BoneTwist_02.{side}', f'BoneTwist_01.{side}'):
        pb[n].matrix_basis = pb[n].matrix_basis @ Matrix.Rotation(ang / 3, 4, 'Y')
        bpy.context.view_layer.update()
    log('IK', side, 'pole', best[1], 'wrist err mm', round(best[2] / K * 1000, 1), 'twist deg', round(math.degrees(ang), 1))
    return best[2]


# ------------------------------------------------------------------ 5. contact solver
dg = bpy.context.evaluated_depsgraph_get()


def eval_co(idx):
    bpy.context.view_layer.update()
    e = arms_mesh.evaluated_get(dg)
    me = e.to_mesh()
    co = [arms_mesh.matrix_world @ me.vertices[i].co for i in idx]
    e.to_mesh_clear()
    return co


def depths(idx, maxd=0.03 * K):
    """Penetration depth (>0 inside) per vertex, plus distance to surface when outside (negative)."""
    return [inside_depth(gun_bvh, p, maxd) for p in eval_co(idx)]


TOL = 0.0006 * K       # 0.6 mm real
CONTACT = 0.0035 * K   # fingertips closer than 3.5 mm count as touching


def push_hand_out(side, iters=40, max_move=0.045, max_rot=35.0, snug=True):
    """Rigid 6-DOF least-squares fit of the hand (IK control) so the PALM (hand + metacarpals) leaves the gun:
    small rotation w and translation t with  n.(t + w x r) = depth  at every penetrating palm vertex.
    Then slide back along the mean surface normal until the palm just touches (snug grip)."""
    import numpy as np
    hb = verts_of([f'Hand_{side}'] + [f'Bone_{side}.{c[0]}' for c in FINGERS])
    ctrl = pb[f'IK_Hand_Cntrl_{side}']
    moved = Vector(); rot = 0.0
    for _ in range(iters):
        co = eval_co(hb)
        pen = []
        for p in co:
            d = inside_depth(gun_bvh, p, 0.03 * K)
            if d > 0.3 * TOL:
                pen.append((p, gun_bvh.find_nearest(p, 0.03 * K)[1], d + 0.3 * TOL))
        if not pen:
            break
        cen = sum(co, Vector()) / len(co)
        A = np.array([[n.x, n.y, n.z, *(p - cen).cross(n)] for p, n, d in pen]); bb = np.array([d for _, _, d in pen])
        x = np.linalg.solve(A.T @ A + np.diag([1e-6] * 3 + [0.01 * K * K] * 3), A.T @ bb)
        t = Vector(x[:3]); w = Vector(x[3:])
        if t.length > 0.003 * K: t = t.normalized() * 0.003 * K
        ang = min(w.length, math.radians(3))
        if (moved + t).length > max_move * K or rot + math.degrees(ang) > max_rot:
            break
        R = Matrix.Rotation(ang, 4, w.normalized()) if ang > 1e-6 else Matrix()
        ctrl.matrix = Matrix.Translation(cen + t) @ R @ Matrix.Translation(-cen) @ ctrl.matrix
        moved += t; rot += math.degrees(ang)
    back = 0.0
    if snug:
        # Direction toward the gun = minus the mean normal at the nearest surface points of the palm.
        co = eval_co(hb)
        nsum = Vector(); dmin = 1e9
        for p in co:
            h = gun_bvh.find_nearest(p, 0.04 * K)
            if h[0] is not None:
                nsum += h[1] / max(h[3], 1e-4); dmin = min(dmin, h[3])
        if nsum.length > 0 and dmin < 0.04 * K:
            dirn = -nsum.normalized()
            step = 0.0005 * K
            for _ in range(60):
                m0 = ctrl.matrix.copy()
                m = m0.copy(); m.translation += dirn * step; ctrl.matrix = m
                if max(depths(hb)) > TOL:
                    ctrl.matrix = m0; break
                back += step
    log('hand fit', side, 'move mm', round(moved.length / K * 1000, 1), 'rot deg', round(rot, 1), 'snug mm', round(back / K * 1000, 1))
    return moved


def curl_sign(bone):
    """+1 if rotating +X curls the segment toward the palm."""
    side = bone.name[5]
    pc = (pb[f'Hand_{side}'].matrix.translation + pb[f'Bone_{side}.009'].matrix.translation) / 2
    tip = bone.matrix @ Vector((0, bone.length, 0))
    m0 = bone.matrix_basis.copy()
    bone.matrix_basis = m0 @ Matrix.Rotation(0.05, 4, 'X'); bpy.context.view_layer.update()
    tip2 = bone.matrix @ Vector((0, bone.length, 0))
    bone.matrix_basis = m0; bpy.context.view_layer.update()
    return 1 if (pc - tip2).length < (pc - tip).length else -1


def solve_finger(side, chain, wrap=True, max_iter=80, limit=45.0):
    """De-penetrate a finger (search curl X / abduct Z per segment, distal first, limited deviation),
    then curl wrap fingers until the tip touches the surface."""
    segs = [pb[f'Bone_{side}.{i}'] for i in (chain[1:] if len(chain) == 4 else chain)]
    names = [x.name for x in segs]
    vidx = {n: verts_of([n]) for n in names}
    below = {n: sum((vidx[m] for m in names[names.index(n):]), []) for n in names}
    sign = {x.name: curl_sign(x) for x in segs}
    dev = {n: Vector((0, 0)) for n in names}  # (curl, abduct) radians
    step = math.radians(3)
    lim = math.radians(limit)

    def pen_of(idx):
        return sum(max(0.0, d - TOL) for d in depths(idx))

    for it in range(max_iter):
        pens = {n: pen_of(vidx[n]) for n in names}
        bad = [n for n in names if pens[n] > 0]
        if not bad:
            break
        n = bad[-1]
        base = pen_of(below[n])
        best = None
        for ax, sgn in (('X', -1), ('X', 1), ('Z', -1), ('Z', 1)):
            k = 0 if ax == 'X' else 1
            dv = dev[n].copy(); dv[k] += sgn * step * (sign[n] if ax == 'X' else 1)
            if abs(dv[k]) > lim: continue
            m0 = pb[n].matrix_basis.copy()
            pb[n].matrix_basis = m0 @ Matrix.Rotation(sgn * step * (sign[n] if ax == 'X' else 1), 4, ax)
            v = pen_of(below[n])
            pb[n].matrix_basis = m0
            if best is None or v < best[0]:
                best = (v, ax, sgn, k)
        if best is None or best[0] >= base:
            # stuck on this segment: try the parent segment next round by marking it limit-reached
            i = names.index(n)
            if i == 0:
                break
            n2 = names[i - 1]
            pb[n2].matrix_basis = pb[n2].matrix_basis @ Matrix.Rotation(-sign[n2] * step, 4, 'X'); dev[n2][0] -= step
            continue
        v, ax, sgn, k = best
        ang = sgn * step * (sign[n] if ax == 'X' else 1)
        pb[n].matrix_basis = pb[n].matrix_basis @ Matrix.Rotation(ang, 4, ax); dev[n][k] += ang
    if wrap:
        for it in range(30):
            tipd = -max(depths(vidx[names[-1]]))
            if tipd <= CONTACT:
                break
            moved = False
            for n in names:
                if dev[n][0] * sign[n] < lim:
                    m0 = pb[n].matrix_basis.copy()
                    pb[n].matrix_basis = m0 @ Matrix.Rotation(sign[n] * step, 4, 'X')
                    if pen_of(below[n]) > 0:
                        pb[n].matrix_basis = m0
                        continue
                    dev[n][0] += sign[n] * step; moved = True
                    break
            if not moved:
                break
    return {n[7:]: (round(math.degrees(d[0]), 0), round(math.degrees(d[1]), 0)) for n, d in dev.items()}


for side in ([] if os.environ.get('FP_NOIK') else SIDES):
    push_hand_out(side)
    solve_arm(side)
    for _ in range(2):  # wrist twist moves palm vertices: re-fit, re-solve
        push_hand_out(side, iters=15, snug=False)
        solve_arm(side)
if not FAST:
    for side in SIDES:
        for ch in FINGERS:
            # Right index stays on the trigger (no wrap curl); thumbs only de-penetrate.
            wrap = not ((side == 'R' and ch[0] == '004') or ch[0] == '020')
            res = solve_finger(side, ch, wrap=wrap, limit=60.0 if ch[0] == '020' else 45.0)
            log('finger', side, ch[0], res)

# ------------------------------------------------------------------ 6. report
REG = {
    'R_hand': [f'Hand_R'] + [f'Bone_R.{i}' for c in FINGERS for i in c],
    'L_hand': [f'Hand_L'] + [f'Bone_L.{i}' for c in FINGERS for i in c],
    'R_forearm': ['Forearm_R', 'BoneTwist_03.R', 'BoneTwist_02.R', 'BoneTwist_01.R', 'UpArm_R'],
    'L_forearm': ['Forearm_L', 'BoneTwist_03.L', 'BoneTwist_02.L', 'BoneTwist_01.L', 'UpArm_L'],
}
pen = {}
for k, names in REG.items():
    d = depths(verts_of(names), maxd=0.05 * K)
    inside = [x for x in d if x > 0]
    pen[k] = {'max_mm': round(max(inside) / K * 1000, 2) if inside else 0.0, 'n_inside': len(inside),
              'min_gap_mm': round(-max(x for x in d if x <= 0) / K * 1000, 2) if any(x <= 0 for x in d) else None}
REPORT['penetration'] = pen
allidx = list(range(len(arms_mesh.data.vertices)))
dall = depths(allidx, maxd=0.05 * K)
per = {}
for i, d in zip(allidx, dall):
    if d > TOL:
        per[DOM[i]] = max(per.get(DOM[i], 0), d)
REPORT['per_bone_mm'] = {k: round(v / K * 1000, 1) for k, v in sorted(per.items(), key=lambda x: -x[1])}
log('per-bone', REPORT['per_bone_mm'])
REPORT['max_mm'] = max(v['max_mm'] for v in pen.values())
log('PENETRATION', json.dumps(pen))

# ------------------------------------------------------------------ 7. renders
if os.environ.get('FP_SIDE'):
    bpy.context.view_layer.update()
    for side in SIDES:
        idx = verts_of([f'Hand_{side}', f'Bone_{side}.008', f'Bone_{side}.012'])
        co = eval_co(idx)
        log('pre-render centroid', side, [round(x, 3) for x in sum(co, Vector()) / len(co)])
    co = eval_co(list(range(len(arms_mesh.data.vertices))))
    log('arms eval bbox', [[round(x, 3) for x in v] for v in bbox(co)], 'objects', [(o.name, o.type, o.hide_render) for o in bpy.data.objects if o.type == 'MESH' and 'Arm' in o.name])
    vis = [o for o in bpy.data.objects if o.type == 'MESH' and not o.hide_render]
    side_render(vis, os.path.join(WORK, f'rig_{GID}_side.png'), step=0.05)
    side_render(vis, os.path.join(WORK, f'rig_{GID}_top.png'), step=0.05, view='top')
    bpy.context.scene.camera = None
setup_render('', 960, 540, samples=12)
for o in bpy.data.objects:
    if o.name.startswith('pole_'): o.hide_render = True
ov = os.environ.get('FP_OVERRIDE')
make_camera(CAM_W, vfov_deg=52.0)
render(os.path.join(WORK, f'rig_{GID}_fp.png'))
if not FAST:
    # Close-ups of each hand (orbit from the outside / below).
    for side in SIDES:
        hv = eval_co(verts_of(REG[f'{side}_hand']))
        c = sum(hv, Vector()) / len(hv)
        eye = c + Vector((0.20 * K if side == 'R' else -0.20 * K, 0.16 * K, -0.04 * K))
        make_camera(Matrix.Translation(eye) @ (c - eye).to_track_quat('-Z', 'Z').to_matrix().to_4x4(), vfov_deg=40)
        render(os.path.join(WORK, f'rig_{GID}_hand{side}.png'))
        eye = c + Vector((0.04 * K if side == 'R' else -0.04 * K, 0.10 * K, -0.26 * K))
        make_camera(Matrix.Translation(eye) @ (c - eye).to_track_quat('-Z', 'Y').to_matrix().to_4x4(), vfov_deg=40)
        render(os.path.join(WORK, f'rig_{GID}_hand{side}_under.png'))
    cam = bpy.context.scene.camera; cam.data.type = 'PERSP'
save_json(os.path.join(WORK, f'rig_{GID}.json'), REPORT)

# ------------------------------------------------------------------ 8. export
if OUT != '-':
    bpy.context.view_layer.objects.active = arms_mesh
    for o in bpy.data.objects: o.select_set(o == arms_mesh)
    bpy.ops.object.modifier_apply(modifier=mod.name)
    # ---- Corrective contact pass (baked into the rest pose = the hold) ----
    # Vertices still inside the gun are projected onto its surface (+0.3 mm); neighbours within 12 mm
    # follow with a smooth falloff so the glove creases instead of denting. Iterated: the falloff can
    # push a neighbour in elsewhere.
    from mathutils.kdtree import KDTree
    me = arms_mesh.data
    W_ = arms_mesh.matrix_world; Wi = W_.inverted()
    kd = KDTree(len(me.vertices))
    for v in me.vertices: kd.insert(W_ @ v.co, v.index)
    kd.balance()
    R_FALL = 0.012 * K
    moved_total = 0
    for it in range(6):
        disp = {}
        for v in me.vertices:
            p = W_ @ v.co
            d = inside_depth(gun_bvh, p, 0.03 * K)
            if d > 0.0002 * K:
                loc, nrm, _, _ = gun_bvh.find_nearest(p, 0.03 * K)
                delta = (loc + nrm * 0.0003 * K) - p
                for (q, j, dist) in kd.find_range(p, R_FALL):
                    w = 1.0 if j == v.index else 0.5 * (1 + math.cos(math.pi * dist / R_FALL)) * 0.85
                    cur = disp.get(j)
                    if cur is None or (delta * w).length > cur.length:
                        disp[j] = delta * w
        if not disp:
            break
        for j, dv in disp.items():
            me.vertices[j].co = Wi @ ((W_ @ me.vertices[j].co) + dv)
        moved_total += len(disp)
        me.update()
        kd = KDTree(len(me.vertices))
        for v in me.vertices: kd.insert(W_ @ v.co, v.index)
        kd.balance()
    dfin = [inside_depth(gun_bvh, W_ @ v.co, 0.05 * K) for v in me.vertices]
    fin = {}
    for i, d in enumerate(dfin):
        if d > 0:
            k_ = next((k for k, names in REG.items() if DOM[i] in names), 'other')
            fin[k_] = max(fin.get(k_, 0), d)
    REPORT['final_mm'] = {k: round(v / K * 1000, 2) for k, v in fin.items()}
    REPORT['final_max_mm'] = round(max(fin.values(), default=0) / K * 1000, 2)
    REPORT['corrected_vertices'] = moved_total
    log('FINAL (after corrective pass)', REPORT['final_max_mm'], REPORT['final_mm'], 'verts moved', moved_total)
    save_json(os.path.join(WORK, f'rig_{GID}.json'), REPORT)
    bpy.context.view_layer.objects.active = arm
    for o in bpy.data.objects: o.select_set(o == arm)
    bpy.ops.object.mode_set(mode='POSE')
    bpy.ops.pose.armature_apply(selected=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    m2 = arms_mesh.modifiers.new('Armature', 'ARMATURE'); m2.object = arm
    for p_ in pb:
        p_.matrix_basis = Matrix()
    bpy.context.view_layer.update()
    # ---- Variant: support hand on a vertical foregrip (game: GunModels.vgrip at VGripMount) ----
    VG = SPEC.get('vgrip')
    vg_mount = None
    if VG is not None and not FAST:
        att = 0.82 / 0.72  # FP_TUNE.default.opticScale / 0.72, as ViewModel scales attachments
        xc, uz = underside(gun_pts, VG, 0.02, 0.06)
        top = Vector((xc, VG, uz + 0.004))
        vg_mount = top
        bm = bmesh.new()
        bmesh.ops.create_cone(bm, cap_ends=True, segments=16, radius1=0.026 * att, radius2=0.022 * att, depth=0.13 * att)
        me = bpy.data.meshes.new('vg'); bm.to_mesh(me); bm.free()
        me.transform(Matrix.Translation(top + Vector((0, 0, -0.075 * att))))
        vgo = bpy.data.objects.new('VGripCollider', me); bpy.context.scene.collection.objects.link(vgo)
        bm2 = bmesh.new(); bmesh.ops.create_cube(bm2, size=1); me2 = bpy.data.meshes.new('vgc'); bm2.to_mesh(me2); bm2.free()
        me2.transform(Matrix.Translation(top + Vector((0, 0, -0.01 * att))) @ Matrix.Diagonal((0.04 * att, 0.06 * att, 0.025 * att, 1)))
        vgc = bpy.data.objects.new('VGripClamp', me2); bpy.context.scene.collection.objects.link(vgc)
        bpy.context.view_layer.update()
        gun_bvh, _ = bvh_of(coll + [vgo, vgc])
        TBV = TB['bolt']; f_v = L_REF / chain_len_tpl(TBV, 'R')
        tvp = tpl_scan('bolt')
        sl = [q for q in tvp if abs(q.y - 0.262) < 0.012 and q.z < 0.03]
        tx = (min(q.x for q in sl) + max(q.x for q in sl)) / 2 if sl else 0.0
        top_tpl = Vector((tx, 0.262, 0.035))
        M_V = Matrix.Translation(top) @ Matrix.Scale(K * f_v, 4) @ Matrix.Translation(-top_tpl)
        set_hand('L', M_V, TBV)
        push_hand_out('L')
        solve_arm('L')
        for ch in FINGERS:
            solve_finger('L', ch, wrap=ch[0] != '020')
        d = depths(verts_of(REG['L_hand']), maxd=0.05 * K)
        REPORT['vgrip_L_max_mm'] = round(max([x for x in d if x > 0] or [0]) / K * 1000, 2)
        log('VGRIP L penetration mm', REPORT['vgrip_L_max_mm'])
        make_camera(CAM_W, vfov_deg=52.0); render(os.path.join(WORK, f'rig_{GID}_vgrip.png'))
        act = bpy.data.actions.new('grip_vgrip')
        arm.animation_data_create(); arm.animation_data.action = act
        for p_ in pb:
            if p_.name.endswith('_L') or '.L' in p_.name or p_.name.startswith('Bone_L'):
                p_.keyframe_insert('location', frame=0); p_.keyframe_insert('rotation_quaternion', frame=0)
        arm.animation_data.action = None
        for p_ in pb:
            p_.matrix_basis = Matrix()
        bpy.data.objects.remove(vgo, do_unlink=True); bpy.data.objects.remove(vgc, do_unlink=True)
        save_json(os.path.join(WORK, f'rig_{GID}.json'), REPORT)
    for o in list(bpy.data.objects):
        if o.name.startswith('pole_') or o.type in ('CAMERA', 'LIGHT'):
            bpy.data.objects.remove(o, do_unlink=True)
    # Contract markers (gun frame).
    root = bpy.data.objects.new(f'FP_{GID}', None); bpy.context.scene.collection.objects.link(root)
    gun_root.parent = root; arm.parent = root

    def marker(name, M):
        e = bpy.data.objects.new(name, None); bpy.context.scene.collection.objects.link(e)
        e.parent = gun_root if name not in ('GripR', 'GripL', 'VGripMount') else root
        e.matrix_world = M
        return e
    if not any(o.name.startswith('MuzzleSocket') or o.name.startswith('MuzzleDeviceTip') for o in bpy.data.objects):
        marker('MuzzleSocket', Matrix.Translation((0, bore_front, BORE_Z)))
    if not any(o.name.startswith('EjectionPort') for o in bpy.data.objects):
        marker('EjectionPort', Matrix.Translation((0.03 * K, SPEC['web'][0] + (0.09 if SPEC['cls'] != 'pistol' else 0.06) * K, BORE_Z + 0.01 * K)))
    marker('GripR', Matrix.Translation(O_tgt) @ Matrix.Rotation(math.radians(-SPEC['rake']), 4, 'X'))
    if tkey != 'pistol':
        marker('GripL', Matrix.Translation(S_tgt))
    if vg_mount is not None:
        marker('VGripMount', Matrix.Translation(vg_mount))
    root['fp'] = json.dumps({'K': K, 'cls': SPEC['cls'], 'hip': REPORT['hip'], 'boreZ': BORE_Z, 'web': list(SPEC['web']),
                             'trig': list(SPEC['trig']), 'maxPenetrationMm': REPORT.get('final_max_mm', REPORT['max_mm'])})
    if not os.environ.get('FP_NOAO'):
        tb = time.time()
        for o in bpy.data.objects: o.hide_render = False  # every exported mesh needs the AO uv set
        bake_ao([o for o in bpy.data.objects if o.type == 'MESH'], distance=0.05 * K,
                out_png=os.path.join(WORK, f'rig_{GID}_ao.png'))
        log('AO baked', round(time.time() - tb, 1), 's')
    for o in bpy.data.objects: o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=OUT, use_selection=True, export_format='GLB', export_extras=True,
                              export_skins=True, export_animations=bool(bpy.data.actions), export_animation_mode='ACTIONS',
                              export_force_sampling=False, export_image_format='AUTO')
    log('exported', OUT)
log('done', json.dumps({'max_mm': REPORT['max_mm']}))
