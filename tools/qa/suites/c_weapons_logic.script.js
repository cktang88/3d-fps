// (c) Weapon logic regression: every weapon — equip, hip fire, ADS, burst, tac/empty reload, sprint lockout,
// effects (tracers / flashes / decals / bullets), slot switch. Pure simulation (no rendering) -> fast.
(() => {
  const g = window.__game, Q = window.__qa, out = { weapons: {}, fails: [] };
  const fail = (id, msg) => out.fails.push(`${id}: ${msg}`);
  Q.god(); Q.freezeBots(true);
  // Stand in the courtyard facing a wall so bullets hit something close.
  const ids = Object.keys(window.__WEAPONS || {}).length ? Object.keys(window.__WEAPONS) : ['m4', 'ak', 'scar', 'mp5', 'vss', 'm24', 'awm', 'rpk', 'm870', 'p226', 'm1911'];
  for (const id of ids) {
    const r = {}; out.weapons[id] = r;
    try {
      Q.releaseAll(); Q.place([0, 0.1, 0], 0, 0); Q.loadout(id);
      g.player.spawnProtect = 0;
      Q.sim(1.2);
      const w = g.currentWeapon, s = w.stats;
      r.mag = s.mag; r.modes = s.modes.join('/'); r.closedBolt = !!s.closedBolt; r.state0 = w.state;
      if (w.id !== id) fail(id, 'loadout did not switch, current=' + w.id);
      if (w.state !== 'idle') fail(id, 'not idle 1.2s after equip: ' + w.state);
      // Effects baseline
      let fired = 0; w.on('fire', () => fired++);
      let flashes = 0; const mf = g.effects.muzzleFlash; g.effects.muzzleFlash = function (...a) { flashes++; return mf.apply(this, a); };
      let decalAdds = 0; const pools = Object.values(g.effects.decals); for (const d of pools) { d._qaAdd = d.add; d.add = function (...a) { decalAdds++; return d._qaAdd.apply(this, a); }; }
      let tracers = 0; const tf = g.effects.tracer; g.effects.tracer = function (...a) { tracers++; return tf.apply(this, a); };
      const fx0 = Q.fx();
      // Hip fire: hold trigger 0.5 s (auto) or tap once.
      const a0 = w.ammo;
      const mode = w.mode;
      Q.press('Mouse0'); Q.sim(mode === 'auto' ? 0.5 : 0.05); const fxMid = Q.fx(); Q.down('Mouse0', false); Q.sim(0.6);
      r.hipShots = fired; r.ammoAfterHip = w.ammo;
      const expect = mode === 'burst' ? (s.burst || 3) : mode === 'auto' ? null : 1;
      if (expect != null && fired !== expect) fail(id, `${mode} fire produced ${fired} shots, expected ${expect}`);
      if (mode === 'auto') { r.effRpm = Math.round(fired / 0.5 * 60); }
      if (mode === 'auto' && fired < 3) fail(id, `auto fire for 0.5 s produced only ${fired} shots`);
      if (a0 - w.ammo !== fired) fail(id, `ammo dropped ${a0 - w.ammo} but ${fired} shots fired`);
      Q.sim(0.4);
      const fx1 = Q.fx();
      r.fxMid = fxMid; r.flashCalls = flashes; r.tracerCalls = tracers; delete g.effects.muzzleFlash; delete g.effects.tracer;
      if (fired >= 3 && tracers === 0) fail(id, 'no tracers for ' + fired + ' shots');
      r.fx = { flashes: fx1.flashes - fx0.flashes, decalsAdded: fx1.decals - fx0.decals, sparksDust: (fx1.sparks + fx1.dust) - (fx0.sparks + fx0.dust) };
      r.fxPeak = fx1;
      r.decalAdds = decalAdds; for (const d of pools) { delete d.add; delete d._qaAdd; }
      if (decalAdds === 0 && fired > 0) fail(id, 'no bullet-hole decals added after firing at wall');
      // Bolt / pump cycle
      if (mode === 'bolt' || mode === 'pump') { Q.press('Mouse0'); Q.sim(0.05); Q.down('Mouse0', false); r.cycleState = w.state; if (w.state !== mode) fail(id, `after shot state=${w.state}, expected ${mode}`); Q.sim(2); }
      // Burst check for weapons that have burst mode elsewhere in their list.
      if (s.modes.includes('burst') && mode !== 'burst') {
        while (w.mode !== 'burst') w.cycleMode();
        fired = 0; Q.press('Mouse0'); Q.sim(0.6); Q.down('Mouse0', false); Q.sim(0.3);
        r.burstShots = fired; if (fired !== (s.burst || 3)) fail(id, `burst (held 0.6 s) fired ${fired}`);
        while (w.modeIndex !== 0) w.cycleMode();
      }
      // ADS
      Q.down('Mouse2'); Q.sim(s.ads + 0.25); r.adsT = Q.r(w.adsT); r.fov = Q.r(g.renderer.camera.fov, 1);
      if (w.adsT < 0.99) fail(id, `adsT=${w.adsT.toFixed(2)} after ${s.ads}+0.25 s`);
      Q.down('Mouse2', false); Q.sim(0.6);
      if (w.adsT > 0.01) fail(id, 'did not leave ADS');
      // Tactical reload
      if (w.ammo === s.mag) { Q.press('Mouse0'); Q.sim(0.05); Q.down('Mouse0', false); Q.sim(1.5); }
      const before = w.ammo, res0 = w.reserve;
      Q.tap('KeyR'); Q.sim(0.05);
      r.tacType = w.reloadType; r.tacState = w.state;
      if (s.tube) { Q.sim(8); r.afterShellReload = w.ammo; if (w.ammo !== s.mag) fail(id, `shell reload ended at ${w.ammo}/${s.mag}`); }
      else {
        Q.sim(s.tacReload + 0.3);
        r.tacAmmo = w.ammo; const want = s.mag + (s.closedBolt ? 1 : 0);
        if (w.ammo !== want) fail(id, `tac reload from ${before} gave ${w.ammo}, expected ${want}`);
        if (res0 - w.reserve !== w.ammo - before) fail(id, `reserve accounting off: reserve -${res0 - w.reserve}, ammo +${w.ammo - before}`);
      }
      // Empty reload
      w.ammo = 0; w.chambered = false;
      Q.press('Mouse0'); Q.sim(0.05); Q.down('Mouse0', false); // dry fire triggers auto reload
      r.emptyType = w.reloadType; r.emptyState = w.state;
      if (w.state !== 'reload') fail(id, 'dry trigger did not start reload, state=' + w.state);
      Q.sim((s.tube ? 9 : s.emptyReload) + 0.6);
      r.emptyAmmo = w.ammo;
      if (w.ammo !== s.mag) fail(id, `empty reload gave ${w.ammo}, expected ${s.mag}`);
      if (w.state !== 'idle') fail(id, 'not idle after empty reload: ' + w.state);
      // Sprint: lockout, no fire, no ADS
      fired = 0; Q.down('ShiftLeft'); Q.down('KeyW'); Q.sim(0.8);
      r.sprintT = Q.r(w.sprintT); r.sprintSpeed = Q.r(Q.hspeed()); r.sprinting = g.player.sprinting;
      Q.press('Mouse0'); Q.sim(0.1); Q.down('Mouse0', false);
      if (fired) fail(id, `fired ${fired} while sprinting`);
      if (w.sprintT < 0.9) fail(id, 'sprint pose not reached, sprintT=' + w.sprintT.toFixed(2));
      Q.down('ShiftLeft', false); Q.down('KeyW', false); Q.sim(0.6);
      // Reload during sprint must not be cancelled for nothing; inspect works
      Q.tap('KeyI'); Q.sim(0.1); r.inspect = w.state; Q.sim(3.5);
    } catch (e) { fail(id, 'EXC ' + e.message); r.exc = String(e.stack).slice(0, 300); }
  }
  // Slot switch with default loadout
  Q.releaseAll(); Q.loadout('m4', 'p226'); Q.sim(1);
  const t0 = performance.now();
  Q.tap('Digit2'); Q.sim(0.05); out.switchStart = g.currentWeapon.id; let tSwitch = null;
  for (let i = 0; i < 60 && tSwitch == null; i++) { Q.sim(1 / 30); if (g.currentWeapon.id === 'p226' && g.currentWeapon.state === 'idle') tSwitch = Q.r((i + 2) / 30); }
  out.switchToSecondary = { now: g.currentWeapon.id, secondsToReady: tSwitch };
  if (g.currentWeapon.id !== 'p226') out.fails.push('switch: slot 2 did not select secondary');
  Q.tap('Digit1'); Q.sim(2); if (g.currentWeapon.id !== 'm4') out.fails.push('switch: slot 1 did not return to primary');
  out.nan = Q.nanScan(); if (out.nan.length) out.fails.push('NaN: ' + out.nan.join(','));
  out.simMs = Q.r(performance.now() - t0, 0);
  Q.thawBots();
  return out;
})()
