"""Shared helpers for the first-person rig pipeline (Blender 4.2, run headless).

Conventions (Blender space, metres unless stated):
  gun canonical frame : +X right, +Y muzzle/forward, +Z up  (glTF export maps +Y -> -Z, i.e. muzzle -Z)
  camera space        : eye at origin looking +Y, +Z up, +X right (three.js view camera after export)
  K (GUN_K)           : FP GLBs are authored at K x real scale (steel-tide convention) so the game's
                        procedural attachments / optics keep their sizes. WeaponRoot scale in game = 1/K.
"""
import bpy, bmesh, json, math, os, re, sys
from mathutils import Vector, Matrix, Euler, Quaternion
from mathutils.bvhtree import BVHTree

GUN_K = 2.0
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))


def args():
    return sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


def canon(name):
    """Strip the exporter's numeric suffix: 'Bone_R.005_039' -> 'Bone_R.005', 'Hand_R_038' -> 'Hand_R'."""
    return re.sub(r'_\d+$', '', name)


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_glb(path, rig=False):
    before = set(bpy.data.objects)
    kw = dict(filepath=path)
    if rig:
        kw.update(guess_original_bind_pose=False, bone_heuristic='TEMPERANCE')
    bpy.ops.import_scene.gltf(**kw)
    new = [o for o in bpy.data.objects if o not in before]
    for o in new:
        if o.name.startswith('Icosphere'):
            bpy.data.objects.remove(o, do_unlink=True)
    return [o for o in bpy.data.objects if o not in before]


def evaluated_verts(objs, matrix=None):
    dg = bpy.context.evaluated_depsgraph_get()
    pts = []
    for o in objs:
        if o.type != 'MESH':
            continue
        e = o.evaluated_get(dg)
        me = e.to_mesh()
        M = (matrix or Matrix()) @ o.matrix_world
        pts += [M @ v.co for v in me.vertices]
        e.to_mesh_clear()
    return pts


def bbox(pts):
    mn = Vector([min(p[i] for p in pts) for i in range(3)])
    mx = Vector([max(p[i] for p in pts) for i in range(3)])
    return mn, mx


def bake_mesh_copy(o, name, matrix=Matrix()):
    """Evaluated (posed/modified) copy of a mesh object as a static mesh with transform baked."""
    dg = bpy.context.evaluated_depsgraph_get()
    e = o.evaluated_get(dg)
    me = bpy.data.meshes.new_from_object(e, preserve_all_data_layers=True, depsgraph=dg)
    me.transform(matrix @ o.matrix_world)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def bvh_of(objs, matrix=Matrix()):
    """World-space BVH (plus the bmesh) for a list of mesh objects (evaluated)."""
    dg = bpy.context.evaluated_depsgraph_get()
    bm = bmesh.new()
    for o in objs:
        if o.type != 'MESH' or o.hide_render:
            continue
        e = o.evaluated_get(dg)
        me = e.to_mesh()
        tmp = bmesh.new(); tmp.from_mesh(me)
        bmesh.ops.transform(tmp, matrix=matrix @ o.matrix_world, verts=tmp.verts)
        me2 = bpy.data.meshes.new('_tmp'); tmp.to_mesh(me2); tmp.free()
        bm.from_mesh(me2); bpy.data.meshes.remove(me2)
        e.to_mesh_clear()
    bm.verts.ensure_lookup_table(); bm.faces.ensure_lookup_table()
    return BVHTree.FromBMesh(bm), bm


def signed_depth(bvh, p, maxd=0.05):
    """Signed distance of p to the surface (negative = inside, using the face normal)."""
    hit = bvh.find_nearest(p, maxd)
    if hit[0] is None:
        return maxd
    loc, nrm, idx, d = hit
    s = (p - loc).dot(nrm)
    return -d if s < 0 else d


def setup_render(path, w=960, h=540, engine='BLENDER_EEVEE_NEXT', samples=32, bg=(0.42, 0.45, 0.5)):
    sc = bpy.context.scene
    sc.render.engine = engine
    if engine == 'BLENDER_EEVEE_NEXT':
        sc.eevee.taa_render_samples = samples
    sc.render.resolution_x, sc.render.resolution_y = w, h
    sc.render.filepath = path
    sc.view_settings.view_transform = 'AgX'
    if not sc.world:
        sc.world = bpy.data.worlds.new('w')
    sc.world.use_nodes = True
    sc.world.node_tree.nodes['Background'].inputs[0].default_value = (*bg, 1)
    sc.world.node_tree.nodes['Background'].inputs[1].default_value = 0.9
    if not any(o.type == 'LIGHT' for o in sc.objects):
        L = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
        sc.collection.objects.link(L)
        L.rotation_euler = (math.radians(50), math.radians(-20), math.radians(30))
        L.data.energy = 3.5
    return sc


def make_camera(matrix, vfov_deg=52.0, ortho=None):
    sc = bpy.context.scene
    cam = sc.camera
    if cam is None:
        cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
        sc.collection.objects.link(cam)
        sc.camera = cam
    cam.data.clip_start = 0.005
    cam.data.clip_end = 100
    if ortho:
        cam.data.type = 'ORTHO'; cam.data.ortho_scale = ortho
    else:
        cam.data.type = 'PERSP'; cam.data.sensor_fit = 'VERTICAL'; cam.data.angle = math.radians(vfov_deg)
    cam.matrix_world = matrix
    return cam


# Camera space: eye at origin, looking +Y, +Z up.  Blender cameras look down local -Z with +Y up,
# so the FP camera's world matrix is a +90 deg rotation about X.
FP_CAM = Matrix.Rotation(math.radians(90), 4, 'X')


def render(path):
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


def grid_overlay(png, meta):
    """Draw a metric grid on an orthographic side render. meta: {cy, cz, W} (W = ortho width)."""
    try:
        from PIL import Image, ImageDraw
    except ImportError:  # Blender's bundled Python: leave it to tools/blender/gridify.py
        save_json(png + '.json', meta)
        return
    im = Image.open(png).convert('RGB'); d = ImageDraw.Draw(im)
    Wpx, Hpx = im.size; s = Wpx / meta['W']
    X = lambda y: Wpx / 2 + (y - meta['cy']) * s
    Y = lambda z: Hpx / 2 - (z - meta['cz']) * s
    step = meta.get('step', 0.02)
    y = math.floor((meta['cy'] - meta['W'] / 2) / step) * step
    while y < meta['cy'] + meta['W'] / 2:
        major = abs(round(y / (step * 5)) - y / (step * 5)) < 1e-6
        col = (255, 0, 0) if major else (255, 210, 0)
        d.line([(X(y), 0), (X(y), Hpx)], fill=col, width=1)
        if major: d.text((X(y) + 2, 2), f"{y:.2f}", fill=col)
        y += step
    z = math.floor((meta['cz'] - meta['W'] * Hpx / Wpx / 2) / step) * step
    while z < meta['cz'] + meta['W'] * Hpx / Wpx / 2:
        major = abs(round(z / (step * 5)) - z / (step * 5)) < 1e-6
        col = (0, 0, 255) if major else (0, 170, 255)
        d.line([(0, Y(z)), (Wpx, Y(z))], fill=col, width=1)
        if major: d.text((2, Y(z) + 2), f"{z:.2f}", fill=col)
        z += step
    im.save(png)


def side_render(objs, png, step=0.02, pad=1.08, w=1600, h=900, view='right'):
    """Orthographic gridded view of objects in canonical frame (right side: +Y to the right of image)."""
    pts = evaluated_verts([o for o in objs if not o.hide_render])
    mn, mx = bbox(pts); c = (mn + mx) / 2
    W = max(mx.y - mn.y, (mx.z - mn.z) * w / h) * pad
    if view == 'right':
        M = Matrix.Translation((mx.x + 2, c.y, c.z)) @ Euler((math.radians(90), 0, math.radians(90))).to_matrix().to_4x4()
        meta = {'cy': c.y, 'cz': c.z, 'W': W, 'step': step}
    else:  # top: +Y right, +X down
        M = Matrix.Translation((c.x, c.y, mx.z + 2)) @ Euler((0, 0, math.radians(90))).to_matrix().to_4x4()
        meta = {'cy': c.y, 'cz': c.x, 'W': W, 'step': step}
    make_camera(M, ortho=W)
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_WORKBENCH'
    sc.display.shading.light = 'STUDIO'; sc.display.shading.color_type = 'TEXTURE'; sc.display.shading.show_cavity = True
    sc.render.resolution_x, sc.render.resolution_y = w, h
    render(png)
    grid_overlay(png, meta)
    return meta


def mat_to_list(M):
    return [list(r) for r in M]


def list_to_mat(L):
    return Matrix(L)


def save_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        json.dump(data, f, indent=1)


def load_json(path):
    with open(path) as f:
        return json.load(f)
