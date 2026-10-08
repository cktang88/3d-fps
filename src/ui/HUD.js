import { DEG } from '../core/MathUtil.js';

const $ = (sel, root = document) => root.querySelector(sel);
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------------------------------------------------------------- medal art
// Every medal shares one badge silhouette (a clipped shield) so they read as a set; tier sets the
// colour, the glyph tells you what happened.
const GLYPH = {
  crosshair: '<circle cx="32" cy="31" r="10" fill="none" stroke="currentColor" stroke-width="3.2"/><path d="M32 15v8M32 39v8M16 31h8M40 31h8" stroke="currentColor" stroke-width="3.2"/><circle cx="32" cy="31" r="2.6" fill="currentColor"/>',
  x2: '<text x="32" y="40" text-anchor="middle" font-size="24" font-weight="700" fill="currentColor" font-family="Barlow Condensed, Rajdhani, sans-serif">2×</text>',
  x3: '<text x="32" y="40" text-anchor="middle" font-size="24" font-weight="700" fill="currentColor" font-family="Barlow Condensed, Rajdhani, sans-serif">3×</text>',
  x4: '<text x="32" y="40" text-anchor="middle" font-size="22" font-weight="700" fill="currentColor" font-family="Barlow Condensed, Rajdhani, sans-serif">4×+</text>',
  long: '<path d="M14 40 L46 22" stroke="currentColor" stroke-width="3" stroke-dasharray="4 3"/><circle cx="46" cy="22" r="6" fill="none" stroke="currentColor" stroke-width="3"/>',
  knife: '<path d="M18 44 L40 20 L46 18 L44 24 L22 46 Z" fill="currentColor"/><path d="M16 42 l6 6" stroke="currentColor" stroke-width="4"/>',
  frag: '<circle cx="31" cy="35" r="10" fill="currentColor"/><rect x="27" y="20" width="8" height="6" fill="currentColor"/><path d="M35 22 q8 -2 8 8" stroke="currentColor" stroke-width="2.6" fill="none"/>',
  cross: '<path d="M21 20 L43 42 M43 20 L21 42" stroke="currentColor" stroke-width="5"/>',
  drop: '<path d="M32 16 C 40 28 43 33 43 37 a11 11 0 0 1 -22 0 c0 -4 3 -9 11 -21z" fill="currentColor"/>',
  revenge: '<path d="M20 28 a12 12 0 1 1 3 12" stroke="currentColor" stroke-width="3.4" fill="none"/><path d="M14 26 l7 4 l3 -8" fill="currentColor"/>',
  chev3: '<path d="M20 22 l12 7 l12 -7 M20 30 l12 7 l12 -7 M20 38 l12 7 l12 -7" stroke="currentColor" stroke-width="3.4" fill="none"/>',
  chev5: '<path d="M20 18 l12 7 l12 -7 M20 26 l12 7 l12 -7 M20 34 l12 7 l12 -7 M20 42 l12 7 l12 -7" stroke="currentColor" stroke-width="3" fill="none"/><circle cx="32" cy="13" r="2.5" fill="currentColor"/>',
  star: '<path d="M32 15 l4.7 10 l11 1.2 l-8.2 7.4 l2.3 10.8 l-9.8 -5.6 l-9.8 5.6 l2.3 -10.8 l-8.2 -7.4 l11 -1.2z" fill="currentColor"/>',
};
const MEDALS = {
  headshot: { title: 'HEADSHOT', glyph: 'crosshair', tier: 1 },
  double: { title: 'DOUBLE KILL', glyph: 'x2', tier: 1 },
  triple: { title: 'TRIPLE KILL', glyph: 'x3', tier: 2 },
  multi: { title: 'MULTI KILL', glyph: 'x4', tier: 3 },
  longshot: { title: 'LONGSHOT', glyph: 'long', tier: 1 },
  melee: { title: 'HUMILIATION', glyph: 'knife', tier: 2 },
  frag: { title: 'FRAG OUT', glyph: 'frag', tier: 1 },
  buzzkill: { title: 'BUZZKILL', glyph: 'cross', tier: 2 },
  firstblood: { title: 'FIRST BLOOD', glyph: 'drop', tier: 2 },
  revenge: { title: 'REVENGE', glyph: 'revenge', tier: 1 },
  streak3: { title: 'KILLSTREAK ×3', glyph: 'chev3', tier: 1 },
  streak5: { title: 'MERCILESS ×5', glyph: 'chev5', tier: 2 },
  streak10: { title: 'UNSTOPPABLE ×10', glyph: 'star', tier: 3 },
};
export { MEDALS };
export function medalSvg(key, size = 64) {
  const m = MEDALS[key] || MEDALS.headshot;
  return `<svg class="medal-svg t${m.tier}" width="${size}" height="${size}" viewBox="0 0 64 64">
    <path class="rim" d="M32 2 L58 12 L58 36 C58 49 46 58 32 62 C18 58 6 49 6 36 L6 12 Z"/>
    <path class="face" d="M32 7 L53 15 L53 36 C53 46 44 53 32 57 C20 53 11 46 11 36 L11 15 Z"/>
    <g class="glyph">${GLYPH[m.glyph]}</g></svg>`;
}

const STREAK_UAV = 4;

export class HUD {
  constructor(game) {
    this.game = game;
    this.root = h(`<div id="hud">
      <div id="bloodVignette"></div>
      <div id="deathfx"></div>
      <div id="flashbang"></div>
      <div id="scope"><div class="lens"></div><div class="h"></div><div class="v"></div><div class="mils"></div><div class="center"></div><div class="zoomlbl"></div><div class="breath"><i></i></div></div>
      <div id="damage"></div>
      <div id="minimap"><canvas width="360" height="360"></canvas><div class="ring"></div><div class="north">N</div><div class="uav">UAV</div></div>
      <div id="top">
        <div id="compass"><div class="strip"></div><div class="pings"></div><div class="caret"></div><div class="hdg">000</div></div>
        <div id="score">
          <div class="side a"><div class="lbl">FRIENDLY</div><div class="num">0</div><div class="prog"><i></i></div></div>
          <div class="mid"><div class="timer">10:00</div><div class="goal"></div></div>
          <div class="side b"><div class="lbl">ENEMY</div><div class="num">0</div><div class="prog"><i></i></div></div>
        </div>
      </div>
      <div id="killfeed"></div>
      <div id="crosshair"><div class="l t"></div><div class="l b"></div><div class="l lf"></div><div class="l r"></div><div class="l dot"></div></div>
      <div id="hitmarker"><i class="a"></i><i class="b"></i><i class="c"></i><i class="d"></i></div>
      <div id="ammoWarn"></div>
      <div id="tally"><div class="head"><span class="name"></span></div><div class="total"></div><div class="lines"></div></div>
      <div id="medals"></div>
      <div id="prompt"></div>
      <div id="banner"></div>
      <div id="health">
        <div class="streak"><span class="lbl">STREAK</span><span class="pips"></span><span class="uavtag">UAV</span></div>
        <div class="row"><div class="hp">100</div><div class="bars"><div class="bar"><i class="ghost"></i><i class="fill"></i><div class="ticks"></div></div><div class="stamina"><i></i></div></div></div>
      </div>
      <div id="ammo"><div class="weapon"><span class="name"></span><span class="mode"></span></div><div class="count"><span class="mag">30</span><span class="reserve">120</span></div><div class="bullets"></div><div class="equip"></div></div>
      <div id="death">
        <div class="by">ELIMINATED BY</div>
        <div class="killer"></div>
        <div class="info"></div>
        <div class="khp"><span>KILLER HEALTH</span><div class="kbar"><i></i></div><b></b></div>
        <div class="deploy"><div class="dbar"><i></i></div><div class="dtxt"></div></div>
      </div>
      <div id="spawnfade"></div>
      <div id="scoreboard"><div class="sbhead"><div class="mname"></div><div class="mtime"></div></div><div class="cols"></div><div class="sbfoot"></div></div>
      <div id="fps"></div>
    </div>`);
    document.body.appendChild(this.root);
    const r = this.root;
    this.el = {
      cross: $('#crosshair', r), hit: $('#hitmarker', r), mag: $('#ammo .mag', r), reserve: $('#ammo .reserve', r),
      wname: $('#ammo .weapon .name', r), mode: $('#ammo .weapon .mode', r), bullets: $('#ammo .bullets', r), equip: $('#ammo .equip', r),
      hp: $('#health .hp', r), hfill: $('#health .fill', r), hghost: $('#health .ghost', r), health: $('#health', r),
      stamina: $('#health .stamina i', r), streak: $('#health .streak', r), streakPips: $('#health .streak .pips', r),
      feed: $('#killfeed', r), prompt: $('#prompt', r), banner: $('#banner', r),
      damage: $('#damage', r), blood: $('#bloodVignette', r), flash: $('#flashbang', r), deathfx: $('#deathfx', r), spawnfade: $('#spawnfade', r),
      scope: $('#scope', r), scopeZoom: $('#scope .zoomlbl', r), breath: $('#scope .breath i', r),
      scoreA: $('#score .a .num', r), scoreB: $('#score .b .num', r), lblA: $('#score .a .lbl', r), lblB: $('#score .b .lbl', r),
      progA: $('#score .a .prog i', r), progB: $('#score .b .prog i', r), timer: $('#score .timer', r), goal: $('#score .goal', r),
      sb: $('#scoreboard', r), death: $('#death', r), fps: $('#fps', r),
      compass: $('#compass .strip', r), pings: $('#compass .pings', r), hdg: $('#compass .hdg', r),
      minimap: $('#minimap canvas', r), mmWrap: $('#minimap', r), north: $('#minimap .north', r),
      tally: $('#tally', r), tallyTotal: $('#tally .total', r), tallyLines: $('#tally .lines', r), tallyName: $('#tally .name', r),
      medals: $('#medals', r), ammoWarn: $('#ammoWarn', r),
    };
    // Health bar ticks (every 25 hp).
    $('#health .ticks', r).innerHTML = '<i></i><i></i><i></i>';
    // Hitmarker arms.
    // Mil-dots.
    const mils = $('#scope .mils', r);
    for (let i = -4; i <= 4; i++) if (i) {
      mils.appendChild(h(`<i style="left:${i * 4.5}vh;top:0"></i>`));
      mils.appendChild(h(`<i style="top:${i * 4.5}vh;left:0"></i>`));
    }
    // Compass strip: numbers every 15°, cardinals bold; minor ticks drawn by CSS gradient.
    const dirs = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    this.compassPxPerDeg = 3.2;
    this.compassW = 440;
    let strip = '';
    for (let d = -360; d <= 720; d += 15) {
      const nd = ((d % 360) + 360) % 360;
      strip += dirs[nd] !== undefined
        ? `<span class="cd${nd % 90 === 0 ? ' major' : ''}" style="left:${d * this.compassPxPerDeg}px">${dirs[nd]}</span>`
        : `<span class="deg" style="left:${d * this.compassPxPerDeg}px">${nd}</span>`;
    }
    this.el.compass.innerHTML = strip;
    this.el.compass.style.setProperty('--tick', `${this.compassPxPerDeg * 5}px`);
    this.mm = this.el.minimap.getContext('2d');
    this.hitT = 0;
    this.wedges = new Map();
    this.lastAmmoKey = '';
    this.fpsAcc = 0; this.fpsFrames = 0;
    this.flashV = 0;
    this.ghostHp = 100;
    this.tallyT = 0; this.tallySum = 0;
    this.medalQueue = []; this.medalT = 0;
    this._cache = {};
    this._crossGap = -1;
    this._mmFrame = 0;
    this.streak(0);
  }

  show(v) { this.root.classList.toggle('hidden', !v); }

  /** Clear transient state at match start. */
  reset() {
    this.el.feed.innerHTML = '';
    this.el.tallyLines.innerHTML = ''; this.tallyT = 0; this.tallySum = 0; this.el.tally.classList.remove('on');
    this.medalQueue.length = 0; this.el.medals.innerHTML = ''; this.medalT = 0;
    for (const [, w] of this.wedges) w.el.remove();
    this.wedges.clear();
    this.streak(0);
    this.ghostHp = 100;
  }

  // Write a style/text only when it changes (keeps per-frame DOM churn near zero).
  _set(el, key, prop, val) {
    const k = key + prop;
    if (this._cache[k] === val) return;
    this._cache[k] = val;
    if (prop === 'text') el.textContent = val;
    else if (prop === 'html') el.innerHTML = val;
    else if (prop[0] === '-') el.style.setProperty(prop, val);
    else el.style[prop] = val;
  }

  // ---------------------------------------------------------------- feedback
  hitmarker(kind = 'hit') {
    const el = this.el.hit;
    el.className = '';
    void el.offsetWidth; // restart animation
    el.className = `on ${kind}`;
    this.hitT = kind === 'kill' ? 0.42 : 0.2;
  }

  /** Directional damage arc. `src` is a live position (attacker) or a fixed one (explosion). */
  damageFrom(src, amount = 20) {
    let w = this.wedges.get(src);
    if (!w) {
      const el = h('<div class="wedge"><svg viewBox="-160 -160 320 320" width="320" height="320"><defs><linearGradient id="dg" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#ff2b2b" stop-opacity="0"/><stop offset="1" stop-color="#ff3b30" stop-opacity="0.95"/></linearGradient></defs><path d="M -64 -128 A 143 143 0 0 1 64 -128 L 52 -104 A 116 116 0 0 0 -52 -104 Z" fill="url(#dg)"/><path d="M -60 -131 A 146 146 0 0 1 60 -131" stroke="#ffd2cc" stroke-opacity=".8" stroke-width="2" fill="none"/></svg></div>');
      this.el.damage.appendChild(el);
      w = { el, pos: src, t: 0 };
      this.wedges.set(src, w);
    }
    w.t = 1.6;
    w.k = Math.min(1, 0.55 + amount / 60);
  }

  killfeed(killer, victim, weapon, headshot, mine, type) {
    const g = this.game;
    const team = (a) => (g.mode.teams ? (a?.team === g.player.team ? 'ally' : 'enemy') : a === g.player ? 'ally' : 'enemy');
    const nm = (a) => `<span class="${team(a)}${a === g.player ? ' you' : ''}">${esc(a.name)}</span>`;
    const icon = type === 'grenade' ? '<b class="ic frag"></b>' : type === 'melee' ? '<b class="ic knife"></b>' : '';
    const row = h(`<div class="row ${mine ? 'mine' : ''}">
      ${killer ? nm(killer) : ''}
      <span class="wpn">${icon}${esc(weapon)}</span>${headshot ? '<span class="hs" title="Headshot"></span>' : ''}
      ${nm(victim)}</div>`);
    this.el.feed.prepend(row);
    while (this.el.feed.children.length > 5) this.el.feed.lastChild.remove();
    setTimeout(() => row.classList.add('out'), 6500);
    setTimeout(() => row.remove(), 7000);
  }

  /** Score tally line ("+100 ENEMY KILLED"); totals accumulate while lines keep coming. */
  score(text, pts) {
    if (this.tallyT <= 0) { this.tallySum = 0; this.el.tallyLines.innerHTML = ''; this.el.tallyName.textContent = ''; }
    this.tallySum += pts;
    this.tallyT = 2.6;
    this.game.matchStats.xp += pts;
    const line = h(`<div class="ln"><b>+${pts}</b><span>${esc(text)}</span></div>`);
    this.el.tallyLines.prepend(line);
    while (this.el.tallyLines.children.length > 4) this.el.tallyLines.lastChild.remove();
    const t = this.el.tallyTotal;
    t.textContent = `+${this.tallySum}`;
    t.classList.remove('bump'); void t.offsetWidth; t.classList.add('bump');
    this.el.tally.classList.add('on');
  }

  killConfirm(victim, headshot) {
    this.el.tallyName.innerHTML = `<i class="sk"></i>${esc(victim.name)}${headshot ? '<em>HEADSHOT</em>' : ''}`;
  }

  medal(key) {
    if (!MEDALS[key]) return;
    this.medalQueue.push(key);
  }

  _showMedal(key) {
    const m = MEDALS[key];
    const el = h(`<div class="medal t${m.tier}">${medalSvg(key, 72)}<div class="mt">${m.title}</div></div>`);
    this.el.medals.innerHTML = '';
    this.el.medals.appendChild(el);
    this.game.audio.ui('medal');
    setTimeout(() => el.classList.add('out'), 1100);
    setTimeout(() => el.remove(), 1500);
  }

  streak(n) {
    this._streakN = n;
    const pips = [];
    const shown = Math.max(STREAK_UAV, n);
    for (let i = 0; i < Math.min(shown, 10); i++) pips.push(`<i class="${i < n ? 'on' : ''}${i === STREAK_UAV - 1 ? ' uav' : ''}"></i>`);
    this.el.streakPips.innerHTML = pips.join('');
    this.el.streak.classList.toggle('hot', n >= STREAK_UAV);
  }

  banner(big, small = '', dur = 2.5, cls = '') {
    const b = this.el.banner;
    clearTimeout(this._bt); clearTimeout(this._bt2);
    if (!big) { b.innerHTML = ''; b.className = ''; return; }
    b.className = '';
    b.innerHTML = `<div class="big">${esc(big)}</div>${small ? `<div class="small">${esc(small)}</div>` : ''}`;
    void b.offsetWidth;
    b.className = `on ${cls}`;
    if (dur > 0) {
      this._bt = setTimeout(() => b.classList.add('out'), dur * 1000);
      this._bt2 = setTimeout(() => { b.innerHTML = ''; b.className = ''; }, dur * 1000 + 450);
    }
  }

  prompt(html) { if (this._prompt !== html) { this.el.prompt.innerHTML = html || ''; this._prompt = html; } }

  /** White-out from a nearby explosion (0..1), decays in update(). */
  flash(a) { this.flashV = Math.max(this.flashV, a); }
  flashbang(a) { this.flash(a); }

  onSpawn() {
    const f = this.el.spawnfade;
    f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
    this.ghostHp = 100;
  }

  // ---------------------------------------------------------------- per frame
  update(dt) {
    const g = this.game, p = g.player, w = g.currentWeapon;
    // FPS counter.
    this.fpsAcc += dt; this.fpsFrames++;
    if (this.fpsAcc > 0.5) {
      const info = g.renderer.renderer.info;
      this.el.fps.textContent = g.settings.showFps ? `${Math.round(this.fpsFrames / this.fpsAcc)} FPS · ${info.render.calls} draws · ${(info.render.triangles / 1000).toFixed(0)}k tris` : '';
      this.fpsAcc = 0; this.fpsFrames = 0;
    }

    // Health with a trailing "ghost" chunk that shows the damage just taken.
    const hpv = Math.max(0, p.health);
    this.ghostHp = hpv >= this.ghostHp ? hpv : Math.max(hpv, this.ghostHp - dt * (g.time - p.lastDamageTime > 0.5 ? 60 : 0));
    this._set(this.el.hp, 'hp', 'text', String(Math.ceil(hpv)));
    this._set(this.el.hfill, 'hf', 'transform', `scaleX(${(hpv / p.maxHealth).toFixed(3)})`);
    this._set(this.el.hghost, 'hg', 'transform', `scaleX(${(this.ghostHp / p.maxHealth).toFixed(3)})`);
    const lowCls = p.health < 35 ? 'crit' : p.health < 60 ? 'low' : '';
    if (this._cache.hcls !== lowCls) { this._cache.hcls = lowCls; this.el.health.classList.toggle('low', lowCls === 'low'); this.el.health.classList.toggle('crit', lowCls === 'crit'); }
    this._set(this.el.stamina, 'st', 'transform', `scaleX(${(p.tacSprintTime / 4).toFixed(2)})`);
    const low = p.alive ? Math.max(0, 1 - p.health / 45) : 0;
    this._set(this.el.blood, 'bv', 'opacity', Math.max(low * 0.9, g.renderer.damagePulse * 0.6).toFixed(2));
    if (this.flashV > 0.001) this.flashV *= Math.exp(-dt * 2.2); else this.flashV = 0;
    this._set(this.el.flash, 'fl', 'opacity', this.flashV.toFixed(3));
    // UAV tag.
    this.el.streak.classList.toggle('uavon', g.uavTime > 0);
    this.el.mmWrap.classList.toggle('uavon', g.uavTime > 0);

    // Ammo.
    if (w) {
      const key = `${w.id}|${w.ammo}|${w.reserve}|${w.modeIndex}|${g.grenades}`;
      if (key !== this.lastAmmoKey) {
        const prevAmmo = this._prevAmmo;
        this.lastAmmoKey = key;
        this.el.wname.textContent = w.stats.name;
        this.el.mag.textContent = w.ammo;
        this.el.reserve.textContent = w.reserve;
        const ratio = w.ammo / w.stats.mag;
        this.el.mag.className = 'mag' + (w.ammo === 0 ? ' empty' : ratio <= 0.25 ? ' low' : '');
        if (prevAmmo !== undefined && w.ammo > prevAmmo) { this.el.mag.classList.add('refill'); }
        this._prevAmmo = w.ammo;
        const m = w.mode;
        const pips = m === 'auto' ? 3 : m === 'burst' ? 2 : 1;
        this.el.mode.innerHTML = `${m.toUpperCase()}<span class="pips">${'<b></b>'.repeat(pips)}</span>`;
        const cap = Math.min(w.stats.mag, 60);
        let bh = '';
        if (w.stats.mag <= 60) for (let i = 0; i < cap; i++) bh += `<b class="${i < w.ammo ? '' : 'spent'}"></b>`;
        this.el.bullets.innerHTML = bh;
        this.el.bullets.classList.toggle('thin', cap > 30);
        this.el.equip.innerHTML = `<span class="gr">${'<b class="ic frag"></b>'.repeat(g.grenades)}${'<b class="ic frag spent"></b>'.repeat(Math.max(0, 2 - g.grenades))}</span><kbd>G</kbd>`;
      }
      // Low ammo / reload hint under the crosshair.
      let warn = '';
      if (p.alive && w.state !== 'reload') {
        if (w.ammo === 0) warn = w.reserve > 0 ? 'RELOAD' : 'NO AMMO';
        else if (w.ammo / w.stats.mag <= 0.25 && w.stats.mag > 4) warn = w.reserve > 0 ? 'LOW AMMO' : 'LAST MAG';
      }
      if (this._cache.warn !== warn) {
        this._cache.warn = warn;
        this.el.ammoWarn.innerHTML = warn ? (warn === 'RELOAD' ? '<kbd>R</kbd>RELOAD' : warn) : '';
        this.el.ammoWarn.className = warn === 'RELOAD' || warn === 'NO AMMO' ? 'hot' : '';
      }
    }

    // Crosshair: spread to pixels.
    const cam = g.renderer.camera;
    if (w && p.alive) {
      const spread = g.currentSpread ?? 2;
      const px = (Math.tan(spread * DEG) / Math.tan((cam.fov * DEG) / 2)) * (innerHeight / 2);
      const gap = Math.round(Math.max(4, px) * 2) / 2;
      if (gap !== this._crossGap) {
        this._crossGap = gap;
        this.el.cross.style.setProperty('--gap', `${gap}px`);
      }
      let op = 1 - Math.min(1, w.adsT * 2.2);
      if (p.sprinting || w.state === 'reload' || p.mantle) op *= 0.2;
      if (w.stats.cls === 'Sniper Rifle' && w.adsT < 0.5) op *= 0.6;
      this._set(this.el.cross, 'xo', 'opacity', op.toFixed(2));
      this._set(this.el.cross, 'xc', '--xh', g.settings.crosshairColor);
    } else this._set(this.el.cross, 'xo', 'opacity', '0');

    // Hitmarker fade.
    if (this.hitT > 0) {
      this.hitT -= dt;
      if (this.hitT <= 0) this.el.hit.classList.remove('on');
    }

    // Score tally + medals.
    if (this.tallyT > 0) {
      this.tallyT -= dt;
      if (this.tallyT <= 0) this.el.tally.classList.remove('on');
    }
    this.medalT -= dt;
    if (this.medalT <= 0 && this.medalQueue.length) { this._showMedal(this.medalQueue.shift()); this.medalT = 1.15; }

    // Damage arcs (relative to current yaw).
    for (const [k, wd] of this.wedges) {
      wd.t -= dt;
      if (wd.t <= 0 || !wd.pos) { wd.el.remove(); this.wedges.delete(k); continue; }
      const dx = wd.pos.x - p.position.x, dz = wd.pos.z - p.position.z;
      const ang = Math.atan2(dx, -dz);
      const rel = ang + p.yaw;
      wd.el.style.transform = `rotate(${rel.toFixed(3)}rad)`;
      wd.el.style.opacity = (Math.min(1, wd.t / 0.6) * wd.k).toFixed(2);
    }

    // Scope overlay.
    const scoped = w && w.stats.overlay && w.adsT > 0.85;
    this.el.scope.classList.toggle('on', !!scoped);
    if (scoped) {
      this.el.scope.style.opacity = Math.min(1, (w.adsT - 0.85) / 0.15);
      this._set(this.el.scopeZoom, 'zl', 'text', `${w.zoom()}×`);
      this.el.breath.style.width = `${(g.breath ?? 1) * 100}%`;
    }

    // Compass + heading.
    const yawDeg = ((-p.yaw / DEG) % 360 + 360) % 360;
    this.el.compass.style.transform = `translateX(${(this.compassW / 2 - yawDeg * this.compassPxPerDeg).toFixed(1)}px)`;
    this._set(this.el.hdg, 'hd', 'text', String(Math.round(yawDeg) % 360).padStart(3, '0'));
    this.el.north.style.transform = `rotate(${p.yaw.toFixed(3)}rad)`;

    // Score + timer.
    const mode = g.mode;
    let a, b;
    if (mode.teams) {
      a = mode.score[p.team]; b = mode.score[1 - p.team];
      this._set(this.el.lblA, 'la', 'text', 'FRIENDLY'); this._set(this.el.lblB, 'lb', 'text', 'ENEMY');
    } else {
      let lead = null;
      for (const x of g.actors) if (x !== p && (!lead || x.stats.kills > lead.stats.kills)) lead = x;
      a = p.stats.kills; b = lead?.stats.kills ?? 0;
      this._set(this.el.lblA, 'la', 'text', 'YOU'); this._set(this.el.lblB, 'lb', 'text', lead ? lead.name.toUpperCase() : 'LEADER');
    }
    this._set(this.el.scoreA, 'sa', 'text', String(a));
    this._set(this.el.scoreB, 'sb', 'text', String(b));
    this._set(this.el.progA, 'pa', 'transform', `scaleX(${Math.min(1, a / mode.scoreLimit).toFixed(3)})`);
    this._set(this.el.progB, 'pb', 'transform', `scaleX(${Math.min(1, b / mode.scoreLimit).toFixed(3)})`);
    const tl = Math.max(0, mode.timeLeft);
    this._set(this.el.timer, 'tm', 'text', `${Math.floor(tl / 60)}:${String(Math.floor(tl % 60)).padStart(2, '0')}`);
    this._set(this.el.timer, 'tc', 'color', tl < 60 ? 'var(--enemy)' : '');
    this._set(this.el.goal, 'gl', 'text', `${mode.teams ? 'TDM' : 'FFA'} · ${mode.scoreLimit}`);

    // Death screen.
    const dead = !p.alive && g.deathInfo;
    if (dead) {
      const di = g.deathInfo;
      const d = this.el.death;
      if (!d.classList.contains('on')) {
        d.classList.add('on');
        this.el.deathfx.classList.add('on');
        const k = di.killer;
        const self = !k || k === p;
        d.querySelector('.by').textContent = self ? 'YOU DIED' : 'ELIMINATED BY';
        d.querySelector('.killer').textContent = self ? di.weapon : k.name;
        d.querySelector('.killer').className = 'killer' + (self ? ' self' : '');
        d.querySelector('.info').innerHTML = self ? '' : `<span>${esc(di.weapon)}</span>${di.headshot ? '<span class="hs">HEADSHOT</span>' : ''}<span>${Math.round(di.distance)} m</span>`;
        const khp = d.querySelector('.khp');
        khp.style.display = self ? 'none' : '';
        khp.querySelector('i').style.transform = `scaleX(${(di.killerHp || 0) / 100})`;
        khp.querySelector('b').textContent = di.killerHp || 0;
      }
      const total = g.constructor.RESPAWN_AUTO ?? 4.5, min = g.constructor.RESPAWN_MIN ?? 1.6;
      const elapsed = g.time - (g.deathTime ?? g.time);
      d.querySelector('.dbar i').style.transform = `scaleX(${Math.min(1, elapsed / total).toFixed(3)})`;
      d.querySelector('.dbar').classList.toggle('ready', elapsed >= min);
      this._set(d.querySelector('.dtxt'), 'dt', 'html', elapsed < min ? 'DEPLOYING…' : `<kbd>SPACE</kbd> DEPLOY NOW · AUTO ${Math.max(0, total - elapsed).toFixed(0)}s`);
    } else if (this.el.death.classList.contains('on')) {
      this.el.death.classList.remove('on');
      this.el.deathfx.classList.remove('on');
    }
    this.root.classList.toggle('dead', !p.alive);

    // Keep the scoreboard live while held.
    if (this.el.sb.classList.contains('on') && (this._sbT = (this._sbT || 0) - dt) <= 0) { this._sbT = 0.5; this.scoreboard(true); }

    // Minimap at half rate (it's a 2D canvas redraw).
    if ((this._mmFrame++ & 1) === 0) this.drawMinimap();
  }

  drawMinimap() {
    const g = this.game, p = g.player, ctx = this.mm;
    const S = 360, R = 45; // metres radius
    const k = S / 2 / R;
    ctx.clearRect(0, 0, S, S);
    ctx.save();
    ctx.translate(S / 2, S / 2);
    ctx.rotate(p.yaw);
    ctx.translate(-p.position.x * k, -p.position.z * k);
    // Grid (10 m).
    ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1;
    ctx.beginPath();
    const gx0 = Math.floor((p.position.x - 70) / 10) * 10, gz0 = Math.floor((p.position.z - 70) / 10) * 10;
    for (let x = gx0; x < gx0 + 140; x += 10) { ctx.moveTo(x * k, (gz0) * k); ctx.lineTo(x * k, (gz0 + 140) * k); }
    for (let z = gz0; z < gz0 + 140; z += 10) { ctx.moveTo(gx0 * k, z * k); ctx.lineTo((gx0 + 140) * k, z * k); }
    ctx.stroke();
    // Level footprint.
    if (g.level?.minimapShapes) {
      for (const s of g.level.minimapShapes) {
        ctx.fillStyle = s.fill;
        ctx.save();
        ctx.translate(s.x * k, s.z * k);
        ctx.rotate(-s.rot || 0);
        ctx.fillRect(-s.w / 2 * k, -s.d / 2 * k, s.w * k, s.d * k);
        ctx.restore();
      }
    }
    // Actors.
    const uav = g.uavTime > 0;
    for (const a of g.actors) {
      if (!a.alive || a === p) continue;
      const ally = g.mode.teams && a.team === p.team;
      const firing = a.lastFiredTime !== undefined && g.time - a.lastFiredTime < 1.5 && !a.weapon?.stats.suppressed;
      if (!(ally || firing || uav)) continue;
      const x = a.position.x * k, z = a.position.z * k;
      if (ally) {
        ctx.save(); ctx.translate(x, z); ctx.rotate(-a.yaw);
        ctx.fillStyle = '#4cb5ff';
        ctx.beginPath(); ctx.moveTo(0, -9); ctx.lineTo(6, 6); ctx.lineTo(0, 3); ctx.lineTo(-6, 6); ctx.closePath(); ctx.fill();
        ctx.restore();
      } else {
        ctx.fillStyle = '#ff4d5a';
        ctx.beginPath(); ctx.arc(x, z, firing ? 7 : 6, 0, Math.PI * 2); ctx.fill();
        if (firing) { ctx.strokeStyle = 'rgba(255,77,90,0.5)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, z, 7 + ((g.time * 20) % 10), 0, Math.PI * 2); ctx.stroke(); }
      }
    }
    ctx.restore();
    // UAV sweep.
    if (uav) {
      const a = (g.time * 2.2) % (Math.PI * 2);
      const grd = ctx.createConicGradient ? ctx.createConicGradient(a - 0.6, S / 2, S / 2) : null;
      if (grd) {
        grd.addColorStop(0, 'rgba(255,77,90,0)'); grd.addColorStop(0.095, 'rgba(255,77,90,0.18)'); grd.addColorStop(0.1, 'rgba(255,77,90,0)'); grd.addColorStop(1, 'rgba(255,77,90,0)');
        ctx.fillStyle = grd; ctx.fillRect(0, 0, S, S);
      }
    }
    // FOV cone.
    const fov = 2 * Math.atan(Math.tan((g.renderer.camera.fov * DEG) / 2) * g.renderer.camera.aspect);
    const grd = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    grd.addColorStop(0, 'rgba(255,255,255,0.16)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grd;
    ctx.beginPath(); ctx.moveTo(S / 2, S / 2);
    ctx.arc(S / 2, S / 2, S / 2, -Math.PI / 2 - fov / 2, -Math.PI / 2 + fov / 2); ctx.closePath(); ctx.fill();
    // Player arrow (always up).
    ctx.fillStyle = '#ffc83d';
    ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(S / 2, S / 2 - 13); ctx.lineTo(S / 2 + 9, S / 2 + 10); ctx.lineTo(S / 2, S / 2 + 5); ctx.lineTo(S / 2 - 9, S / 2 + 10);
    ctx.closePath(); ctx.stroke(); ctx.fill();
  }

  scoreboard(on) {
    const sb = this.el.sb;
    sb.classList.toggle('on', on);
    if (!on) return;
    const g = this.game, mode = g.mode, ms = g.matchStats;
    sb.classList.toggle('ffa', !mode.teams);
    sb.querySelector('.mname').innerHTML = `${esc(mode.name)}<span>${esc(g.level.name || '')}</span>`;
    sb.querySelector('.mtime').textContent = this.el.timer.textContent;
    const row = (a, i) => `<tr class="${a === g.player ? 'me' : ''} ${a.alive ? '' : 'dead'}"><td class="rk">${i + 1}</td><td class="nm">${esc(a.name)}${a.alive ? '' : '<i class="sk"></i>'}</td><td class="n">${a.stats.score}</td><td class="n">${a.stats.kills}</td><td class="n">${a.stats.deaths}</td><td class="n">${a.stats.assists}</td><td class="n">${(a.stats.kills / Math.max(1, a.stats.deaths)).toFixed(2)}</td><td class="n dim">${a.isPlayer ? '—' : a.ping}</td></tr>`;
    const head = '<tr><th></th><th>OPERATOR</th><th class="n">SCORE</th><th class="n">K</th><th class="n">D</th><th class="n">A</th><th class="n">K/D</th><th class="n">PING</th></tr>';
    const sorted = [...g.actors].sort((x, y) => y.stats.score - x.stats.score);
    let html;
    if (mode.teams) {
      const t = (team, cls, label) => `<div class="${cls}"><h3><span>${label}</span><b>${mode.score[team]}</b></h3><table>${head}${sorted.filter((a) => a.team === team).map(row).join('')}</table></div>`;
      html = t(g.player.team, 'ta', 'FRIENDLY') + t(1 - g.player.team, 'tb', 'ENEMY');
    } else html = `<div class="tf"><table>${head}${sorted.map(row).join('')}</table></div>`;
    sb.querySelector('.cols').innerHTML = html;
    const acc = ms.shots ? Math.round((ms.hits / ms.shots) * 100) : 0;
    sb.querySelector('.sbfoot').innerHTML = `<span>ACCURACY <b>${acc}%</b></span><span>HEADSHOTS <b>${ms.headshots}</b></span><span>BEST STREAK <b>${ms.bestStreak}</b></span><span>DAMAGE <b>${Math.round(ms.damage)}</b></span>`;
  }
}
