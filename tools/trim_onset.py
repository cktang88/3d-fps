"""Trim leading silence of gunshot samples so playback is instant; cap length with a fade."""
import sys, os, subprocess
import numpy as np
d = sys.argv[1]
maxlen = float(sys.argv[2]) if len(sys.argv) > 2 else 1.4
for fn in sorted(os.listdir(d)):
    if not fn.endswith('.ogg'):
        continue
    p = os.path.join(d, fn)
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', p, '-f', 'f32le', '-ac', '1', '-ar', '44100', '-'], capture_output=True, check=True).stdout
    x = np.frombuffer(raw, np.float32).copy()
    e = np.abs(x)
    on = int(np.argmax(e > e.max() * 0.2))
    s = max(0, on - int(44100 * 0.004))
    seg = x[s:s + int(44100 * maxlen)]
    f = min(len(seg) // 3, int(44100 * 0.25))
    seg[-f:] *= np.linspace(1, 0, f) ** 2
    seg *= 0.95 / max(1e-6, np.abs(seg).max())
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'f32le', '-ar', '44100', '-ac', '1', '-i', '-', '-c:a', 'libvorbis', '-q:a', '6', p],
                   input=seg.astype(np.float32).tobytes(), check=True)
    print(f'{fn}: trimmed {s/44100:.3f}s, len {len(seg)/44100:.2f}s')
