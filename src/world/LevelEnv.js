import * as THREE from 'three';

/**
 * Environment helpers for the level: HDRI analysis/re-orientation, IBL sun clamping, height fog with sun
 * in-scattering (global ShaderChunk override), fake volumetric light shafts and dust motes.
 */

const LUMA = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Read accessor for an HDR DataTexture (half-float or float RGBA). */
function reader(tex) {
  const { data, width: w, height: h } = tex.image;
  const half = data instanceof Uint16Array;
  const ch = data.length / (w * h);
  const f = half ? (i) => THREE.DataUtils.fromHalfFloat(data[i]) : (i) => data[i];
  return { data, w, h, half, ch, f };
}

/**
 * Rotate the equirect horizontally (column shift) so the sun ends up at azimuth `targetPhi`
 * (three.js convention: dir = (cos phi cos el, sin el, sin phi cos el)). Done on the data so the visible sky,
 * the IBL and the sun light stay consistent by construction. Returns sun info.
 */
export function orientHDR(tex, targetPhi) {
  const { data, w, h, ch, f } = reader(tex);
  // Locate the sun: brightest pixel in the upper hemisphere (blurred 3x3 to avoid hot pixels).
  let best = -1, bx = 0, by = 0;
  for (let y = 1; y < h / 2; y += 2) for (let x = 1; x < w - 1; x += 2) {
    const i = (y * w + x) * ch;
    const l = LUMA(f(i), f(i + 1), f(i + 2));
    if (l > best) { best = l; bx = x; by = y; }
  }
  const u0 = (bx + 0.5) / w;
  const uT = targetPhi / (Math.PI * 2) + 0.5;
  const shift = Math.round((u0 - uT) * w);
  if (shift !== 0) {
    const row = new data.constructor(w * ch);
    const s = ((shift % w) + w) % w;
    for (let y = 0; y < h; y++) {
      const o = y * w * ch;
      row.set(data.subarray(o, o + w * ch));
      for (let x = 0; x < w; x++) {
        const src = ((x + s) % w) * ch;
        for (let c = 0; c < ch; c++) data[o + x * ch + c] = row[src + c];
      }
    }
    tex.needsUpdate = true;
  }
  const bxN = (((bx - shift) % w) + w) % w;
  const u = (bxN + 0.5) / w, v = 1 - (by + 0.5) / h;
  const phi = (u - 0.5) * Math.PI * 2, el = (v - 0.5) * Math.PI;
  const dir = new THREE.Vector3(Math.cos(phi) * Math.cos(el), Math.sin(el), Math.sin(phi) * Math.cos(el)).normalize();
  // Colours: horizon ring average, horizon toward the sun, zenith, and the sun's own colour.
  const avg = (rows, uFrom, uTo) => {
    const c = new THREE.Color(0, 0, 0); let n = 0;
    for (const vv of rows) {
      const y = Math.min(h - 1, Math.max(0, Math.round((1 - vv) * h)));
      for (let k = 0; k < 64; k++) {
        const uu = uFrom + (uTo - uFrom) * (k / 63);
        const x = Math.floor(((uu % 1) + 1) % 1 * w) % w;
        const i = (y * w + x) * ch;
        const r = f(i), g = f(i + 1), b = f(i + 2);
        if (LUMA(r, g, b) > 20) continue; // skip the sun disc
        c.r += r; c.g += g; c.b += b; n++;
      }
    }
    return n ? c.multiplyScalar(1 / n) : c;
  };
  const vh = 0.5 + 2.5 / 180; // ~2.5° above horizon
  const horizon = avg([vh, vh + 0.01, vh + 0.02], 0, 1);
  const sunHorizon = avg([vh, vh + 0.015], u - 0.05, u + 0.05);
  const zenith = avg([0.92, 0.96], 0, 1);
  const sunPx = (by * w + bxN) * ch;
  const sunColor = new THREE.Color(f(sunPx), f(sunPx + 1), f(sunPx + 2));
  const m = Math.max(sunColor.r, sunColor.g, sunColor.b) || 1;
  sunColor.multiplyScalar(1 / m);
  return { dir, el, phi, horizon, sunHorizon, zenith, sunColor, peak: best };
}

/** Copy of an HDR equirect with values clamped (removes the sun spike for IBL: the sun is a real light). */
export function clampedHDR(tex, maxV = 12) {
  const { data, w, h, half } = reader(tex);
  const out = data.slice();
  if (half) {
    const lim = THREE.DataUtils.toHalfFloat(maxV);
    for (let i = 0; i < out.length; i++) if ((out[i] & 0x8000) === 0 && out[i] > lim) out[i] = lim;
  } else {
    for (let i = 0; i < out.length; i++) if (out[i] > maxV) out[i] = maxV;
  }
  const t = new THREE.DataTexture(out, w, h, tex.format, tex.type);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = tex.colorSpace;
  t.flipY = tex.flipY;
  t.magFilter = tex.magFilter; t.minFilter = tex.minFilter; t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

/**
 * Global fog override: exponential *height* fog (dense near the ground, thinning with altitude) with
 * forward in-scattering toward the sun, so distance haze glows warm against the light and cool away from it.
 * Must run before shaders compile. Applies to every material with fog enabled.
 */
export function installAtmosphere({ sunDir, sunColor, heightFalloff = 0.07, heightShare = 0.75, scatter = 0.9, indoor = [] }) {
  const v3 = (v) => `vec3(${v.x.toFixed(5)}, ${v.y.toFixed(5)}, ${v.z.toFixed(5)})`;
  const c3 = (c) => `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
  THREE.ShaderChunk.fog_pars_vertex = `#ifdef USE_FOG
  varying float vFogDepth; varying vec3 vFogWorld;
#endif`;
  THREE.ShaderChunk.fog_vertex = `#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  vFogWorld = (vec4(mvPosition.xyz, 0.0) * viewMatrix).xyz;
#endif`;
  THREE.ShaderChunk.fog_pars_fragment = `#ifdef USE_FOG
  uniform vec3 fogColor; varying float vFogDepth; varying vec3 vFogWorld;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear; uniform float fogFar;
  #endif
#endif`;
  THREE.ShaderChunk.fog_fragment = `#ifdef USE_FOG
  {
    vec3 fw = vFogWorld;
    float fd = length(fw);
    vec3 fdir = fw / max(fd, 1e-3);
    #ifdef FOG_EXP2
      const float HF = ${heightFalloff.toFixed(4)};
      float hc = max(cameraPosition.y, 0.0);
      float dyF = fw.y * HF;
      float hfac = exp(-HF * hc) * (abs(dyF) > 1e-3 ? (1.0 - exp(-dyF)) / dyF : 1.0);
      float fogFactor = 1.0 - exp(-fogDensity * fd * (hfac * ${heightShare.toFixed(3)} + ${(1 - heightShare).toFixed(3)}));
    #else
      float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    vec3 fwp = cameraPosition + fw; float fin = 0.0;
    ${indoor.map((b) => `fin = max(fin, step(${b.min.x.toFixed(2)}, fwp.x) * step(fwp.x, ${b.max.x.toFixed(2)}) * step(${b.min.z.toFixed(2)}, fwp.z) * step(fwp.z, ${b.max.z.toFixed(2)}) * step(fwp.y, ${b.max.y.toFixed(2)}));`).join('\n    ')}
    fogFactor *= 1.0 - fin * 0.7; // interiors: much less haze
    float sunAmt = pow(max(dot(fdir, ${v3(sunDir)}), 0.0), 6.0) * (1.0 - fin);
    vec3 fcol = fogColor + ${c3(sunColor)} * sunAmt * ${scatter.toFixed(3)};
    gl_FragColor.rgb = mix(gl_FragColor.rgb, fcol, fogFactor);
  }
#endif`;
}

/** Soft gradient texture for light shaft cards (u across, v along the beam). */
function shaftTexture() {
  const W = 64, H = 256;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  const img = g.createImageData(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = x / (W - 1), v = y / (H - 1);
    const across = Math.pow(Math.sin(Math.PI * u), 1.6);
    const along = Math.pow(1 - v, 1.4) * Math.min(1, v * 14 + 0.25);
    const n = 0.75 + 0.25 * Math.sin(u * 37 + Math.sin(v * 9) * 2) * Math.sin(u * 13 + 1.7);
    const a = across * along * n;
    const i = (y * W + x) * 4;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.round(255 * Math.min(1, a)); img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

/**
 * Fake volumetric sun shafts through openings: each opening (centre, width, height, wall normal) spawns
 * three crossed additive cards extruded along the sun direction. Cards fade when seen edge-on and glow
 * more when looking toward the sun (forward scattering). Returns { mesh, update(camera) }.
 */
export function buildLightShafts(openings, sunDir, color, { length = 26, intensity = 0.16 } = {}) {
  const L = sunDir.clone().negate().normalize(); // light travel direction
  const pos = [], uv = [], nrm = [];
  const quad = (a, b, c, d, n) => {
    for (const [p, t] of [[a, [0, 0]], [b, [1, 0]], [c, [1, 1]], [a, [0, 0]], [c, [1, 1]], [d, [0, 1]]]) {
      pos.push(p.x, p.y, p.z); uv.push(t[0], t[1]); nrm.push(n.x, n.y, n.z);
    }
  };
  for (const o of openings) {
    const c = o.center, wn = o.normal; // wn: wall normal pointing toward the sun side
    const tang = new THREE.Vector3(0, 1, 0).cross(wn).normalize(); // horizontal along wall
    const len = o.length ?? length;
    for (let k = 0; k < 3; k++) {
      // Card spanning the opening: k=0 width-wise, k=1 height-wise, k=2 diagonal.
      const ax = k === 0 ? tang.clone().multiplyScalar(o.w / 2)
        : k === 1 ? new THREE.Vector3(0, o.h / 2, 0)
          : tang.clone().multiplyScalar(o.w / 2).add(new THREE.Vector3(0, o.h / 2, 0)).multiplyScalar(0.8);
      const a = c.clone().sub(ax), b = c.clone().add(ax);
      const a2 = a.clone().addScaledVector(L, len), b2 = b.clone().addScaledVector(L, len);
      const n = ax.clone().cross(L).normalize();
      quad(a, b, b2, a2, n);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      tShaft: { value: shaftTexture() }, uColor: { value: color.clone() }, uIntensity: { value: intensity },
      uLightDir: { value: L }, uTime: { value: 0 },
    },
    vertexShader: /* glsl */`
      varying vec2 vUv; varying vec3 vN; varying vec3 vW;
      void main() {
        vUv = uv; vN = normalize(mat3(modelMatrix) * normal);
        vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */`
      uniform sampler2D tShaft; uniform vec3 uColor; uniform float uIntensity; uniform vec3 uLightDir; uniform float uTime;
      varying vec2 vUv; varying vec3 vN; varying vec3 vW;
      void main() {
        vec3 V = normalize(vW - cameraPosition);
        float edge = abs(dot(normalize(vN), V));
        float face = smoothstep(0.05, 0.5, edge);
        float fwd = 0.35 + 1.4 * pow(max(dot(V, uLightDir), 0.0), 4.0);
        float s = texture2D(tShaft, vUv).r;
        float flick = 0.9 + 0.1 * sin(uTime * 0.7 + vW.x * 0.3);
        float near = smoothstep(0.4, 2.5, length(vW - cameraPosition));
        gl_FragColor = vec4(uColor * s * face * fwd * uIntensity * flick * near, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 5;
  return mesh;
}

/** Dust motes drifting inside given boxes (sparkle when lit along the light direction). */
export function buildDust(boxes, count, color, sunDir) {
  const pos = [], seed = [];
  let s = 4242; const R = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < count; i++) {
    const b = boxes[i % boxes.length];
    pos.push(b.min.x + R() * (b.max.x - b.min.x), b.min.y + R() * (b.max.y - b.min.y), b.min.z + R() * (b.max.z - b.min.z));
    seed.push(R());
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('seed', new THREE.Float32BufferAttribute(seed, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uColor: { value: color.clone() }, uLightDir: { value: sunDir.clone().negate() } },
    vertexShader: /* glsl */`
      attribute float seed; uniform float uTime; varying float vA;
      void main() {
        vec3 p = position;
        float t = uTime * (0.05 + seed * 0.08);
        p += vec3(sin(t * 2.1 + seed * 40.0) * 0.6, sin(t * 1.3 + seed * 17.0) * 0.4 - fract(t * 0.1 + seed) * 0.6, cos(t * 1.7 + seed * 23.0) * 0.6);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(26.0 / -mv.z, 1.0, 5.0);
        vA = (0.5 + 0.5 * sin(uTime * (0.6 + seed) + seed * 50.0)) * smoothstep(14.0, 2.0, -mv.z);
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor; varying float vA;
      void main() {
        vec2 d = gl_PointCoord - 0.5; float r = dot(d, d);
        float a = smoothstep(0.25, 0.0, r) * vA;
        gl_FragColor = vec4(uColor * a, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  return pts;
}
