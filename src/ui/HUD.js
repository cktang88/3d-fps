import * as THREE from 'three';
import { DEG } from '../core/MathUtil.js';

const $ = (sel, root = document) => root.querySelector(sel);
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; };

export class HUD {
  constructor(game) {
    this.game = game;
    this.root = h(`<div id="hud">
      <div id="bloodVignette"></div>
      <div id="flashbang"></div>
      <div id="scope"><div class="lens"></div><div class="h"></div><div class="v"></div><div class="mils"></div><div class="center"></div><div class="zoomlbl"></div><div class="breath"><i></i></div></div>
      <div id="minimap"><canvas width="380" height="380"></canvas></div>
      <div id="compass"><div class="strip"></div></div>
      <div id="score"><div class="team a">0</div><div class="timer">10:00</div><div class="team b">0</div><div class="goal"></div></div>
      <div id="killfeed"></div>
      <div id="crosshair"><div class="l t"></div><div class="l b"></div><div class="l lf"></div><div class="l r"></div><div class="l dot"></div></div>
      <div id="hitmarker"><i style="transform:rotate(45deg) translateY(-9px)"></i><i style="transform:rotate(135deg) translateY(-9px)"></i><i style="transform:rotate(225deg) translateY(-9px)"></i><i style="transform:rotate(315deg) translateY(-9px)"></i></div>
      <div id="damage"></div>
      <div id="events"></div>
      <div id="prompt"></div>
      <div id="banner"></div>
      <div id="health"><div class="label"><span>HEALTH</span><span class="hp">100</span></div><div class="bar"></div><div class="stamina"><i></i></div></div>
      <div id="ammo"><div class="weapon"></div><div class="count"><span class="mag">30</span><span class="reserve">/ 120</span></div><div class="mode"></div><div class="bullets"></div><div class="equip"></div></div>
      <div id="death"><div class="by">KILLED BY</div><div class="killer"></div><div class="info"></div><div class="respawn"></div></div>
      <div id="scoreboard"><h2><span class="mname"></span><span class="mtime"></span></h2><div class="cols"></div></div>
      <div id="fps"></div>
    </div>`);
    document.body.appendChild(this.root);
    this.el = {
      cross: $('#crosshair', this.root), hit: $('#hitmarker', this.root), mag: $('#ammo .mag', this.root),
      reserve: $('#ammo .reserve', this.root), wname: $('#ammo .weapon', this.root), mode: $('#ammo .mode', this.root),
      bullets: $('#ammo .bullets', this.root), equip: $('#ammo .equip', this.root),
      hp: $('#health .hp', this.root), hbar: $('#health .bar', this.root), health: $('#health', this.root),
      stamina: $('#health .stamina i', this.root),
      feed: $('#killfeed', this.root), events: $('#events', this.root), prompt: $('#prompt', this.root), banner: $('#banner', this.root),
      damage: $('#damage', this.root), blood: $('#bloodVignette', this.root), flash: $('#flashbang', this.root),
      scope: $('#scope', this.root), scopeZoom: $('#scope .zoomlbl', this.root), breath: $('#scope .breath i', this.root),
      scoreA: $('#score .a', this.root), scoreB: $('#score .b', this.root), timer: $('#score .timer', this.root), goal: $('#score .goal', this.root),
      sb: $('#scoreboard', this.root), death: $('#death', this.root), fps: $('#fps', this.root),
      compass: $('#compass .strip', this.root), minimap: $('#minimap canvas', this.root),
    };
    // Health segments.
    for (let i = 0; i < 4; i++) this.el.hbar.appendChild(h('<div class="seg"><i></i></div>'));
    this.segs = [...this.el.hbar.querySelectorAll('.seg i')];
    // Mil-dots.
    const mils = $('#scope .mils', this.root);
    for (let i = -4; i <= 4; i++) if (i) {
      mils.appendChild(h(`<i style="left:${i * 4.5}vh;top:0"></i>`));
      mils.appendChild(h(`<i style="top:${i * 4.5}vh;left:0"></i>`));
    }
    // Compass strip.
    const dirs = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    this.compassPxPerDeg = 3;
    for (let d = -360; d <= 720; d += 15) {
      const nd = ((d % 360) + 360) % 360;
      const lbl = dirs[nd] ?? (nd % 45 === 0 ? '' : '|');
      const s = document.createElement('span');
      s.textContent = dirs[nd] ? lbl : nd;
      if (dirs[nd]) s.className = 'card';
      else s.style.fontSize = '10px';
      s.style.left = (d * this.compassPxPerDeg) + 'px';
      this.el.compass.appendChild(s);
    }
    this.mm = this.el.minimap.getContext('2d');
    this.hitT = 0;
    this.wedges = new Map();
    this.lastAmmoKey = '';
    this.fpsAcc = 0; this.fpsFrames = 0;
    this.eventQueue = [];
  }

  show(v) { this.root.classList.toggle('hidden', !v); }

  hitmarker(kind = 'hit') {
    const el = this.el.hit;
    el.className = kind === 'kill' ? 'kill' : kind === 'head' ? 'head' : '';
    el.style.transition = 'none';
    el.style.opacity = '1';
    el.style.transform = `scale(${kind === 'kill' ? 1.5 : 1.15})`;
    this.hitT = kind === 'kill' ? 0.35 : 0.16;
  }

  damageFrom(attackerPos) {
    const id = attackerPos ? `${Math.round(attackerPos.x)}_${Math.round(attackerPos.z)}` : 'x';
    let w = this.wedges.get(attackerPos);
    if (!w) {
      const el = document.createElement('div');
      el.className = 'wedge';
      this.el.damage.appendChild(el);
      w = { el, pos: attackerPos, t: 0 };
      this.wedges.set(attackerPos, w);
    }
    w.pos = attackerPos?.clone?.() ?? attackerPos;
    w.t = 1.5;
  }

  killfeed(killer, victim, weapon, headshot, mine) {
    const team = (a) => (this.game.mode.teams ? (a?.team === this.game.player.team ? 'ally' : 'enemy') : a === this.game.player ? 'ally' : 'enemy');
    const row = h(`<div class="row ${mine ? 'mine' : ''}">
      ${killer ? `<span class="${team(killer)}">${killer.name}</span>` : ''}
      <span class="wpn">${weapon}</span>${headshot ? '<span class="hs">⌖ HS</span>' : ''}
      <span class="${team(victim)}">${victim.name}</span></div>`);
    this.el.feed.appendChild(row);
    while (this.el.feed.children.length > 6) this.el.feed.firstChild.remove();
    setTimeout(() => row.remove(), 6000);
  }

  event(text, pts, cls = '') {
    const el = h(`<div class="ev ${cls}">${text}${pts ? `<span class="pts">+${pts}</span>` : ''}</div>`);
    this.el.events.appendChild(el);
    while (this.el.events.children.length > 4) this.el.events.firstChild.remove();
    setTimeout(() => { el.style.transition = 'opacity .4s'; el.style.opacity = '0'; }, 1600);
    setTimeout(() => el.remove(), 2100);
  }

  banner(big, small = '', dur = 2.5) {
    this.el.banner.innerHTML = big ? `<div class="big">${big}</div><div class="small">${small}</div>` : '';
    clearTimeout(this._bt);
    if (dur > 0) this._bt = setTimeout(() => (this.el.banner.innerHTML = ''), dur * 1000);
  }

  prompt(html) { if (this._prompt !== html) { this.el.prompt.innerHTML = html || ''; this._prompt = html; } }

  flashbang(a) { this.el.flash.style.opacity = a; }

  update(dt) {
    const g = this.game, p = g.player, w = g.currentWeapon;
    // FPS counter.
    this.fpsAcc += dt; this.fpsFrames++;
    if (this.fpsAcc > 0.5) {
      const info = g.renderer.renderer.info;
      this.el.fps.textContent = g.settings.showFps ? `${Math.round(this.fpsFrames / this.fpsAcc)} FPS · ${info.render.calls} draws · ${(info.render.triangles / 1000).toFixed(0)}k tris` : '';
      this.fpsAcc = 0; this.fpsFrames = 0;
    }

    // Health.
    const hp = Math.ceil(p.health);
    this.el.hp.textContent = hp;
    for (let i = 0; i < 4; i++) {
      const v = Math.max(0, Math.min(1, (p.health - i * 25) / 25));
      this.segs[i].style.transform = `scaleX(${v})`;
    }
    this.el.health.classList.toggle('low', p.health < 40);
    this.el.stamina.style.width = `${(p.tacSprintTime / 4) * 100}%`;
    const low = p.alive ? Math.max(0, 1 - p.health / 45) : 0;
    this.el.blood.style.opacity = Math.max(low * 0.9, g.renderer.damagePulse * 0.6);

    // Ammo.
    if (w) {
      const key = `${w.id}|${w.ammo}|${w.reserve}|${w.modeIndex}|${w.state}|${g.grenades}`;
      if (key !== this.lastAmmoKey) {
        this.lastAmmoKey = key;
        this.el.wname.textContent = w.stats.name;
        this.el.mag.textContent = w.ammo;
        this.el.reserve.textContent = `/ ${w.reserve}`;
        const ratio = w.ammo / w.stats.mag;
        this.el.mag.className = 'mag' + (w.ammo === 0 ? ' empty' : ratio <= 0.3 ? ' low' : '');
        const m = w.mode;
        const pips = m === 'auto' ? 3 : m === 'burst' ? 2 : 1;
        this.el.mode.innerHTML = `<span>${m.toUpperCase()}</span><span class="pips">${'<b></b>'.repeat(pips)}</span>`;
        const cap = Math.min(w.stats.mag, 60);
        let bh = '';
        if (w.stats.mag <= 60) for (let i = 0; i < cap; i++) bh += `<b class="${i < w.ammo ? '' : 'spent'}"></b>`;
        this.el.bullets.innerHTML = bh;
        this.el.equip.innerHTML = `FRAG ×${g.grenades}`;
      }
    }

    // Crosshair: spread to pixels.
    const cam = g.renderer.camera;
    if (w && p.alive) {
      const spread = g.currentSpread ?? 2;
      const px = (Math.tan(spread * DEG) / Math.tan((cam.fov * DEG) / 2)) * (innerHeight / 2);
      const gap = Math.max(3, px);
      const s = this.el.cross.children;
      s[0].style.top = `${-gap - 8}px`; s[1].style.top = `${gap}px`;
      s[2].style.left = `${-gap - 8}px`; s[3].style.left = `${gap}px`;
      let op = 1 - Math.min(1, w.adsT * 2.2);
      if (p.sprinting || w.state === 'reload' || p.mantle) op *= 0.25;
      if (w.stats.cls === 'Sniper Rifle' && w.adsT < 0.5) op *= 0.6;
      this.el.cross.style.opacity = op;
      this.el.cross.style.setProperty('--xh', g.settings.crosshairColor);
    } else this.el.cross.style.opacity = 0;

    // Hitmarker fade.
    if (this.hitT > 0) {
      this.hitT -= dt;
      if (this.hitT <= 0) { this.el.hit.style.transition = 'opacity .12s, transform .12s'; this.el.hit.style.opacity = '0'; this.el.hit.style.transform = 'scale(1)'; }
    }

    // Damage wedges (relative to current yaw).
    for (const [k, wd] of this.wedges) {
      wd.t -= dt;
      if (wd.t <= 0 || !wd.pos) { wd.el.remove(); this.wedges.delete(k); continue; }
      const dx = wd.pos.x - p.position.x, dz = wd.pos.z - p.position.z;
      const ang = Math.atan2(dx, -dz); // world angle from north (−z)
      const rel = ang + p.yaw; // yaw: 0 looks −z, positive turns left
      wd.el.style.transform = `rotate(${rel}rad)`;
      wd.el.style.opacity = Math.min(1, wd.t);
    }

    // Scope overlay.
    const scoped = w && w.stats.overlay && w.adsT > 0.85;
    this.el.scope.classList.toggle('on', !!scoped);
    if (scoped) {
      this.el.scope.style.opacity = Math.min(1, (w.adsT - 0.85) / 0.15);
      this.el.scopeZoom.textContent = `${w.zoom()}×`;
      this.el.breath.style.width = `${(g.breath ?? 1) * 100}%`;
    }

    // Compass.
    const yawDeg = ((-p.yaw / DEG) % 360 + 360) % 360;
    this.el.compass.style.left = `${210 - yawDeg * this.compassPxPerDeg}px`;

    // Score + timer.
    const mode = g.mode;
    if (mode.teams) {
      this.el.scoreA.textContent = mode.score[p.team];
      this.el.scoreB.textContent = mode.score[1 - p.team];
    } else {
      const sorted = [...g.actors].sort((a, b) => b.stats.kills - a.stats.kills);
      this.el.scoreA.textContent = p.stats.kills;
      this.el.scoreB.textContent = (sorted[0] === p ? sorted[1] : sorted[0])?.stats.kills ?? 0;
    }
    const tl = Math.max(0, mode.timeLeft);
    this.el.timer.textContent = `${Math.floor(tl / 60)}:${String(Math.floor(tl % 60)).padStart(2, '0')}`;
    this.el.timer.style.color = tl < 60 ? 'var(--enemy)' : '';
    this.el.goal.textContent = `${mode.name} · FIRST TO ${mode.scoreLimit}`;

    // Death screen.
    if (!p.alive && g.deathInfo) {
      this.el.death.classList.add('on');
      const di = g.deathInfo;
      this.el.death.querySelector('.killer').textContent = di.killer?.name ?? 'Yourself';
      this.el.death.querySelector('.info').textContent = di.killer && di.killer !== p
        ? `${di.weapon}${di.headshot ? ' · HEADSHOT' : ''} · ${Math.round(di.distance)}m · ${Math.ceil(di.killer.health)} HP left` : '';
      this.el.death.querySelector('.respawn').textContent = g.respawnTimer > 0 ? `RESPAWN IN ${g.respawnTimer.toFixed(1)}` : 'PRESS SPACE / CLICK TO DEPLOY';
    } else this.el.death.classList.remove('on');

    this.drawMinimap();
  }

  drawMinimap() {
    const g = this.game, p = g.player, ctx = this.mm;
    const S = 380, R = 50; // metres radius
    const k = S / 2 / R;
    ctx.clearRect(0, 0, S, S);
    ctx.save();
    ctx.translate(S / 2, S / 2);
    ctx.rotate(p.yaw);
    ctx.translate(-p.position.x * k, -p.position.z * k);
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
    for (const a of g.actors) {
      if (!a.alive || a === p) continue;
      const ally = g.mode.teams && a.team === p.team;
      const visible = ally || (a.lastFiredTime !== undefined && g.time - a.lastFiredTime < 1.5 && !a.weapon?.stats.suppressed) || g.uavTime > 0;
      if (!visible) continue;
      ctx.fillStyle = ally ? '#3fa9f5' : '#ff4655';
      ctx.beginPath();
      ctx.arc(a.position.x * k, a.position.z * k, 6, 0, Math.PI * 2);
      ctx.fill();
      if (ally) {
        // Facing tick.
        ctx.strokeStyle = '#3fa9f5'; ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(a.position.x * k, a.position.z * k);
        ctx.lineTo((a.position.x - Math.sin(a.yaw) * 1.6) * k, (a.position.z - Math.cos(a.yaw) * 1.6) * k);
        ctx.stroke();
      }
    }
    ctx.restore();
    // Player arrow (always up).
    ctx.fillStyle = '#ffc83d';
    ctx.beginPath();
    ctx.moveTo(S / 2, S / 2 - 12); ctx.lineTo(S / 2 + 8, S / 2 + 9); ctx.lineTo(S / 2, S / 2 + 4); ctx.lineTo(S / 2 - 8, S / 2 + 9);
    ctx.closePath(); ctx.fill();
    // FOV cone.
    const fov = 2 * Math.atan(Math.tan((g.renderer.camera.fov * DEG) / 2) * g.renderer.camera.aspect);
    const grd = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    grd.addColorStop(0, 'rgba(255,255,255,0.12)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grd;
    ctx.beginPath(); ctx.moveTo(S / 2, S / 2);
    ctx.arc(S / 2, S / 2, S / 2, -Math.PI / 2 - fov / 2, -Math.PI / 2 + fov / 2); ctx.closePath(); ctx.fill();
  }

  scoreboard(on) {
    const sb = this.el.sb;
    sb.classList.toggle('on', on);
    if (!on) return;
    const g = this.game, mode = g.mode;
    sb.classList.toggle('ffa', !mode.teams);
    sb.querySelector('.mname').textContent = `${mode.name} — ${g.level.name}`;
    sb.querySelector('.mtime').textContent = this.el.timer.textContent;
    const row = (a) => `<tr class="${a === g.player ? 'me' : ''} ${a.alive ? '' : 'dead'}"><td>${a.name}</td><td class="n">${a.stats.score}</td><td class="n">${a.stats.kills}</td><td class="n">${a.stats.deaths}</td><td class="n">${a.stats.assists}</td><td class="n">${(a.stats.kills / Math.max(1, a.stats.deaths)).toFixed(2)}</td><td class="n">${a.isPlayer ? '—' : a.ping}</td></tr>`;
    const head = '<tr><th>NAME</th><th class="n">SCORE</th><th class="n">K</th><th class="n">D</th><th class="n">A</th><th class="n">K/D</th><th class="n">PING</th></tr>';
    const sorted = [...g.actors].sort((a, b) => b.stats.score - a.stats.score);
    let html;
    if (mode.teams) {
      const t = (team, cls, label) => `<div class="${cls}"><h3><span>${label}</span><span>${mode.score[team]}</span></h3><table>${head}${sorted.filter((a) => a.team === team).map(row).join('')}</table></div>`;
      html = t(g.player.team, 'ta', 'FRIENDLY') + t(1 - g.player.team, 'tb', 'ENEMY');
    } else html = `<div><table>${head}${sorted.map(row).join('')}</table></div>`;
    sb.querySelector('.cols').innerHTML = html;
  }
}
