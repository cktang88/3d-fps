// Weapon-feel spray test (in-engine). Needs lib.js first. Fires every weapon through the real Game loop
// (player ADS, fixed in place, bots frozen) and records each bullet's direction relative to the original aim.
//   __qa.sprayAll(ids?)        -> summary { id: { case: { n, resid:[right,up]deg, 10:{torso,med,es,mpi}, 25:…, 50:… } } }
//   __qa.spraySheet(D)         -> DOM overlay: every weapon x case group on a wall at D m (screenshot it)
//   __qa.sprayWall(id, kase, D, slot) -> really sprays a wall D m away, then parks the camera 2.6 m from the
//                                 impact area (aim point at screen centre, torso box overlay) for a screenshot
// Cases: auto (full mag, no pull-down), autoC (full mag, simulated pull-down), burst3C (3-round bursts),
// tapC (aimed taps every 0.4 s), hip10 (10-round hip spray). C = simulated compensation: a decent player
// correcting what they saw ~100 ms ago (9/s vertical, 6/s horizontal, max 30 deg/s) via the mouse-look path.
(() => {
  const Q = window.__qa, G = () => window.__game, DEG = Math.PI / 180;
  const CASES = ['auto', 'autoC', 'burst3C', 'tapC', 'hip10'];
  const IDS = ['m4', 'ak', 'scar', 'mp5', 'vss', 'rpk', 'm870', 'm24', 'awm', 'p226', 'm1911'];
  Q.SPRAY_CASES = CASES;
  const wrap = (a) => ((a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;

  // Run one case at the player's current position/aim. Returns hits [[right, up] deg] + residual aim offset.
  Q.sprayCase = (id, kase, opts = {}) => {
    const g = G(), p = g.player;
    Q.releaseAll();
    if (g.currentWeapon.id !== id) { Q.loadout(id); }
    p.spawnProtect = 0;
    const w = g.currentWeapon, s = w.stats;
    w.refill(); w.state = 'idle'; w.burstLeft = 0;
    const pref = kase === 'tapC' ? ['semi', 'bolt', 'pump'] : kase === 'burst3C' ? ['burst', 'auto', 'semi'] : ['auto', 'semi', 'bolt', 'pump'];
    const pick = pref.find((m) => s.modes.includes(m));
    let guard = 0; if (pick) while (w.mode !== pick && guard++ < 5) w.cycleMode();
    const mode = w.mode, bolt = mode === 'bolt' || mode === 'pump';
    const ads = kase !== 'hip10', comp = kase.endsWith('C');
    const y0 = opts.yaw ?? p.yaw, p0 = opts.pitch ?? 0;
    const dt = 1 / 60;
    // Settle: equip, ADS in, recoil state clean.
    if (ads) Q.down('Mouse2');
    Q.sim(Math.max(0.9, s.equip + s.ads + 0.3), dt, () => { p.yaw = y0; p.pitch = p0; });
    p.yaw = y0; p.pitch = p0; g.aimRecoil?.reset?.(); if (g.recoilAccum) g.recoilAccum.set(0, 0);
    w.spread = 0; w.shotIndex = 0; w.lastShotTime = -9; w.cooldown = 0;
    if (w.stats.overlay) g.breath = 1;
    // Capture bullets.
    const hits = []; const bf = g.ballistics.fire;
    g.ballistics.fire = function (owner, origin, dir, ...rest) {
      if (owner === p) hits.push([-wrap(Math.atan2(-dir.x, -dir.z) - y0) / DEG, (Math.asin(Math.max(-1, Math.min(1, dir.y))) - p0) / DEG]);
      return bf.call(this, owner, origin, dir, ...rest);
    };
    // Compensation through the real look path (Game measures pitch/yaw change around p.look).
    const look = p.look; const hist = []; let lastShot = -9, nShots = 0, phase = 0, gapUntil = 0, held = false, t = 0;
    let fired = 0; const onFire = () => { fired++; }; w.on('fire', onFire);
    p.look = function (dx, dy, sens) {
      look.call(this, dx, dy, sens);
      if (!comp) return;
      if (kase === 'tapC' && t - lastShot < (bolt ? 0.7 : 0.3)) return;
      const lagN = Math.round(0.1 / dt), h = hist.length > lagN ? hist[hist.length - 1 - lagN] : [0, 0];
      const cap = 30 * DEG * dt;
      if (Math.abs(h[1]) > 0.03 * DEG) this.pitch += Math.max(-cap, Math.min(cap, -h[1] * 9 * dt));
      if (Math.abs(h[0]) > 0.03 * DEG) this.yaw += Math.max(-cap, Math.min(cap, -h[0] * 6 * dt));
    };
    const want = kase === 'hip10' ? 10 : kase === 'burst3C' ? 15 : kase === 'tapC' ? (bolt ? 5 : 8) : s.mag;
    try {
      Q.sim(14, dt, () => {
        t += dt;
        hist.push([p.yaw - y0, p.pitch - p0]);
        if (fired > nShots) {
          const add = fired - nShots; nShots = fired; lastShot = t; phase += add;
          if (kase === 'burst3C' && phase >= 3) { phase = 0; gapUntil = t + (mode === 'burst' ? 0.3 : 0.35); }
          if (kase === 'tapC') gapUntil = t + (bolt ? 0.3 : 0.4);
        }
        let fire = false, pressed = false;
        if (nShots < want) {
          if (kase === 'burst3C' || kase === 'tapC') {
            if (t >= gapUntil && w.state === 'idle') {
              if (mode === 'auto' && kase === 'burst3C') { fire = true; pressed = !held; }
              else if (mode === 'burst') { if (!held && w.burstLeft === 0) fire = pressed = true; }
              else if (t - lastShot > 60 / s.rpm + dt) fire = pressed = true;
            }
          } else if (mode === 'auto') { fire = true; pressed = !held; }
          else if (w.state === 'idle' && t - lastShot > 60 / s.rpm + dt) fire = pressed = true;
        }
        if (mode !== 'auto' && held) { fire = false; pressed = false; } // release between semi presses
        held = fire;
        const i = g.input;
        if (fire) i.down.add('Mouse0'); else i.down.delete('Mouse0');
        if (pressed) i.pressed.add('Mouse0');
        if (nShots >= want && t - lastShot > 1.6) throw 'done';
      });
    } catch (e) { if (e !== 'done') throw e; } finally {
      if (Object.getPrototypeOf(g.ballistics).fire === bf) delete g.ballistics.fire; else g.ballistics.fire = bf;
      if (Object.getPrototypeOf(p).look === look) delete p.look; else p.look = look; Q.releaseAll();
      const L = w.listeners.fire; L.splice(L.indexOf(onFire), 1);
    }
    return { hits: hits.slice(0, want * (s.pellets > 1 ? s.pellets : 1)), resid: [-wrap(p.yaw - y0) / DEG, (p.pitch - p0) / DEG], mode };
  };

  const stats = (hits, D) => {
    const pts = hits.map(([x, y]) => [D * Math.tan(x * DEG), D * Math.tan(y * DEG)]);
    if (!pts.length) return null;
    const torso = pts.filter(([x, y]) => Math.abs(x) <= 0.225 && Math.abs(y) <= 0.3).length / pts.length;
    const r = pts.map(([x, y]) => Math.hypot(x, y)).sort((a, b) => a - b);
    let es = 0; for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) es = Math.max(es, Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]));
    const mx = pts.reduce((a, q) => a + q[0], 0) / pts.length, my = pts.reduce((a, q) => a + q[1], 0) / pts.length;
    return { torsoPct: Math.round(torso * 100), medCm: Math.round(r[r.length >> 1] * 100), esCm: Math.round(es * 100), mpiCm: [Math.round(mx * 100), Math.round(my * 100)] };
  };

  Q.sprayAll = (ids = IDS, pos = null) => {
    const g = G();
    Q.god(); Q.freezeBots(true);
    const spot = pos || Q.sprayFindWall(10)?.pos || [0, 0.1, 0];
    const out = {}; Q.sprayData = {};
    for (const id of ids) {
      out[id] = {}; Q.sprayData[id] = {};
      const bolt = ['bolt', 'pump'].includes((window.__WEAPONS?.[id] || {}).modes?.[0]) || ['m870', 'm24', 'awm'].includes(id);
      for (const k of CASES) {
        if (bolt && k !== 'tapC') continue;
        Q.place(spot.pos || spot, spot.yaw ?? 0, 0);
        let r;
        try { r = Q.sprayCase(id, k, { yaw: spot.yaw ?? 0, pitch: 0 }); } catch (e) { out[id][k] = { error: String(e) }; continue; }
        Q.sprayData[id][k] = r.hits;
        const o = { n: r.hits.length, mode: r.mode, resid: r.resid.map((v) => +v.toFixed(2)) };
        for (const D of [10, 25, 50]) o[D] = stats(r.hits, D);
        out[id][k] = o;
      }
    }
    return out;
  };

  // Find a flat wall facing an open floor at distance D (m) from a standing spot. Returns {pos, yaw, wall}.
  Q.sprayFindWall = (D, lateral = 0) => {
    const g = G(), ph = g.physics, lv = g.level;
    const cands = [[0, 0, 0], ...(lv.spawns?.ffa || []).map((s) => [s.pos.x, s.pos.y, s.pos.z]), ...(lv.spawns?.[0] || []).map((s) => [s.pos.x, s.pos.y, s.pos.z])];
    const V = (x, y, z) => ({ x, y, z });
    for (const c of cands) for (let k = 0; k < 24; k++) {
      const yaw = (k / 24) * Math.PI * 2, d = V(-Math.sin(yaw), 0, -Math.cos(yaw));
      const eye = V(c[0], c[1] + 1.6, c[2]);
      const hit = ph.raycast(eye, d, 90);
      if (!hit || hit.normal.x * d.x + hit.normal.z * d.z > -0.95) continue;
      const L = Math.hypot(hit.point.x - eye.x, hit.point.z - eye.z);
      if (L < D + 0.5) continue;
      // Lateral offset along the wall (so several patterns don't overlap), then verify the wall is still flat there.
      const rx = Math.cos(yaw), rz = -Math.sin(yaw);
      const sx = c[0] + d.x * (L - D) + rx * lateral, sz = c[2] + d.z * (L - D) + rz * lateral;
      const e2 = V(sx, c[1] + 1.6, sz);
      const h2 = ph.raycast(e2, d, D + 3);
      if (!h2 || Math.abs(Math.hypot(h2.point.x - sx, h2.point.z - sz) - D) > 0.25) continue;
      // Wall must also be clear 1.3 m above and 0.9 m below the aim line, and the path to it empty.
      const up = ph.raycast(V(sx, c[1] + 2.9, sz), d, D + 3), dn = ph.raycast(V(sx, c[1] + 0.7, sz), d, D + 3);
      if (!up || !dn || Math.abs(Math.hypot(up.point.x - sx, up.point.z - sz) - D) > 0.3 || Math.abs(Math.hypot(dn.point.x - sx, dn.point.z - sz) - D) > 0.3) continue;
      const fl = ph.raycast(V(sx, c[1] + 1.5, sz), V(0, -1, 0), 3);
      if (!fl || Math.abs(fl.point.y - c[1]) > 0.3) continue;
      return { pos: [sx, fl.point.y + 0.05, sz], yaw, wall: [h2.point.x, h2.point.y, h2.point.z], D };
    }
    return null;
  };

  // Spray a real wall, then frame the impact area for a screenshot.
  Q.sprayWall = (id, kase, D = 10, slot = 0) => {
    const g = G(), p = g.player;
    Q.god(); Q.freezeBots(true);
    const spot = Q.sprayFindWall(D, (slot - 2) * 3.2);
    if (!spot) return { error: 'no wall found at ' + D + ' m' };
    Q.place(spot.pos, spot.yaw, 0);
    const r = Q.sprayCase(id, kase, { yaw: spot.yaw, pitch: 0 });
    // Park the camera 2.6 m in front of the aim point, looking straight at it (aim point = screen centre).
    const view = 2.6, d = [-Math.sin(spot.yaw), -Math.cos(spot.yaw)];
    Q.place([spot.wall[0] - d[0] * view, spot.pos[1] - 0.05, spot.wall[2] - d[1] * view], spot.yaw, 0);
    p.velocity.set(0, 0, 0);
    g.viewmodel.holder.scale.setScalar(1e-4); Q._vmHidden = true; g.hud.show(false);
    Q.sprayOverlay(view, `${id.toUpperCase()} ${kase} @ ${D} m`, r.hits, D);
    return { n: r.hits.length, D, at: spot.pos.map((v) => +v.toFixed(1)), stats: stats(r.hits, D) };
  };

  // Torso box + aim cross + scale (DOM), drawn for a camera `view` m from the wall.
  Q.sprayOverlay = (view, label, hits, D) => {
    Q.sprayClear();
    const g = G(), cam = g.renderer.camera;
    const H = innerHeight, W = innerWidth, pxm = (H / 2) / Math.tan((cam.fov * DEG) / 2) / view;
    const el = document.createElement('div'); el.id = 'qa-spray';
    el.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:99999;font:600 14px/1.2 monospace;color:#fff;text-shadow:0 1px 2px #000';
    const cx = W / 2, cy = H / 2;
    const box = `<div style="position:absolute;left:${cx - 0.225 * pxm}px;top:${cy - 0.3 * pxm}px;width:${0.45 * pxm}px;height:${0.6 * pxm}px;border:2px dashed #4cf"></div>`;
    const head = `<div style="position:absolute;left:${cx - 0.1 * pxm}px;top:${cy - 0.3 * pxm - 0.22 * pxm}px;width:${0.2 * pxm}px;height:${0.2 * pxm}px;border:2px dashed #4cf;border-radius:50%"></div>`;
    const cross = `<div style="position:absolute;left:${cx - 8}px;top:${cy - 1}px;width:16px;height:2px;background:#f33"></div><div style="position:absolute;left:${cx - 1}px;top:${cy - 8}px;width:2px;height:16px;background:#f33"></div>`;
    const st = hits && D ? stats(hits, D) : null;
    el.innerHTML = box + head + cross + `<div style="position:absolute;left:12px;top:10px;background:#0009;padding:6px 8px">${label}<br>torso box 45x60 cm (blue) · red = aim point${st ? `<br>${hits.length} rds · torso ${st.torsoPct}% · median r ${st.medCm} cm · ES ${st.esCm} cm` : ''}</div>`;
    document.body.appendChild(el);
  };
  Q.sprayClear = () => document.getElementById('qa-spray')?.remove();

  // Paper-target sheet of every recorded group at distance D (from Q.sprayData).
  Q.spraySheet = (D) => {
    Q.sprayClear();
    const data = Q.sprayData || {}; const ids = Object.keys(data);
    const W = innerWidth, H = innerHeight;
    const cols = CASES.length, rows = ids.length;
    const lw = 60, th = 26, cw = (W - lw - 10) / cols, ch = (H - th - 8) / Math.max(1, rows);
    const span = 2.4, m = Math.min(cw / span, ch / (span * 0.75)) * 0.95; // px per metre (cell = 2.4 x 1.8 m)
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" style="position:fixed;inset:0;z-index:99999;background:#e9e4d8;font:12px monospace">`;
    svg += `<text x="8" y="18" font-weight="bold">Spray groups on a wall at ${D} m — cell = 2.4 x 1.8 m, box = 45x60 cm torso, ring = 10 cm head, + = aim point. ${CASES.join(' | ')}</text>`;
    ids.forEach((id, r) => {
      svg += `<text x="6" y="${th + r * ch + ch / 2 + 4}" font-weight="bold">${id}</text>`;
      CASES.forEach((k, c) => {
        const x0 = lw + c * cw, y0 = th + r * ch, cx = x0 + cw / 2, cy = y0 + ch * 0.62;
        svg += `<rect x="${x0 + 1}" y="${y0 + 1}" width="${cw - 2}" height="${ch - 2}" fill="#f7f3ea" stroke="#bbb"/>`;
        const hits = data[id][k]; if (!hits) return;
        svg += `<rect x="${cx - 0.225 * m}" y="${cy - 0.3 * m}" width="${0.45 * m}" height="${0.6 * m}" fill="none" stroke="#3a7" stroke-width="1.5"/>`;
        svg += `<circle cx="${cx}" cy="${cy - 0.42 * m}" r="${0.1 * m}" fill="none" stroke="#3a7"/>`;
        svg += `<path d="M${cx - 5} ${cy}h10M${cx} ${cy - 5}v10" stroke="#c22"/>`;
        let off = 0;
        for (const [hx, hy] of hits) {
          const px = cx + D * Math.tan(hx * DEG) * m, py = cy - D * Math.tan(hy * DEG) * m;
          if (px < x0 || px > x0 + cw || py < y0 || py > y0 + ch) { off++; continue; }
          svg += `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="1.8" fill="#111"/>`;
        }
        const st = stats(hits, D);
        svg += `<text x="${x0 + 4}" y="${y0 + 12}" font-size="10">${k} ${st.torsoPct}% r${st.medCm}${off ? ` (+${off} off)` : ''}</text>`;
      });
    });
    svg += '</svg>';
    const el = document.createElement('div'); el.id = 'qa-spray'; el.innerHTML = svg; document.body.appendChild(el);
    return ids.length;
  };
  const prev = Q.cleanup;
  Q.cleanup = () => { prev?.(); Q.sprayClear?.(); };
})();
