import * as THREE from 'three';

// Procedurally generated effect textures (canvas based), so effects have no external deps.

const canvas = (w, h = w) => {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')];
};

// Value-noise fbm for organic shapes.
function makeNoise(seed = 1) {
  const p = new Uint8Array(512);
  let s = seed * 9301 + 49297;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) { const j = (rnd() * (i + 1)) | 0; [p[i], p[j]] = [p[j], p[i]]; }
  for (let i = 0; i < 256; i++) p[i + 256] = p[i];
  const fade = (t) => t * t * (3 - 2 * t);
  const n2 = (x, y) => {
    const xi = Math.floor(x) & 255, yi = Math.floor(y) & 255, xf = x - Math.floor(x), yf = y - Math.floor(y);
    const a = p[p[xi] + yi] / 255, b = p[p[xi + 1] + yi] / 255, c = p[p[xi] + yi + 1] / 255, d = p[p[xi + 1] + yi + 1] / 255;
    const u = fade(xf), v = fade(yf);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  return (x, y, oct = 4) => {
    let f = 0, amp = 0.5, fr = 1;
    for (let i = 0; i < oct; i++) { f += amp * n2(x * fr, y * fr); amp *= 0.5; fr *= 2; }
    return f;
  };
}

const tex = (c, srgb = true) => {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
};

/** 2x2 atlas of muzzle flash shapes (front view star bursts), additive. */
export function muzzleFlashAtlas() {
  const S = 256, [c, g] = canvas(S * 2);
  for (let k = 0; k < 4; k++) {
    const ox = (k % 2) * S + S / 2, oy = Math.floor(k / 2) * S + S / 2;
    g.save();
    g.translate(ox, oy);
    g.globalCompositeOperation = 'lighter';
    const prongs = 4 + k;
    for (let i = 0; i < prongs; i++) {
      const a = (i / prongs) * Math.PI * 2 + k * 0.4 + Math.random() * 0.3;
      const len = S * (0.32 + Math.random() * 0.16);
      g.save(); g.rotate(a);
      const gr = g.createLinearGradient(0, 0, len, 0);
      gr.addColorStop(0, 'rgba(255,240,200,1)');
      gr.addColorStop(0.4, 'rgba(255,170,60,0.8)');
      gr.addColorStop(1, 'rgba(255,90,10,0)');
      g.fillStyle = gr;
      g.beginPath(); g.moveTo(0, -S * 0.05); g.quadraticCurveTo(len * 0.5, -S * 0.03, len, 0); g.quadraticCurveTo(len * 0.5, S * 0.03, 0, S * 0.05); g.fill();
      g.restore();
    }
    const rg = g.createRadialGradient(0, 0, 0, 0, 0, S * 0.22);
    rg.addColorStop(0, 'rgba(255,255,240,1)');
    rg.addColorStop(0.35, 'rgba(255,210,120,0.9)');
    rg.addColorStop(1, 'rgba(255,120,20,0)');
    g.fillStyle = rg; g.beginPath(); g.arc(0, 0, S * 0.22, 0, Math.PI * 2); g.fill();
    g.restore();
  }
  return tex(c);
}

/** Side-view flash (elongated cone) for the third-person / side planes. */
export function muzzleSideTex() {
  const W = 256, H = 128, [c, g] = canvas(W, H);
  g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 6; i++) {
    const len = W * (0.55 + Math.random() * 0.4), w = H * (0.12 + Math.random() * 0.15);
    const gr = g.createLinearGradient(0, 0, len, 0);
    gr.addColorStop(0, 'rgba(255,245,210,0.9)');
    gr.addColorStop(0.3, 'rgba(255,170,60,0.6)');
    gr.addColorStop(1, 'rgba(255,80,0,0)');
    g.fillStyle = gr;
    g.beginPath(); g.moveTo(0, H / 2 - w * 0.3); g.quadraticCurveTo(len * 0.4, H / 2 - w, len, H / 2 + (Math.random() - 0.5) * w); g.quadraticCurveTo(len * 0.4, H / 2 + w, 0, H / 2 + w * 0.3); g.fill();
  }
  return tex(c);
}

/** 4x4 atlas of smoke puffs (alpha). */
export function smokeAtlas() {
  const S = 128, N = 4, [c, g] = canvas(S * N);
  const img = g.createImageData(S * N, S * N);
  for (let k = 0; k < N * N; k++) {
    const noise = makeNoise(k + 3);
    const ox = (k % N) * S, oy = Math.floor(k / N) * S;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const dx = (x - S / 2) / (S / 2), dy = (y - S / 2) / (S / 2);
      const r = Math.sqrt(dx * dx + dy * dy);
      const n = noise(x / 22 + k * 7, y / 22, 5);
      let a = Math.max(0, 1 - r * (1.05 + (0.6 - n) * 0.9));
      a = Math.pow(a, 1.4) * (0.55 + n * 0.8);
      const shade = 200 + n * 55;
      const i = ((oy + y) * S * N + ox + x) * 4;
      img.data[i] = shade; img.data[i + 1] = shade; img.data[i + 2] = shade;
      img.data[i + 3] = Math.min(255, a * 255);
    }
  }
  g.putImageData(img, 0, 0);
  return tex(c);
}

/** Soft glow dot (sparks, tracers, lights). */
export function glowTex() {
  const S = 64, [c, g] = canvas(S);
  const rg = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  rg.addColorStop(0, 'rgba(255,255,255,1)');
  rg.addColorStop(0.25, 'rgba(255,255,255,0.8)');
  rg.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = rg; g.fillRect(0, 0, S, S);
  return tex(c);
}

/** Tracer streak: bright core, soft edges, fading tail (u along length). */
export function tracerTex() {
  const W = 256, H = 32, [c, g] = canvas(W, H);
  const lg = g.createLinearGradient(0, 0, W, 0);
  lg.addColorStop(0, 'rgba(255,255,255,0)');
  lg.addColorStop(0.7, 'rgba(255,255,255,0.6)');
  lg.addColorStop(1, 'rgba(255,255,255,1)');
  g.fillStyle = lg; g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = 'destination-in';
  const vg = g.createLinearGradient(0, 0, 0, H);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(0.5, 'rgba(0,0,0,1)'); vg.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = vg; g.fillRect(0, 0, W, H);
  return tex(c);
}

/**
 * Bullet hole decal atlas (2x2 variants) + matching normal map.
 * Height field: crater rim, deep centre, radial cracks & chips. Normals derived via Sobel.
 */
export function bulletHoleTextures(kind = 'concrete') {
  const S = 128, N = 2, W = S * N;
  const height = new Float32Array(W * W);
  const alpha = new Float32Array(W * W);
  const color = new Float32Array(W * W);
  for (let k = 0; k < 4; k++) {
    const noise = makeNoise(k * 11 + (kind === 'metal' ? 50 : kind === 'wood' ? 90 : 7));
    const ox = (k % N) * S, oy = Math.floor(k / N) * S;
    const cracks = [];
    const nc = kind === 'metal' ? 0 : 5 + k;
    for (let i = 0; i < nc; i++) cracks.push({ a: Math.random() * Math.PI * 2, len: 0.45 + Math.random() * 0.45, w: 0.03 + Math.random() * 0.03 });
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const dx = (x - S / 2) / (S / 2), dy = (y - S / 2) / (S / 2);
      const r = Math.sqrt(dx * dx + dy * dy), ang = Math.atan2(dy, dx);
      const n = noise(x / 9, y / 9, 4);
      const holeR = kind === 'metal' ? 0.14 : 0.16 + n * 0.06;
      const chipR = kind === 'metal' ? 0.32 : 0.45 + n * 0.25;
      let h = 0, a = 0, col = 1;
      if (r < holeR) { h = -1; a = 1; col = 0.04; }
      else if (r < chipR) {
        const t = (r - holeR) / (chipR - holeR);
        h = -0.6 * (1 - t) + (kind === 'metal' ? 0.5 * Math.exp(-((t - 0.15) ** 2) * 60) : 0) + (n - 0.5) * 0.4;
        a = Math.pow(1 - t, 0.7) * (kind === 'metal' ? 1 : 0.95);
        col = kind === 'metal' ? 0.55 + t * 0.4 : 0.35 + t * 0.5 + (n - 0.5) * 0.3;
      }
      for (const cr of cracks) {
        let d = Math.abs(((ang - cr.a + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        d += (n - 0.5) * 0.15;
        if (r < cr.len && d < cr.w * (1 - r / cr.len)) { h = Math.min(h, -0.4); a = Math.max(a, 0.9 * (1 - r / cr.len)); col = Math.min(col, 0.15); }
      }
      // Soot / dust ring.
      const soot = Math.max(0, 1 - r / (kind === 'metal' ? 0.55 : 0.9)) * 0.45 * (0.6 + n * 0.8);
      if (a < soot) { a = soot; col = Math.min(col, 0.3); }
      const i = (oy + y) * W + ox + x;
      height[i] = h; alpha[i] = a; color[i] = col;
    }
  }
  const [c, g] = canvas(W), [cn, gn] = canvas(W);
  const img = g.createImageData(W, W), imn = gn.createImageData(W, W);
  const tint = kind === 'metal' ? [190, 190, 195] : kind === 'wood' ? [120, 82, 50] : [150, 145, 135];
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const v = color[i];
    img.data[i * 4] = tint[0] * v; img.data[i * 4 + 1] = tint[1] * v; img.data[i * 4 + 2] = tint[2] * v;
    img.data[i * 4 + 3] = alpha[i] * 255;
    const hx = (height[y * W + Math.min(W - 1, x + 1)] - height[y * W + Math.max(0, x - 1)]) * 2.5;
    const hy = (height[Math.min(W - 1, y + 1) * W + x] - height[Math.max(0, y - 1) * W + x]) * 2.5;
    const len = Math.sqrt(hx * hx + hy * hy + 1);
    imn.data[i * 4] = ((-hx / len) * 0.5 + 0.5) * 255;
    imn.data[i * 4 + 1] = ((hy / len) * 0.5 + 0.5) * 255;
    imn.data[i * 4 + 2] = ((1 / len) * 0.5 + 0.5) * 255;
    imn.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0); gn.putImageData(imn, 0, 0);
  return { map: tex(c), normal: tex(cn, false) };
}

export function bloodTex() {
  const S = 256, [c, g] = canvas(S);
  const noise = makeNoise(42);
  const img = g.createImageData(S, S);
  const blobs = [];
  for (let i = 0; i < 14; i++) {
    const a = Math.random() * Math.PI * 2, d = Math.random() * 0.6;
    blobs.push({ x: Math.cos(a) * d, y: Math.sin(a) * d, r: 0.04 + Math.random() * (0.25 - d * 0.25) });
  }
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = (x - S / 2) / (S / 2), dy = (y - S / 2) / (S / 2);
    let f = 0;
    for (const b of blobs) { const d = Math.hypot(dx - b.x, dy - b.y); f = Math.max(f, 1 - d / b.r); }
    const n = noise(x / 12, y / 12, 4);
    const a = f > 0 ? Math.min(1, f * 3 + n * 0.3) : 0;
    const i = (y * S + x) * 4;
    img.data[i] = 90 + n * 40; img.data[i + 1] = 6; img.data[i + 2] = 8; img.data[i + 3] = a * 235;
  }
  g.putImageData(img, 0, 0);
  return tex(c);
}

export function scorchTex() {
  const S = 256, [c, g] = canvas(S);
  const noise = makeNoise(5);
  const img = g.createImageData(S, S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = (x - S / 2) / (S / 2), dy = (y - S / 2) / (S / 2);
    const r = Math.sqrt(dx * dx + dy * dy);
    const n = noise(x / 16, y / 16, 5);
    const a = Math.max(0, 1 - r * (1 + (0.5 - n))) ** 0.8;
    const i = (y * S + x) * 4;
    img.data[i] = 15; img.data[i + 1] = 13; img.data[i + 2] = 12; img.data[i + 3] = a * 240;
  }
  g.putImageData(img, 0, 0);
  return tex(c);
}

/** Lens / scope dirt + reticle textures. */
export function reticleTex(type = 'dot', color = '#ff2a1a') {
  const S = 256, [c, g] = canvas(S);
  g.translate(S / 2, S / 2);
  g.fillStyle = color; g.strokeStyle = color;
  g.shadowColor = color; g.shadowBlur = 8;
  // Designs fill the quad: the quad's angular size is set by the optic (ViewModel reticleAngle).
  if (type === 'dot') {
    g.shadowBlur = 26;
    g.beginPath(); g.arc(0, 0, 30, 0, Math.PI * 2); g.fill();
    g.shadowBlur = 6; g.fillStyle = '#ffd0c8';
    g.beginPath(); g.arc(0, 0, 11, 0, Math.PI * 2); g.fill();
  } else if (type === 'holo') {
    // EOTech-style ring + centre dot, ring ticks at the cardinal points. Thick strokes with a soft
    // glow so the ring survives downsampling at 1080p and below.
    g.shadowBlur = 10;
    g.lineWidth = 11; g.beginPath(); g.arc(0, 0, 92, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.arc(0, 0, 12, 0, Math.PI * 2); g.fill();
    for (const a of [0, Math.PI / 2, Math.PI * 1.5]) {
      g.save(); g.rotate(a); g.fillRect(-5, -118, 10, 26); g.restore();
    }
  } else if (type === 'chevron') {
    g.lineWidth = 6;
    g.beginPath(); g.moveTo(-20, 20); g.lineTo(0, 0); g.lineTo(20, 20); g.stroke();
    g.fillRect(-2, 26, 4, 70);
  }
  return tex(c);
}

/** Generic tileable noise texture for grime / variation. */
export function grimeTex(size = 256, seed = 9) {
  const [c, g] = canvas(size);
  const noise = makeNoise(seed);
  const img = g.createImageData(size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    // Tileable by sampling torus-ish: blend 4 offsets.
    const fx = x / size, fy = y / size;
    const s = (u, v) => noise(u * 8, v * 8, 5);
    const n = s(fx, fy) * (1 - fx) * (1 - fy) + s(fx + 1, fy) * fx * (1 - fy) + s(fx, fy + 1) * (1 - fx) * fy + s(fx + 1, fy + 1) * fx * fy;
    const v = Math.max(0, Math.min(255, n * 255));
    const i = (y * size + x) * 4;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = tex(c, false);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

export { makeNoise };
