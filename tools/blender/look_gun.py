"""Beauty render of a normalised gun GLB (EEVEE, 3/4 view) for material QA.
  blender -b --python tools/blender/look_gun.py -- gun.glb out.png"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fp_lib import *
a = args(); reset(); objs = import_glb(a[0])
pts = evaluated_verts([o for o in objs if o.type == 'MESH']); mn, mx = bbox(pts); c = (mn + mx) / 2; r = (mx - mn).length
setup_render(a[1], 960, 540, samples=16)
loc = c + Vector((r * 0.55, -r * 0.25, r * 0.22))
make_camera(Matrix.Translation(loc) @ (c - loc).to_track_quat('-Z', 'Y').to_matrix().to_4x4(), vfov_deg=40)
render(a[1])
