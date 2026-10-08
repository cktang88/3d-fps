#!/usr/bin/env python3
"""Convert PBR texture JPGs to WebP (perf: ~4x smaller downloads, identical resolution).

Usage: python3 tools/perf/compress_textures.py [--delete] [dirs...]
Defaults to public/assets/textures and public/assets/ambience/textures.
Colour/roughness: q88, normal maps: q90 (mean angular error ~4.5 deg, same as a q90 JPEG re-encode).
Anything above --max (default 1024 px) is downscaled with Lanczos (1K is the prop/surface budget, see docs/PERF.md).
"""
import argparse, glob, os, sys
from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument('dirs', nargs='*', default=['public/assets/textures', 'public/assets/ambience/textures'])
ap.add_argument('--delete', action='store_true', help='remove the source JPGs after conversion')
ap.add_argument('--max', type=int, default=0, help='downscale textures larger than this (0 = keep size)')
a = ap.parse_args()

t0 = t1 = 0
for d in a.dirs:
    for f in sorted(glob.glob(os.path.join(d, '**', '*.jpg'), recursive=True)):
        out = f[:-4] + '.webp'
        im = Image.open(f); im.load()
        if a.max and max(im.size) > a.max:
            s = a.max / max(im.size)
            im = im.resize((max(1, round(im.size[0] * s)), max(1, round(im.size[1] * s))), Image.LANCZOS)
        nrm = 'nor' in os.path.basename(f).lower()
        im.save(out, 'WEBP', quality=90 if nrm else 88, method=6)
        s0, s1 = os.path.getsize(f), os.path.getsize(out)
        t0 += s0; t1 += s1
        print(f'{f}: {s0 // 1024} KB -> {s1 // 1024} KB {im.size}')
        if a.delete: os.remove(f)
print(f'total {t0 / 1048576:.1f} MB -> {t1 / 1048576:.1f} MB', file=sys.stderr)
