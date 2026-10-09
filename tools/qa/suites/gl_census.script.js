// GL call census (owner: render). Per-frame counts of GPU→CPU sync points, uploads, shader compiles, FBO
// switches and draws during live play, plus program count over time and the timer-query extension.
//   node tools/qa/submit.mjs render tools/qa/suites/gl_census.json
(async () => {
  const g = window.__game, Q = window.__qa, r = g.renderer.renderer, gl = r.getContext();
  const frame = () => new Promise((res) => requestAnimationFrame(() => res()));
  const C = {}; let on = false;
  const SYNC = ['readPixels', 'getError', 'clientWaitSync', 'fenceSync', 'getBufferSubData', 'finish', 'getProgramParameter', 'getShaderParameter', 'getProgramInfoLog', 'getShaderInfoLog', 'getParameter', 'getSyncParameter', 'checkFramebufferStatus', 'getQueryParameter'];
  const WORK = ['compileShader', 'linkProgram', 'useProgram', 'bindFramebuffer', 'blitFramebuffer', 'drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'clear', 'texImage2D', 'texSubImage2D', 'texImage3D', 'texSubImage3D', 'texStorage2D', 'texStorage3D', 'bufferData', 'bufferSubData', 'generateMipmap', 'renderbufferStorageMultisample', 'framebufferTexture2D', 'invalidateFramebuffer', 'flush'];
  const fmts = {};
  const orig = {};
  for (const k of [...SYNC, ...WORK]) {
    if (!gl[k]) continue;
    orig[k] = gl[k];
    gl[k] = function (...a) {
      if (on) {
        C[k] = (C[k] || 0) + 1;
        if (k === 'bufferData' || k === 'bufferSubData') { const d = a[1]; C[k + '_bytes'] = (C[k + '_bytes'] || 0) + (d?.byteLength ?? (typeof d === 'number' ? d : 0)); }
        if (k === 'texImage2D' || k === 'texSubImage2D') { const w = a.length >= 9 ? a[3] * a[4] : (a[5]?.width || 0) * (a[5]?.height || 0); C[k + '_px'] = (C[k + '_px'] || 0) + (w || 0); }
        if (k === 'getParameter') { const n = a[0]; C['getParameter_' + n] = (C['getParameter_' + n] || 0) + 1; }
      }
      if (k === 'texStorage2D' || k === 'texStorage3D') { const f = '0x' + a[2].toString(16) + ` ${a[3]}x${a[4]}`; fmts[f] = (fmts[f] || 0) + 1; }
      return orig[k].apply(this, a);
    };
  }
  const out = { timerQuery: !!gl.getExtension('EXT_disjoint_timer_query_webgl2'), parallelCompile: !!gl.getExtension('KHR_parallel_shader_compile'), renderer: g.renderer.gpuInfo, phases: {} };
  Q.god(); Q.releaseAll();
  const run = async (name, n, setup) => {
    setup?.();
    window.__qaSkipRender = false;
    await frame(); await frame();
    const p0 = r.info.programs.length;
    for (const k of Object.keys(C)) delete C[k];
    on = true;
    const progs = [];
    for (let i = 0; i < n; i++) { await frame(); progs.push(r.info.programs.length); }
    on = false;
    const per = {};
    for (const [k, v] of Object.entries(C)) per[k] = +(v / n).toFixed(2);
    out.phases[name] = { frames: n, programsStart: p0, programsEnd: r.info.programs.length, programsTrace: progs.filter((_, i) => i % 5 === 0), perFrame: per };
  };
  await run('hip_courtyard', 30, () => { Q.place([0, 0, 20], 0.3, 0.02); });
  await run('firing', 30, () => { Q.down('Mouse0'); });
  Q.down('Mouse0', false);
  await run('ads_scope', 30, () => { Q.loadout('scar'); Q.sim(1.2); Q.place([0, 0.1, 10], 0.15, 0.02); Q.down('Mouse2'); Q.sim(0.8); });
  Q.down('Mouse2', false);
  await run('sun', 20, () => { Q.place([2, 0, -8], 2.68, 0.06); });
  out.texStorageFormats = fmts;
  out.programsTotal = r.info.programs.length;
  out.vm = { probeEvery: g.viewmodel?.probeEvery, probeInterval: g.viewmodel?.probeInterval };
  for (const k of Object.keys(orig)) gl[k] = orig[k];
  window.__qaSkipRender = true;
  return out;
})()
