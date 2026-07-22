/**
 * Enemy auto-attack: discover player in range, 1s ready delay, 1 shot/s
 * with distance / accuracy miss. Chases when out of shooting range.
 */
import {
  hitscanWorld,
  rayHitPlayer,
  shotBodyOrigin,
  clampedMuzzle,
} from './shooting.js';
import { slideXZ } from './collision.js';

/** Enemy discover / aim / shot range (slightly beyond player MAX_SHOOT_RANGE 18). */
const ENEMY_MAX_RANGE = 20;
const DISCOVER_RANGE = ENEMY_MAX_RANGE;
const READY_DELAY = 1.0;
const FIRE_INTERVAL = 1.0;
const CHASE_SPEED = 2.6;
/** Stop chasing / start shooting inside this radius (meters). */
const CHASE_STOP_DIST = ENEMY_MAX_RANGE * 0.82;
const MUZZLE_HEIGHT = 1.35;
const MUZZLE_FORWARD = 0.35;
const PLAYER_CHEST = 1.15;
/** Fraction of shots that stay on target (rest spray wide). */
const ENEMY_ACCURACY = 0.5;
/** Angular error on missed shots (radians). */
const MISS_SPREAD = 0.32;
/** Must roughly face player to shoot (after turning). */
const SHOOT_FACE_DOT = 0.82;

function ensureCombat(e) {
  if (!e.combat) {
    e.combat = {
      alerted: false,
      readyTimer: 0,
      cooldown: 0,
    };
  }
  return e.combat;
}

function enemyPos(e) {
  if (e.root) {
    return { x: e.root.position.x, y: e.root.position.y, z: e.root.position.z };
  }
  return { x: e.x, y: e.y, z: e.z };
}

function syncEnemy(e, pos) {
  e.x = pos.x;
  e.y = pos.y;
  e.z = pos.z;
  if (e.root) {
    e.root.position.x = pos.x;
    e.root.position.y = pos.y;
    e.root.position.z = pos.z;
  }
}

function enemyForward(yaw) {
  return { x: -Math.sin(yaw), z: -Math.cos(yaw) };
}

function yawTo(dx, dz) {
  return Math.atan2(-dx, -dz);
}

function turnEnemyToward(e, yaw, snap = false) {
  e.yaw = yaw;
  if (e.root) {
    if (snap) e.root.rotation.y = yaw;
    else {
      let d = yaw - e.root.rotation.y;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      e.root.rotation.y += d * 0.22;
      e.yaw = e.root.rotation.y;
    }
  }
}

/**
 * @param {{
 *   getEnemies: () => any[],
 *   getSolids: () => any[],
 *   getPlayer: () => {x:number,y:number,z:number, stance?: string},
 *   shotSystem: { addShot: Function },
 *   onPlayerHit?: (damage: number) => void,
 * }} opts
 */
export class EnemyCombat {
  constructor(opts) {
    this.getEnemies = opts.getEnemies;
    this.getSolids = opts.getSolids;
    this.getPlayer = opts.getPlayer;
    this.shotSystem = opts.shotSystem;
    this.onPlayerHit = opts.onPlayerHit ?? null;
    this.enabled = true;
  }

  update(dt) {
    if (!this.enabled || !this.shotSystem) return;
    if (dt > 0.05) dt = 0.05;

    const player = this.getPlayer?.();
    if (!player) return;
    const enemies = this.getEnemies?.() || [];
    const solids = this.getSolids?.() || [];

    for (const e of enemies) {
      const c = ensureCombat(e);
      const pos = enemyPos(e);
      const dx = player.x - pos.x;
      const dz = player.z - pos.z;
      const distXZ = Math.hypot(dx, dz);
      if (distXZ < 1e-4) continue;

      const toX = dx / distXZ;
      const toZ = dz / distXZ;
      const wantYaw = yawTo(dx, dz);

      if (!c.alerted) {
        if (distXZ <= DISCOVER_RANGE) {
          c.alerted = true;
          c.readyTimer = READY_DELAY;
          c.cooldown = 0;
          turnEnemyToward(e, wantYaw, true);
        }
        continue;
      }

      if (distXZ > DISCOVER_RANGE * 1.65) {
        c.alerted = false;
        c.readyTimer = 0;
        continue;
      }

      // Track player — turn every frame while engaged.
      turnEnemyToward(e, wantYaw, false);

      const fwd = enemyForward(e.yaw);
      const facingDot = fwd.x * toX + fwd.z * toZ;

      // Chase when too far to shoot reliably (slide against boxes).
      if (distXZ > CHASE_STOP_DIST) {
        const step = Math.min(CHASE_SPEED * dt, distXZ - CHASE_STOP_DIST);
        const moved = slideXZ(pos, toX * step, toZ * step, solids);
        syncEnemy(e, moved);
      }

      const canShoot =
        distXZ <= ENEMY_MAX_RANGE &&
        facingDot >= SHOOT_FACE_DOT &&
        this._hasLos(e, player, solids);

      if (!canShoot) continue;

      if (c.readyTimer > 0) {
        c.readyTimer -= dt;
        continue;
      }

      c.cooldown -= dt;
      if (c.cooldown <= 0) {
        this._shoot(e, player, solids, distXZ);
        c.cooldown = FIRE_INTERVAL;
      }
    }
  }

  _hasLos(e, player, solids) {
    const pos = enemyPos(e);
    const origin = shotBodyOrigin(pos, MUZZLE_HEIGHT);
    const target = {
      x: player.x,
      y: player.y + PLAYER_CHEST,
      z: player.z,
    };
    const dx = target.x - origin.x;
    const dy = target.y - origin.y;
    const dz = target.z - origin.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) return true;
    const dir = { x: dx / len, y: dy / len, z: dz / len };
    const world = hitscanWorld(origin, dir, solids, len - 0.08);
    return !world.hit;
  }

  _shoot(e, player, solids, distXZ) {
    const pos = enemyPos(e);
    const body = shotBodyOrigin(pos, MUZZLE_HEIGHT);
    const target = {
      x: player.x,
      y: player.y + PLAYER_CHEST,
      z: player.z,
    };

    let dx = target.x - body.x;
    let dy = target.y - body.y;
    let dz = target.z - body.z;
    let len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) return;
    let dir = { x: dx / len, y: dy / len, z: dz / len };

    // 50% accurate — missed shots spray off target.
    if (Math.random() > ENEMY_ACCURACY) {
      const yawJitter = (Math.random() - 0.5) * 2 * MISS_SPREAD;
      const pitchJitter = (Math.random() - 0.5) * 2 * MISS_SPREAD;
      dir = applySpread(dir, yawJitter, pitchJitter);
    }

    const maxDist = Math.min(ENEMY_MAX_RANGE, Math.max(len + 4, 6));
    const world = hitscanWorld(body, dir, solids, maxDist);
    const playerT = rayHitPlayer(body, dir, player, maxDist);
    const muzzle = clampedMuzzle(body, dir, solids, MUZZLE_FORWARD);

    let end = world.hit
      ? world.point
      : {
          x: body.x + dir.x * maxDist,
          y: body.y + dir.y * maxDist,
          z: body.z + dir.z * maxDist,
        };
    let hitPlayer = false;

    if (playerT !== null && (!world.hit || playerT < world.t)) {
      end = {
        x: body.x + dir.x * playerT,
        y: body.y + dir.y * playerT,
        z: body.z + dir.z * playerT,
      };
      hitPlayer = true;
    }

    this.shotSystem.addShot(muzzle, end, hitPlayer || world.hit, hitPlayer, true);

    if (hitPlayer && typeof this.onPlayerHit === 'function') {
      const damage = Math.max(6, Math.round(14 - distXZ * 0.35));
      this.onPlayerHit(damage);
    }
  }
}

function applySpread(dir, yaw, pitch) {
  const up = Math.abs(dir.y) < 0.95 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const rx = up.y * dir.z - up.z * dir.y;
  const ry = up.z * dir.x - up.x * dir.z;
  const rz = up.x * dir.y - up.y * dir.x;
  const rLen = Math.hypot(rx, ry, rz) || 1;
  const right = { x: rx / rLen, y: ry / rLen, z: rz / rLen };
  const ux = dir.y * right.z - dir.z * right.y;
  const uy = dir.z * right.x - dir.x * right.z;
  const uz = dir.x * right.y - dir.y * right.x;

  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);

  let x = dir.x * cy + right.x * sy;
  let y = dir.y * cy + right.y * sy;
  let z = dir.z * cy + right.z * sy;
  x = x * cp + ux * sp;
  y = y * cp + uy * sp;
  z = z * cp + uz * sp;
  const len = Math.hypot(x, y, z) || 1;
  return { x: x / len, y: y / len, z: z / len };
}
