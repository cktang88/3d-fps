#!/usr/bin/env python3
"""Montage a QA result's screenshots into contact sheets, grouped by name prefix (text before the last '_').
Usage: python3 tools/qa/contact.py tools/qa/results/<id> [cols]   -> <id>/contact_<prefix>.png"""
import json, os, sys
from PIL import Image, ImageDraw
d = sys.argv[1]; cols = int(sys.argv[2]) if len(sys.argv) > 2 else 4
r = json.load(open(os.path.join(d, 'result.json')))
groups = {}
for s in r.get('shots', []):
    n = os.path.basename(s)[:-4]
    groups.setdefault(n.rsplit('_', 1)[0], []).append(n)
for g, names in groups.items():
    ims = [Image.open(os.path.join(d, n + '.png')).convert('RGB') for n in names]
    w, h = ims[0].size; rows = (len(ims) + cols - 1) // cols
    sheet = Image.new('RGB', (w * cols, h * rows), (20, 20, 20)); dr = ImageDraw.Draw(sheet)
    for k, (im, n) in enumerate(zip(ims, names)):
        x, y = (k % cols) * w, (k // cols) * h; sheet.paste(im, (x, y))
        info = r.get('data', {}).get(n)
        dr.text((x + 4, y + 4), n + ('  ' + json.dumps(info)[:70] if info else ''), fill=(255, 255, 0))
    out = os.path.join(d, f'contact_{g}.png'); sheet.save(out); print(out)
