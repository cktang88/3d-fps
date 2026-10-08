// (h) Bot animation jank metrics — logic only. Runs a live TDM for SIM seconds at 30 Hz with every bot forced to
// full-rate animation (LOD off) and measures, per bot: planted-foot slide, action-weight pops, chest-vs-hips
// twist, barrel-vs-aim error when firing, hands-apart (T-pose / gun not in hands), floating / sinking feet,
// bot-bot and bot-wall interpenetration, lingering corpses. Thresholds in TH; result.fails lists violations.
(() => {
  const g = window.__game, Q = window.__qa, out = { fails: [], warn: [] };
  const SIM = window.__jankSeconds || 60, dt = 1 / 30;
  const TH = { slideP95: 0.35, slideWarn: 0.2, popsPerMin: 6, twistDeg: 75, aimP90Deg: 10, handsApart: 0.95, handsApartT: 0.3, floatM: 0.15, sinkM: -0.1, floatT: 0.5, botBotM: 0.45, corpseS: 30 };
  out.thresholds = TH;
  Q.god(); Q.releaseAll();
  // Park the player out of the way (top of the guard tower) so bots fight each other.
  const park = [-48, 4.3, -40.5];
  const V = g.player.position.constructor;
  const bots = g.bots;
  const S = bots.map(() => ({ slide: [], pops: 0, popList: [], twistMax: 0, aimErr: [], apartT: 0, apartMax: 0, tpose: 0, floatT: 0, floatMax: 0, sinkMin: 0, floatEv: 0, inside: 0, deadT: 0, corpseMax: 0, lastToe: null, lastW: new Map(), aliveT: 0 }));
  for (const b of bots) if (b.model) { b.model._qaLod = b.model._lodInterval; b.model._lodInterval = () => 0; }
  const wp = (o, v = new V()) => o.getWorldPosition(v);
  const yawOf = (o) => { const d = new V(0, 0, 1).applyQuaternion(o.getWorldQuaternion(new o.quaternion.constructor())); return Math.atan2(d.x, d.z); };
  const angDiff = (a, b) => Math.abs(((a - b + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
  const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]].map((a) => new V(...a));
  let botBot = 0, botBotPairs = new Set();
  Q.sim(SIM, dt, () => {
    g.player.position.set(...park); g.player.velocity.set(0, 0, 0);
    bots.forEach((b, i) => {
      const s = S[i], m = b.model; if (!m?.bones?.lToe) return;
      if (!b.alive) {
        s.deadT += dt; if (m.root.visible) s.corpseMax = Math.max(s.corpseMax, s.deadT); s.lastToe = null; s.apartT = 0; s.floatT = 0; return;
      }
      s.deadT = 0; s.aliveT += dt;
      m.root.updateMatrixWorld(true);
      const B = m.bones;
      // Planted-foot slide (toes near the ground and not rising).
      const toes = [wp(B.lToe), wp(B.rToe)];
      if (s.lastToe) for (let k = 0; k < 2; k++) {
        const h = toes[k].y - b.position.y, vy = (toes[k].y - s.lastToe[k].y) / dt;
        if (h < 0.08 && Math.abs(vy) < 0.15) s.slide.push(Math.hypot(toes[k].x - s.lastToe[k].x, toes[k].z - s.lastToe[k].z) / dt);
      }
      s.lastToe = toes;
      // Floating / sinking: lowest toe vs ground while not jumping.
      const low = Math.min(toes[0].y, toes[1].y) - b.position.y;
      if (!(b.jumpY > 0.01)) {
        if (low > TH.floatM || low < TH.sinkM) { s.floatT += dt; if (s.floatT > TH.floatT) s.floatEv++; } else s.floatT = 0;
        s.floatMax = Math.max(s.floatMax, low); s.sinkMin = Math.min(s.sinkMin, low);
      }
      // Action weight pops.
      for (const a of m.mixer._actions) {
        const w = a.getEffectiveWeight(), w0 = s.lastW.get(a);
        if (w0 !== undefined && Math.abs(w - w0) > 0.35) { s.pops++; if (s.popList.length < 5) s.popList.push((a.getClip()?.name || '?') + ' ' + w0.toFixed(2) + '->' + w.toFixed(2)); }
        s.lastW.set(a, w);
      }
      // Chest vs hips twist.
      if (B.spine2 && B.hips) s.twistMax = Math.max(s.twistMax, angDiff(yawOf(B.spine2), yawOf(B.hips)) * 57.3);
      // Hands apart (T-pose / support hand off the gun).
      const apart = wp(B.lHand).distanceTo(wp(B.rHand)); s.apartMax = Math.max(s.apartMax, apart);
      if (apart > TH.handsApart && !m.dying) { s.apartT += dt; if (s.apartT > TH.handsApartT) s.tpose++; } else s.apartT = 0;
      // Barrel vs aim right after a shot.
      if (b.lastFiredTime !== undefined && g.time - b.lastFiredTime < dt * 1.01) {
        const mz = m.muzzleWorld?.(b);
        if (mz) {
          const barrel = mz.clone().sub(wp(B.rHand)).normalize();
          const aim = new V(-Math.sin(b.aimYaw) * Math.cos(b.aimPitch), Math.sin(b.aimPitch), -Math.cos(b.aimYaw) * Math.cos(b.aimPitch));
          s.aimErr.push(Math.acos(Math.max(-1, Math.min(1, barrel.dot(aim)))) * 57.3);
        }
      }
      // Inside static geometry (solid ray from the chest has zero length).
      const c = new V(b.position.x, b.position.y + 1.0, b.position.z);
      for (const d of DIRS) { const h = g.physics.raycast(c, d, 0.2); if (h && h.distance < 0.005) { s.inside++; break; } }
    });
    // Bot-bot interpenetration
    for (let i = 0; i < bots.length; i++) for (let j = i + 1; j < bots.length; j++) {
      const a = bots[i], b = bots[j]; if (!a.alive || !b.alive) continue;
      if (Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z) < TH.botBotM && Math.abs(a.position.y - b.position.y) < 1) { botBot++; botBotPairs.add(i + '-' + j); }
    }
  });
  for (const b of bots) if (b.model?._qaLod) { b.model._lodInterval = b.model._qaLod; delete b.model._qaLod; }
  const pct = (arr, p) => { if (!arr.length) return 0; const a = arr.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; };
  out.bots = S.map((s, i) => {
    const r = { i, aliveS: Q.r(s.aliveT, 1), slideP95: Q.r(pct(s.slide, 0.95)), slideN: s.slide.length, popsPerMin: Q.r(s.pops / Math.max(1e-3, s.aliveT) * 60, 1), pops: s.popList, twistMax: Q.r(s.twistMax, 0), aimP90: Q.r(pct(s.aimErr, 0.9), 1), aimN: s.aimErr.length, handsApartMax: Q.r(s.apartMax), tposeEvents: s.tpose, floatMax: Q.r(s.floatMax), sinkMin: Q.r(s.sinkMin), floatEvents: s.floatEv, insideFrames: s.inside, corpseMaxS: Q.r(s.corpseMax, 1) };
    const F = (m) => out.fails.push(`bot${i}: ${m}`);
    if (r.slideP95 > TH.slideP95) F(`planted-foot slide p95 ${r.slideP95} m/s > ${TH.slideP95}`); else if (r.slideP95 > TH.slideWarn) out.warn.push(`bot${i}: foot slide p95 ${r.slideP95}`);
    if (r.popsPerMin > TH.popsPerMin) F(`${r.popsPerMin} weight pops/min (${s.popList.join('; ')})`);
    if (r.twistMax > TH.twistDeg) F(`chest-hips twist ${r.twistMax}°`);
    if (r.aimN >= 5 && r.aimP90 > TH.aimP90Deg) F(`barrel-vs-aim p90 ${r.aimP90}° over ${r.aimN} shots`);
    if (r.tposeEvents) F(`hands apart > ${TH.handsApart} m for > ${TH.handsApartT}s (${r.tposeEvents} frames; max ${r.handsApartMax} m)`);
    if (r.floatEvents) F(`feet floating/sinking > ${TH.floatT}s (max ${r.floatMax}, min ${r.sinkMin})`);
    if (r.insideFrames > 15) F(`chest inside static geometry for ${r.insideFrames} frames`);
    if (r.corpseMaxS > TH.corpseS) F(`corpse visible ${r.corpseMaxS}s`);
    return r;
  });
  out.botBotFrames = botBot; out.botBotPairs = [...botBotPairs].slice(0, 10);
  if (botBot > 30) out.fails.push(`bot-bot interpenetration ${botBot} pair-frames (${out.botBotPairs.join(',')})`);
  out.kills = g.mode.score; out.nan = Q.nanScan(); if (out.nan.length) out.fails.push('NaN ' + out.nan);
  return out;
})()
