// Filmstrip suite: sequential follow-cam frames of live bots (run, engage/strafe/turn/fire, reload, death).
// Run: node tools/qa/suites/gen_film.mjs  -> h_bot_film.json ; after the job: python3 tools/qa/contact.py <result dir>
import fs from 'node:fs';
const dir = new URL('.', import.meta.url).pathname;
const v = [];
const seg = (tag, n, step, pickEval, ang, extra = '') => {
  v.push({ name: `${tag}_pick`, shot: false, frames: 1, eval: `window.__fb = ${pickEval};`, read: 'window.__fb' });
  for (let k = 0; k < n; k++) v.push({ name: `${tag}_${String(k).padStart(2, '0')}`, frames: 1, eval: `${k === 0 ? extra : ''}__qa.sim(${step});window.__fr=__qa.follow(window.__fb,3.6,${ang});`, read: 'window.__fr' });
};
v.push({ name: 'settle', shot: false, frames: 1, eval: '__qa.god();__qa.place([-48,4.3,-40.5],0,0);__qa.sim(16);' });
seg('run', 8, 0.1, `__qa.pickBot(b=>Math.hypot(b.velocity.x,b.velocity.z)>3)`, 'Math.PI/2');
seg('engage', 12, 0.1, `__qa.pickBot(b=>b.goal==='engage')`, 'Math.PI*0.7');
seg('reload', 8, 0.25, `__qa.pickBot(b=>b.goal!=='engage')`, 'Math.PI*0.6', 'const b=__game.bots[window.__fb]; if(b){b.weapon.ammo=0; b.weapon.reload();}');
seg('death', 8, 0.15, `__qa.pickBot(b=>true)`, 'Math.PI*0.5', 'const b=__game.bots[window.__fb]; if(b){ b.spawnProtect=0; const V=__game.player.position.constructor; b.takeDamage(500, __game.player, {weapon:"m4", dir: new V(1,0,0), point: b.position.clone().setY(b.position.y+1.2)}); }');
const job = { tag: 'h_film', setupFiles: ['tools/qa/suites/lib.js'], match: 'tdm', w: 480, h: 270, views: v };
fs.writeFileSync(dir + 'h_bot_film.json', JSON.stringify(job, null, 1));
console.log(v.length, 'views');
