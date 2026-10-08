# Usage: blender -b --python inspect.py -- file.glb
import bpy, sys
from mathutils import Vector
f = sys.argv[sys.argv.index('--')+1]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=f)
for o in bpy.data.objects:
    bb = [o.matrix_world @ Vector(c) for c in o.bound_box] if o.type=='MESH' else []
    mn = [round(min(v[i] for v in bb),3) for i in range(3)] if bb else ''
    mx = [round(max(v[i] for v in bb),3) for i in range(3)] if bb else ''
    extra = ''
    if o.type=='MESH': extra = f"v={len(o.data.vertices)} mats={[m.name for m in o.data.materials][:4]} vg={len(o.vertex_groups)}"
    if o.type=='ARMATURE': extra = f"bones={len(o.data.bones)}"
    print(f"{o.type:9s} {o.name:40s} parent={o.parent.name if o.parent else '-':25s} loc={[round(x,3) for x in o.matrix_world.translation]} {mn} {mx} {extra}")
for a in bpy.data.actions: print('ACTION', a.name, a.frame_range[:])
