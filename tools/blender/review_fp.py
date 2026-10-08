"""Render an exported FP rig GLB (what the game loads) from its authored hip camera + hand close-ups,
and re-measure penetration on the exported skinned mesh.
  blender -b --python tools/blender/review_fp.py -- <fp.glb> <out_prefix> [variant_clip]"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fp_lib import *

a = args(); reset()
objs = import_glb(a[0], rig=True)
root = [o for o in objs if o.name.startswith('FP_')][0]
meta = json.loads(root.get('fp', '{}'))
K = meta.get('K', 2)
arm = [o for o in objs if o.type == 'ARMATURE'][0]
if arm.animation_data:
    arm.animation_data.action = None
for p in arm.pose.bones: p.matrix_basis = Matrix()
if len(a) > 2:
    act = bpy.data.actions.get(a[2]) or next((x for x in bpy.data.actions if a[2] in x.name), None)
    if act:
        arm.animation_data_create(); arm.animation_data.action = act; bpy.context.scene.frame_set(0)
bpy.context.view_layer.update()
gun = [o for o in objs if o.type == 'MESH' and not o.find_armature() and not re.search('Glass', o.name)]
arms = [o for o in objs if o.type == 'MESH' and o.find_armature()]
for o in objs:
    if o.type == 'MESH' and re.search('Glass', o.name): o.hide_render = True
bvh, _ = bvh_of(gun)
pts = evaluated_verts(arms)
d = [inside_depth(bvh, p, 0.05 * K) for p in pts]
pen = max([x for x in d if x > 0] or [0]) / K * 1000
print('REVIEW penetration mm', round(pen, 2), 'inside verts', sum(1 for x in d if x > 0.0005 * K))
h = meta['hip']; Bref = Vector(h['boreRef']) * K
p_, y_, r_ = [math.radians(v) for v in h['rot']]
ROT = Matrix.Rotation(y_, 4, 'Z') @ Matrix.Rotation(p_, 4, 'X') @ Matrix.Rotation(-r_, 4, 'Y')
G = Matrix.Translation(Vector(h['pos']) * K) @ ROT @ Matrix.Translation(-Bref)
Ginv = G.inverted()
setup_render('', 960, 540, samples=12)
make_camera(Ginv @ FP_CAM, vfov_deg=52.0)
render(a[1] + '_fp.png')
for side in 'RL':
    hb = arm.pose.bones.get(f'Hand_{side}')
    c = arm.matrix_world @ hb.head
    for nm, off, up in (('o', (0.20 if side == 'R' else -0.20, 0.14, -0.03), 'Z'), ('u', (0.03 if side == 'R' else -0.03, 0.08, -0.24), 'Y')):
        eye = c + Vector(off) * K
        make_camera(Matrix.Translation(eye) @ (c - eye).to_track_quat('-Z', up).to_matrix().to_4x4(), vfov_deg=38)
        render(a[1] + f'_{side}{nm}.png')
