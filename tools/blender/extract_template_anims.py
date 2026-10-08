"""Sample the Free FPS Template (Fab) rifle animations into a neutral JSON for analysis + retargeting.

  blender -b <Animations_Assault_Rifle.blend> --python tools/blender/extract_template_anims.py -- <out.json>

Per action and frame: camera world matrix (camera is CHILD_OF the head bone), weapon armature world matrix
(SKEL_AssaultRifle follows ik_hand_gun), world matrices of the deform arm/hand/finger bones, and the weapon
part bones (WEP_* actions: magazine, bolt...). Units: metres (the source is centimetres).
Only motion is extracted; no Manny geometry leaves Blender.
"""
import bpy, json, sys
from mathutils import Matrix

out = sys.argv[sys.argv.index('--') + 1]
sc = bpy.context.scene
arm = bpy.data.objects['Armature']
cam = bpy.data.objects['Camera']
weps = [o for o in bpy.data.objects if o.type == 'ARMATURE' and o.name.startswith('SKEL_AssaultRifle') and o.constraints]
wep = weps[0]
mag = next((o for o in bpy.data.objects if o.name.startswith('SM_AssaultRifle_Magazine') and o.constraints), None)
gunmesh = next((o for o in bpy.data.objects if o.name.startswith('SK_AssaultRifle') and o.type == 'MESH' and o.constraints), None)
U = 0.01
S = Matrix.Scale(U, 4)
KEEP = [b.name for b in arm.data.bones if b.use_deform and any(k in b.name for k in (
    'clavicle', 'upperarm', 'lowerarm', 'hand', 'index', 'middle', 'ring', 'pinky', 'thumb', 'head', 'ik_hand_gun'))]
KEEP.append('ik_hand_gun')


def M(m):
    return [round(v, 6) for row in (S @ m) for v in row]


data = {'fps': sc.render.fps / sc.render.fps_base, 'units': 'm', 'bones': KEEP, 'wepBones': [b.name for b in wep.data.bones], 'actions': {}}
# Rest/reference info for the weapon mesh (bounds in weapon-armature space) to find muzzle / grip.
if gunmesh:
    inv = wep.matrix_world.inverted()
    bpy.context.view_layer.update()
    vs = [inv @ (gunmesh.matrix_world @ v.co) for v in gunmesh.data.vertices]
    data['gunBounds'] = [[min(v[i] for v in vs) * U for i in range(3)], [max(v[i] for v in vs) * U for i in range(3)]]
wep_actions = {a.name.replace('_WEP', ''): a for a in bpy.data.actions if a.name.startswith('A_FP_WEP_')}
ref_wep = bpy.data.actions.get('A_WEP_Reference')
for act in bpy.data.actions:
    if not act.name.startswith('A_FP_') or act.name.startswith('A_FP_WEP_'):
        continue
    arm.animation_data.action = act
    wa = wep_actions.get(act.name)
    wep.animation_data_create()
    wep.animation_data.action = wa or ref_wep
    f0, f1 = int(act.frame_range[0]), int(act.frame_range[1])
    frames = []
    for f in range(f0, f1 + 1):
        sc.frame_set(f)
        fr = {'cam': M(cam.matrix_world @ Matrix.Diagonal((1 / cam.scale.x, 1 / cam.scale.y, 1 / cam.scale.z, 1))),
              'gun': M(wep.matrix_world),
              'b': {n: M(arm.matrix_world @ arm.pose.bones[n].matrix) for n in KEEP if n in arm.pose.bones},
              'w': {b.name: M(wep.matrix_world @ b.matrix) for b in wep.pose.bones}}
        if mag:
            fr['mag'] = M(mag.matrix_world)
        frames.append(fr)
    data['actions'][act.name] = {'range': [f0, f1], 'wep': wa.name if wa else None, 'frames': frames}
    print('ACTION', act.name, f0, f1, 'wep', wa.name if wa else None)
json.dump(data, open(out, 'w'))
print('WROTE', out)
