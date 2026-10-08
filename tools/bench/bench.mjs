import { chromium } from 'playwright';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const root = process.cwd();
const srv = http.createServer((q, s) => { const f = path.join(root, decodeURIComponent(q.url.split('?')[0])); if (!fs.existsSync(f)) { s.writeHead(404); return s.end(); } s.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html' }); fs.createReadStream(f).pipe(s); }).listen(5399);
const configs = {
  swiftshader: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  mesa_gl: ['--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
  mesa_egl: ['--use-gl=egl', '--ignore-gpu-blocklist'],
  mesa_vulkan: ['--use-gl=angle', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist'],
};
const HEADFUL = !!process.env.DISPLAY;
for (const [name, args] of Object.entries(configs)) {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args, headless: !HEADFUL });
  const p = await b.newPage({ viewport: { width: 960, height: 540 } });
  try {
    await p.goto('http://localhost:5399/tools/bench/bench.html');
    await p.waitForFunction(() => window.__ms, null, { timeout: 120000 });
    console.log(name, (await p.evaluate(() => window.__ms)).toFixed(0) + ' ms/frame', await p.evaluate(() => window.__gl));
  } catch (e) { console.log(name, 'FAILED', e.message.split('\n')[0]); }
  await b.close();
}
srv.close();
