"""Draw the metric grid on side renders whose metadata Blender left in <png>.json (system python + PIL).
  python3 tools/blender/gridify.py <png>..."""
import json, math, sys, os
from PIL import Image, ImageDraw
for png in sys.argv[1:]:
    if not os.path.exists(png + '.json'):
        continue
    m = json.load(open(png + '.json'))
    im = Image.open(png).convert('RGB'); d = ImageDraw.Draw(im)
    Wpx, Hpx = im.size; s = Wpx / m['W']; step = m.get('step', 0.02)
    X = lambda y: Wpx / 2 + (y - m['cy']) * s
    Y = lambda z: Hpx / 2 - (z - m['cz']) * s
    i0 = math.floor((m['cy'] - m['W'] / 2) / step)
    for i in range(i0, i0 + int(m['W'] / step) + 2):
        y = i * step; major = i % 5 == 0
        col = (255, 0, 0) if major else (255, 215, 0)
        d.line([(X(y), 0), (X(y), Hpx)], fill=col, width=1)
        if major: d.text((X(y) + 2, 2), f"{y:.2f}", fill=col)
    hz = m['W'] * Hpx / Wpx / 2
    j0 = math.floor((m['cz'] - hz) / step)
    for j in range(j0, j0 + int(2 * hz / step) + 2):
        z = j * step; major = j % 5 == 0
        col = (0, 0, 255) if major else (0, 170, 255)
        d.line([(0, Y(z)), (Wpx, Y(z))], fill=col, width=1)
        if major: d.text((2, Y(z) + 2), f"{z:.2f}", fill=col)
    im.save(png)
    os.remove(png + '.json')
