// Movement diagnostics: per-frame traces around slide / vault / mantle / stairs top.
(() => {
  const g = window.__game, Q = window.__qa, p = g.player, out = {};
  Q.god(); Q.freezeBots(true); Q.releaseAll(); Q.loadout('m4', 'p226');
  const st = () => ({ x: Q.r(p.position.x), y: Q.r(p.position.y), z: Q.r(p.position.z), v: Q.r(Q.hspeed()), gr: p.grounded, spr: p.sprinting, sl: p.sliding, cr: p.crouching, m: p.mantle?.type || 0, cd: Q.r(p.slideCooldown) });
  const ev = []; const om = p.events._qaOrigMantle ?? (p.events._qaOrigMantle = p.events.onMantle); p.events.onMantle = (t, l) => { ev.push([t, Q.r(l)]); om?.(t, l); };
  // Slide
  Q.place([0, 0.1, 20], 0, 0); Q.sim(0.6); Q.down('KeyW'); Q.down('ShiftLeft'); Q.sim(1.2);
  out.slidePre = st(); Q.tap('KeyC'); const tr = []; Q.sim(0.5, 1 / 30, () => tr.push(st())); out.slideTrace = tr.slice(0, 6); Q.releaseAll(); Q.sim(1);
  // Slide with KeyC held (hold-crouch users)
  Q.place([0, 0.1, 20], 0, 0); Q.sim(0.6); Q.down('KeyW'); Q.down('ShiftLeft'); Q.sim(1.2); Q.press('KeyC'); Q.sim(1 / 30); out.slideHeld = st(); Q.releaseAll(); Q.sim(1.5);
  out.holdCrouch = g.settings.holdCrouch;
  // Vault: walk (not sprint) at the brick wall, sample when blocked, then press jump right at the wall.
  const runAt = (start, yaw, axis, sign, label) => {
    ev.length = 0; Q.place(start, yaw, 0); Q.sim(0.6); Q.down('KeyW'); const t = [];
    Q.sim(2.5, 1 / 30, (tt) => { if (Math.round(tt * 30) % 5 === 0) t.push(st()); });
    out[label + '_walkInto'] = { end: st(), trace: t };
    Q.tap('Space'); Q.sim(1.5); out[label + '_afterJump'] = { end: st(), events: ev.slice() }; Q.releaseAll();
    // raycast toward the obstacle from start height 0.6
    const o = new p.position.constructor(start[0], 0.6, start[2]); const d = new p.position.constructor(axis === 'x' ? sign : 0, 0, axis === 'z' ? sign : 0);
    const h = g.physics.raycast(o, d, 20); out[label + '_ray'] = h ? { dist: Q.r(h.distance), point: [Q.r(h.point.x), Q.r(h.point.y), Q.r(h.point.z)] } : null;
  };
  runAt([-30, 0.1, 0], Math.PI / 2, 'x', -1, 'wall');
  runAt([9, 0.1, -20], 0, 'z', -1, 'dock');
  // Stairs top: walk up and trace densely around the top.
  Q.place([-16.4, 0.1, -31], 0, 0); Q.sim(0.6); Q.down('KeyW'); const t2 = [];
  Q.sim(3.5, 1 / 30, () => t2.push(st())); Q.releaseAll();
  out.stairsTop = t2.filter((s) => s.z < -38 && s.z > -46);
  // Down-rays to map the catwalk deck along x=-16.4 between z=-38..-50.
  const deck = []; for (let z = -38; z >= -50; z -= 1) { const o = new p.position.constructor(-16.4, 8, z); const h = g.physics.raycast(o, new p.position.constructor(0, -1, 0), 10); deck.push([z, h ? Q.r(h.point.y) : null]); }
  out.deckProfile = deck;
  p.events.onMantle = om; delete p.events._qaOrigMantle; Q.thawBots();
  return out;
})()
