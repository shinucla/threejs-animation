/**
 * Aim marker + hitscan tracers. Aim comes from a screen ray (mouse or reticle).
 */
import * as THREE from 'three';

const FIRE_INTERVAL = 1 / 5;
const TRACER_LIFE = 0.12;
const MARK_LIFE = 0.35;
const ENEMY_RADIUS = 0.4;
const ENEMY_HEIGHT = 1.8;
/** Max aim + shot range along the screen ray (meters). */
export const MAX_SHOOT_RANGE = 18;
/** Muzzle / fire origin height (meters above feet). */
const MUZZLE_HEIGHT = 1.25;
const MUZZLE_FORWARD = 0.4;
const GROUND_Y = 0;
/** NDC Y for RMB reticle — horizontally centered, higher in the upper view. */
export const RMB_AIM_NDC_Y = 0.35;

/** Screen-space client position of the RMB aim reticle on `dom`. */
export function rmbAimClientPoint(dom) {
  const rect = dom.getBoundingClientRect();
  return {
    x: rect.left + rect.width * 0.5,
    y: rect.top + rect.height * (1 - RMB_AIM_NDC_Y) * 0.5,
  };
}

/**
 * Shiny aim dot driven by a camera screen ray.
 * - no buttons: follow mouse pointer
 * - RMB: snap to upper-center reticle
 * - LMB only: hold last aim while orbiting
 * Dot sits on the first LOS hit (ground / boxes / enemies), else on the
 * MAX_SHOOT_RANGE sphere along the aim ray.
 */
export class AimTarget {
  /**
   * @param {THREE.Scene} scene
   * @param {{ getSolids?: () => any[], getEnemies?: () => any[] }} [opts]
   */
  constructor(scene, opts = {}) {
    this.getSolids = opts.getSolids ?? (() => []);
    this.getEnemies = opts.getEnemies ?? (() => []);
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 20, 20),
      new THREE.MeshStandardMaterial({
        color: 0xfff0a8,
        emissive: 0xffcc33,
        emissiveIntensity: 2.8,
        metalness: 0.85,
        roughness: 0.12,
      }),
    );
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 16, 16),
      new THREE.MeshBasicMaterial({
        color: 0xffe066,
        transparent: true,
        opacity: 0.4,
        depthWrite: false,
      }),
    );
    core.add(halo);
    this.mesh = core;
    this._mat = core.material;
    this._t = 0;
    this._raycaster = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    /** @type {{x:number,y:number,z:number}} */
    this.aimDir = { x: 0, y: 0, z: 1 };
    this._hasAim = false;
    scene.add(this.mesh);
  }

  setVisible(v) {
    this.mesh.visible = !!v;
  }

  getAimDirection() {
    return this.aimDir;
  }

  /** World-space aim point (the shiny dot). */
  getAimPoint() {
    return {
      x: this.mesh.position.x,
      y: this.mesh.position.y,
      z: this.mesh.position.z,
    };
  }

  /**
   * @param {THREE.Camera} camera
   * @param {HTMLElement} dom
   * @param {{x:number,y:number,z:number}} _playerPos unused (kept for call-site compat)
   * @param {{ lmb: boolean, rmb: boolean, pointerX: number, pointerY: number }} pointer
   * @param {number} dt
   */
  updateFromScreen(camera, dom, _playerPos, pointer, dt = 0) {
    this._t += dt;

    const rect = dom.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;

    let clientX;
    let clientY;
    let freeze = false;

    if (pointer.rmb) {
      // Upper center of the canvas (NDC y = +RMB_AIM_NDC_Y).
      clientX = rect.left + rect.width * 0.5;
      clientY = rect.top + rect.height * (1 - RMB_AIM_NDC_Y) * 0.5;
    } else if (pointer.lmb) {
      // Hold last aim while LMB orbiting.
      freeze = this._hasAim;
      clientX = pointer.pointerX;
      clientY = pointer.pointerY;
    } else {
      clientX = pointer.pointerX;
      clientY = pointer.pointerY;
    }

    if (!freeze) {
      this._ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      this._ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      this._raycaster.setFromCamera(this._ndc, camera);
      const origin = this._raycaster.ray.origin;
      const dir = this._raycaster.ray.direction;

      this.aimDir = { x: dir.x, y: dir.y, z: dir.z };
      this._hasAim = true;

      const rayOrigin = { x: origin.x, y: origin.y, z: origin.z };
      const rayDir = { x: dir.x, y: dir.y, z: dir.z };
      // Hitscan: first surface within MAX_SHOOT_RANGE, else point on the max-range sphere.
      const res = hitscan(
        rayOrigin,
        rayDir,
        this.getSolids(),
        this.getEnemies(),
        MAX_SHOOT_RANGE,
      );
      this.mesh.position.set(res.point.x, res.point.y, res.point.z);
    }

    this._mat.emissiveIntensity = 2.2 + Math.sin(this._t * 6) * 0.7;
  }
}

export class ShotSystem {
  /**
   * @param {THREE.Scene} scene
   * @param {{ getSolids?: () => any[], getEnemies?: () => any[], onEnemyHit?: (i:number) => void }} opts
   */
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.getSolids = opts.getSolids ?? (() => []);
    this.getEnemies = opts.getEnemies ?? (() => []);
    this.onEnemyHit = opts.onEnemyHit ?? null;
    this.cooldown = 0;
    this.tracers = [];
    this.marks = [];
    this._group = new THREE.Group();
    scene.add(this._group);
  }

  setVisible(v) {
    this._group.visible = !!v;
  }

  /**
   * Spawn a tracer (player or enemy). Optional impact mark.
   * @param {{x:number,y:number,z:number}} from
   * @param {{x:number,y:number,z:number}} to
   * @param {boolean} hit
   * @param {boolean} [kill]
   */
  addShot(from, to, hit, kill = false, enemy = false) {
    this._addTracer(from, to, hit, enemy);
    if (hit) this._addMark(to, kill);
  }

  /**
   * @param {number} dt
   * @param {{ firing: boolean, position: {x:number,y:number,z:number}, aimPoint: {x:number,y:number,z:number} }} state
   */
  update(dt, state) {
    this._ageFx(dt);

    if (!state?.firing) {
      this.cooldown = 0;
      return;
    }

    this.cooldown -= dt;
    if (this.cooldown <= 0) {
      this._fire(state.position, state.aimPoint);
      this.cooldown = FIRE_INTERVAL;
    }
  }

  /**
   * Fire along the free 3D path to the aim point (same freedom as the aim ray).
   * Tracer always seeks the aim dot; only stops early if something sits strictly
   * between muzzle and aim along that segment.
   */
  _fire(pos, aimPoint) {
    if (!aimPoint) return;

    const solids = this.getSolids() || [];
    const enemies = this.getEnemies() || [];
    const origin = shotBodyOrigin(pos, MUZZLE_HEIGHT);

    const dx = aimPoint.x - origin.x;
    const dy = aimPoint.y - origin.y;
    const dz = aimPoint.z - origin.z;
    const aimDist = Math.hypot(dx, dy, dz);
    if (aimDist < 1e-4) return;
    const dir = { x: dx / aimDist, y: dy / aimDist, z: dz / aimDist };
    const muzzle = clampedMuzzle(origin, dir, solids);

    const eps = 0.1;
    const hit = hitscan(origin, dir, solids, enemies, aimDist + eps);

    // Blocker strictly before the aim point → stop on it.
    if (hit.hit && hit.t < aimDist - eps) {
      this._addTracer(muzzle, hit.point, true);
      this._addMark(hit.point, hit.enemyIndex >= 0);
      if (hit.enemyIndex >= 0 && typeof this.onEnemyHit === 'function') {
        this.onEnemyHit(hit.enemyIndex);
      }
      return;
    }

    // Path reaches the aim dot (clear air, or aim sits on the hit surface).
    this._addTracer(muzzle, aimPoint, !!hit.hit);
    if (hit.hit && hit.enemyIndex >= 0) {
      this._addMark(aimPoint, true);
      if (typeof this.onEnemyHit === 'function') this.onEnemyHit(hit.enemyIndex);
    } else if (hit.hit) {
      this._addMark(aimPoint, false);
    }
  }

  _addTracer(from, to, hit, enemy = false) {
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(from.x, from.y, from.z),
      new THREE.Vector3(to.x, to.y, to.z),
    ]);
    const line = new THREE.Line(
      geo,
      new THREE.LineBasicMaterial({
        color: enemy ? (hit ? 0xff5544 : 0xff9988) : hit ? 0xffcc55 : 0xffe899,
        transparent: true,
        opacity: 1,
      }),
    );
    this._group.add(line);
    this.tracers.push({ line, age: 0 });
  }

  _addMark(pos, kill) {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(kill ? 0.12 : 0.07, 10, 10),
      new THREE.MeshBasicMaterial({
        color: kill ? 0xff6644 : 0xffaa44,
        transparent: true,
        opacity: 0.95,
      }),
    );
    mesh.position.set(pos.x, pos.y, pos.z);
    this._group.add(mesh);
    this.marks.push({ mesh, age: 0 });
  }

  _ageFx(dt) {
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.age += dt;
      const a = 1 - t.age / TRACER_LIFE;
      if (a <= 0) {
        this._group.remove(t.line);
        t.line.geometry.dispose();
        t.line.material.dispose();
        this.tracers.splice(i, 1);
      } else {
        t.line.material.opacity = a;
      }
    }
    for (let i = this.marks.length - 1; i >= 0; i--) {
      const m = this.marks[i];
      m.age += dt;
      const a = 1 - m.age / MARK_LIFE;
      if (a <= 0) {
        this._group.remove(m.mesh);
        m.mesh.geometry.dispose();
        m.mesh.material.dispose();
        this.marks.splice(i, 1);
      } else {
        m.mesh.material.opacity = a;
        m.mesh.scale.setScalar(1 + (1 - a) * 0.8);
      }
    }
  }
}

/**
 * Hitscan: enemies, then solid AABBs, then ground y=0.
 * Solids block even when the ray starts inside a box (t = 0).
 * @returns {{ hit: boolean, point: {x:number,y:number,z:number}, enemyIndex: number, t: number }}
 */
export function hitscan(origin, dir, solids, enemies, maxDist) {
  let bestT = maxDist;
  let hit = false;
  let enemyIndex = -1;
  let point = {
    x: origin.x + dir.x * maxDist,
    y: origin.y + dir.y * maxDist,
    z: origin.z + dir.z * maxDist,
  };

  for (let i = 0; i < (enemies?.length || 0); i++) {
    const e = enemies[i];
    const min = {
      x: e.x - ENEMY_RADIUS,
      y: e.y,
      z: e.z - ENEMY_RADIUS,
    };
    const max = {
      x: e.x + ENEMY_RADIUS,
      y: e.y + ENEMY_HEIGHT,
      z: e.z + ENEMY_RADIUS,
    };
    const t = rayAABB(origin, dir, min, max);
    // Tiny epsilon so we don't self-hit at the muzzle.
    if (t !== null && t < bestT && t > 1e-4) {
      bestT = t;
      hit = true;
      enemyIndex = i;
      point = {
        x: origin.x + dir.x * t,
        y: origin.y + dir.y * t,
        z: origin.z + dir.z * t,
      };
    }
  }

  for (const box of solids || []) {
    const t = rayAABB(origin, dir, box.min, box.max);
    // Include t === 0 when the ray starts inside a box (blocks pass-through).
    if (t !== null && t < bestT && t >= 0) {
      bestT = t;
      hit = true;
      enemyIndex = -1;
      point = {
        x: origin.x + dir.x * t,
        y: origin.y + dir.y * t,
        z: origin.z + dir.z * t,
      };
    }
  }

  if (Math.abs(dir.y) > 1e-8) {
    const t = (GROUND_Y - origin.y) / dir.y;
    if (t > 1e-4 && t < bestT) {
      bestT = t;
      hit = true;
      enemyIndex = -1;
      point = {
        x: origin.x + dir.x * t,
        y: GROUND_Y,
        z: origin.z + dir.z * t,
      };
    }
  }

  return { hit, point, enemyIndex, t: bestT };
}

/**
 * World blockers only (boxes + ground) — used for LOS / enemy shots.
 * @returns {{ hit: boolean, point: {x:number,y:number,z:number}, t: number }}
 */
export function hitscanWorld(origin, dir, solids, maxDist) {
  const res = hitscan(origin, dir, solids, [], maxDist);
  return { hit: res.hit, point: res.point, t: res.t };
}

/** Expand solid AABBs (camera collision / near-touch padding). */
export function inflateSolids(solids, pad = 0.06) {
  if (!solids?.length) return [];
  return solids.map((b) => ({
    min: { x: b.min.x - pad, y: b.min.y - pad, z: b.min.z - pad },
    max: { x: b.max.x + pad, y: b.max.y + pad, z: b.max.z + pad },
  }));
}

/**
 * Fire origin at the actor feet + height (no forward offset).
 */
export function shotBodyOrigin(pos, height = MUZZLE_HEIGHT) {
  return { x: pos.x, y: pos.y + height, z: pos.z };
}

/**
 * Visual muzzle along aim dir, clamped so it never starts past / inside a box.
 */
export function clampedMuzzle(bodyOrigin, dir, solids, forward = MUZZLE_FORWARD) {
  const world = hitscanWorld(bodyOrigin, dir, solids || [], forward + 0.05);
  if (world.hit && world.t <= forward) {
    const t = Math.max(0, world.t - 0.02);
    return {
      x: bodyOrigin.x + dir.x * t,
      y: bodyOrigin.y + dir.y * t,
      z: bodyOrigin.z + dir.z * t,
    };
  }
  const m = {
    x: bodyOrigin.x + dir.x * forward,
    y: bodyOrigin.y + dir.y * forward,
    z: bodyOrigin.z + dir.z * forward,
  };
  if (pointInSolids(m, solids)) return { ...bodyOrigin };
  return m;
}

/**
 * Player body AABB along a ray.
 * @returns {number|null} hit distance or null
 */
export function rayHitPlayer(origin, dir, playerPos, maxDist) {
  const stanceScale = 1;
  const min = {
    x: playerPos.x - ENEMY_RADIUS,
    y: playerPos.y,
    z: playerPos.z - ENEMY_RADIUS,
  };
  const max = {
    x: playerPos.x + ENEMY_RADIUS,
    y: playerPos.y + ENEMY_HEIGHT * stanceScale,
    z: playerPos.z + ENEMY_RADIUS,
  };
  const t = rayAABB(origin, dir, min, max);
  if (t === null || t < 1e-4 || t > maxDist) return null;
  return t;
}

function pointInAABB(p, min, max) {
  return (
    p.x >= min.x &&
    p.x <= max.x &&
    p.y >= min.y &&
    p.y <= max.y &&
    p.z >= min.z &&
    p.z <= max.z
  );
}

function pointInSolids(p, solids) {
  for (const box of solids || []) {
    if (pointInAABB(p, box.min, box.max)) return true;
  }
  return false;
}

/**
 * Ray ↔ AABB. Returns entry distance along dir.
 * If the origin is inside the box, returns 0 so the solid still blocks.
 */
function rayAABB(origin, dir, min, max) {
  if (pointInAABB(origin, min, max)) return 0;

  let tmin = 0;
  let tmax = Infinity;
  const axes = ['x', 'y', 'z'];
  for (const a of axes) {
    const o = origin[a];
    const d = dir[a];
    const mn = min[a];
    const mx = max[a];
    if (Math.abs(d) < 1e-12) {
      if (o < mn || o > mx) return null;
      continue;
    }
    let t1 = (mn - o) / d;
    let t2 = (mx - o) / d;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  if (tmax < 0) return null;
  return tmin >= 0 ? tmin : null;
}
