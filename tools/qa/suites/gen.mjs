// Generates the view-heavy suite JSON files (weapons visual, key art). Run: node tools/qa/suites/gen.mjs
import fs from 'node:fs';
const dir = new URL('.', import.meta.url).pathname;
const W = ['m4', 'ak', 'scar', 'mp5', 'vss', 'rpk', 'm24', 'awm', 'm870', 'p226', 'm1911'];
const wv = (id) => [
  { name: `${id}_1hip`, frames: 1, eval: `__qa.god();__qa.freezeBots(true);__qa.releaseAll();__qa.place([0,0.1,10],0.15,0.02);__qa.loadout('${id}');__qa.sim(1.4);__game.player.spawnProtect=0;`, read: `({id:__game.currentWeapon.id,state:__game.currentWeapon.state,ammo:__game.currentWeapon.ammo})` },
  { name: `${id}_2ads`, frames: 1, eval: `__qa.down('Mouse2');__qa.sim(__game.currentWeapon.stats.ads+0.35);`, read: `({adsT:__game.currentWeapon.adsT,fov:__game.renderer.camera.fov})`, release: ['Mouse2'] },
  { name: `${id}_3fire`, frames: 1, eval: `__qa.down('Mouse2',false);__qa.sim(0.5);__qa.press('Mouse0');__qa.sim(0.12);__qa.press('Mouse0');`, read: `({ammo:__game.currentWeapon.ammo,fx:__qa.fx()})`, release: ['Mouse0'] },
  { name: `${id}_4reload`, frames: 1, eval: `__qa.down('Mouse0',false);__qa.sim(1.2);const w=__game.currentWeapon;w.ammo=Math.min(w.ammo,Math.max(1,w.stats.mag-3));__qa.tap('KeyR');__qa.sim((w.stats.tube?w.stats.shellReload*1.5:w.stats.tacReload)*0.45);`, read: `({state:__game.currentWeapon.state,type:__game.currentWeapon.reloadType})` },
  { name: `${id}_5sprint`, frames: 1, eval: `__qa.sim(5);__qa.place([0,0.1,22],0.15,0);__qa.down('ShiftLeft');__qa.down('KeyW');__qa.sim(0.7);`, read: `({sprintT:__game.currentWeapon.sprintT})`, release: ['ShiftLeft', 'KeyW'] },
];
const job = (tag, ids) => ({ tag, setupFiles: ['tools/qa/suites/lib.js'], match: 'tdm', w: 640, h: 360, views: ids.flatMap(wv) });
fs.writeFileSync(dir + 'c_weapons_visual_a.json', JSON.stringify(job('c_wvis_a', W.slice(0, 6)), null, 1));
fs.writeFileSync(dir + 'c_weapons_visual_b.json', JSON.stringify(job('c_wvis_b', W.slice(6)), null, 1));

// Key art + perf per area (960x540). [name, pos, yaw, pitch]
const ART = [
  ['e01_sun', [2, 0, -8], 2.68, 0.06],
  ['e02_courtyardN', [0, 0, 20], 0.3, 0.02],
  ['e03_courtyard_dock', [2, 0, -12], 0.4, 0.02],
  ['e04_warehouse', [13, 0, -35], 1.57, 0.12],
  ['e05_warehouse_rev', [-12, 0, -30], -1.9, 0.05],
  ['e06_catwalk', [10, 4, -46.6], 1.9, -0.15],
  ['e07_office1', [-12.5, 0, 40.5], -1.9, 0],
  ['e08_office2', [-12.5, 3.4, 35], -1.57, 0],
  ['e09_containers', [37, 0, 4], 0.1, 0.03],
  ['e10_ruins', [-28, 0, -2], 1.4, 0],
  ['e11_ruins_wall', [-30, 0, 3], 1.9, 0.0],
  ['e12_perimeter', [30, 0, 50], 2.4, 0.08],
  ['e13_tower', [-48, 4.2, -40.5], -0.9, -0.05],
];
const art = {
  tag: 'e_keyart', setupFiles: ['tools/qa/suites/lib.js'], match: 'tdm', w: 960, h: 540,
  views: ART.map(([name, pos, yaw, pitch]) => ({ name, frames: 2, eval: `__qa.god();__qa.freezeBots(false);__qa.releaseAll();__qa.place([${pos}],${yaw},${pitch});__qa.sim(0.3);__game.player.yaw=${yaw};__game.player.pitch=${pitch};`, read: '__qa.perf()' })),
};
fs.writeFileSync(dir + 'e_keyart.json', JSON.stringify(art, null, 1));
console.log('ok');
