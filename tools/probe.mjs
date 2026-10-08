// Headless probe: boots the game, starts a TDM match, then runs a JS file inside the page.
// Usage: PORT=5204 node tools/probe.mjs <script.js> [shotPrefix]
// The script body runs as an async function with (g = window.__game, h = helpers) and its return
// value is printed as JSON. helpers: sim(cmd, n, dt) steps the player only (deterministic),
// frames(n) waits for n real frames, log(...) collects lines.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const file = process.argv[2];
const body = fs.readFileSync(file, 'utf8');
const PORT = process.env.PORT || '5204';
const W = +(process.env.W || 1280), H = +(process.env.H || 720);
const server = spawn('npx', ['vite', '--port', PORT, '--strictPort'], { env: { ...process.env, NO_HMR: '1' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
const killServer = () => { try { process.kill(-server.pid, 'SIGTERM'); } catch {} };
server.stderr.on('data', (d) => { if (String(d).includes('already in use')) { console.log('port busy'); process.exit(1); } });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('Local') || String(d).includes('ready')) res(); }));
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.setDefaultTimeout(600000);
const logs = [];
page.on('console', (m) => { if (m.text().startsWith('[probe]')) console.log(m.text()); else if (m.type() === 'error' || m.type() === 'warning' || process.env.VERBOSE) logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message + '\n' + e.stack));
await page.exposeFunction('__shot', async (name) => { fs.mkdirSync('tools/shots', { recursive: true }); await page.screenshot({ path: `tools/shots/probe_${name}.png`, timeout: 180000 }); });
await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game?.menu, null, { timeout: 240000 }).catch(() => {});
// Harness-only guard: strip stray morph attributes that crash three's renderer (level prop bug).
await page.evaluate(() => { const g = window.__game; g?.renderer?.scene.traverse((o) => { if (o.isMesh && o.geometry?.morphAttributes && Object.keys(o.geometry.morphAttributes).length && !o.morphTargetInfluences) o.geometry.morphAttributes = {}; }); });
if (!process.env.NOSTART) await page.evaluate(() => { const g = window.__game; g.menu.close(); g.startMatch(window.__mode || 'tdm'); g.paused = false; });
try {
  const res = await page.evaluate(async (body) => {
    const g = window.__game;
    const out = [];
    const h = {
      log: (...a) => out.push(console.log('[probe]', ...a) ?? a.map((x) => (typeof x === 'number' ? +x.toFixed(3) : typeof x === 'object' ? JSON.stringify(x) : x)).join(' ')),
      frames: (n) => new Promise((r) => { let i = 0; const f = () => (++i >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }),
      shot: (n) => window.__shot(n),
      cmd: (o = {}) => ({ moveX: 0, moveY: 0, sprint: false, sprintPressed: false, crouchPressed: false, crouchHeld: false, jumpPressed: false, jumpHeld: false, aim: false, walk: false, leanLeft: false, leanRight: false, ...o }),
      place: (x, y, z, yaw = 0) => { const p = g.player; p.position.set(x, y, z); p.velocity.set(0, 0, 0); p.yaw = yaw; p.pitch = 0; p.mantle = null; p.crouching = p.sliding = false; p.setHeight(1.8); p._syncBody(); p.grounded = false; },
      sim(cmd, n, dt = 1 / 60, each) {
        const p = g.player;
        for (let i = 0; i < n; i++) {
          const c = typeof cmd === 'function' ? cmd(i) : cmd;
          p.update(dt, c, g.currentWeapon);
          g.physics.world.step();
          each?.(i, p);
        }
      },
    };
    const fn = new Function('g', 'h', 'return (async () => {' + body + '\n})()');
    const r = await fn(g, h);
    return { out, r };
  }, body);
  console.log(res.out.join('\n'));
  if (res.r !== undefined) console.log(JSON.stringify(res.r, null, 1));
} catch (e) { console.log('ERROR', e.message); }
console.log(logs.slice(0, 40).join('\n'));
await browser.close();
killServer();
process.exit(0);
