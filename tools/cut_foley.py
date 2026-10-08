"""Extract the first transient event from long field recordings, normalise, export OGG.
Usage: python3 cut_foley.py <in_dir> <out_dir>"""
import sys, os, subprocess, wave
import numpy as np

src, dst = sys.argv[1], sys.argv[2]
os.makedirs(dst, exist_ok=True)
MAXLEN = {'rack': 1.3, 'pump': 1.0, 'bolt_back': 0.8, 'bolt_fwd': 0.8, 'boltdrop': 0.8, 'slide': 0.8}

for fn in sorted(os.listdir(src)):
    if not fn.endswith('.wav'):
        continue
    name = fn[:-4]
    tmp = os.path.join(dst, name + '.tmp.wav')
    # Decode to mono 44.1k float via ffmpeg.
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', os.path.join(src, fn), '-ac', '1', '-ar', '44100', '-f', 'f32le', '-'],
                         capture_output=True, check=True).stdout
    x = np.frombuffer(raw, dtype=np.float32)
    sr = 44100
    win = int(sr * 0.005)
    env = np.sqrt(np.convolve(x * x, np.ones(win) / win, mode='same'))
    peak = env.max()
    thr_on = peak * 0.12
    onset = int(np.argmax(env > thr_on))
    start = max(0, onset - int(sr * 0.01))
    maxlen = next((v for k, v in MAXLEN.items() if k in name), 0.6)
    # End when envelope stays below 3% of peak for 120 ms, capped.
    quiet = env < peak * 0.03
    end = min(len(x), start + int(sr * maxlen))
    run = 0
    for i in range(onset, end):
        run = run + 1 if quiet[i] else 0
        if run > sr * 0.12 and i - onset > sr * 0.05:
            end = i
            break
    seg = x[start:end].copy()
    fade = min(len(seg) // 4, int(sr * 0.04))
    seg[-fade:] *= np.linspace(1, 0, fade)
    seg /= max(1e-6, np.abs(seg).max()) / 0.89
    out = os.path.join(dst, name + '.ogg')
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'f32le', '-ar', '44100', '-ac', '1', '-i', '-', '-c:a', 'libvorbis', '-q:a', '5', out],
                   input=seg.astype(np.float32).tobytes(), check=True)
    print(f'{name}: {len(seg)/sr:.2f}s')
