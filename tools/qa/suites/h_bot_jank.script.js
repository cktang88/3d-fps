// (h) Bot animation jank metrics — logic only. Runs a live TDM for SIM seconds at 30 Hz with every bot forced to
// full-rate animation (LOD off) and measures, per bot: planted-foot slide, action-weight pops, chest-vs-hips
// twist, barrel-vs-aim error when firing, hands-apart (T-pose / gun not in hands), floating / sinking feet,
// bot-bot and bot-wall interpenetration, lingering corpses. Thresholds in TH; result.fails lists violations.
(() => {
  const g = window.__game, Q = window.__qa, out = { fails: [], warn: [] };
  const SIM = window.__jankSeconds || 75, dt = 1 / 60; // 60 Hz: toe |vy| test is noisy at 30 Hz
  const TH = { stanceSlideP95: 0.03, stanceSlideWarn: 0.02, supportP95: 0.05, yawRateP99: 540, moveAimP95: 2, deathGroundLo: 0.6, deathGroundHi: 1.3, deathDisp: 0.3, deathJitter: 0.01, slideP95: 0.35, slideWarn: 0.2, ratioLo: 0.8, ratioHi: 1.25, popsPerMin: 6, twistDeg: 100, aimP90Deg: 10, handsApart: 0.95, handsApartT: 0.3, floatM: 0.15, sinkM: -0.1, floatT: 0.5, botBotM: 0.45, corpseS: 30 };
  out.thresholds = TH;
  Q.god(); Q.releaseAll();
  // Park the player out of the way (top of the guard tower) so bots fight each other.
  const park = [-48, 4.3, -40.5];
  const V = g.player.position.constructor;
  const bots = g.bots;
  const TPL = bots[0]?.model?.tpl || g.charTemplate; const tplFR = TPL?.forceFullRate; if (TPL) TPL.forceFullRate = true; out.tplSame = TPL === g.charTemplate; // every Character incl. respawn spares animates fully
  const S = bots.map(() => ({ stance: [[], []], stanceAcc: [0, 0], stanceOn: [false, false], support: [], yawRate: [], lastChestYaw: null, moveAim: [], deaths: [], dth: null, ratio: [], slide: [], pops: 0, popList: [], twistMax: 0, aimErr: [], apartT: 0, apartMax: 0, tpose: 0, floatT: 0, floatMax: 0, sinkMin: 0, floatEv: 0, inside: 0, deadT: 0, corpseMax: 0, lastToe: null, lastW: new Map(), aliveT: 0 }));
  for (const b of bots) if (b.model) { b.model._qaLod = b.model._lodInterval; b.model._lodInterval = () => 0; }
  const wp = (o, v = new V()) => o.getWorldPosition(v);
  const yawOf = (o) => { const d = new V(0, 0, 1).applyQuaternion(o.getWorldQuaternion(new o.quaternion.constructor())); return Math.atan2(d.x, d.z); };
  const angDiff = (a, b) => Math.abs(((a - b + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
  const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]].map((a) => new V(...a));
  let botBot = 0, botBotPairs = new Set();
  const lastHead = new Map(); const _ok = g.onActorKilled; g.onActorKilled = function (v, k, info) { lastHead.set(v, !!info?.headshot); return _ok.call(this, v, k, info); };
  const dumps = bots.map(() => []), excs = bots.map(() => []); let tick = 0;
  for (const b of bots) { if (!b._qaUpd) { b._qaUpd = b.update; const i = bots.indexOf(b); b.update = function (d) { try { return b._qaUpd.call(this, d); } catch (e) { if (excs[i].length < 3) excs[i].push(String(e.stack || e).slice(0, 300)); } }; } }
  Q.sim(SIM, dt, () => {
    g.player.position.set(...park); g.player.velocity.set(0, 0, 0);
    bots.forEach((b, i) => {
      const s = S[i], m = b.model; if (!m?.bones?.lToe) return;
      if (!m._qaLod) { m._qaLod = m._lodInterval; m._lodInterval = () => 0; s.lastToe = null; s.minHist = []; } // models swap on respawn (corpse hand-off)
      if (!b.alive) {
        // Death: time for the hips to reach the ground, hips displacement, settle jitter 3-4 s after death.
        if (m.bones?.hips && m.root.visible) {
          m.root.updateMatrixWorld(true); const hp = wp(m.bones.hips);
          if (!s.dth) s.dth = { head: lastHead.get(b) || false, t: 0, p0: hp.clone(), ground: null, last: hp.clone(), jit: 0, y0: b.position.y };
          const d = s.dth; d.t += dt;
          if (d.ground == null && hp.y - d.y0 < 0.32) d.ground = d.t;
          if (d.t > 3 && d.t <= 4) d.jit = Math.max(d.jit, hp.distanceTo(d.last) / dt);
          if (d.t <= 3) d.disp = Math.hypot(hp.x - d.p0.x, hp.z - d.p0.z);
          d.last.copy(hp);
          if (d.t > 4.05 && !d.done) { d.done = true; s.deaths.push({ head: d.head, ground: d.ground == null ? null : +d.ground.toFixed(2), disp: +(d.disp || 0).toFixed(2), jitter: +d.jit.toFixed(3) }); }
        }
        s.deadT += dt; if (m.root.visible) s.corpseMax = Math.max(s.corpseMax, s.deadT); s.lastToe = null; s.apartT = 0; s.floatT = 0; return;
      }
      if (s.dth && !s.dth.done && s.dth.t > 1.5) s.deaths.push({ head: s.dth.head, ground: s.dth.ground, disp: +(s.dth.disp || 0).toFixed(2), jitter: null, respawnedAt: +s.dth.t.toFixed(1) });
      if (s.dth || s.aliveT === 0) s.spawnT = 0; s.spawnT = (s.spawnT || 0) + dt;
      s.dth = null; s.deadT = 0; s.aliveT += dt;
      if (m._hidden) { s.hiddenF = (s.hiddenF || 0) + 1; s.lastToe = null; s.lastToes = null; return; } // LOD-hidden: no aim/IK pass by design
      m.root.updateMatrixWorld(true);
      const B = m.bones;
      // Ground reference: raycast down from the hips (nav y can be off on stairs / ramps).
      const hipsW = wp(B.hips);
      const gh = g.physics.raycast(new V(hipsW.x, b.position.y + 0.9, hipsW.z), new V(0, -1, 0), 3);
      const groundY = gh ? gh.point.y : b.position.y;
      // Planted-foot slide: only the LOWER foot, and only while it sits within 3 cm of its rolling 1 s minimum
      // height and isn't rising - i.e. the stance foot. Slide = horizontal travel per contact.
      const feet = [wp(B.lFoot), wp(B.rFoot)];
      // Bots-engineer contact definition: per foot, ankle within 3.5 cm of its own 1 s minimum height, |vy| < 0.15,
      // body speed < 2.2 m/s (the run clip has a flight phase).
      s.fh = s.fh || [[], []];
      const bodyV = Math.hypot(b.velocity.x, b.velocity.z);
      if (s.lastToe) for (let k = 0; k < 2; k++) {
        const h = feet[k].y - groundY; s.fh[k].push(h); if (s.fh[k].length > 60) s.fh[k].shift();
        const vy = (feet[k].y - s.lastToe[k].y) / dt, floorK = Math.min(...s.fh[k]);
        const planted = bodyV < 2.2 && h < floorK + 0.035 && Math.abs(vy) < 0.15;
        const dxz = Math.hypot(feet[k].x - s.lastToe[k].x, feet[k].z - s.lastToe[k].z);
        if (planted) { s.slide.push(dxz / dt); s.stanceAcc[k] += dxz; s.stanceOn[k] = true; }
        else if (s.stanceOn[k]) { s.stance[k].push(s.stanceAcc[k]); s.stanceAcc[k] = 0; s.stanceOn[k] = false; }
      }
      // Tighter contact test (bots engineer): TOE within 2 cm of its 1 s minimum, |vy| < 0.1, body speed < 2.2.
      const toesNow = [wp(B.lToe), wp(B.rToe)];
      s.th = s.th || [[], []]; s.toeSlip = s.toeSlip || [];
      if (s.lastToes) for (let k = 0; k < 2; k++) {
        const h = toesNow[k].y - groundY; s.th[k].push(h); if (s.th[k].length > 60) s.th[k].shift();
        const vy = (toesNow[k].y - s.lastToes[k].y) / dt;
        if (bodyV < 2.2 && h < Math.min(...s.th[k]) + 0.02 && Math.abs(vy) < 0.1) {
          const slip = Math.hypot(toesNow[k].x - s.lastToes[k].x, toesNow[k].z - s.lastToes[k].z) / dt;
          s.toeSlip.push(slip);
          // Locomotion class for the per-class split (bots engineer request).
          const by = m.bodyYaw ?? b.yaw, sp = m.speedS ?? bodyV;
          const yr = s.lastBY == null ? 0 : angDiff(by, s.lastBY) / dt;
          let cls = 'idle';
          if (sp < 0.3) cls = yr > 1 ? 'turn' : 'idle';
          else { const vAng = Math.atan2(-b.velocity.x, -b.velocity.z); const rel = angDiff(vAng, by) * 57.3; cls = rel < 45 ? 'fwd' : rel <= 135 ? 'strafe' : 'back'; }
          (s.cls = s.cls || {}); (s.cls[cls] = s.cls[cls] || []).push(slip);
          if ((cls === 'back' || cls === 'turn') && slip > 0.5 && (s.backDump = s.backDump || []).length < 3) {
            const vAng = Math.atan2(-b.velocity.x, -b.velocity.z);
            s.backDump.push({ t: +g.time.toFixed(2), cls, slip: Q.r(slip), foot: k ? 'R' : 'L', velRel: Q.r(angDiff(vAng, by) * 57.3, 0), speedS: Q.r(sp), runMode: m.runMode, backward: m.backward, camDist: Q.r(b.position.distanceTo(g.renderer.camera.position), 1), fl: (m._fl || []).map((f) => ({ locked: f?.locked, w: Q.r(f?.w ?? 0), anchor: f?.anchor ? [Q.r(f.anchor.x), Q.r(f.anchor.y), Q.r(f.anchor.z)] : null })) });
          }
        }
      }
      s.lastToes = toesNow; s.lastBY = m.bodyYaw ?? b.yaw;
      s.lastToe = feet;
      // Floating / sinking: lowest toe vs the raycast ground while not jumping.
      const low = Math.min(wp(B.lToe).y, wp(B.rToe).y) - groundY;
      if (!(b.jumpY > 0.01)) {
        if (low > TH.floatM || low < TH.sinkM) { s.floatT += dt; if (s.floatT > TH.floatT) s.floatEv++; } else s.floatT = 0;
        s.floatMax = Math.max(s.floatMax, low); s.sinkMin = Math.min(s.sinkMin, low);
      }
      // Action weight pops.
      for (const a of m.mixer._actions) {
        if (a === m.hitAction || a === m.deathAction || a === m.toppleLoAction || a === m.toppleUpAction) continue;
        const w = a.getEffectiveWeight(), w0 = s.lastW.get(a);
        if (w0 !== undefined && Math.abs(w - w0) > 0.35 && s.spawnT > 0.5) { s.pops++; if (s.popList.length < 5) s.popList.push((a.getClip()?.name || '?') + ' ' + w0.toFixed(2) + '->' + w.toFixed(2)); }
        s.lastW.set(a, w);
      }
      // Chest vs hips twist.
      s.twistMax = Math.max(s.twistMax, Math.abs(m.twist ?? 0) * 57.3);
      // Gait playback ratio: ground speed / blended natural clip speed (moving only).
      if ((m.speedS ?? 0) > 0.8) { let ws = 0, ns = 0; for (const [k, gk] of Object.entries(m.tpl?.gait || {})) { const a = m.lowerActions?.[k]; if (!a) continue; const w = a.getEffectiveWeight(); ws += w; ns += w * gk.speed; } if (ws > 0.5) s.ratio.push(m.speedS / (ns / ws)); }
      // Support palm vs its grip target (outside reload / throw).
      if (m.lGripWorld && !(m.reloadW > 0.1) && !(m.oneShotW > 0) && !m.oneShot) { const gw = typeof m.lGripWorld === 'function' ? m.lGripWorld(b) : m.lGripWorld; if (gw?.isVector3) { const palm = B.lMid ? wp(B.lHand).lerp(wp(B.lMid), 0.5) : wp(B.lHand); s.support.push(palm.distanceTo(gw)); } }
      // Upper-body yaw rate.
      if (B.spine2) { const cy = yawOf(B.spine2); if (s.lastChestYaw != null) s.yawRate.push(angDiff(cy, s.lastChestYaw) * 57.3 / dt); s.lastChestYaw = cy; }
      // Muzzle steadiness while moving and aiming (engaged, not firing, not reloading).
      if (b.goal === 'engage' && (m.speedS ?? 0) > 0.5 && m.weaponObj && !(m.reloadW > 0.1) && !(m.oneShotW > 0) && (b.lastFiredTime === undefined || g.time - b.lastFiredTime > 0.15)) {
        const br = new V(0, 0, -1).applyQuaternion(m.weaponObj.getWorldQuaternion(new m.weaponObj.quaternion.constructor()));
        const am = new V(-Math.sin(b.yaw) * Math.cos(b.pitch), Math.sin(b.pitch), -Math.cos(b.yaw) * Math.cos(b.pitch));
        s.moveAim.push(Math.acos(Math.max(-1, Math.min(1, br.dot(am)))) * 57.3);
      }
      // Hands apart (T-pose / support hand off the gun).
      const apart = wp(B.lHand).distanceTo(wp(B.rHand)); s.apartMax = Math.max(s.apartMax, apart);
      if (apart > TH.handsApart && !m.dying && !m.oneShot && !(m.oneShotW > 0)) { s.apartT += dt; if (s.apartT > TH.handsApartT) s.tpose++; } else s.apartT = 0;
      // Barrel vs aim right after a shot.
      if (b.lastFiredTime !== undefined && g.time - b.lastFiredTime < dt * 1.01) {
        const mz = m.muzzleWorld?.(b);
        if (mz && m.weaponObj && !(m.oneShotW > 0) && !(m.reloadW > 0.1)) {
          const barrel = new V(0, 0, -1).applyQuaternion(m.weaponObj.getWorldQuaternion(new m.weaponObj.quaternion.constructor()));
          const aim = new V(-Math.sin(b.yaw) * Math.cos(b.pitch), Math.sin(b.pitch), -Math.cos(b.yaw) * Math.cos(b.pitch));
          s.aimErr.push(Math.acos(Math.max(-1, Math.min(1, barrel.dot(aim)))) * 57.3);
        }
      }
      // Inside static geometry (solid ray from the chest has zero length).
      const c = new V(b.position.x, b.position.y + 1.0, b.position.z);
      for (const d of DIRS) { const h = g.physics.raycast(c, d, 0.2); if (h && h.distance < 0.005) { s.inside++; break; } }
    });
    if (tick++ % 60 === 0) bots.forEach((b, i) => { const c = b.model; if (!c || dumps[i].length > 70) return; dumps[i].push({ t: +g.time.toFixed(0), same: c === b.spareModel, hasWrap: !!c.weaponObj, wrapParentIsRoot: c.weaponObj?.parent === c.root, rootInScene: !!c.root?.parent, hidden: c._hidden, osw: c.oneShotW, oneShot: c.oneShot?.name, reloadW: c.reloadW, wstate: b.weapon?.state, alive: b.alive, lodAcc: c._lodAcc, animDt: c._animDt, frame: c._frame, matrixFrame: c._matrixFrame, deadTime: c.deadTime, dying: !!c.dying, grip: !!c.lGripWorld, wrapParentType: c.weaponObj?.parent?.type, handOff: c.handOff, rootVisible: c.root?.visible }); });
    // Bot-bot interpenetration
    for (let i = 0; i < bots.length; i++) for (let j = i + 1; j < bots.length; j++) {
      const a = bots[i], b = bots[j]; if (!a.alive || !b.alive) continue;
      if (Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z) < TH.botBotM && Math.abs(a.position.y - b.position.y) < 1) { botBot++; botBotPairs.add(i + '-' + j); }
    }
  });
  if (TPL) TPL.forceFullRate = tplFR;
  for (const b of bots) for (const m of [b.model, b.spareModel, b.corpse]) if (m?._qaLod) { m._lodInterval = m._qaLod; delete m._qaLod; }
  const pct = (arr, p) => { if (!arr.length) return 0; const a = arr.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; };
  out.bots = S.map((s, i) => {
    const stance = s.stance[0].concat(s.stance[1]);
    const byCls = {}; for (const [c, a] of Object.entries(s.cls || {})) byCls[c] = { n: a.length, p50: Q.r(pct(a, 0.5)), p90: Q.r(pct(a, 0.9)) };
    const r = { i, backDump: s.backDump, toeByClass: byCls, toeSlipP50: Q.r(pct(s.toeSlip || [], 0.5)), toeSlipP90: Q.r(pct(s.toeSlip || [], 0.9)), toeN: (s.toeSlip || []).length, hiddenFrames: s.hiddenF || 0, team: bots[i].team, weapon: bots[i].weapon?.id, stanceSlideP95: Q.r(pct(stance, 0.95), 3), stanceN: stance.length, supportP95: Q.r(pct(s.support, 0.95), 3), supportN: s.support.length, yawRateP99: Q.r(pct(s.yawRate, 0.99), 0), moveAimP95: Q.r(pct(s.moveAim, 0.95), 1), moveAimN: s.moveAim.length, deaths: s.deaths, ratioP5: Q.r(pct(s.ratio, 0.05)), ratioP95: Q.r(pct(s.ratio, 0.95)), ratioN: s.ratio.length, aliveS: Q.r(s.aliveT, 1), slideP95: Q.r(pct(s.slide, 0.95)), slideN: s.slide.length, popsPerMin: Q.r(s.pops / Math.max(1e-3, s.aliveT) * 60, 1), pops: s.popList, twistMax: Q.r(s.twistMax, 0), aimP90: Q.r(pct(s.aimErr, 0.9), 1), aimN: s.aimErr.length, handsApartMax: Q.r(s.apartMax), tposeEvents: s.tpose, floatMax: Q.r(s.floatMax), sinkMin: Q.r(s.sinkMin), floatEvents: s.floatEv, insideFrames: s.inside, corpseMaxS: Q.r(s.corpseMax, 1) };
    const F = (m) => out.fails.push(`bot${i}: ${m}`);
    if (r.toeN > 60 && r.toeSlipP90 > 0.7) F(`planted toe slip p90 ${r.toeSlipP90} m/s > 0.7 (p50 ${r.toeSlipP50})`); else if (r.toeN > 60 && r.toeSlipP50 > 0.25) out.warn.push(`bot${i}: toe slip p50 ${r.toeSlipP50}`);
    if (r.stanceN > 10 && r.stanceSlideP95 > TH.stanceSlideP95) out.warn.push(`bot${i}: [unvalidated] stance foot slide p95 ${r.stanceSlideP95} m per contact > ${TH.stanceSlideP95} (spec ≤0.02)`); else if (r.stanceN > 10 && r.stanceSlideP95 > TH.stanceSlideWarn) out.warn.push(`bot${i}: stance slide p95 ${r.stanceSlideP95} m`);
    if (r.supportN > 30 && r.supportP95 > TH.supportP95) F(`support hand off grip p95 ${r.supportP95} m > ${TH.supportP95}`);
    if (r.yawRateP99 > TH.yawRateP99) F(`upper-body yaw rate p99 ${r.yawRateP99}°/s > ${TH.yawRateP99}`);
    if (r.moveAimN > 20 && r.moveAimP95 > TH.moveAimP95) F(`muzzle off aim while moving aimed p95 ${r.moveAimP95}° > ${TH.moveAimP95}`);
    for (const d of s.deaths) {
      if (d.head) continue; // headshots drop instantly by design
      if ((d.ground == null && !(d.respawnedAt < 1.5)) || d.ground < TH.deathGroundLo || d.ground > TH.deathGroundHi) F(`death: hips grounded at ${d.ground == null ? 'never (within ' + (d.respawnedAt ?? 4) + ' s)' : d.ground + ' s'} (spec 0.7-1.1)`);
      if (d.jitter != null && d.jitter > TH.deathJitter) F(`death: corpse jitter ${d.jitter} m/s at 3-4 s`);
    }
    out._deaths = (out._deaths || []).concat(s.deaths);
    if (r.ratioN > 30 && (r.ratioP5 < TH.ratioLo || r.ratioP95 > TH.ratioHi)) F(`gait playback ratio p5..p95 ${r.ratioP5}..${r.ratioP95} outside ${TH.ratioLo}..${TH.ratioHi}`);
    if (r.popsPerMin > TH.popsPerMin) F(`${r.popsPerMin} weight pops/min (${s.popList.join('; ')})`);
    if (r.twistMax > TH.twistDeg) F(`chest twist ${r.twistMax}° > ${TH.twistDeg}`);
    if (r.aimN >= 5 && r.aimP90 > TH.aimP90Deg) F(`barrel-vs-aim p90 ${r.aimP90}° over ${r.aimN} shots`);
    if (r.tposeEvents) F(`hands apart > ${TH.handsApart} m for > ${TH.handsApartT}s (${r.tposeEvents} frames; max ${r.handsApartMax} m)`);
    if (r.floatEvents) out.warn.push(`bot${i}: [unvalidated] feet floating/sinking > ${TH.floatT}s (max ${r.floatMax}, min ${r.sinkMin})`);
    if (r.insideFrames > 15) F(`chest inside static geometry for ${r.insideFrames} frames`);
    if (r.corpseMaxS > TH.corpseS) F(`corpse visible ${r.corpseMaxS}s`);
    return r;
  });
  const D = out._deaths || []; delete out._deaths;
  const far = D.filter((d) => d.disp > TH.deathDisp + 0.15).length;
  out.deathSummary = { n: D.length, dispOver045: far, groundTimes: D.map((d) => d.ground) };
  if (D.length >= 5 && far / D.length > 0.3) out.fails.push(`deaths: ${far}/${D.length} displace hips > ${TH.deathDisp + 0.15} m (spec ≤0.3; allowance 30% for backward-fall variant + shotgun/grenade knockback)`);
  if (Object.prototype.hasOwnProperty.call(g, 'onActorKilled')) delete g.onActorKilled;
  for (const b of bots) if (b._qaUpd) { b.update = b._qaUpd; delete b._qaUpd; }
  out.updateExceptions = excs.map((e, i) => e.length ? { i, e } : null).filter(Boolean);
  out.dumps = out.bots.map((r, i) => (r.aimP90 > 8 || r.moveAimP95 > 4 || r.supportP95 > 1) ? { i, dump: dumps[i] } : null).filter(Boolean);
  const agg = {}; S.forEach((s) => { for (const [c, a] of Object.entries(s.cls || {})) (agg[c] = agg[c] || []).push(...a); });
  const tot = Object.values(agg).reduce((t, a) => t + a.length, 0) || 1;
  out.toeSlipByClass = Object.fromEntries(Object.entries(agg).map(([c, a]) => [c, { share: Q.r(a.length / tot), n: a.length, p50: Q.r(pct(a, 0.5)), p90: Q.r(pct(a, 0.9)) }]));
  out.botBotFrames = botBot; out.botBotPairs = [...botBotPairs].slice(0, 10);
  if (botBot > 30) out.fails.push(`bot-bot interpenetration ${botBot} pair-frames (${out.botBotPairs.join(',')})`);
  out.kills = g.mode.score; out.nan = Q.nanScan(); if (out.nan.length) out.fails.push('NaN ' + out.nan);
  return out;
})()
