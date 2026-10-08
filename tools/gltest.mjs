import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const p = await b.newPage();
const r = await p.evaluate(()=>{const c=document.createElement('canvas');const g=c.getContext('webgl2');return g? g.getParameter(g.VERSION)+' | '+g.getParameter(g.getExtension('WEBGL_debug_renderer_info')?.UNMASKED_RENDERER_WEBGL||g.RENDERER):'none'});
console.log(r); await b.close();
