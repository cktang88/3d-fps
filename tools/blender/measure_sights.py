"""Measure iron-sight line + optic rail per prepped gun (canonical K-space) and print FP_TUNE entries in
WeaponRoot-local (three.js) coordinates: (x, y, z)_three = (x, z, -y)_canonical.
  blender -b --python tools/blender/measure_sights.py -- <work_dir> [ids]

Heuristics (verified on the gridded renders):
  rear sight  = highest centre-line point between the grip web and +REAR_SPAN behind/ahead of it, minus notch
  front sight = highest centre-line point in the front 35 % of the gun (front post / bead / hood top)
  rail        = receiver top at web + RAIL_AHEAD (where optics sit)
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fp_lib import *
from rigs import RIGS

K = GUN_K
HIDE = re.compile(r'Spare|Suppressor|Foregrip|OpticMount|Glass|Magazine|ChargingHandleGeometry_|Pump')
NOTCH = {'pistol': 0.003 * K, 'default': 0.004 * K}


def main():
    a = args(); work = a[0]
    ids = a[1].split(',') if len(a) > 1 else list(RIGS)
    out = {}
    for gid in ids:
        spec = RIGS[gid]
        reset()
        objs = import_glb(os.path.join(work, f'gun_{gid}.glb'))
        def hidden(o):
            p = o
            while p:
                if HIDE.search(p.name): return True
                p = p.parent
            return False
        pts = evaluated_verts([o for o in objs if o.type == 'MESH' and not hidden(o)])
        mn, mx = bbox(pts)
        L = mx.y - mn.y
        web = spec['web'][0]
        cw = 0.012 * K
        cen = [p for p in pts if abs(p.x) < cw]
        pistol = spec['cls'] == 'pistol'
        if pistol:
            rear_s = [p for p in cen if p.y < mn.y + 0.22 * L and p.z > mx.z - 0.05 * K]
        else:
            rear_s = [p for p in cen if web - 0.06 * K < p.y < web + 0.30 * K]
        front_s = [p for p in cen if p.y > mx.y - (0.15 if pistol else 0.35) * L]
        rp = max(rear_s, key=lambda p: p.z); fp = max(front_s, key=lambda p: p.z)
        notch = NOTCH['pistol' if pistol else 'default']
        rear = Vector((0, rp.y, rp.z - notch)); front = Vector((0, fp.y, fp.z - 0.001 * K))
        ry = web + (0.06 if pistol else 0.16) * K
        top = [p for p in cen if abs(p.y - ry) < 0.02 * K]
        rail = Vector((0, ry, max(p.z for p in top)))
        t3 = lambda v: [round(v.x, 4), round(v.z, 4), round(-v.y, 4)]
        out[gid] = {'ironRear': t3(rear), 'ironFront': t3(front), 'rail': t3(rail),
                    'rearSrc': [round(rp.y, 3), round(rp.z, 3)], 'frontSrc': [round(fp.y, 3), round(fp.z, 3)]}
        print('SIGHTS', gid, json.dumps(out[gid]))
    save_json(os.path.join(work, 'sights.json'), out)


main()
