import '@fontsource/rajdhani/500.css';
import '@fontsource/rajdhani/600.css';
import '@fontsource/rajdhani/700.css';
import '@fontsource/barlow-condensed/600.css';
import './ui/hud.css';
import { Game } from './game/Game.js';
import { Menu, loadSettings, saveSettings } from './ui/Menu.js';

const settings = loadSettings();
const canvas = document.getElementById('game');
const loading = document.getElementById('loading');
const bar = loading.querySelector('.bar i');
const msg = loading.querySelector('.msg');

const game = new Game(canvas, settings);
window.__game = game; // debugging / automated playtests

async function boot() {
  try {
    await game.init((p, label) => {
      bar.style.width = `${Math.round(p * 100)}%`;
      if (label) msg.textContent = String(label).split('/').pop().replace(/\.(glb|gltf|jpg|hdr|ogg)$/, '');
    });
  } catch (e) {
    console.error(e);
    msg.textContent = 'Failed to load: ' + e.message;
    return;
  }
  loading.remove();
  const menu = new Menu(game);
  game.menu = menu;
  menu.open(false);

  game.onMatchEnd = (result) => {
    game.paused = true;
    game.input.unlock();
    game.hud.banner(result, '', 4);
    setTimeout(() => { game.started = false; game.hud.show(false); menu.showEnd(result); }, 2500);
  };

  // Pointer lock handling: losing lock pauses (Esc).
  game.input.onLockChange = (locked) => {
    menu.clickToPlay.style.display = 'none';
    if (!locked && game.started && game.match.state === 'live' && !menu.isOpen) {
      game.paused = true;
      menu.open(true);
    }
  };
  canvas.addEventListener('click', () => {
    if (game.started && !game.paused && !game.input.locked) game.input.lock();
  });
  addEventListener('keydown', (e) => {
    if (e.code === 'KeyT' && game.started && !game.player.alive) { game.paused = true; game.input.unlock(); menu.page = 'gunsmith'; menu.open(true); }
  });
  addEventListener('beforeunload', () => saveSettings(settings));

  let last = performance.now();
  const frame = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    game.update(dt);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
boot();
