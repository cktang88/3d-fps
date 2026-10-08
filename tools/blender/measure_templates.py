"""Report gun length and hand size per extracted template (to pick a consistent arm scale)."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fp_lib import *
work = args()[0]
T = load_json(os.path.join(work, 'templates.json'))
for k, t in T.items():
    B = {n: Matrix(m) for n, m in t['bones'].items()}
    mn, mx = t['gun_bbox']
    for side in 'LR':
        h = B['Hand_' + side].translation
        tips = {n: (B[n].translation - h).length for n in B if n.startswith(f'Bone_{side}.') and n.endswith('_end')}
        w = (B[f'Bone_{side}.004'].translation - B[f'Bone_{side}.016'].translation).length
        sh = B['Arm_' + side].translation; el = B['Forearm_' + side].translation
        print(k, side, 'gunlen', round(mx[1] - mn[1], 3), 'hand->tips', {n[7:10]: round(v, 3) for n, v in tips.items()},
              'shoulder', [round(x, 3) for x in B['UpArm_' + side].translation], 'elbow', [round(x, 3) for x in el], 'hand', [round(x, 3) for x in h])
