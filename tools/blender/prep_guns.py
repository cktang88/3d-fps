"""Normalise weapon source models into the canonical FP gun frame at GUN_K x real scale.

  blender -b --python tools/blender/prep_guns.py -- <sketchfab_dir> <work_dir> [ids]

Writes <work>/gun_<id>.glb (contract nodes: Gun_<id> root, Body meshes, Magazine, ChargingHandle,
Pump, Glass...) and <work>/gun_<id>_side.png / _top.png (gridded, K-space metres) for marker reading.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fp_lib import *
from guns import GUNS


def bake_world(objs):
    """Bake every mesh's world transform into its data, unparent everything, drop empties."""
    for o in objs:
        if o.type == 'MESH':
            o.data = o.data.copy()
            o.data.transform(o.matrix_world)
    for o in objs:
        if o.type == 'MESH':
            o.parent = None
            o.matrix_world = Matrix()
    for o in objs:
        if o.type != 'MESH' and o.name in bpy.data.objects:
            bpy.data.objects.remove(o, do_unlink=True)
    return [o for o in bpy.data.objects if o.type == 'MESH']


def split_skinned(o, roles):
    """Split a skinned mesh into one static mesh per role by dominant bone (rest pose)."""
    out = []
    names = {g.index: canon(g.name) for g in o.vertex_groups}
    dom = []
    for v in o.data.vertices:
        best = max(v.groups, key=lambda g: g.weight, default=None)
        dom.append(names.get(best.group) if best else None)
    for role, rx in roles.items():
        keep = {i for i, n in enumerate(dom) if n and re.match(rx, n)}
        if not keep:
            continue
        me = o.data.copy()
        bm = bmesh.new(); bm.from_mesh(me)
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.index not in keep], context='VERTS')
        bm.to_mesh(me); bm.free()
        for _ in range(len(me.attributes)):
            pass
        ob = bpy.data.objects.new(role, me)
        bpy.context.scene.collection.objects.link(ob)
        ob.matrix_world = o.matrix_world
        ob.vertex_groups.clear()
        out.append(ob)
    return out


def join(objs, name):
    if not objs:
        return None
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    ob.name = name; ob.data.name = name
    return ob


def prep(gid, spec, sfdir, work):
    reset()
    src = spec['src']
    path = os.path.join(ROOT, src[5:]) if src.startswith('repo:') else os.path.join(sfdir, src[3:])
    objs = import_glb(path, rig=spec.get('skinned', False))
    K = GUN_K
    if spec.get('keep_nodes'):
        # Steel-tide asset with authored contract nodes: wrap and rescale only.
        roots = [o for o in objs if o.parent is None]
        rx = re.compile(spec.get('measure', '.*'))
        pts = evaluated_verts([o for o in objs if o.type == 'MESH' and rx.match(o.name) and not re.search('Spare|Suppressor|Foregrip|Optic', o.name + (o.parent.name if o.parent else ''))])
        mn, mx = bbox(pts)
        f = K * spec['length'] / (mx.y - mn.y)
        root = bpy.data.objects.new('Gun_' + gid, None)
        bpy.context.scene.collection.objects.link(root)
        for r in roots:
            r.parent = root
        root.scale = (f, f, f)
        print('PREP', gid, 'keep_nodes scale', round(f, 4))
    else:
        if spec.get('skinned'):
            arm = [o for o in objs if o.type == 'ARMATURE'][0]
            arm.data.pose_position = 'REST'
            bpy.context.view_layer.update()
            meshes = [o for o in objs if o.type == 'MESH']
            gun_meshes = []
            for o in meshes:
                used = {canon(o.vertex_groups[g.group].name) for v in o.data.vertices for g in v.groups if g.weight > 0.05}
                if any(re.match(rx, u) for rx in spec['parts'].values() for u in used) and not any(u.startswith(('Hand', 'Bone_', 'Forearm', 'UpArm')) for u in used):
                    gun_meshes += split_skinned(o, spec['parts'])
            for o in objs:
                if o.name in bpy.data.objects:
                    bpy.data.objects.remove(o, do_unlink=True)
            meshes = gun_meshes
            for o in meshes:
                o.data.transform(o.matrix_world); o.matrix_world = Matrix()
            # Orientation: PCA long axis -> +Y; muzzle at the thin end; up = +Z of the source.
            import numpy as np
            P = np.array([tuple(v.co) for o in meshes for v in o.data.vertices])
            c = P.mean(0); ev, evec = np.linalg.eigh((P - c).T @ (P - c))
            F = Vector(evec[:, -1]).normalized()
            pr = (P - c) @ np.array(F)
            lo, hi = P[pr < np.percentile(pr, 3)], P[pr > np.percentile(pr, 97)]
            spread = lambda Q: np.linalg.norm((Q - Q.mean(0)) - np.outer((Q - Q.mean(0)) @ np.array(F), np.array(F)), axis=1).mean()
            if spread(hi) > spread(lo):
                F = -F
            U = Vector((0, 0, 1)); U = (U - F * U.dot(F)).normalized()
            R = F.cross(U)
            M = Matrix((R, F, U)).to_4x4()  # rows: world -> canonical
            for o in meshes:
                o.data.transform(M)
        else:
            meshes = bake_world(objs)
            if spec.get('drop'):
                for o in list(meshes):
                    if re.search(spec['drop'], o.name):
                        bpy.data.objects.remove(o, do_unlink=True); meshes.remove(o)
            R = Euler([math.radians(x) for x in spec.get('rot', (0, 0, 0))]).to_matrix().to_4x4()
            for o in meshes:
                o.data.transform(R)
        pts = [v.co.copy() for o in meshes for v in o.data.vertices]
        mn, mx = bbox(pts)
        f = K * spec['length'] / (mx.y - mn.y)
        c = (mn + mx) / 2
        T = Matrix.Scale(f, 4) @ Matrix.Translation((-c.x, -c.y, -c.z))
        for o in meshes:
            o.data.transform(T)
        print('PREP', gid, 'scale', round(f, 5), 'src len', round(mx.y - mn.y, 4))
        # Group by role.
        roles = {}
        for o in meshes:
            role = 'Shell' if o.name.startswith('Shell') else 'Body'
            for rn, rx in spec.get('parts', {}).items():
                if re.match(rx, o.name):
                    role = rn
            roles.setdefault(role, []).append(o)
        root = bpy.data.objects.new('Gun_' + gid, None)
        bpy.context.scene.collection.objects.link(root)
        for role, os_ in roles.items():
            ob = join(os_, role + 'Geometry' if role != 'Body' else 'Body')
            if role == 'Body':
                ob.parent = root
                continue
            if role == 'Shell' or ob.name.startswith('Shell'):
                bpy.data.objects.remove(ob, do_unlink=True); continue
            # Pivot node at the part's bounds (magazine: top centre, where it seats).
            p = [v.co for v in ob.data.vertices]
            pmn, pmx = bbox(p)
            piv = Vector(((pmn.x + pmx.x) / 2, (pmn.y + pmx.y) / 2, pmx.z if role == 'Magazine' else (pmn.z + pmx.z) / 2))
            node = bpy.data.objects.new(role, None)
            bpy.context.scene.collection.objects.link(node)
            node.parent = root
            node.location = piv
            ob.data.transform(Matrix.Translation(-piv))
            ob.parent = node
            if role == 'Magazine':
                g = bpy.data.objects.new('MagazineGripSocket', None)
                bpy.context.scene.collection.objects.link(g)
                g.parent = node
                g.location = (pmn.x, 0, (pmn.z - pmx.z) * 0.45)
            if role == 'Glass':
                for m in ob.data.materials:
                    if m: m.name = 'glass_' + m.name
    # Export + diagnostics.
    bpy.ops.object.select_all(action='DESELECT')
    allo = [o for o in bpy.data.objects]
    for o in allo:
        o.select_set(True)
    out = os.path.join(work, f'gun_{gid}.glb')
    bpy.ops.export_scene.gltf(filepath=out, use_selection=True, export_format='GLB', export_image_format='AUTO')
    pts = evaluated_verts([o for o in allo if o.type == 'MESH'])
    mn, mx = bbox(pts)
    print('BOUNDS', gid, [round(x, 3) for x in mn], [round(x, 3) for x in mx])
    side_render(allo, os.path.join(work, f'gun_{gid}_side.png'), step=0.02)
    side_render(allo, os.path.join(work, f'gun_{gid}_top.png'), step=0.02, view='top')


def main():
    a = args()
    sfdir, work = a[0], a[1]
    ids = a[2].split(',') if len(a) > 2 else list(GUNS)
    for gid in ids:
        prep(gid, GUNS[gid], sfdir, work)


main()
