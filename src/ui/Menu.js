import { WEAPONS, ATTACHMENTS, SLOTS, PRIMARY_LIST, SECONDARY_LIST, computeStats } from '../game/weapons/WeaponDefs.js';
import { DIFFICULTY } from '../game/bots/Bot.js';
import { MEDALS, medalSvg } from './HUD.js';
import { runBenchmark } from '../render/Benchmark.js';

const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const DEFAULT_SETTINGS = {
  sensitivity: 1.6, adsSensMult: 1.0, invertY: false, fov: 100, viewmodelFov: 52, quality: 2, renderScale: 1,
  volume: 0.8, fpsCounter: true, dynamicRes: true, crosshairColor: '#ffffff', holdCrouch: false, toggleAds: false, reduceMotion: false,
  botDifficulty: 'regular', botCount: 6, godMode: false,
  qualityAuto: true, // perf: first boot picks Medium on weak GPUs (Renderer.autoQuality); false once the player picks
  // Render: FSR 1 upscaling ('off' | 'quality' | 'balanced' | 'performance' | 'dynamic'), picked by GPU tier until the
  // player chooses (upscalingAuto). sharpness drives RCAS (FSR on) or CAS (Off). Adaptive quality steps features
  // down on slow machines while qualityAuto is still true (src/render/Adaptive.js); adaptiveLevel persists.
  upscaling: 'off', upscalingAuto: true, sharpness: 0.8, adaptiveQuality: true, adaptiveLevel: 0,
  loadout: { primary: 'm4', secondary: 'p226', attachments: {} },
  career: { xp: 0, matches: 0, wins: 0, kills: 0, deaths: 0 },
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem('ironline.settings');
    if (raw) {
      const s = JSON.parse(raw);
      const merged = {
        ...structuredClone(DEFAULT_SETTINGS), ...s,
        loadout: { ...DEFAULT_SETTINGS.loadout, ...(s.loadout || {}) },
        career: { ...DEFAULT_SETTINGS.career, ...(s.career || {}) },
      };
      if (!WEAPONS[merged.loadout.primary]) merged.loadout.primary = 'm4';
      if (!WEAPONS[merged.loadout.secondary]) merged.loadout.secondary = 'p226';
      return merged;
    }
  } catch { /* ignore */ }
  return structuredClone(DEFAULT_SETTINGS);
}

export function saveSettings(s) {
  try { localStorage.setItem('ironline.settings', JSON.stringify(s)); } catch { /* ignore */ }
}

// Career levels: each level needs a bit more XP than the last.
export function levelInfo(xp) {
  let lvl = 1, need = 1200, acc = 0;
  while (xp >= acc + need && lvl < 99) { acc += need; lvl++; need = Math.round(need * 1.12); }
  return { lvl, into: xp - acc, need, frac: (xp - acc) / need };
}
const RANKS = ['RECRUIT', 'PRIVATE', 'SPECIALIST', 'CORPORAL', 'SERGEANT', 'STAFF SGT', 'LIEUTENANT', 'CAPTAIN', 'MAJOR', 'COLONEL', 'COMMANDER'];
const rankName = (lvl) => RANKS[Math.min(RANKS.length - 1, Math.floor((lvl - 1) / 3))];

const NAV = [
  { act: 'tdm', label: 'Team Deathmatch', sub: 'Two squads · first to 50', play: true },
  { act: 'ffa', label: 'Free For All', sub: 'Every operator for themselves', play: true },
  { act: 'gunsmith', label: 'Gunsmith', sub: 'Loadout & attachments' },
  { act: 'settings', label: 'Settings', sub: 'Mouse · video · audio · bots' },
  { act: 'controls', label: 'Controls', sub: 'Keys & field notes' },
  { act: 'credits', label: 'Credits', sub: 'Assets & licences' },
];

/** All non-HUD screens: main menu, settings, controls, gunsmith, pause, end of match. */
export class Menu {
  constructor(game) {
    this.game = game;
    this.s = game.settings;
    this.el = h(`<div class="menu" id="menu">
      <div class="bgfx"></div>
      <div class="side">
        <div class="logo"><div class="mark"><i></i><i></i><i></i></div><div class="word">IRONLINE<small>TACTICAL SHOOTER</small></div></div>
        <div class="sub" id="menuSub">IRONLINE DEPOT · SELECT MODE</div>
        <nav>
          <button class="btn resume primary" data-act="resume" style="display:none"><span class="lbl">Resume</span><span class="desc">Back to the fight</span></button>
          ${NAV.map((n, i) => `<button class="btn ${n.play ? 'play' : ''}" data-act="${n.act}" style="--i:${i}"><span class="idx">0${i + 1}</span><span class="lbl">${n.label}</span><span class="desc">${n.sub}</span></button>`).join('')}
          <button class="btn leave" data-act="leave" style="display:none"><span class="lbl">Leave Match</span><span class="desc">Return to main menu</span></button>
        </nav>
        <div class="profile" id="menuProfile"></div>
        <div class="foot"><span><kbd>ESC</kbd> pause</span><span><kbd>T</kbd> gunsmith while dead</span></div>
      </div>
      <div class="main" id="menuMain"></div>
    </div>`);
    document.body.appendChild(this.el);
    this.main = this.el.querySelector('#menuMain');
    this.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      game.audio.init(); game.audio.resume();
      game.audio.ui('click');
      this.action(b.dataset.act);
    });
    this.el.addEventListener('pointerover', (e) => {
      const b = e.target.closest('.btn, .wbtn, .att');
      if (b && b !== this._hovered) { this._hovered = b; game.audio.ui('hover'); }
    });
    this.clickToPlay = h('<div id="clicktoplay">CLICK TO PLAY</div>');
    document.body.appendChild(this.clickToPlay);
    this.page = 'home';
    this.renderPage();
  }

  open(paused = false, page = 'home') {
    this.paused = paused;
    this.page = page;
    this.el.classList.add('on');
    this.el.classList.toggle('paused', paused);
    this.el.querySelector('[data-act=resume]').style.display = paused ? '' : 'none';
    this.el.querySelector('[data-act=leave]').style.display = paused ? '' : 'none';
    this.el.querySelectorAll('.btn.play').forEach((b) => (b.style.display = paused ? 'none' : ''));
    this.el.querySelector('#menuSub').textContent = paused ? `PAUSED · ${this.game.mode.name}` : 'IRONLINE DEPOT · SELECT MODE';
    this.renderPage();
    // Replay the entrance animation.
    this.el.classList.remove('enter'); void this.el.offsetWidth; this.el.classList.add('enter');
  }

  close() { this.el.classList.remove('on'); }
  get isOpen() { return this.el.classList.contains('on'); }

  action(act) {
    const g = this.game;
    if (act === 'tdm' || act === 'ffa') {
      this.close();
      g.startMatch(act);
      g.paused = false;
      g.input.lock();
    } else if (act === 'resume') {
      this.close(); g.paused = false; g.input.lock();
    } else if (act === 'leave') {
      g.started = false; g.hud.show(false); g.match.state = 'idle';
      this.open(false);
    } else if (['settings', 'controls', 'gunsmith', 'credits', 'home'].includes(act)) {
      this.page = this.page === act && act !== 'home' ? 'home' : act;
      this.renderPage();
    }
  }

  renderPage() {
    const m = this.main;
    const pages = { settings: this.settingsHtml, gunsmith: this.gunsmithHtml, controls: this.controlsHtml, credits: this.creditsHtml, home: this.homeHtml };
    m.innerHTML = (pages[this.page] || this.homeHtml).call(this);
    m.dataset.page = this.page;
    m.classList.remove('swap'); void m.offsetWidth; m.classList.add('swap');
    this.el.querySelectorAll('nav .btn').forEach((b) => b.classList.toggle('sel', b.dataset.act === this.page));
    this.renderProfile();
    this.bindPage();
  }

  renderProfile() {
    const c = this.s.career;
    const L = levelInfo(c.xp);
    this.el.querySelector('#menuProfile').innerHTML = `
      <div class="lvl"><b>${L.lvl}</b><span>LVL</span></div>
      <div class="pinfo"><div class="rank">${rankName(L.lvl)}</div>
        <div class="xpbar"><i style="transform:scaleX(${L.frac.toFixed(3)})"></i></div>
        <div class="xptxt">${L.into.toLocaleString()} / ${L.need.toLocaleString()} XP · ${c.matches} matches · ${c.kills} kills</div></div>`;
  }

  // ---------------------------------------------------------------- pages
  homeHtml() {
    const lo = this.s.loadout;
    const wcard = (id, slotLabel) => {
      const def = WEAPONS[id];
      const att = { ...(def.defaults || {}), ...(lo.attachments[id] || {}) };
      const list = SLOTS.filter((sl) => att[sl]).map((sl) => `<span>${esc(ATTACHMENTS[att[sl]]?.name ?? '')}</span>`).join('');
      return `<div class="wcard" data-act="gunsmith"><div class="slotlbl">${slotLabel}</div><div class="wn">${esc(def.name)}</div><div class="wc">${esc(def.cls)}</div><div class="atts">${list || '<span class="dim">No attachments</span>'}</div></div>`;
    };
    const d = DIFFICULTY[this.s.botDifficulty]?.label ?? '';
    return `<div class="card hero"><h3>Loadout</h3><div class="loadout">${wcard(lo.primary, 'PRIMARY')}${wcard(lo.secondary, 'SECONDARY')}
        <div class="wcard eq"><div class="slotlbl">LETHAL</div><div class="wn">Frag ×2</div><div class="wc">Hold G to cook · 3.2s fuse</div><div class="atts"><span>Killstreak · UAV at 4</span></div></div></div></div>
      <div class="card"><h3>Briefing</h3><div class="brief">
        <div><b>Ironline Depot</b><span>Warehouse catwalks, a two-storey office, the container yard and the western ruins. Long sightlines down the road; close quarters inside.</span></div>
        <div><b>Bots · ${esc(d)}</b><span>${this.s.botCount} per team. They hear gunfire and footsteps, flank, throw grenades and use cover.</span></div>
        <div><b>Movement</b><span>Double-tap <kbd>Shift</kbd> to tactical sprint, <kbd>C</kbd> while sprinting to slide, <kbd>Space</kbd> at a ledge to vault or mantle.</span></div>
      </div></div>`;
  }

  controlsHtml() {
    const k = (key, label) => `<div class="krow"><span class="keys">${key.split(' ').map((x) => `<kbd>${x}</kbd>`).join('')}</span><span>${label}</span></div>`;
    return `<div class="card"><h3>Controls</h3><div class="kgrid">
      <div>${k('W A S D', 'Move')}${k('Mouse', 'Look')}${k('LMB', 'Fire')}${k('RMB', 'Aim down sights')}
      ${k('Shift', 'Sprint · double-tap tactical sprint · hold breath when scoped')}${k('Space', 'Jump · vault · mantle')}
      ${k('C', 'Crouch · while sprinting: slide')}${k('Alt', 'Slow walk (silent)')}${k('Q E', 'Lean left / right')}</div>
      <div>${k('R', 'Reload (tactical keeps one chambered)')}${k('B', 'Fire mode')}${k('1 2', 'Primary / secondary (or wheel)')}
      ${k('V', 'Melee · backstab kills')}${k('G', 'Frag grenade · hold to cook')}${k('I', 'Inspect weapon')}${k('L', 'Toggle laser')}
      ${k('Tab', 'Scoreboard')}${k('Esc', 'Pause')}</div>
    </div></div>
    <div class="card"><h3>Field notes</h3><div class="notes">
      <p>Bullets are simulated projectiles with travel time and drop. Wood, plaster and thin metal can be shot through; concrete and brick stop rounds.</p>
      <p>Tactical reloads are faster and keep a round chambered. Sprinting lowers your weapon — there is a short sprint-to-fire delay.</p>
      <p>Bots hear unsuppressed gunfire and footsteps; walk or crouch to stay quiet. Four kills without dying calls in a UAV.</p>
    </div></div>`;
  }

  creditsHtml() {
    const c = (what, who) => `<div class="cr"><b>${what}</b><span>${who}</span></div>`;
    return `<div class="card"><h3>Credits</h3><div class="credits">
      ${c('First-person guns', 'Sketchfab CC BY 4.0: Firewarden (M4A1), Hitansh_3DArtist (SCAR-L), Rotuma (MP5), Naudaff3D (M24), erhanmatur (AWM), Alexcanot (P226), egorbelous (M1911); ArmsMuseum (VSS, CC0); tris09 (870)')}
      ${c('Optics', 'valterjherson1, Argentavisss, ense7en — CC BY 4.0')}
      ${c('First-person arms & grip templates', 'DJMaesen, ccransh — CC BY 4.0')}
      ${c('First-person rifle animations', 'Free FPS Template (Fab), used under its licence')}
      ${c('Fallback weapons & FP data', 'Operation Steel Tide (MIT) · meshes CC0 by nisu, taradavies, Quaternius')}
      ${c('Soldiers', '1799danly (tactical suit), BAMEN — CC BY 4.0')}
      ${c('Bot motion capture', '100STYLE (Mason, Starke, Komura) — CC BY 4.0 · Quaternius UAL 1 & 2 — CC0')}
      ${c('Gunshots & foley', 'The Free Firearm Sound Library — CC0')}
      ${c('Impacts, footsteps, UI & explosion sounds', 'Kenney (Impact, Interface, Sci-Fi Sounds) — CC0')}
      ${c('Textures, props, HDRI, decals', 'ambientCG & Poly Haven — CC0')}
      ${c('Upscaling', 'AMD FidelityFX FSR 1 (EASU/RCAS) — MIT')}
      ${c('Fonts', 'Rajdhani, Barlow Condensed — SIL OFL')}
      ${c('Full list', 'See README.md › Credits & licences')}
    </div></div>`;
  }

  settingsHtml() {
    const s = this.s;
    const range = (key, label, min, max, step, fmt = (v) => v) => `<label>${label}</label><div class="rng"><input type="range" data-set="${key}" min="${min}" max="${max}" step="${step}" value="${s[key]}" style="--p:${((s[key] - min) / (max - min)) * 100}%"></div><span class="val" data-val="${key}">${fmt(s[key])}</span>`;
    const check = (key, label) => `<label>${label}</label><label class="tog"><input type="checkbox" data-set="${key}" ${s[key] ? 'checked' : ''}><i></i></label><span></span>`;
    const sel = (key, label, opts) => `<label>${label}</label><div class="seg">${opts.map(([v, t]) => `<button class="${String(s[key]) === String(v) ? 'on' : ''}" data-seg="${key}" data-v="${v}">${t}</button>`).join('')}</div><span></span>`;
    return `<div class="card"><h3>Mouse</h3><div class="opts">
      ${range('sensitivity', 'Sensitivity', 0.2, 6, 0.05)}${range('adsSensMult', 'ADS sens multiplier', 0.3, 2, 0.05)}
      ${check('invertY', 'Invert Y')}${check('toggleAds', 'Toggle ADS')}${check('holdCrouch', 'Hold to crouch')}
    </div></div>
    <div class="card"><h3>Video</h3><div class="opts">
      ${range('fov', 'Field of view', 70, 120, 1)}${range('viewmodelFov', 'Viewmodel FOV', 40, 70, 1)}
      ${sel('quality', 'Quality', [[0, 'Low'], [1, 'Medium'], [2, 'High'], [3, 'Ultra']])}
      ${sel('upscaling', 'Upscaling (FSR 1)', [['off', 'Off'], ['quality', 'Quality'], ['balanced', 'Balanced'], ['performance', 'Performance'], ['dynamic', 'Dynamic']])}
      ${range('sharpness', 'Sharpness', 0, 1, 0.05, (v) => Math.round(v * 100) + '%')}
      <label>Render resolution</label><span class="val resinfo" data-resinfo>${this.resInfo()}</span><span></span>
      ${range('renderScale', 'Render scale (upscaling off)', 0.5, 1, 0.05, (v) => Math.round(v * 100) + '%')}
      ${check('fpsCounter', 'Show FPS')}${check('dynamicRes', 'Dynamic resolution')}${check('adaptiveQuality', 'Adaptive quality')}${check('reduceMotion', 'Reduce camera motion')}
      <label>Graphics benchmark</label><div class="seg"><button data-bench>Run graphics benchmark</button></div><span></span>
      <label>Crosshair colour</label><div class="swatches">${['#ffffff', '#7dff6a', '#3fe0ff', '#ffd23f', '#ff4df0'].map((c) => `<button class="${s.crosshairColor === c ? 'on' : ''}" data-color="${c}" style="--c:${c}"></button>`).join('')}</div><span></span>
    </div></div>
    <div class="card"><h3>Audio</h3><div class="opts">${range('volume', 'Master volume', 0, 1, 0.01, (v) => Math.round(v * 100))}</div></div>
    <div class="card"><h3>Match</h3><div class="opts">
      ${sel('botDifficulty', 'Bot difficulty', Object.entries(DIFFICULTY).map(([k, d]) => [k, d.label]))}
      ${range('botCount', 'Bots per team', 1, 8, 1)}
      ${check('godMode', 'Practice: invulnerable')}
    </div></div>`;
  }

  gunsmithHtml() {
    const lo = this.s.loadout;
    const cur = this.gsWeapon || lo.primary;
    this.gsWeapon = cur;
    const def = WEAPONS[cur];
    const att = { ...(def.defaults || {}), ...(lo.attachments[cur] || {}) };
    const list = (ids, slotName) => ids.map((id) => {
      const w = WEAPONS[id];
      const eq = (slotName === 'primary' ? lo.primary : lo.secondary) === id;
      return `<button class="wbtn ${id === cur ? 'sel' : ''} ${eq ? 'eq' : ''}" data-gs-weapon="${id}" data-gs-slot="${slotName}"><span class="wn">${esc(w.name)}</span><small>${esc(w.cls)}</small>${eq ? '<em>EQUIPPED</em>' : ''}</button>`;
    }).join('');
    const slotsHtml = SLOTS.map((slot) => {
      const opts = def.attachments.filter((a) => ATTACHMENTS[a].slot === slot);
      if (!opts.length) return '';
      return `<div class="slot"><h4>${slot}</h4>
        <button class="att ${!att[slot] ? 'sel' : ''}" data-gs-att="${slot}" data-gs-val="">None</button>
        ${opts.map((a) => `<button class="att ${att[slot] === a ? 'sel' : ''}" data-gs-att="${slot}" data-gs-val="${a}">${esc(ATTACHMENTS[a].name)}</button>`).join('')}
      </div>`;
    }).join('');
    const base = computeStats(cur, {});
    const st = computeStats(cur, att);
    const bar = (label, v, b, max, invert = false, fmt = (x) => x) => {
      const pct = Math.min(100, (v / max) * 100), bp = Math.min(100, (b / max) * 100);
      const better = invert ? v < b : v > b;
      const cls = Math.abs(v - b) < 1e-6 ? '' : better ? 'delta-up' : 'delta-down';
      return `<span>${label}</span><div class="barbg"><i style="width:${Math.min(pct, bp)}%"></i>${cls ? `<i class="${cls}" style="left:${Math.min(pct, bp)}%;width:${Math.abs(pct - bp)}%"></i>` : ''}</div><span class="sv ${cls}">${fmt(v)}</span>`;
    };
    const ttk = Math.ceil(100 / st.damage[0]) - 1;
    return `<div class="gs">
      <div class="card"><h3>Primary</h3><div class="wlist">${list(PRIMARY_LIST, 'primary')}</div>
        <h3 style="margin-top:14px">Secondary</h3><div class="wlist">${list(SECONDARY_LIST, 'secondary')}</div></div>
      <div class="card"><h3>${esc(def.name)} <span class="dim">· ${esc(def.cls)}</span></h3><div class="slots">${slotsHtml}</div></div>
      <div class="card"><h3>Performance</h3><div class="stats">
        ${bar('Damage', st.damage[0], base.damage[0], 130)}
        ${bar('Range', st.range[1], base.range[1], 160, false, (x) => Math.round(x) + 'm')}
        ${bar('Fire rate', st.rpm, base.rpm, 1100, false, (x) => x + ' rpm')}
        ${bar('ADS time', st.ads, base.ads, 0.6, true, (x) => Math.round(x * 1000) + 'ms')}
        ${bar('Recoil control', 2 - st.vRecoilMul, 2 - base.vRecoilMul, 1.4, false, (x) => Math.round(x * 100) + '%')}
        ${bar('Mobility', st.mobility, base.mobility, 1.1, false, (x) => Math.round(x * 100) + '%')}
        ${bar('Magazine', st.mag, base.mag, 100)}
        ${bar('Tac reload', st.tacReload || st.shellReload, base.tacReload || base.shellReload, 6, true, (x) => x.toFixed(2) + 's')}
        ${bar('Hip spread', st.hipSpread, base.hipSpread, 7, true, (x) => x.toFixed(1) + '°')}
      </div><div class="ttk"><span><b>${ttk + 1}</b> shots to kill</span><span>TTK <b>${Math.round((ttk * 60000) / st.rpm)}</b> ms</span><span>${st.modes.join(' / ').toUpperCase()}</span>${st.suppressed ? '<span class="sup">SUPPRESSED</span>' : ''}</div></div>
    </div>`;
  }

  /** "1232×693 → 1600×900 (FSR Quality)" for the settings page (render owner). */
  resInfo() {
    const R = this.game.renderer, i = R?.internalSize, o = R?.outputSize;
    if (!i || !o) return '';
    const up = i.w !== o.w || i.h !== o.h;
    const mode = { off: 'native', quality: 'FSR Quality', balanced: 'FSR Balanced', performance: 'FSR Performance', dynamic: 'FSR Dynamic' }[R.upscaling] || '';
    return up ? `${i.w}×${i.h} → ${o.w}×${o.h} · ${mode}` : `${o.w}×${o.h} · ${R.upscaling === 'off' ? 'native' : mode + ' (100%)'}`;
  }

  bindPage() {
    const m = this.main, s = this.s, g = this.game;
    const refreshRes = () => { const el = m.querySelector('[data-resinfo]'); if (el) el.textContent = this.resInfo(); };
    m.querySelectorAll('input[data-set]').forEach((el) => {
      const key = el.dataset.set;
      el.addEventListener('input', () => {
        let v = el.type === 'checkbox' ? el.checked : el.type === 'range' ? parseFloat(el.value) : el.value;
        s[key] = v;
        if (el.type === 'range') el.style.setProperty('--p', `${((v - el.min) / (el.max - el.min)) * 100}%`);
        const lbl = m.querySelector(`[data-val="${key}"]`);
        if (lbl) lbl.textContent = key === 'volume' ? Math.round(v * 100) : key === 'renderScale' || key === 'sharpness' ? Math.round(v * 100) + '%' : v;
        if (key === 'volume') g.audio.setVolume(v);
        if (key === 'adaptiveQuality' && !v) s.adaptiveLevel = 0;
        if (['renderScale', 'sharpness', 'dynamicRes', 'adaptiveQuality'].includes(key)) { g.renderer.applySettings(); refreshRes(); }
        if (el.type === 'checkbox') g.audio.ui('click');
        saveSettings(s);
      });
    });
    m.querySelectorAll('[data-seg]').forEach((el) => el.addEventListener('click', () => {
      const key = el.dataset.seg;
      s[key] = key === 'quality' ? parseInt(el.dataset.v, 10) : el.dataset.v;
      if (key === 'quality') {
        // A manual pick ends automatic quality (GPU tier + adaptive step-downs). Upscaling follows the preset until
        // the player picks an upscaling mode themselves.
        s.qualityAuto = false; s.adaptiveLevel = 0;
        if (s.upscalingAuto !== false) s.upscaling = ['performance', 'balanced', 'quality', 'off'][s.quality];
      }
      if (key === 'upscaling') s.upscalingAuto = false;
      el.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === el));
      if (key === 'quality' || key === 'upscaling') {
        g.renderer.applySettings();
        m.querySelectorAll('[data-seg="upscaling"]').forEach((b) => b.classList.toggle('on', b.dataset.v === s.upscaling));
        refreshRes();
      }
      g.audio.ui('click');
      saveSettings(s);
    }));
    m.querySelector('[data-bench]')?.addEventListener('click', () => { g.audio.ui('click'); runBenchmark(g); });
    m.querySelectorAll('[data-color]').forEach((el) => el.addEventListener('click', () => {
      s.crosshairColor = el.dataset.color;
      el.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === el));
      g.audio.ui('click'); saveSettings(s);
    }));
    m.querySelectorAll('[data-gs-weapon]').forEach((el) => el.addEventListener('click', () => {
      const id = el.dataset.gsWeapon;
      if (el.dataset.gsSlot === 'primary') s.loadout.primary = id; else s.loadout.secondary = id;
      this.gsWeapon = id;
      saveSettings(s); g.audio.ui('click'); g.applyLoadoutChange(); this._rerender();
    }));
    m.querySelectorAll('[data-gs-att]').forEach((el) => el.addEventListener('click', () => {
      const cur = this.gsWeapon;
      const att = { ...(WEAPONS[cur].defaults || {}), ...(s.loadout.attachments[cur] || {}) };
      const slot = el.dataset.gsAtt, val = el.dataset.gsVal;
      if (val) att[slot] = val; else delete att[slot];
      // Store explicit nulls so removing a default attachment sticks.
      const store = { ...att };
      for (const sl of SLOTS) if (!(sl in store)) store[sl] = null;
      s.loadout.attachments[cur] = store;
      saveSettings(s); g.audio.ui('click'); g.applyLoadoutChange(); this._rerender();
    }));
  }

  // Re-render the current page in place without replaying the entrance animation (keeps scroll).
  _rerender() {
    const st = this.main.scrollTop;
    this.main.innerHTML = (this.page === 'gunsmith' ? this.gunsmithHtml : this.homeHtml).call(this);
    this.main.scrollTop = st;
    this.bindPage();
  }

  // ---------------------------------------------------------------- end of match
  showEnd(result) {
    const g = this.game, p = g.player, ms = g.matchStats, c = this.s.career;
    g.hud.scoreboard(false);
    g.hud.show(false);
    const before = levelInfo(c.xp);
    const winBonus = result === 'VICTORY' ? 500 : result === 'DRAW' ? 250 : 100;
    const xpGain = Math.round(p.stats.score + winBonus);
    c.xp += xpGain; c.matches++; if (result === 'VICTORY') c.wins++;
    c.kills += p.stats.kills; c.deaths += p.stats.deaths;
    saveSettings(this.s);
    const after = levelInfo(c.xp);
    const sorted = [...g.actors].sort((a, b) => b.stats.score - a.stats.score);
    const place = sorted.indexOf(p) + 1;
    const acc = ms.shots ? Math.round((ms.hits / ms.shots) * 100) : 0;
    const kd = (p.stats.kills / Math.max(1, p.stats.deaths)).toFixed(2);
    const medals = Object.entries(ms.medals).sort((a, b) => (MEDALS[b[0]]?.tier ?? 0) - (MEDALS[a[0]]?.tier ?? 0));
    const resCls = result === 'VICTORY' ? 'win' : result === 'DRAW' ? 'draw' : 'loss';
    const stat = (lbl, val, i) => `<div class="st" style="--i:${i}"><b>${val}</b><span>${lbl}</span></div>`;
    const teamRows = (list) => list.map((a, i) => `<tr class="${a === p ? 'me' : ''}"><td class="rk">${i + 1}</td><td>${esc(a.name)}</td><td class="n">${a.stats.score}</td><td class="n">${a.stats.kills}</td><td class="n">${a.stats.deaths}</td><td class="n">${a.stats.assists}</td></tr>`).join('');
    const thead = '<tr><th></th><th>OPERATOR</th><th class="n">SCORE</th><th class="n">K</th><th class="n">D</th><th class="n">A</th></tr>';
    const boards = g.mode.teams
      ? `<div class="eboards"><div class="ta"><h4><span>FRIENDLY</span><b>${g.mode.score[p.team]}</b></h4><table>${thead}${teamRows(sorted.filter((a) => a.team === p.team))}</table></div><div class="tb"><h4><span>ENEMY</span><b>${g.mode.score[1 - p.team]}</b></h4><table>${thead}${teamRows(sorted.filter((a) => a.team !== p.team))}</table></div></div>`
      : `<div class="eboards one"><div><table>${thead}${teamRows(sorted)}</table></div></div>`;
    this.main.innerHTML = `<div class="endscreen ${resCls}">
      <div class="result"><div class="rtxt">${result}</div><div class="rsub">${esc(g.mode.name)} · ${g.mode.teams ? `${g.mode.score[p.team]} — ${g.mode.score[1 - p.team]}` : `PLACED #${place} OF ${sorted.length}`}</div></div>
      <div class="card"><h3>Your match</h3><div class="estats">
        ${stat('SCORE', p.stats.score, 0)}${stat('KILLS', p.stats.kills, 1)}${stat('DEATHS', p.stats.deaths, 2)}${stat('K/D', kd, 3)}
        ${stat('ACCURACY', acc + '%', 4)}${stat('HEADSHOTS', ms.headshots, 5)}${stat('BEST STREAK', ms.bestStreak, 6)}${stat('ASSISTS', p.stats.assists, 7)}
      </div>
      ${medals.length ? `<div class="emedals">${medals.map(([k, n], i) => `<div class="em" style="--i:${i}">${medalSvg(k, 52)}<span>${MEDALS[k].title}</span>${n > 1 ? `<b>×${n}</b>` : ''}</div>`).join('')}</div>` : '<div class="emedals none">No medals this time — chain kills, land headshots and break streaks to earn them.</div>'}
      <div class="exp"><div class="xl"><b class="lv">${before.lvl}</b><span>LVL</span></div><div class="xb"><div class="xpbar big"><i class="prev" style="transform:scaleX(${before.frac.toFixed(3)})"></i><i class="gain"></i></div>
        <div class="xptxt"><span>+${xpGain.toLocaleString()} XP</span><span class="dim">MATCH ${p.stats.score} · ${result === 'VICTORY' ? 'WIN' : result === 'DRAW' ? 'DRAW' : 'COMPLETION'} +${winBonus}</span></div></div></div>
      </div>
      <div class="card"><h3>Scoreboard</h3>${boards}</div>
    </div>`;
    this.page = 'end';
    this.main.dataset.page = 'end';
    this.el.classList.add('on');
    this.el.classList.remove('paused');
    this.el.querySelector('[data-act=resume]').style.display = 'none';
    this.el.querySelector('[data-act=leave]').style.display = 'none';
    this.el.querySelectorAll('.btn.play').forEach((b) => (b.style.display = ''));
    this.el.querySelectorAll('nav .btn').forEach((b) => b.classList.remove('sel'));
    this.el.querySelector('#menuSub').textContent = 'MATCH COMPLETE · PLAY AGAIN';
    this.el.classList.remove('enter'); void this.el.offsetWidth; this.el.classList.add('enter');
    this.main.classList.remove('swap'); void this.main.offsetWidth; this.main.classList.add('swap');
    this.renderProfile();
    // Animate XP bar: fill from previous to new (wrapping on level up).
    const gain = this.main.querySelector('.xpbar .gain'), lvEl = this.main.querySelector('.exp .lv');
    const startF = before.frac, levels = after.lvl - before.lvl;
    gain.style.left = `${startF * 100}%`;
    setTimeout(() => {
      if (levels === 0) { gain.style.width = `${(after.frac - startF) * 100}%`; return; }
      gain.style.width = `${(1 - startF) * 100}%`;
      setTimeout(() => {
        lvEl.textContent = after.lvl; lvEl.parentElement.classList.add('up');
        this.game.audio.ui('streak');
        gain.style.transition = 'none'; gain.style.left = '0'; gain.style.width = '0';
        this.main.querySelector('.xpbar .prev').style.transform = 'scaleX(0)';
        void gain.offsetWidth; gain.style.transition = '';
        gain.style.width = `${after.frac * 100}%`;
      }, 1000);
    }, 900);
  }
}
