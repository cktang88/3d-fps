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
const TIPS = [
  'Double-tap Shift to tactical sprint, then press C to slide.',
  'Press Space at a waist-high wall to vault without losing speed.',
  'Wood, plaster and thin metal can be shot through. Concrete cannot.',
  'Four kills without dying calls in a UAV.',
  'Tactical reloads keep a round chambered and are faster.',
  'Bots hear footsteps and gunfire. Walk with Alt or crouch to move quietly.',
];
loading.querySelector('.tip').textContent = 'TIP · ' + TIPS[(Math.random() * TIPS.length) | 0];

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
    game.hud.banner(result, game.mode.teams ? `${game.mode.score[game.player.team]} — ${game.mode.score[1 - game.player.team]}` : '', 4, result === 'VICTORY' ? 'ally' : result === 'DEFEAT' ? 'enemy' : '');
    game.audio.ui(result === 'VICTORY' ? 'streak' : 'medal');
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
    if (e.code === 'KeyT' && game.started && !game.player.alive) { game.paused = true; game.input.unlock(); menu.open(true, 'gunsmith'); }
  });
  addEventListener('beforeunload', () => saveSettings(settings));

  let last = performance.now();
  const frameErrors = new Set();
  const frame = (now) => {
    // QA harness hook: fixed simulation step so headless tests are deterministic and fast.
    const dt = window.__qaFixedDt ?? Math.min(0.05, (now - last) / 1000);
    last = now;
    requestAnimationFrame(frame);
    // Never let one bad frame kill the loop; report each distinct error once.
    try { game.update(dt); } catch (e) {
      const key = e?.message;
      if (!frameErrors.has(key)) { frameErrors.add(key); console.error(e); }
      game.input.endFrame();
    }
  };
  requestAnimationFrame(frame);
}
boot();
