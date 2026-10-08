"""Trademark hygiene for gun textures: erase roll-marks / logos in given gun-frame rectangles.
For each rectangle (canonical K-space: side 'R'|'L', y0, y1, z0, z1) rays are cast at the gun from that side;
the hit UVs give a texel mask that is in-painted (blurred from the surrounding texels) in base colour and
flattened in the normal map.  Runs inside prep: blender -b --python blank_marks.py -- <gun.glb> <id>
(re-exports the GLB in place)."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fp_lib import *
import numpy as np
import mathutils, mathutils.geometry

MARKS = {
    # COLT AUTOMATIC / CALIBRE .45 (right side of slide) + left-side GOVERNMENT MODEL / COLT markings
    'm1911': [('R', 0.02, 0.13, 0.075, 0.12), ('L', -0.13, 0.13, 0.06, 0.125), ('L', -0.10, 0.0, 0.03, 0.065)],
}


def blur_fill(px, mask, it=40):
    out = px.copy(); m = mask.copy()
    for _ in range(it):
        if not m.any(): break
        acc = np.zeros_like(out); cnt = np.zeros(m.shape, np.float32)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            sh = np.roll(np.roll(out, dy, 0), dx, 1); shm = np.roll(np.roll(~m, dy, 0), dx, 1)
            acc += sh * shm[..., None]; cnt += shm
        fill = m & (cnt > 0)
        out[fill] = acc[fill] / cnt[fill][:, None]
        m = m & ~fill
    return out


def main():
    a = args(); path, gid = a[0], a[1]
    reset(); objs = import_glb(path)
    meshes = [o for o in objs if o.type == 'MESH']
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    masks = {}
    for side, y0, y1, z0, z1 in MARKS.get(gid, []):
        sx = 1 if side == 'R' else -1
        for y in np.linspace(y0, y1, 120):
            for z in np.linspace(z0, z1, 50):
                hit, loc, nrm, idx, ob, _ = bpy.context.scene.ray_cast(dg, Vector((sx * 0.5, y, z)), Vector((-sx, 0, 0)))
                if not hit or ob.type != 'MESH': continue
                me = ob.data
                if not me.loop_triangles: me.calc_loop_triangles()
                uvl = me.uv_layers[0].data
                lp = ob.matrix_world.inverted() @ loc
                uv = None
                for t in me.loop_triangles:
                    if t.polygon_index != idx: continue
                    a_, b_, c_ = (me.vertices[me.loops[l].vertex_index].co for l in t.loops)
                    bary = mathutils.geometry.barycentric_transform(lp, a_, b_, c_, Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1)))
                    if min(bary) > -1e-3:
                        ua, ub, uc = (uvl[l].uv for l in t.loops)
                        uv = ua * bary.x + ub * bary.y + uc * bary.z
                        break
                if uv is None: continue
                for m in me.materials:
                    if not m or not m.node_tree: continue
                    for n in m.node_tree.nodes:
                        if n.type == 'TEX_IMAGE' and n.image:
                            masks.setdefault(n.image.name, []).append((uv.x, uv.y))
    for name, uvs in masks.items():
        img = bpy.data.images[name]; w, h = img.size
        if not w: continue
        px = np.array(img.pixels[:], np.float32).reshape(h, w, 4)
        mk = np.zeros((h, w), bool)
        r = max(2, w // 400)
        for u, v in uvs:
            x = int((u % 1) * w); yv = int((v % 1) * h)
            mk[max(0, yv - r):yv + r, max(0, x - r):x + r] = True
        is_normal = 'normal' in name.lower() or px[..., 2].mean() > 0.7 and abs(px[..., 0].mean() - 0.5) < 0.1
        if is_normal:
            px[mk, :3] = (0.5, 0.5, 1.0)
        else:
            px[..., :3] = blur_fill(px[..., :3], mk)
        img.pixels[:] = px.ravel(); img.update()
        # Re-pack from the edited buffer (packing a dirty image as PNG); the glTF exporter reads packed data.
        img.file_format = 'PNG'; img.filepath_raw = f'/tmp/_blank_{gid}_{name}.png'; img.save(); img.unpack(method='REMOVE') if img.packed_file else None
        img.filepath = img.filepath_raw; img.reload(); img.pack()
        if os.environ.get('FP_DEBUG'):
            mi = bpy.data.images.new('m_' + name, w, h); mm = np.zeros((h, w, 4), np.float32); mm[mk] = 1; mm[..., 3] = 1
            mi.pixels[:] = mm.ravel(); mi.filepath_raw = f'/tmp/_mask_{gid}_{name}.png'; mi.file_format = 'PNG'; mi.save()
        print('BLANKED', gid, name, int(mk.sum()), 'texels', 'normal' if is_normal else 'colour')
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.export_scene.gltf(filepath=path, use_selection=True, export_format='GLB', export_extras=True)


main()
