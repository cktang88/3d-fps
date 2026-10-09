"""Move the arms' base-colour + normal maps (identical in every FP rig) out of each GLB into shared files next to them
(fp/arms_basecolor.webp, fp/arms_normal.webp) referenced by URI, and compact the BIN chunk. The per-rig ORM map
(carries that rig's baked AO) stays embedded. The browser then downloads the shared maps once.
  python3 tools/blender/share_arms_textures.py public/assets/models/fp/*.glb
"""
import hashlib, json, os, struct, sys


def read_glb(p):
    b = open(p, 'rb').read()
    jl = struct.unpack('<I', b[12:16])[0]
    j = json.loads(b[20:20 + jl])
    off = 20 + jl
    bl = struct.unpack('<I', b[off:off + 4])[0]
    return j, bytearray(b[off + 8:off + 8 + bl])


def write_glb(p, j, bin_):
    js = json.dumps(j, separators=(',', ':')).encode()
    js += b' ' * ((4 - len(js) % 4) % 4)
    bin_ += b'\0' * ((4 - len(bin_) % 4) % 4)
    total = 12 + 8 + len(js) + 8 + len(bin_)
    with open(p, 'wb') as f:
        f.write(struct.pack('<4sII', b'glTF', 2, total))
        f.write(struct.pack('<I4s', len(js), b'JSON')); f.write(js)
        f.write(struct.pack('<I4s', len(bin_), b'BIN\0')); f.write(bin_)


def compact(j, bin_):
    used = set()
    for a in j.get('accessors', []):
        if 'bufferView' in a: used.add(a['bufferView'])
        sp = a.get('sparse')
        if sp: used.add(sp['indices']['bufferView']); used.add(sp['values']['bufferView'])
    for im in j.get('images', []):
        if 'bufferView' in im: used.add(im['bufferView'])
    for ext in (j.get('extensions') or {}).values():
        pass
    remap, views, out = {}, [], bytearray()
    for i, v in enumerate(j['bufferViews']):
        if i not in used: continue
        while len(out) % 4: out += b'\0'
        start = v.get('byteOffset', 0)
        data = bin_[start:start + v['byteLength']]
        nv = dict(v); nv['byteOffset'] = len(out)
        out += data
        remap[i] = len(views); views.append(nv)
    j['bufferViews'] = views
    for a in j.get('accessors', []):
        if 'bufferView' in a: a['bufferView'] = remap[a['bufferView']]
        sp = a.get('sparse')
        if sp: sp['indices']['bufferView'] = remap[sp['indices']['bufferView']]; sp['values']['bufferView'] = remap[sp['values']['bufferView']]
    for im in j.get('images', []):
        if 'bufferView' in im: im['bufferView'] = remap[im['bufferView']]
    j['buffers'][0]['byteLength'] = len(out)
    return out


def main():
    for p in sys.argv[1:]:
        d = os.path.dirname(p)
        j, bin_ = read_glb(p)
        mat = next((m for m in j['materials'] if m.get('name') == 'arms'), None)
        if not mat:
            print('skip (no arms material)', p); continue
        slots = {'basecolor': (mat.get('pbrMetallicRoughness') or {}).get('baseColorTexture'), 'normal': mat.get('normalTexture')}
        moved = 0
        for slot, tref in slots.items():
            if not tref: continue
            tex = j['textures'][tref['index']]
            src = tex.get('source', (tex.get('extensions') or {}).get('EXT_texture_webp', {}).get('source'))
            im = j['images'][src]
            if 'bufferView' not in im: continue
            v = j['bufferViews'][im['bufferView']]
            data = bytes(bin_[v.get('byteOffset', 0):v.get('byteOffset', 0) + v['byteLength']])
            ext = {'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg'}[im.get('mimeType', 'image/png')]
            name = f'arms_{slot}.{ext}'
            fp = os.path.join(d, name)
            if os.path.exists(fp) and hashlib.md5(open(fp, 'rb').read()).digest() != hashlib.md5(data).digest():
                name = f'arms_{slot}_{hashlib.md5(data).hexdigest()[:8]}.{ext}'; fp = os.path.join(d, name)
            if not os.path.exists(fp):
                open(fp, 'wb').write(data)
            im.pop('bufferView'); im['uri'] = name
            moved += 1
        bin_ = compact(j, bin_)
        write_glb(p, j, bin_)
        print(os.path.basename(p), 'shared', moved, 'maps ->', round(os.path.getsize(p) / 1e6, 2), 'MB')


main()
