import * as THREE from 'three';
import { G } from '../core/Physics.js';
import { rayCapsule, rayPointDistance, DEG } from '../core/MathUtil.js';

// Material penetration cost per metre of thickness (BF/CS style). Infinity = stops bullets.
const PEN_COST = { wood: 10, plaster: 8, metal: 30, glass: 2, concrete: Infinity, dirt: Infinity, brick: Infinity, foliage: 0.5, fabric: 2 };
const _dir = new THREE.Vector3();

/**
 * Projectile bullets with gravity drop + travel time. Each frame the segment travelled is
 * raycast against the static world (Rapier) and actor hitboxes (analytic capsules).
 * Supports penetration through thin wood/metal, damage falloff by distance, headshots,
 * near-miss whiz for the local player and suppression.
 */
export class Ballistics {
  constructor(game) {
    this.game = game;
    this.bullets = [];
  }

  /** Spawn a bullet. stats = weapon stats; dir = unit vector. */
  fire(owner, origin, dir, stats, opts = {}) {
    const vel = dir.clone().multiplyScalar(stats.velocity * (opts.velMul ?? 1));
    const b = {
      owner, stats, pos: origin.clone(), vel, travelled: 0, pen: stats.penetration, dmgMul: 1,
      pellet: opts.pellet ?? false, tracer: opts.tracer ?? false, whizzed: false, life: 0,
      tracerFrom: opts.tracerFrom || origin.clone(),
    };
    this.bullets.push(b);
    // Step once immediately so close-range hits are same-frame (feels hitscan up close).
    this._step(b, 1 / 60);
    return b;
  }

  update(dt) {
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      if (b.dead || !this._step(b, dt)) this.bullets.splice(i, 1);
    }
  }

  // Returns false if the bullet is finished.
  _step(b, dt) {
    if (b.dead) return false;
    b.life += dt;
    if (b.life > 2 || b.travelled > 700) return false;
    const start = b.pos.clone();
    b.vel.y -= 9.81 * dt;
    const step = b.vel.clone().multiplyScalar(dt);
    let remaining = step.length();
    const dir = step.divideScalar(remaining);
    let origin = start;
    let guard = 0;
    while (remaining > 0 && guard++ < 4) {
      const worldHit = this.game.physics.raycast(origin, dir, remaining, G.WORLD);
      const maxD = worldHit ? worldHit.distance : remaining;
      const actorHit = this._hitActors(b, origin, dir, maxD);
      this._whiz(b, origin, dir, maxD);
      if (actorHit) {
        this._applyActorHit(b, actorHit, dir);
        b.dead = true;
        this._finishTracer(b, actorHit.point);
        return false;
      }
      if (!worldHit) { b.travelled += remaining; origin = origin.clone().addScaledVector(dir, remaining); break; }
      b.travelled += worldHit.distance;
      const surface = worldHit.data.surface || 'concrete';
      this.game.onBulletImpact(worldHit.point, worldHit.normal, surface, dir, b);
      // Penetration.
      const cost = PEN_COST[surface] ?? Infinity;
      if (!isFinite(cost) || b.pellet) { b.dead = true; this._finishTracer(b, worldHit.point); return false; }
      const exit = this._findExit(worldHit, dir, 0.6);
      if (!exit) { b.dead = true; this._finishTracer(b, worldHit.point); return false; }
      const thick = exit.distanceTo(worldHit.point);
      const spend = cost * thick;
      if (spend > b.pen) { b.dead = true; this._finishTracer(b, worldHit.point); return false; }
      b.pen -= spend;
      b.dmgMul *= Math.max(0.2, 1 - 0.25 * spend);
      this.game.onBulletImpact(exit, dir.clone(), surface, dir, b, true);
      const used = worldHit.distance + thick + 0.01;
      remaining -= used;
      origin = exit.clone().addScaledVector(dir, 0.01);
    }
    b.pos.copy(origin);
    if (b.tracer && !b.tracerSpawned) {
      // Tracers are emitted once along an extrapolated path for cheapness.
      b.tracerSpawned = true;
      const end = this._predictEnd(b);
      this.game.effects.tracer(b.tracerFrom, end, Math.min(b.stats.velocity, 700));
    }
    return true;
  }

  _finishTracer(b, point) {
    if (b.tracer && !b.tracerSpawned) {
      b.tracerSpawned = true;
      this.game.effects.tracer(b.tracerFrom, point, Math.min(b.stats.velocity, 700));
    }
  }

  _predictEnd(b) {
    const d = b.vel.clone().normalize();
    const hit = this.game.physics.raycast(b.pos, d, 300, G.WORLD);
    return hit ? hit.point : b.pos.clone().addScaledVector(d, 300);
  }

  _findExit(hit, dir, maxThick) {
    // Cast back from beyond the surface to find the exit face.
    const far = hit.point.clone().addScaledVector(dir, maxThick);
    const back = this.game.physics.raycast(far, dir.clone().negate(), maxThick - 0.005, G.WORLD);
    if (!back) return hit.point.clone().addScaledVector(dir, 0.02);
    // Ensure we're on the same collider, otherwise it's something else behind.
    if (back.collider !== hit.collider) return null;
    return back.point;
  }

  _hitActors(b, origin, dir, maxD) {
    let best = null;
    for (const actor of this.game.actors) {
      if (!actor.alive || actor === b.owner) continue;
      if (this.game.mode.friendlyFire === false && b.owner && actor.team === b.owner.team && this.game.mode.teams) continue;
      // Broad phase: bounding sphere.
      const c = actor.center;
      const { dist, t } = rayPointDistance(origin, dir, c);
      if (dist > 1.4 || t > maxD + 1.4) continue;
      for (const hb of actor.getHitboxes()) {
        const d = rayCapsule(origin, dir, hb.a, hb.b, hb.r);
        if (d >= 0 && d <= maxD && (!best || d < best.distance)) {
          best = { actor, hitbox: hb, distance: d, point: origin.clone().addScaledVector(dir, d) };
        }
      }
    }
    return best;
  }

  _applyActorHit(b, hit, dir) {
    const s = b.stats;
    const dist = b.travelled + hit.distance;
    const [near, far] = s.range;
    const [dMax, dMin] = s.damage;
    let dmg = dist <= near ? dMax : dist >= far ? dMin : dMax + (dMin - dMax) * ((dist - near) / (far - near));
    let mult = hit.hitbox.mult;
    if (hit.hitbox.part === 'head') mult = s.headMult;
    else if (hit.hitbox.part === 'legs' || hit.hitbox.part === 'arms') mult = s.legMult ?? 0.85;
    dmg *= mult * b.dmgMul;
    dmg = Math.round(dmg);
    this.game.effects.impact(hit.point, dir.clone().negate(), 'flesh', dir);
    this.game.onActorHit(hit.actor, dmg, b.owner, {
      part: hit.hitbox.part, point: hit.point, dir: dir.clone(), weapon: s.id, distance: dist, headshot: hit.hitbox.part === 'head',
    });
  }

  _whiz(b, origin, dir, maxD) {
    const p = this.game.player;
    if (b.whizzed || !p.alive || b.owner === p) return;
    const head = p.head;
    const { dist, t } = rayPointDistance(origin, dir, head);
    if (t > 0 && t < maxD && dist < 2.2) {
      b.whizzed = true;
      const pos = origin.clone().addScaledVector(dir, t);
      this.game.audio.whiz(pos);
      this.game.onSuppressed?.(1 - dist / 2.2);
    }
    // Bots get suppressed too.
    for (const bot of this.game.bots) {
      if (!bot.alive || bot === b.owner || bot.team === b.owner?.team) continue;
      const r = rayPointDistance(origin, dir, bot.head);
      if (r.t > 0 && r.t < maxD && r.dist < 2.5) bot.onSuppressed?.(b.owner, 1 - r.dist / 2.5);
    }
  }
}

/** Apply a random cone spread (degrees, half-angle) to a direction. */
export function applySpread(dir, spreadDeg, out = new THREE.Vector3()) {
  if (spreadDeg <= 0) return out.copy(dir);
  // Uniform disc sample (sqrt for uniform area) -> slightly centre-weighted with pow.
  const r = Math.tan(spreadDeg * DEG) * Math.pow(Math.random(), 0.65);
  const a = Math.random() * Math.PI * 2;
  const up = Math.abs(dir.y) > 0.99 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const right = _dir.crossVectors(dir, up).normalize();
  const up2 = new THREE.Vector3().crossVectors(right, dir).normalize();
  out.copy(dir).addScaledVector(right, Math.cos(a) * r).addScaledVector(up2, Math.sin(a) * r).normalize();
  return out;
}
