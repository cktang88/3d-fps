"""Extract authored grip templates from ccransh's FPS animation packs (CC-BY, same arm rig).

For each pack: evaluate the idle clip at frame 0, build a canonical gun frame (+X right, +Y muzzle,
+Z up, metres, normalised so the rig matches the reference arm size), and store every bone's world
matrix in that frame. Also renders a gridded right-side view so grip markers can be read off.

  blender -b --python tools/blender/extract_templates.py -- <packs_dir> <out_dir>
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fp_lib import *

PACKS = {
    # pack: (file, idle action substring, gun-body bone, forward bone)
    'rifle': ('cc_ak74/model.glb', 'AK_Idle', 'PBody', 'Rif'),
    'pistol': ('cc_pistol/model.glb', 'Pistol_Idle', 'PBody', 'Rif'),
    'shotgun': ('rem/model.glb', 'SG_FPS_Idle', 'Body', 'Slide'),
    'bolt': ('cc_sniper/model.glb', 'SRifle_Idle', 'Body', 'Bolt'),
}
REF_UPARM = 0.2377  # UpArm bone length of the reference (shotgun pack) rig, metres


def main():
    a = args()
    src, out = a[0], a[1]
    only = a[2].split(',') if len(a) > 2 else list(PACKS)
    data = {}
    for key in only:
        fn, idle, body, fwd = PACKS[key]
        reset()
        objs = import_glb(os.path.join(src, fn), rig=True)
        arm = [o for o in objs if o.type == 'ARMATURE'][0]
        act = [x for x in bpy.data.actions if idle in x.name][0]
        arm.animation_data.action = act
        bpy.context.scene.frame_set(0)
        pb = {canon(b.name): b for b in arm.pose.bones}
        W = lambda n: arm.matrix_world @ pb[n].matrix
        s = REF_UPARM / ((W('Forearm_L').translation - W('UpArm_L').translation).length)
        meshes = [o for o in objs if o.type == 'MESH']
        # Gun meshes: skinned to the body/part bones (not to the arm/hand bones).
        armbones = {n for n in pb if re.match(r'(Arm|UpArm|Forearm|BoneTwist|Hand|Bone_|IK_|Root|Head_Cam|_rootJoint)', n)}
        def used(o):
            names = {o.vertex_groups[g.group].name for v in o.data.vertices for g in v.groups if g.weight > 0.05}
            return {canon(x) for x in names}
        gun = [o for o in meshes if not (used(o) & armbones)]
        arms = [o for o in meshes if o not in gun]
        # Forward axis: the slide/bolt bone's direction, signed toward the muzzle (the thin end).
        # PCA major axis of the slide / bolt-carrier vertices (always elongated along the bore).
        dg = bpy.context.evaluated_depsgraph_get()
        part = []
        for o in gun:
            gi = {g.index for g in o.vertex_groups if canon(g.name) == fwd}
            e = o.evaluated_get(dg); me = e.to_mesh()
            for v, ve in zip(o.data.vertices, me.vertices):
                if any(g.group in gi and g.weight > 0.5 for g in v.groups):
                    part.append(o.matrix_world @ ve.co)
            e.to_mesh_clear()
        import numpy as np
        P = np.array([tuple(p) for p in part]); P -= P.mean(0)
        evals, evecs = np.linalg.eigh(P.T @ P)
        Fw = Vector(evecs[:, -1]).normalized()
        gp = evaluated_verts(gun)
        o0 = W(body).translation
        proj = sorted(gp, key=lambda p: (p - o0).dot(Fw))
        n = max(10, len(proj) // 40)

        def spread(ps):
            c = sum(ps, Vector()) / len(ps)
            return sum(((p - c) - Fw * (p - c).dot(Fw)).length for p in ps) / len(ps)
        if spread(proj[:n]) < spread(proj[-n:]):
            Fw = -Fw
        U = Vector((0, 0, 1)); U = (U - Fw * U.dot(Fw)).normalized()
        R = Fw.cross(U).normalized()
        G = Matrix((R, Fw, U)).transposed().to_4x4(); G.translation = o0
        Ginv = G.inverted()
        S = Matrix.Scale(s, 4)
        bones = {}
        for nme in pb:
            M = S @ Ginv @ W(nme)
            bones[nme] = mat_to_list(M)
        # Rest (bind) matrices too, for retargeting.
        data[key] = {'scale': s, 'bones': bones, 'pack': fn}
        # Canonical copies for the marker sheet.
        for o in meshes:
            c = bake_mesh_copy(o, 'C_' + o.name, S @ Ginv)
            c['is_gun'] = o in gun
        for o in objs:
            o.hide_render = True
        cps = [o for o in bpy.data.objects if o.name.startswith('C_')]
        gpts = evaluated_verts([o for o in cps if o['is_gun']])
        mn, mx = bbox(gpts)
        data[key]['gun_bbox'] = [list(mn), list(mx)]
        meta = side_render(cps, os.path.join(out, f'tpl_{key}_side.png'), step=0.02)
        for o in cps:
            o.hide_render = not o['is_gun']
        side_render(cps, os.path.join(out, f'tpl_{key}_gun.png'), step=0.02)
        # Export the canonical gun so later passes can measure it (BVH etc).
        for o in bpy.data.objects:
            o.select_set(o in cps and o['is_gun'])
        bpy.ops.export_scene.gltf(filepath=os.path.join(out, f'tpl_{key}_gun.glb'), use_selection=True, export_format='GLB')
        print('TEMPLATE', key, 'scale', s, 'gun bbox', [round(x, 3) for x in mn], [round(x, 3) for x in mx])
    prev = load_json(os.path.join(out, 'templates.json')) if os.path.exists(os.path.join(out, 'templates.json')) else {}
    prev.update(data)
    save_json(os.path.join(out, 'templates.json'), prev)


main()
