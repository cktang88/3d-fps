"""Zoomed gridded side/top render of a GLB region:  -- in.glb out.png y0 y1 z0 z1 step [right|top] [hide_regex]"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fp_lib import *
a = args(); reset(); objs = import_glb(a[0], rig=True)
if len(a) > 8:
    for o in objs:
        if re.search(a[8], o.name): o.hide_render = True
side_render(objs, a[1], step=float(a[6]), region=tuple(map(float, a[2:6])), view=a[7] if len(a) > 7 else 'right')
