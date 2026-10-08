// Automated playtest / screenshot harness (headless Chromium + SwiftShader WebGL).
// Usage: node tools/shot.mjs <scenario> [outDir]
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const scenario = process.argv[2] || 'overview';
const out = process.argv[3] || 'tools/shots';
fs.mkdirSync(out, { recursive: true });
const W = +(process.env.W || 1280), H = +(process.env.H || 720);
const PORT = process.env.PORT || '5199';

const server = spawn('npx', ['vite', '--port', PORT, '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('Local') || String(d).includes('ready')) res(); }));

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning' || process.env.VERBOSE) logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message + '\n' + e.stack));
await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
const t0 = Date.now();
await page.waitForFunction(() => window.__game?.menu, null, { timeout: 240000 }).catch(() => {});
console.log('loaded in', ((Date.now() - t0) / 1000).toFixed(1), 's');

const shot = async (name) => { await page.screenshot({ path: `${out}/${scenario}_${name}.png` }); console.log('shot', name); };
const frames = (n) => page.evaluate((n) => new Promise((r) => { let i = 0; const f = () => (++i >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
const ev = (fn, arg) => page.evaluate(fn, arg);

try {
  if (scenario === 'menu') {
    await frames(5); await shot('menu');
  } else {
    await ev(() => { const g = window.__game; g.menu.close(); g.startMatch('tdm'); g.paused = false; });
    await frames(10);
    const views = JSON.parse(process.env.VIEWS || 'null') || [
      { name: 'spawn', pos: null },
      { name: 'courtyard', pos: [-20, 0, 2], yaw: -1.2, pitch: -0.05 },
      { name: 'warehouse', pos: [-6, 0, -30], yaw: 0.2, pitch: 0.05 },
      { name: 'containers', pos: [22, 0, 4], yaw: -1.6, pitch: 0 },
      { name: 'office', pos: [-2, 0, 24], yaw: Math.PI, pitch: 0.05 },
      { name: 'ruins', pos: [-30, 0, -4], yaw: 1.3, pitch: 0.02 },
    ];
    for (const v of views) {
      await ev((v) => {
        const g = window.__game, p = g.player;
        if (v.pos) { p.position.set(v.pos[0], v.pos[1], v.pos[2]); p.velocity.set(0, 0, 0); p._syncBody(); }
        if (v.yaw !== undefined) p.yaw = v.yaw;
        if (v.pitch !== undefined) p.pitch = v.pitch;
        if (v.weapon !== undefined) g.switchSlot(v.weapon);
        if (v.ads) { g.input.down.add('Mouse2'); } else g.input.down.delete('Mouse2');
        if (v.fire) { g.input.down.add('Mouse0'); g.input.pressed.add('Mouse0'); } else g.input.down.delete('Mouse0');
        if (v.reload) { g.input.pressed.add('KeyR'); }
        if (v.sprint) { g.input.down.add('ShiftLeft'); g.input.down.add('KeyW'); } else { g.input.down.delete('ShiftLeft'); g.input.down.delete('KeyW'); }
        if (v.eval) (0, eval)(v.eval);
      }, v);
      await frames(v.frames || 8);
      await shot(v.name);
    }
  }
  const stats = await ev(() => {
    const g = window.__game; const i = g.renderer.renderer.info;
    return { calls: i.render.calls, tris: i.render.triangles, geos: i.memory.geometries, tex: i.memory.textures, bots: g.bots.length, alive: g.bots.filter((b) => b.alive).length, nav: g.nav?.buildTime };
  });
  console.log('stats', JSON.stringify(stats));
} catch (e) {
  console.log('ERROR', e.message);
}
console.log(logs.slice(0, 40).join('\n'));
await browser.close();
try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); }
process.exit(0);
