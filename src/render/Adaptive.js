import { ADAPTIVE_STEPS } from './Renderer.js';
import { saveSettings } from '../ui/Menu.js';

/**
 * Adaptive quality (render owner). Dynamic resolution handles small misses within a second or two; this handles
 * machines that are far off: if live gameplay averages < 30 fps over the first ~8 s (after a 2 s grace period), or
 * over any later 10 s window, step one feature tier down (Renderer ADAPTIVE_STEPS: AO → god rays → shadow size →
 * viewmodel probe → bloom levels → render scale), show a small toast, and keep measuring.
 *
 * Never fights a manual choice: only active while settings.qualityAuto is true (the player never picked a quality)
 * and settings.adaptiveQuality is on. Picking a quality in Settings resets settings.adaptiveLevel to 0. Never steps
 * back up on its own. Off in QA / automation and while the benchmark runs. The level persists across sessions.
 */
export class AdaptiveQuality {
  constructor(game) {
    this.g = game;
    this.last = 0;
    this.reset();
  }

  reset() { this.n = 0; this.sum = 0; this.liveMs = 0; this.window = 8000; }

  get level() { return this.g.settings.adaptiveLevel | 0; }

  active() {
    const s = this.g.settings;
    return s.adaptiveQuality !== false && s.qualityAuto !== false && !window.__qaFixedDt && !navigator.webdriver
      && !this.g._benchRunning && this.level < ADAPTIVE_STEPS.length;
  }

  update(live) {
    const now = performance.now(), dtw = now - (this.last || now);
    this.last = now;
    if (!live || !this.active()) { if (!live) { this.n = 0; this.sum = 0; this.liveMs = 0; } return; }
    if (document.hidden || dtw > 1000 || dtw <= 0) return; // tab switch / hitch: not a signal
    this.liveMs += dtw;
    if (this.liveMs < 2000) return; // spawn, first-use compiles
    this.n++; this.sum += dtw;
    if (this.sum < this.window) return;
    const fps = (1000 * this.n) / this.sum;
    this.n = 0; this.sum = 0;
    this.window = 10000;
    if (fps < 30) this.stepDown(fps);
  }

  stepDown(fps) {
    const g = this.g, s = g.settings, step = ADAPTIVE_STEPS[this.level];
    s.adaptiveLevel = this.level + 1;
    g.renderer.applySettings();
    saveSettings(s);
    this.liveMs = 0; // settle (resize / recompiles) before the next window
    console.info(`[adaptive quality] ${fps.toFixed(1)} fps → level ${s.adaptiveLevel}: ${step.label}`);
    toast('Graphics adjusted for performance — change in Settings');
  }
}

function toast(text) {
  let el = document.getElementById('gfxToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'gfxToast';
    el.style.cssText = 'position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:60;pointer-events:none;padding:7px 14px;'
      + 'background:rgba(12,12,12,.72);color:#e9e2d4;font:500 12px/1.3 system-ui,sans-serif;letter-spacing:.02em;border-left:2px solid #d8b46a;'
      + 'border-radius:2px;opacity:0;transition:opacity .4s ease;max-width:calc(100vw - 32px)';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.style.opacity = '1';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.opacity = '0'; }, 5000);
}
