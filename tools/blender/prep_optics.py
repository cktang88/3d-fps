"""Build public/assets/models/weapons/optics.glb from realistic CC-BY optics, keeping the steel-tide contract:

  <P>Optic (P = Micro | Holo | Scope | Sniper)  optical axis on the node origin, +Y (Blender) = toward target
    <P>Geometry                                   housing + mount (lens / reticle planes removed: the game draws them)
    <P>ReticleAnchor, <P>RearApertureAnchor       eye-side end of the optical axis
    <P>FrontApertureAnchor                        objective end

Scale: rail-to-axis height == the ViewModel contact constant (micro 0.070, holo 0.092, scope/sniper 0.084),
so placement code is unchanged. Usage: blender -b --python tools/blender/prep_optics.py -- <sf_dir> <out.glb>
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fp_lib import *

OPTICS = {
    # prefix: (source, rotZ deg so the objective faces +Y, lens regex (axis + radius), drop regex, contact)
    'Micro': ('o_reddot/model.glb', 180, r'^wSphere', r'^wSphere', 0.070),
    'Holo': ('o_holo/model.glb', 180, r'^1\.00[134]_', r'^1\.00[134]_', 0.092),
    'Scope': ('o_acog/model.glb', 0, None, None, 0.084),
    'Sniper': ('o_scope/model.glb', 0, r'^Object_4$', r'^Object_[24]$', 0.084),
}


def main():
    a = args(); sf, out = a[0], a[1]
    reset()
    top = bpy.data.objects.new('SteelTideAuthoredOptics', None); bpy.context.scene.collection.objects.link(top)
    report = {}
    for P, (src, rz, lens_rx, drop_rx, contact) in OPTICS.items():
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=os.path.join(sf, src))
        new = [o for o in bpy.data.objects if o not in before]
        bpy.context.view_layer.update()
        meshes = [o for o in new if o.type == 'MESH']
        for o in meshes:
            o.data = o.data.copy(); o.data.transform(o.matrix_world)
        for o in meshes:
            o.parent = None; o.matrix_world = Matrix()
        for o in new:
            if o.type != 'MESH': bpy.data.objects.remove(o, do_unlink=True)
        meshes = [o for o in meshes if o.name in bpy.data.objects]
        R = Matrix.Rotation(math.radians(rz), 4, 'Z')
        for o in meshes: o.data.transform(R)
        pts = [v.co for o in meshes for v in o.data.vertices]
        mn, mx = bbox(pts)
        # Long axis must be Y.
        ext = mx - mn
        if ext.x > ext.y:
            for o in meshes: o.data.transform(Matrix.Rotation(math.radians(90), 4, 'Z'))
        lens = [o for o in meshes if lens_rx and re.match(lens_rx, o.name)]
        if lens:
            lp = [v.co for o in lens for v in o.data.vertices]; lmn, lmx = bbox(lp)
            axis = Vector(((lmn.x + lmx.x) / 2, 0, (lmn.z + lmx.z) / 2))
            lens_r = min(lmx.x - lmn.x, lmx.z - lmn.z) / 2
        else:
            # Eyepiece ring: the rear-most 6% slab of the housing.
            pts = [v.co for o in meshes for v in o.data.vertices]; mn, mx = bbox(pts)
            sl = [p for p in pts if p.y < mn.y + 0.06 * (mx.y - mn.y)]
            smn, smx = bbox(sl)
            axis = Vector(((smn.x + smx.x) / 2, 0, (smn.z + smx.z) / 2)); lens_r = min(smx.x - smn.x, smx.z - smn.z) / 2
        if drop_rx:
            for o in list(meshes):
                if re.match(drop_rx, o.name):
                    bpy.data.objects.remove(o, do_unlink=True); meshes.remove(o)
        pts = [v.co for o in meshes for v in o.data.vertices]; mn, mx = bbox(pts)
        f = contact / (axis.z - mn.z)
        T = Matrix.Scale(f, 4) @ Matrix.Translation((-axis.x, -(mn.y + mx.y) / 2, -axis.z))
        for o in meshes: o.data.transform(T)
        pts = [v.co for o in meshes for v in o.data.vertices]; mn, mx = bbox(pts)
        bpy.ops.object.select_all(action='DESELECT')
        for o in meshes: o.select_set(True)
        bpy.context.view_layer.objects.active = meshes[0]
        bpy.ops.object.join()
        g = bpy.context.view_layer.objects.active; g.name = P + 'Geometry'
        node = bpy.data.objects.new(P + 'Optic', None); bpy.context.scene.collection.objects.link(node)
        node.parent = top; g.parent = node
        for nm, y in ((P + 'ReticleAnchor', mn.y), (P + 'RearApertureAnchor', mn.y), (P + 'FrontApertureAnchor', mx.y)):
            e = bpy.data.objects.new(nm, None); bpy.context.scene.collection.objects.link(e)
            e.parent = node; e.location = (0, y, 0)
        node['lensRadius'] = lens_r * f
        report[P] = dict(scale=round(f, 4), length=round(mx.y - mn.y, 4), width=round(mx.x - mn.x, 4), lensR=round(lens_r * f, 4), bottom=round(mn.z, 4))
        print('OPTIC', P, report[P])
        if P != 'Sniper':
            node.location.x = {'Micro': -0.3, 'Holo': 0, 'Scope': 0.3}[P]
    # Side render for review (nodes spread along X).
    vis = [o for o in bpy.data.objects if o.type == 'MESH']
    side_render(vis, out + '.side.png', step=0.02)
    for o in bpy.data.objects:
        if o.name.endswith('Optic'): o.location = (0, 0, 0)
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.export_scene.gltf(filepath=out, use_selection=True, export_format='GLB', export_extras=True)
    save_json(out + '.json', report)


main()
