/**
 * Aim marker + hitscan tracers. Aim comes from a screen ray (mouse or reticle).
 */
import * as THREE from 'three';

const FIRE_INTERVAL = 1 / 5;
const SHOT_RANGE = 80;
const TRACER_LIFE = 0.12;
const MARK_LIFE = 0.35;
const ENEMY_RADIUS = 0.4;
const ENEMY_HEIGHT = 1.8;
/** Aim marker max distance along the screen ray (meters). */
const AIM_DIST = 30;
const MUZZLE_HEIGHT = 1.25;
const MUZZLE_FORWARD = 0.4;
const GROUND_Y = 0;
/** NDC Y for RMB reticle — horizontally centered, upper half of the view. */
const RMB_AIM_NDC_Y = 0.35;

/**
 * Shiny aim dot driven by a camera screen ray.
 * - no buttons: follow mouse pointer
 * - RMB: snap to upper-center reticle
 * - LMB only: hold last aim while orbiting
 */
export class AimTarget {
  constructor(scene) {
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

  /**
   * @param {THREE.Camera} camera
   * @param {HTMLElement} dom
   * @param {{x:number,y:number,z:number}} playerPos feet
   * @param {{ lmb: boolean, rmb: boolean, pointerX: number, pointerY: number }} pointer
   * @param {number} dt
   */
  updateFromScreen(camera, dom, playerPos, pointer, dt = 0) {
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

      let dist = AIM_DIST;
      if (dir.y < -1e-6) {
        const tGround = (GROUND_Y - origin.y) / dir.y;
        if (tGround > 0 && tGround < dist) dist = tGround;
      }

      this.mesh.position.set(
        origin.x + dir.x * dist,
        origin.y + dir.y * dist,
        origin.z + dir.z * dist,
      );
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
   * @param {number} dt
   * @param {{ firing: boolean, position: {x:number,y:number,z:number}, aimDir: {x:number,y:number,z:number} }} state
   */
  update(dt, state) {
    this._ageFx(dt);

    if (!state?.firing) {
      this.cooldown = 0;
      return;
    }

    this.cooldown -= dt;
    if (this.cooldown <= 0) {
      this._fire(state.position, state.aimDir);
      this.cooldown = FIRE_INTERVAL;
    }
  }

  _fire(pos, aimDir) {
    const dir = aimDir;
    const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
    const nx = dir.x / len;
    const ny = dir.y / len;
    const nz = dir.z / len;
    const origin = {
      x: pos.x + nx * MUZZLE_FORWARD,
      y: pos.y + MUZZLE_HEIGHT,
      z: pos.z + nz * MUZZLE_FORWARD,
    };

    const hit = hitscan(
      origin,
      { x: nx, y: ny, z: nz },
      this.getSolids(),
      this.getEnemies(),
      SHOT_RANGE,
    );
    this._addTracer(origin, hit.point, hit.hit);
    if (hit.hit) this._addMark(hit.point, hit.enemyIndex >= 0);

    if (hit.enemyIndex >= 0 && typeof this.onEnemyHit === 'function') {
      this.onEnemyHit(hit.enemyIndex);
    }
  }

  _addTracer(from, to, hit) {
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(from.x, from.y, from.z),
      new THREE.Vector3(to.x, to.y, to.z),
    ]);
    const line = new THREE.Line(
      geo,
      new THREE.LineBasicMaterial({
        color: hit ? 0xffcc55 : 0xffe899,
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
 * @returns {{ hit: boolean, point: {x:number,y:number,z:number}, enemyIndex: number }}
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
    if (t !== null && t < bestT && t > 0) {
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
    if (t !== null && t < bestT && t > 0) {
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
    if (t > 0 && t < bestT) {
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

  return { hit, point, enemyIndex };
}

function rayAABB(origin, dir, min, max) {
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
  return tmin >= 0 ? tmin : tmax >= 0 ? tmax : null;
}
