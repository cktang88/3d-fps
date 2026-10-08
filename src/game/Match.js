import * as THREE from 'three';
import { WEAPONS } from './weapons/WeaponDefs.js';

export const MODES = {
  tdm: { key: 'tdm', name: 'TEAM DEATHMATCH', teams: true, scoreLimit: 50, time: 600, teamSize: 6 },
  ffa: { key: 'ffa', name: 'FREE FOR ALL', teams: false, scoreLimit: 25, time: 600, players: 8 },
};

/** Match flow: team setup, spawns (CoD-style scoring), scoring, medals, streaks, end of match. */
export class Match {
  constructor(game) {
    this.game = game;
    this.state = 'idle';
    this.lastKillTimes = new Map();
    this.streak = 0;
  }

  start(key) {
    const g = this.game, def = MODES[key];
    const mode = g.mode;
    Object.assign(mode, { key, name: def.name, teams: def.teams, scoreLimit: def.scoreLimit, timeLeft: def.time, score: [0, 0], friendlyFire: false });
    // Clear old bots.
    for (const b of g.bots) { g.renderer.scene.remove(b.model.root); if (b.agent) g.nav.removeAgent(b.agent); }
    g.bots.length = 0;
    g.actors.length = 0;
    g.actors.push(g.player);
    g.player.team = 0;
    g.player.stats = { kills: 0, deaths: 0, assists: 0, score: 0 };
    const count = g.settings.botCount;
    if (def.teams) {
      const per = Math.max(1, Math.min(8, count));
      for (let i = 0; i < per - 1; i++) g.addBot(0);
      for (let i = 0; i < per; i++) g.addBot(1);
    } else {
      for (let i = 0; i < Math.max(1, count + 1); i++) g.addBot(10 + i); // unique teams
    }
    for (const b of g.bots) g.spawnBot(b);
    g.spawnPlayer();
    this.state = 'live';
    this.streak = 0;
    g.uavTime = 0;
    g.hud.banner(def.name, def.teams ? `FIRST TO ${def.scoreLimit} KILLS` : `FIRST TO ${def.scoreLimit} KILLS · EVERY OPERATOR FOR THEMSELVES`, 3.5);
  }

  update(dt) {
    if (this.state !== 'live') return;
    const g = this.game, mode = g.mode;
    mode.timeLeft -= dt;
    // Bot respawns.
    for (const b of g.bots) {
      if (!b.alive) {
        b.respawnTimer = (b.respawnTimer ?? 4) - dt;
        if (b.respawnTimer <= 0) { b.respawnTimer = 4; g.spawnBot(b); }
      }
    }
    if (mode.timeLeft <= 0) this.end();
  }

  /** Score spawn points: far from visible enemies, near teammates (TDM), not recently used. */
  pickSpawn(actor) {
    const g = this.game, lvl = g.level, mode = g.mode;
    let list = mode.teams ? lvl.spawns[actor.team === 0 ? 0 : 1] : lvl.spawns.ffa;
    // In TDM, allow mid-map spawns near teammates later in the match (flip resistance).
    if (mode.teams) list = list.concat(lvl.spawns.ffa);
    let best = null, bestS = -Infinity;
    for (const sp of list) {
      let s = Math.random() * 4;
      for (const a of g.actors) {
        if (!a.alive || a === actor) continue;
        const d = a.position.distanceTo(sp.pos);
        const enemy = !mode.teams || a.team !== actor.team;
        if (enemy) {
          if (d < 12) s -= 100;
          else s += Math.min(d, 45) * 0.6;
          if (d < 45 && g.physics.lineOfSight(sp.pos.clone().setY(1.6), a.head)) s -= 40;
        } else if (mode.teams && d < 25) s += 8;
      }
      if (mode.teams && lvl.spawns[actor.team === 0 ? 0 : 1].includes(sp)) s += 25;
      if (sp.lastUsed && g.time - sp.lastUsed < 5) s -= 30;
      if (s > bestS) { bestS = s; best = sp; }
    }
    best.lastUsed = g.time;
    // Small jitter so stacked spawns don't overlap.
    const pos = best.pos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 1.5, 0.05, (Math.random() - 0.5) * 1.5));
    return { pos, yaw: best.yaw };
  }

  onKill(victim, killer, info) {
    const g = this.game, mode = g.mode;
    victim.stats.deaths++;
    const weaponName = info.weapon ? WEAPONS[info.weapon]?.name : info.type === 'grenade' ? 'FRAG' : info.type === 'melee' ? 'MELEE' : info.type === 'fall' ? 'FALL' : '';
    if (killer && killer !== victim) {
      killer.stats.kills++;
      let pts = 100;
      if (info.headshot) pts += 25;
      if ((info.distance ?? 0) > 50) pts += 25;
      killer.stats.score += pts;
      if (mode.teams) mode.score[killer.team === 0 ? 0 : 1]++;
      // Assists.
      if (victim.damageLog) for (const [a, dmg] of victim.damageLog) if (a !== killer && dmg >= 30 && a.stats) { a.stats.assists++; a.stats.score += 25; if (a === g.player) g.hud.event('ASSIST', 25); }
      if (killer === g.player) {
        this.streak++;
        const now = g.time;
        const last = this.lastKillTimes.get(killer) ?? -99;
        this.lastKillTimes.set(killer, now);
        const multi = now - last < 4 ? (this._multi = (this._multi || 1) + 1) : (this._multi = 1);
        g.hud.event(info.headshot ? 'HEADSHOT KILL' : 'KILL', pts, 'kill');
        if ((info.distance ?? 0) > 50) g.hud.event(`LONGSHOT · ${Math.round(info.distance)}M`);
        if (multi === 2) g.hud.event('DOUBLE KILL', 50);
        if (multi === 3) g.hud.event('TRIPLE KILL', 75);
        if (multi >= 4) g.hud.event('MULTI KILL', 100);
        if (this.streak === 4) { g.uavTime = 30; g.hud.event('UAV ONLINE', 0); g.hud.banner('UAV ONLINE', 'ENEMY POSITIONS REVEALED', 2); }
        if (this.streak === 7) g.hud.event('7 KILL STREAK', 0);
        if (victim.lastAttacker === g.player && this.revengeTarget === victim) { g.hud.event('REVENGE', 25); this.revengeTarget = null; }
      }
    } else if (mode.teams && victim.team !== undefined) {
      // Suicide.
      victim.stats.score = Math.max(0, victim.stats.score - 50);
    }
    if (victim === g.player) { this.streak = 0; this.revengeTarget = killer; }
    g.hud.killfeed(killer && killer !== victim ? killer : null, victim, weaponName, info.headshot, killer === g.player || victim === g.player);
    // Victory check.
    const lim = mode.scoreLimit;
    if (mode.teams && (mode.score[0] >= lim || mode.score[1] >= lim)) this.end();
    if (!mode.teams && killer && killer.stats.kills >= lim) this.end();
  }

  end() {
    if (this.state !== 'live') return;
    this.state = 'ended';
    const g = this.game, mode = g.mode;
    let won;
    if (mode.teams) won = mode.score[g.player.team] > mode.score[1 - g.player.team] ? 'VICTORY' : mode.score[0] === mode.score[1] ? 'DRAW' : 'DEFEAT';
    else {
      const top = [...g.actors].sort((a, b) => b.stats.kills - a.stats.kills)[0];
      won = top === g.player ? 'VICTORY' : 'DEFEAT';
    }
    g.onMatchEnd?.(won);
  }
}
