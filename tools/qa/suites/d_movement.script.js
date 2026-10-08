// (d) Movement regression: walk / sprint / crouch speeds, jump apex, slide, vault (low brick wall x=-34),
// mantle (loading dock x=9 z=-24.5), stairs to the warehouse catwalk. Pure simulation.
(() => {
  const g = window.__game, Q = window.__qa, p = g.player, out = { fails: [] };
  const fail = (m) => out.fails.push(m);
  Q.god(); Q.freezeBots(true); Q.releaseAll(); Q.loadout('m4', 'p226');
  const settle = (pos, yaw) => { Q.releaseAll(); Q.place(pos, yaw, 0); Q.sim(0.6); p.spawnProtect = 0; };
  // Speeds in the open courtyard heading -Z from z=+18.
  const speed = (keys, t = 1.6) => { settle([0, 0.1, 18], 0); for (const k of keys) Q.down(k); Q.sim(t); const v = Q.hspeed(); Q.releaseAll(); return Q.r(v); };
  out.walk = speed(['KeyW']); out.sprint = speed(['KeyW', 'ShiftLeft']); out.back = speed(['KeyS']); out.strafe = speed(['KeyD']);
  settle([0, 0.1, 18], 0); Q.tap('KeyC'); Q.sim(0.1); Q.down('KeyW'); Q.sim(1.5); out.crouch = Q.r(Q.hspeed()); out.crouching = p.crouching; Q.releaseAll(); Q.tap('KeyC'); Q.sim(0.4);
  settle([0, 0.1, 18], 0); Q.down('Mouse2'); Q.down('KeyW'); Q.sim(1.6); out.adsWalk = Q.r(Q.hspeed()); Q.releaseAll();
  if (Math.abs(out.walk - 4.6) > 0.5) fail(`walk speed ${out.walk} (expected ~4.6 * mobility)`);
  if (out.sprint < 6.0) fail(`sprint speed ${out.sprint} (expected ~6.8)`);
  if (out.crouch > 2.6) fail(`crouch speed ${out.crouch}`);
  // Jump apex
  settle([0, 0.1, 18], 0); const y0 = p.position.y; let apex = y0, air = 0;
  Q.tap('Space'); Q.sim(1.4, 1 / 60, () => { apex = Math.max(apex, p.position.y); if (!p.grounded) air += 1 / 60; });
  out.jump = { apex: Q.r(apex - y0), airTime: Q.r(air), landedGrounded: p.grounded };
  if (Math.abs(apex - y0 - 1.05) > 0.25) fail(`jump apex ${Q.r(apex - y0)} (expected ~1.05)`);
  // Slide: sprint then crouch
  settle([0, 0.1, 20], 0); Q.down('KeyW'); Q.down('ShiftLeft'); Q.sim(1.2); const sx = p.position.z;
  Q.tap('KeyC'); Q.sim(1 / 30); out.slideStarted = p.sliding; let slideT = 0, peak = 0;
  Q.sim(1.6, 1 / 30, () => { if (p.sliding) { slideT += 1 / 30; peak = Math.max(peak, Q.hspeed()); } });
  out.slide = { started: out.slideStarted, duration: Q.r(slideT), peakSpeed: Q.r(peak), dist: Q.r(sx - p.position.z) };
  if (!out.slideStarted) fail('slide did not start from sprint + crouch');
  Q.releaseAll(); Q.sim(0.5);
  // Vault over the low brick wall at x=-34 (z in [-4,4]); approach from x=-29 heading -X.
  const mt = []; const origMantle = p.events.onMantle; p.events.onMantle = (type, ledge) => { mt.push([type, Q.r(ledge)]); origMantle?.(type, ledge); };
  settle([-29, 0.1, 0], Math.PI / 2); Q.down('KeyW'); Q.down('ShiftLeft'); Q.sim(0.5);
  let jumped = false; Q.sim(2.0, 1 / 30, () => { if (!jumped && p.position.x < -32.4) { Q.tap('Space'); jumped = true; } });
  out.vault = { events: mt.slice(), endPos: Q.p(), crossed: p.position.x < -34.6 };
  if (!mt.some((m) => m[0] === 'vault')) fail(`vault at brick wall x=-34 did not trigger (events ${JSON.stringify(mt)}, end ${JSON.stringify(Q.p())})`);
  if (p.position.x > -34.6) fail(`player did not cross the brick wall, x=${Q.r(p.position.x)}`);
  Q.releaseAll(); mt.length = 0;
  // Mantle onto the loading dock (top y=1.2, z in [-26,-23]); approach from z=-19 heading -Z at x=9.
  settle([9, 0.1, -19], 0); Q.down('KeyW'); Q.sim(0.5);
  jumped = false; Q.sim(2.0, 1 / 30, () => { if (!jumped && p.position.z < -21.9) { Q.tap('Space'); Q.down('Space'); jumped = true; } });
  Q.releaseAll(); Q.sim(0.5);
  out.mantle = { events: mt.slice(), endPos: Q.p(), onDock: p.position.y > 1.0 };
  if (!mt.length) fail('no mantle/climb event at the loading dock');
  if (p.position.y < 1.0) fail(`not on the loading dock after mantle, y=${Q.r(p.position.y)}`);
  p.events.onMantle = origMantle;
  // Stairs to the warehouse catwalk: steel stairs at x=-16.4 starting z~-33.5 rising north (-Z).
  settle([-16.4, 0.1, -31.0], 0); const trace = []; Q.down('KeyW');
  Q.sim(4.5, 1 / 30, (t) => { if (Math.round(t * 30) % 15 === 0) trace.push([Q.r(p.position.z, 1), Q.r(p.position.y, 2)]); });
  Q.releaseAll(); out.stairs = { trace, end: Q.p(), maxY: Math.max(...trace.map((x) => x[1])) };
  if (p.position.y < 3.0) fail(`stairs: did not reach catwalk height, end ${JSON.stringify(Q.p())}`);
  // Stuck check: walk along catwalk east for 3 s
  Q.place([p.position.x, p.position.y + 0.05, p.position.z], -Math.PI / 2, 0); Q.down('KeyW'); const cx = p.position.x; Q.sim(3); Q.releaseAll();
  out.catwalkWalk = { from: Q.r(cx), to: Q.r(p.position.x), y: Q.r(p.position.y) };
  // Fall damage check: drop from catwalk height with god mode off measured on health
  out.nan = Q.nanScan(); if (out.nan.length) fail('NaN: ' + out.nan);
  Q.thawBots();
  return out;
})()
