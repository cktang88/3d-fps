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
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.verts.ensure_lookup_table(); bm.faces.ensure_lookup_table()
    return BVHTree.FromBMesh(bm), bm


_DIRS = [Vector(d) for d in ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1),
                              (0.577, 0.577, 0.577), (-0.577, -0.577, 0.577))]


def inside_depth(bvh, p, maxd):
    """Penetration depth of p (>0 inside, <0 = distance outside). 'Inside' needs both the nearest-face
    normal test and a ray vote (>= 6 of 8 rays leave through a back face), so single-sided planes,
    decals and open edges of game meshes do not produce false penetrations."""
    hit = bvh.find_nearest(p, maxd)
    if hit[0] is None:
        return -maxd
    loc, nrm, _, d = hit
    if (p - loc).dot(nrm) >= 0:
        return -d
    votes = 0
    for dv in _DIRS:
        h = bvh.ray_cast(p + dv * 1e-5, dv, 1.0)
        if h[0] is not None and h[1].dot(dv) > 0:
            votes += 1
    return d if votes >= 6 else -d


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


def side_render(objs, png, step=0.02, pad=1.08, w=1600, h=900, view='right', region=None):
    """Orthographic gridded view of objects in canonical frame (right side: +Y to the right of image).
    region=(y0, y1, z0, z1) zooms to that window."""
    pts = evaluated_verts([o for o in objs if not o.hide_render])
    mn, mx = bbox(pts); c = (mn + mx) / 2
    if region:
        mn = Vector((mn.x, region[0], region[2])); mx = Vector((mx.x, region[1], region[3])); c = (mn + mx) / 2; pad = 1.0
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


def _gltf_output_group():
    """Node group the glTF exporter reads extra outputs from (Occlusion)."""
    g = bpy.data.node_groups.get('glTF Material Output')
    if g is None:
        g = bpy.data.node_groups.new('glTF Material Output', 'ShaderNodeTree')
        g.interface.new_socket('Occlusion', in_out='INPUT', socket_type='NodeSocketFloat')
        g.interface.new_socket('Thickness', in_out='INPUT', socket_type='NodeSocketFloat')
    return g


def bake_ao(meshes, size=1024, samples=48, distance=0.1, out_png=None):
    """Bake ambient occlusion of `meshes` (posed / evaluated, all scene geometry occludes) into ONE shared
    atlas on a second UV layer 'AO', and wire it as each material's glTF occlusion (TEXCOORD_1)."""
    meshes = [o for o in meshes if o.type == 'MESH' and len(o.data.polygons)]
    for o in meshes:
        o.data = o.data.copy() if o.data.users > 1 else o.data
        uv = o.data.uv_layers.get('AO') or o.data.uv_layers.new(name='AO')
        o.data.uv_layers.active = uv
    bpy.ops.object.mode_set(mode='OBJECT') if bpy.context.object and bpy.context.object.mode != 'OBJECT' else None
    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes: o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.004, area_weight=0.0, scale_to_bounds=False)
    bpy.ops.uv.pack_islands(margin=0.004, rotate=True)
    bpy.ops.object.mode_set(mode='OBJECT')
    img = bpy.data.images.new('AO', size, size, alpha=False)
    img.generated_color = (1, 1, 1, 1)
    grp = _gltf_output_group()
    mats = {m for o in meshes for m in o.data.materials if m}
    for m in mats:
        m.use_nodes = True
        nt = m.node_tree
        tex = nt.nodes.new('ShaderNodeTexImage'); tex.image = img; tex.name = 'AO_bake'
        uvn = nt.nodes.new('ShaderNodeUVMap'); uvn.uv_map = 'AO'
        nt.links.new(uvn.outputs['UV'], tex.inputs['Vector'])
        sep = nt.nodes.new('ShaderNodeSeparateColor')
        nt.links.new(tex.outputs['Color'], sep.inputs['Color'])
        gn = nt.nodes.new('ShaderNodeGroup'); gn.node_tree = grp
        nt.links.new(sep.outputs['Red'], gn.inputs['Occlusion'])
        nt.nodes.active = tex
    # Meshes without materials get a neutral one so they can be baked.
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'; sc.cycles.samples = samples; sc.cycles.device = 'CPU'
    sc.world = sc.world or bpy.data.worlds.new('w')
    sc.world.light_settings.distance = distance
    sc.render.bake.margin = 4
    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes:
        if o.data.materials: o.select_set(True)
    bpy.ops.object.bake(type='AO', use_clear=True)
    if out_png:
        img.filepath_raw = out_png; img.file_format = 'PNG'; img.save()
    img.pack()
    return img
