"""Smooth the optic housings' silhouettes (round 2 QA: faceted outlines at ADS, where the housing fills 10-30% of the
screen). Each *Geometry mesh in optics.glb gets one Catmull-Clark level with every edge sharper than CREASE_DEG
creased, so low-segment cylinders (lens tubes, turrets, ring bells) round off while hard edges (rails, housing
corners) stay crisp; then smooth-by-angle normals. Node names / anchors / extras are unchanged.

  blender -b --python tools/blender/smooth_optics.py -- <in optics.glb> <out optics.glb>
  then: npx gltf-transform webp / quantize / meshopt (textures back to WebP, geometry compressed)
"""
import sys, os, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fp_lib import *

# Red dot + holo only: on the ACOG / riflescope the subdivision flattened the rolled rubber eyecup (tried 38-70 deg).
CREASE_DEG = {'Micro': 38.0, 'Holo': 38.0}
a = args()
reset()
objs = import_glb(a[0])
for o in objs:
    if o.type != 'MESH' or not o.name.endswith('Geometry') and 'Geometry' not in (o.parent.name if o.parent else ''):
        continue
    if not re.search(r'(Holo|Micro|Scope|Sniper)Geometry', o.name + ' ' + (o.parent.name if o.parent else '')):
        continue
    key = re.search(r'(Holo|Micro|Scope|Sniper)', o.name + ' ' + (o.parent.name if o.parent else '')).group(1)
    if key not in CREASE_DEG:
        continue
    ang = CREASE_DEG[key]
    me = o.data
    if me.users > 1:
        o.data = me = me.copy()
    n0 = len(me.polygons)
    bm = bmesh.new(); bm.from_mesh(me)
    bmesh.ops.join_triangles(bm, faces=bm.faces[:], angle_face_threshold=math.radians(8), angle_shape_threshold=math.radians(40),
                             cmp_seam=True, cmp_sharp=True, cmp_uvs=True, cmp_materials=True)
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-6)
    bm.to_mesh(me); bm.free()
    # Crease hard edges (and open boundaries) so subdivision keeps them.
    if 'crease_edge' not in me.attributes:
        me.attributes.new('crease_edge', 'FLOAT', 'EDGE')
    cr = me.attributes['crease_edge'].data
    bm = bmesh.new(); bm.from_mesh(me); bm.edges.ensure_lookup_table()
    for e in bm.edges:
        hard = len(e.link_faces) != 2 or e.calc_face_angle(math.pi) > math.radians(ang)
        cr[e.index].value = 1.0 if hard else 0.0
    bm.free()
    md = o.modifiers.new('sub', 'SUBSURF')
    md.levels = md.render_levels = 1
    md.use_creases = True
    md.uv_smooth = 'PRESERVE_BOUNDARIES'
    bpy.context.view_layer.objects.active = o
    for x in bpy.data.objects: x.select_set(x == o)
    bpy.ops.object.modifier_apply(modifier='sub')
    bpy.ops.object.shade_smooth_by_angle(angle=math.radians(ang))
    print('SMOOTH', o.name, n0, '->', len(o.data.polygons))
bpy.ops.object.select_all(action='SELECT')
bpy.ops.export_scene.gltf(filepath=a[1], use_selection=True, export_format='GLB', export_extras=True)
