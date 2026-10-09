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
    this.combat = []; // recent kill sites { pos, t } — spawn selection keeps away from live fights
    this.streak = 0;
  }

  start(key) {
    const g = this.game, def = MODES[key];
    const mode = g.mode;
    Object.assign(mode, { key, name: def.name, teams: def.teams, scoreLimit: def.scoreLimit, timeLeft: def.time, score: [0, 0], friendlyFire: false });
    // Clear old bots.
    for (const b of g.bots) { g.renderer.scene.remove(b.model.root); if (b.spareModel) { g.renderer.scene.remove(b.spareModel.root); b.spareModel.weaponObj?.parent?.remove(b.spareModel.weaponObj); } b.model.weaponObj?.parent?.remove(b.model.weaponObj); if (b.agent) g.nav.removeAgent(b.agent); }
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
    this.firstBlood = false;
    this._warned = false;
    this._multi = 0;
    this.revengeTarget = null;
    this.lastKillTimes.clear();
    for (const a of g.actors) a._streak = 0;
    g.matchStats = g.constructor.freshStats();
    g.uavTime = 0;
    g.hud.reset?.();
    g.hud.banner(def.name, def.teams ? `${g.bots.filter((b) => b.team === 1).length}v${g.bots.filter((b) => b.team === 1).length} · FIRST TO ${def.scoreLimit} KILLS` : `FIRST TO ${def.scoreLimit} KILLS · EVERY OPERATOR FOR THEMSELVES`, 3.5);
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

  /**
   * Score spawn points (CoD/BF-style safety): never in an enemy's line of sight (any range), never next to an
   * enemy, away from fights of the last ~10 s; prefer own base and teammates (TDM), avoid reusing a point.
   */
  pickSpawn(actor) {
    const g = this.game, lvl = g.level, mode = g.mode;
    const own = mode.teams ? lvl.spawns[actor.team === 0 ? 0 : 1] : null;
    let list = mode.teams ? own : lvl.spawns.ffa;
    // In TDM, allow mid-map spawns near teammates later in the match (flip resistance).
    if (mode.teams) list = list.concat(lvl.spawns.ffa);
    this.combat = this.combat.filter((c) => g.time - c.t < 10);
    const eye = new THREE.Vector3();
    let best = null, bestS = -Infinity;
    for (const sp of list) {
      let s = Math.random() * 4;
      eye.copy(sp.pos).setY(sp.pos.y + 1.6);
      for (const a of g.actors) {
        if (!a.alive || a === actor) continue;
        const d = a.position.distanceTo(sp.pos);
        const enemy = !mode.teams || a.team !== actor.team;
        if (enemy) {
          if (d < 12) s -= 120;
          else if (d < 25) s -= 25;
          s += Math.min(d, 50) * 0.5;
          if (d < 110 && g.physics.lineOfSight(eye, a.head)) s -= d < 60 ? 160 : 90;
        } else if (mode.teams && d < 25) s += 8;
      }
      for (const c of this.combat) {
        const d = c.pos.distanceTo(sp.pos);
        if (d < 22) s -= 45 * (1 - (g.time - c.t) / 10) * (1 - d / 22);
      }
      if (own && own.includes(sp)) s += 25;
      if (sp.lastUsed && g.time - sp.lastUsed < 5) s -= 30;
      if (s > bestS) { bestS = s; best = sp; }
    }
    best.lastUsed = g.time;
    actor.spawnTime = g.time;
    // Small jitter so stacked spawns don't overlap.
    const pos = best.pos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 1.5, 0.05, (Math.random() - 0.5) * 1.5));
    return { pos, yaw: best.yaw };
  }

  onKill(victim, killer, info) {
    const g = this.game, mode = g.mode, hud = g.hud;
    victim.stats.deaths++;
    const weaponName = info.weapon ? (WEAPONS[info.weapon]?.name ?? info.weapon) : info.type === 'grenade' ? 'FRAG' : info.type === 'melee' ? 'MELEE' : info.type === 'fall' ? 'FALL' : '';
    const victimStreak = victim._streak || 0;
    this.combat.push({ pos: victim.position.clone(), t: this.game.time });
    if (killer && killer !== victim && killer.position) this.combat.push({ pos: killer.position.clone(), t: this.game.time });
    victim._streak = 0;
    const isFirstBlood = !this.firstBlood && killer && killer !== victim;
    if (isFirstBlood) this.firstBlood = true;
    if (killer && killer !== victim) {
      killer.stats.kills++;
      killer._streak = (killer._streak || 0) + 1;
      // Score lines (CoD-style tally): base + bonuses.
      const lines = [['ENEMY KILLED', 100]];
      if (info.headshot) lines.push(['HEADSHOT', 25]);
      if ((info.distance ?? 0) > 50) lines.push([`LONGSHOT ${Math.round(info.distance)}M`, 25]);
      if (info.type === 'melee') lines.push(['MELEE', 25]);
      if (victimStreak >= 3) lines.push(['BUZZKILL', 50]);
      if (isFirstBlood) lines.push(['FIRST BLOOD', 50]);
      // Assists.
      if (victim.damageLog) for (const [a, dmg] of victim.damageLog) if (a !== killer && dmg >= 30 && a.stats) { a.stats.assists++; a.stats.score += 25; if (a === g.player) hud.score('ASSIST', 25); }
      if (killer === g.player) {
        this.streak++;
        const ms = g.matchStats;
        ms.bestStreak = Math.max(ms.bestStreak, this.streak);
        const now = g.time;
        const last = this.lastKillTimes.get(killer) ?? -99;
        this.lastKillTimes.set(killer, now);
        this._multi = now - last < 4 ? (this._multi || 1) + 1 : 1;
        const medals = [];
        if (this._multi === 2) { lines.push(['DOUBLE KILL', 50]); medals.push('double'); }
        if (this._multi === 3) { lines.push(['TRIPLE KILL', 75]); medals.push('triple'); }
        if (this._multi >= 4) { lines.push(['MULTI KILL', 100]); medals.push('multi'); }
        if (info.headshot) medals.push('headshot');
        if ((info.distance ?? 0) > 50) medals.push('longshot');
        if (info.type === 'melee') medals.push('melee');
        if (info.type === 'grenade') medals.push('frag');
        if (victimStreak >= 3) medals.push('buzzkill');
        if (isFirstBlood) medals.push('firstblood');
        if (this.revengeTarget === victim) { lines.push(['REVENGE', 25]); medals.push('revenge'); this.revengeTarget = null; }
        if (this.streak === 3) medals.push('streak3');
        if (this.streak === 5) medals.push('streak5');
        if (this.streak === 10) medals.push('streak10');
        const pts = lines.reduce((t, l) => t + l[1], 0);
        killer.stats.score += pts;
        for (const [txt, p] of lines) hud.score(txt, p);
        for (const m of medals) { hud.medal(m); ms.medals[m] = (ms.medals[m] || 0) + 1; }
        hud.killConfirm(victim, info.headshot);
        hud.streak(this.streak);
        if (this.streak === 4) {
          g.uavTime = 30;
          g.audio.ui('streak');
          hud.banner('UAV ONLINE', 'ENEMY POSITIONS REVEALED · 30s', 2.4, 'ally');
        }
      } else {
        killer.stats.score += lines.reduce((t, l) => t + l[1], 0);
      }
      if (mode.teams) mode.score[killer.team === 0 ? 0 : 1]++;
    } else {
      // Suicide / environment.
      victim.stats.score = Math.max(0, victim.stats.score - 50);
    }
    if (victim === g.player) { this.streak = 0; hud.streak(0); this.revengeTarget = killer && killer !== victim ? killer : null; }
    hud.killfeed(killer && killer !== victim ? killer : null, victim, weaponName, info.headshot, killer === g.player || victim === g.player, info.type);
    // Score-limit warnings + victory check.
    const lim = mode.scoreLimit;
    if (mode.teams) {
      const mine = mode.score[g.player.team === 0 ? 0 : 1], theirs = mode.score[g.player.team === 0 ? 1 : 0];
      if (!this._warned && Math.max(mine, theirs) === lim - 5) { this._warned = true; hud.banner(mine > theirs ? 'WINNING' : 'LOSING', `${lim - Math.max(mine, theirs)} KILLS REMAIN`, 2, mine > theirs ? 'ally' : 'enemy'); }
    }
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
