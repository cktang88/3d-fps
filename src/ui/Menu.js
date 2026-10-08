import { WEAPONS, ATTACHMENTS, SLOTS, PRIMARY_LIST, SECONDARY_LIST, computeStats } from '../game/weapons/WeaponDefs.js';
import { DIFFICULTY } from '../game/bots/Bot.js';

const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; };

export const DEFAULT_SETTINGS = {
  sensitivity: 1.6, adsSensMult: 1.0, invertY: false, fov: 100, viewmodelFov: 52, quality: 2, renderScale: 1,
  volume: 0.8, showFps: true, crosshairColor: '#ffffff', holdCrouch: false, toggleAds: false, reduceMotion: false,
  botDifficulty: 'regular', botCount: 6, godMode: false,
  loadout: { primary: 'm4', secondary: 'p226', attachments: {} },
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem('ironline.settings');
    if (raw) {
      const s = JSON.parse(raw);
      const merged = { ...structuredClone(DEFAULT_SETTINGS), ...s, loadout: { ...DEFAULT_SETTINGS.loadout, ...(s.loadout || {}) } };
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

/** All non-HUD screens: main menu, settings, controls, gunsmith, pause, end of match. */
export class Menu {
  constructor(game) {
    this.game = game;
    this.s = game.settings;
    this.el = h(`<div class="menu" id="menu">
      <div class="side">
        <div class="title">IRONLINE<small>TACTICAL SHOOTER</small></div>
        <div class="sub" id="menuSub">DEPOT · ${new Date().getFullYear()}</div>
        <button class="btn primary" data-act="resume" style="display:none">Resume</button>
        <button class="btn primary" data-act="tdm">Team Deathmatch</button>
        <button class="btn" data-act="ffa">Free For All</button>
        <button class="btn" data-act="gunsmith">Gunsmith</button>
        <button class="btn" data-act="settings">Settings</button>
        <button class="btn" data-act="controls">Controls</button>
        <button class="btn" data-act="leave" style="display:none">Leave Match</button>
        <div class="hint">Click a mode to deploy. Esc pauses. Assets: CC0/CC-BY — see Credits in README.</div>
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
    this.el.addEventListener('mouseover', (e) => { if (e.target.closest('.btn')) game.audio.ui('hover'); });
    this.clickToPlay = h('<div id="clicktoplay">CLICK TO PLAY</div>');
    document.body.appendChild(this.clickToPlay);
    this.page = 'controls';
    this.renderPage();
  }

  open(paused = false) {
    this.el.classList.add('on');
    this.el.querySelector('[data-act=resume]').style.display = paused ? '' : 'none';
    this.el.querySelector('[data-act=leave]').style.display = paused ? '' : 'none';
    this.el.querySelector('#menuSub').textContent = paused ? 'PAUSED' : 'IRONLINE DEPOT · SELECT MODE';
    this.renderPage();
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
    } else if (['settings', 'controls', 'gunsmith', 'credits'].includes(act)) {
      this.page = act; this.renderPage();
    }
  }

  renderPage() {
    const m = this.main;
    if (this.page === 'settings') m.innerHTML = this.settingsHtml();
    else if (this.page === 'gunsmith') m.innerHTML = this.gunsmithHtml();
    else m.innerHTML = this.controlsHtml();
    this.bindPage();
  }

  controlsHtml() {
    const k = (key, label) => `<div><kbd>${key}</kbd>${label}</div>`;
    return `<div class="card"><h3>Controls</h3><div class="keys">
      ${k('W A S D', 'Move')}${k('Mouse', 'Look')}${k('LMB', 'Fire')}${k('RMB', 'Aim down sights (hold)')}
      ${k('Shift', 'Sprint · double-tap: tactical sprint · hold breath when scoped')}${k('Space', 'Jump / Vault / Mantle')}
      ${k('C / Ctrl', 'Crouch · while sprinting: Slide')}${k('Alt', 'Slow walk (silent)')}${k('Q / E', 'Lean left / right')}
      ${k('R', 'Reload (tactical keeps +1 in chamber)')}${k('B', 'Fire mode (auto / burst / semi)')}${k('1 / 2 / Wheel', 'Primary / Secondary')}
      ${k('V', 'Melee (backstab = kill)')}${k('G', 'Frag grenade')}${k('I', 'Inspect weapon')}${k('L', 'Toggle laser')}
      ${k('RMB+MMB', 'Variable zoom (sniper)')}${k('Tab', 'Scoreboard')}${k('Esc', 'Pause / menu')}
    </div></div>
    <div class="card"><h3>Field notes</h3><div style="line-height:1.7;font-size:15px;color:var(--dim)">
      Bullets are simulated projectiles with travel time and drop. Wood, plaster and thin metal can be shot through; concrete stops rounds.
      Tactical reloads are faster and keep a round chambered. Sprinting lowers your weapon — there is a short sprint-to-fire delay.
      Bots hear unsuppressed gunfire and footsteps; walk (Alt) or crouch to stay quiet. 4 kill streak calls in a UAV.
    </div></div>`;
  }

  settingsHtml() {
    const s = this.s;
    const range = (key, label, min, max, step, fmt = (v) => v) => `<label>${label}</label><input type="range" data-set="${key}" min="${min}" max="${max}" step="${step}" value="${s[key]}"><span class="val" data-val="${key}">${fmt(s[key])}</span>`;
    const check = (key, label) => `<label>${label}</label><input type="checkbox" data-set="${key}" ${s[key] ? 'checked' : ''}><span></span>`;
    const sel = (key, label, opts) => `<label>${label}</label><select data-set="${key}">${opts.map(([v, t]) => `<option value="${v}" ${String(s[key]) === String(v) ? 'selected' : ''}>${t}</option>`).join('')}</select><span></span>`;
    return `<div class="card"><h3>Mouse</h3><div class="opts">
      ${range('sensitivity', 'Sensitivity', 0.2, 6, 0.05)}${range('adsSensMult', 'ADS sens multiplier', 0.3, 2, 0.05)}
      ${check('invertY', 'Invert Y')}${check('toggleAds', 'Toggle ADS')}${check('holdCrouch', 'Hold to crouch')}
    </div></div>
    <div class="card"><h3>Video</h3><div class="opts">
      ${range('fov', 'Field of view (H)', 70, 120, 1)}${range('viewmodelFov', 'Viewmodel FOV', 40, 70, 1)}
      ${sel('quality', 'Quality', [[0, 'Low'], [1, 'Medium'], [2, 'High'], [3, 'Ultra']])}
      ${range('renderScale', 'Render scale', 0.5, 1, 0.05)}
      ${check('showFps', 'Show FPS')}${check('reduceMotion', 'Reduce camera motion')}
      <label>Crosshair colour</label><input type="color" data-set="crosshairColor" value="${s.crosshairColor}"><span></span>
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
      const sel = (slotName === 'primary' ? lo.primary : lo.secondary) === id;
      return `<button class="wbtn ${id === cur ? 'sel' : ''}" data-gs-weapon="${id}" data-gs-slot="${slotName}">${w.name}<small>${w.cls}${sel ? ' · EQUIPPED' : ''}</small></button>`;
    }).join('');
    const slotsHtml = SLOTS.map((slot) => {
      const opts = def.attachments.filter((a) => ATTACHMENTS[a].slot === slot);
      if (!opts.length) return '';
      return `<div class="slot"><h4>${slot}</h4>
        <button class="wbtn ${!att[slot] ? 'sel' : ''}" data-gs-att="${slot}" data-gs-val="">None</button>
        ${opts.map((a) => `<button class="wbtn ${att[slot] === a ? 'sel' : ''}" data-gs-att="${slot}" data-gs-val="${a}">${ATTACHMENTS[a].name}</button>`).join('')}
      </div>`;
    }).join('');
    const base = computeStats(cur, {});
    const st = computeStats(cur, att);
    const bar = (label, v, b, max, invert = false, fmt = (x) => x) => {
      const pct = Math.min(100, (v / max) * 100), bp = Math.min(100, (b / max) * 100);
      const better = invert ? v < b : v > b;
      const cls = Math.abs(v - b) < 1e-6 ? '' : better ? 'delta-up' : 'delta-down';
      return `<span>${label}</span><div class="barbg"><i style="width:${Math.min(pct, bp)}%"></i>${cls ? `<i class="${cls}" style="left:${Math.min(pct, bp)}%;width:${Math.abs(pct - bp)}%"></i>` : ''}</div><span style="text-align:right">${fmt(v)}</span>`;
    };
    const ttk = Math.ceil(100 / st.damage[0]) - 1;
    return `<div class="card"><h3>Primary</h3><div class="wlist">${list(PRIMARY_LIST, 'primary')}</div>
      <h3>Secondary</h3><div class="wlist">${list(SECONDARY_LIST, 'secondary')}</div></div>
      <div class="card"><h3>${def.name} — attachments</h3><div class="slots">${slotsHtml}</div></div>
      <div class="card"><h3>Stats</h3><div class="stats">
        ${bar('Damage', st.damage[0], base.damage[0], 130)}
        ${bar('Range', st.range[1], base.range[1], 160, false, (x) => Math.round(x) + 'm')}
        ${bar('Fire rate', st.rpm, base.rpm, 1100, false, (x) => x + ' rpm')}
        ${bar('ADS time', st.ads, base.ads, 0.6, true, (x) => Math.round(x * 1000) + 'ms')}
        ${bar('Recoil control', 2 - st.vRecoilMul, 2 - base.vRecoilMul, 1.4, false, (x) => Math.round(x * 100) + '%')}
        ${bar('Mobility', st.mobility, base.mobility, 1.1, false, (x) => Math.round(x * 100) + '%')}
        ${bar('Magazine', st.mag, base.mag, 100)}
        ${bar('Tac reload', st.tacReload || st.shellReload, base.tacReload || base.shellReload, 6, true, (x) => x.toFixed(2) + 's')}
        ${bar('Hip spread', st.hipSpread, base.hipSpread, 7, true, (x) => x.toFixed(1) + '°')}
      </div><div class="hint">Shots to kill (close): ${ttk + 1} · TTK ≈ ${Math.round((ttk * 60000) / st.rpm)} ms · modes: ${st.modes.join(' / ')}${st.suppressed ? ' · suppressed' : ''}</div></div>`;
  }

  bindPage() {
    const m = this.main, s = this.s, g = this.game;
    m.querySelectorAll('[data-set]').forEach((el) => {
      const key = el.dataset.set;
      el.addEventListener('input', () => {
        let v = el.type === 'checkbox' ? el.checked : el.type === 'range' ? parseFloat(el.value) : el.value;
        if (key === 'quality') v = parseInt(v, 10);
        s[key] = v;
        const lbl = m.querySelector(`[data-val="${key}"]`);
        if (lbl) lbl.textContent = key === 'volume' ? Math.round(v * 100) : v;
        if (key === 'volume') g.audio.setVolume(v);
        if (key === 'quality' || key === 'renderScale') g.renderer.applySettings();
        saveSettings(s);
      });
    });
    m.querySelectorAll('[data-gs-weapon]').forEach((el) => el.addEventListener('click', () => {
      const id = el.dataset.gsWeapon;
      if (el.dataset.gsSlot === 'primary') s.loadout.primary = id; else s.loadout.secondary = id;
      this.gsWeapon = id;
      saveSettings(s); g.audio.ui('click'); g.applyLoadoutChange(); this.renderPage();
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
      saveSettings(s); g.audio.ui('click'); g.applyLoadoutChange(); this.renderPage();
    }));
  }

  showEnd(result) {
    const g = this.game;
    const sorted = [...g.actors].sort((a, b) => b.stats.score - a.stats.score);
    const mvp = sorted[0];
    this.main.innerHTML = `<div class="card"><h3>Match complete</h3>
      <div style="font-size:64px;font-weight:700;letter-spacing:0.12em;color:${result === 'VICTORY' ? 'var(--gold)' : result === 'DRAW' ? 'var(--fg)' : 'var(--enemy)'}">${result}</div>
      <div style="font-size:18px;color:var(--dim);margin:6px 0 16px">${g.mode.teams ? `${g.mode.score[0]} — ${g.mode.score[1]}` : ''} · MVP: <b style="color:var(--fg)">${mvp.name}</b> (${mvp.stats.kills} kills)</div>
      <table style="width:100%;font-size:16px;border-collapse:collapse">${sorted.map((a, i) => `<tr style="${a === g.player ? 'color:var(--gold)' : ''}"><td>${i + 1}. ${a.name}</td><td style="text-align:right">${a.stats.score}</td><td style="text-align:right">${a.stats.kills}/${a.stats.deaths}/${a.stats.assists}</td></tr>`).join('')}</table></div>`;
    this.page = 'end';
    this.el.classList.add('on');
    this.el.querySelector('[data-act=resume]').style.display = 'none';
    this.el.querySelector('[data-act=leave]').style.display = 'none';
    this.el.querySelector('#menuSub').textContent = 'SELECT MODE TO PLAY AGAIN';
  }
}
