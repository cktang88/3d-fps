// CPU frame-time profile (owner: perf). Live TDM match, bots active, player parked in god mode.
// Per-subsystem main-thread ms per frame at a fixed 60 Hz step, GPU rendering skipped (llvmpipe GPU time is not
// representative of real hardware; draw-call CPU cost is measured separately in perf_profile).
(async () => {
  const g = window.__game, P = window.__perf, Q = window.__qa;
  Q.god(); Q.releaseAll();
  Q.place([0, 0, 20], 0.3, 0.02);
  Q.sim(3); // let bots spread out and engage
  const out = {};
  out.cpu = await P.cpuProfile(240, false);
  // With rendering (320x180 so llvmpipe fill is negligible): renderer.render ≈ JS + GL command submission cost.
  out.cpuRender = await P.cpuProfile(40, true);
  out.bots = { n: g.bots.length, alive: g.bots.filter((b) => b.alive).length };
  return out;
})()
