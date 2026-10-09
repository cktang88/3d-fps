"""Measure first-person arm screen coverage on QA mask shots (arms rendered flat emissive magenta).
  python3 tools/qa/arm_coverage.py tools/qa/results/<id>/   -> per-frame % of screen and % of the central 20% box
Prints a table and writes coverage.json + a contact sheet (coverage_sheet.png) next to the shots."""
import glob, json, os, sys
from PIL import Image, ImageDraw
import numpy as np

d = sys.argv[1]
rows = {}
for f in sorted(glob.glob(os.path.join(d, '*.png'))):
    name = os.path.basename(f)[:-4]
    if name.startswith('coverage'):
        continue
    a = np.asarray(Image.open(f).convert('RGB')).astype(int)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    m = (r > 140) & (b > 140) & (g < 0.55 * np.minimum(r, b))
    h, w = m.shape
    cb = m[int(h * 0.4):int(h * 0.6), int(w * 0.4):int(w * 0.6)]
    upper = m[: int(h * 0.55)]
    rows[name] = {'screen%': round(100 * m.mean(), 1), 'center%': round(100 * cb.mean(), 1), 'upper55%': round(100 * upper.mean(), 1)}
json.dump(rows, open(os.path.join(d, 'coverage.json'), 'w'), indent=1)
for k, v in rows.items():
    print(f"{k:22s} screen {v['screen%']:5.1f}%  centre-box {v['center%']:5.1f}%  upper-55% {v['upper55%']:5.1f}%")
# contact sheet per strip prefix
strips = {}
for k in rows:
    strips.setdefault('_'.join(k.split('_')[:2]), []).append(k)
W, H = 256, 144
sheet = Image.new('RGB', (W * 9, H * len(strips)))
dr = ImageDraw.Draw(sheet)
for j, (pre, ks) in enumerate(sorted(strips.items())):
    for i, k in enumerate(sorted(ks)[:9]):
        im = Image.open(os.path.join(d, k + '.png')).convert('RGB').resize((W, H))
        sheet.paste(im, (i * W, j * H))
        dr.rectangle([i * W, j * H, i * W + W, j * H + 12], fill='black')
        dr.text((i * W + 2, j * H + 1), f"{k} {rows[k]['screen%']}% c{rows[k]['center%']}%", fill='yellow')
sheet.save(os.path.join(d, 'coverage_sheet.png'))
