/**
 * Character ↔ voxel AABB collision (ported from engine8 pkg/render/collision.go).
 *
 * Boxes block walking through; airborne vaulting lets the actor pass onto/over
 * ledges within jump reach; short step-ups handle low lips while grounded.
 */

export const BOX_SIZE = 1;
export const COLLIDER_RADIUS = 0.28;
export const SKIN = 0.02;
/** Tallest ledge walkable without jumping (~ankle height). */
export const MAX_STEP_HEIGHT = 0.35;

/**
 * @typedef {{ min: {x:number,y:number,z:number}, max: {x:number,y:number,z:number} }} AABB
 */

/** Build solid AABBs from editor voxel corners (min corner + 1³). */
export function boxesToAABBs(boxes, size = BOX_SIZE) {
  if (!boxes?.length) return [];
  const out = [];
  for (const b of boxes) {
    out.push({
      min: { x: b.x, y: b.y, z: b.z },
      max: { x: b.x + size, y: b.y + size, z: b.z + size },
    });
  }
  return out;
}

export function bodyHeight(stance, height = 1.8) {
  const h = height < 0.5 ? 1.6 : height;
  if (stance === 'crouch') return h * 0.55;
  if (stance === 'prone') return h * 0.28;
  return h * 0.92;
}

/** Apex rise from takeoff: v² / (2g). */
export function maxJumpHeight(jumpSpeed, gravity) {
  if (!(jumpSpeed > 0) || !(gravity > 0)) return 1.05;
  return (jumpSpeed * jumpSpeed) / (2 * gravity);
}

function aabbOverlap(a, b) {
  return (
    a.min.x < b.max.x &&
    a.max.x > b.min.x &&
    a.min.y < b.max.y &&
    a.max.y > b.min.y &&
    a.min.z < b.max.z &&
    a.max.z > b.min.z
  );
}

function xzOverlap(ax, az, ar, box) {
  return (
    ax + ar > box.min.x &&
    ax - ar < box.max.x &&
    az + ar > box.min.z &&
    az - ar < box.max.z
  );
}

/**
 * Highest walkable surface under the feet (floor y=0 or box tops).
 * landSnap catches fast falls that briefly penetrate a surface.
 */
export function supportHeight(ax, ay, az, ar, solids) {
  const landSnap = 0.75;
  let best = 0;
  for (const b of solids) {
    const top = b.max.y;
    if (top < best) continue;
    if (ay < top - landSnap) continue;
    if (!xzOverlap(ax, az, ar, b)) continue;
    best = top;
  }
  return best;
}

function canVault(ctrl, box, jumpReach) {
  if (ctrl.onGround) return false;
  return box.max.y <= ctrl.jumpStartY + jumpReach + SKIN;
}

function resolveHorizontal(ctrl, solids, axisX, jumpReach) {
  const r = COLLIDER_RADIUS;
  const h = bodyHeight(ctrl.stance);
  const feet = ctrl.position.y + SKIN;
  const head = ctrl.position.y + h;

  for (const b of solids) {
    if (feet >= b.max.y - SKIN) continue;
    if (canVault(ctrl, b, jumpReach)) continue;
    if (b.min.y >= head || b.max.y <= ctrl.position.y) continue;

    const body = {
      min: {
        x: ctrl.position.x - r,
        y: ctrl.position.y,
        z: ctrl.position.z - r,
      },
      max: {
        x: ctrl.position.x + r,
        y: head,
        z: ctrl.position.z + r,
      },
    };
    if (!aabbOverlap(body, b)) continue;

    const step = b.max.y - ctrl.position.y;
    if (
      ctrl.onGround &&
      step > 0 &&
      step <= MAX_STEP_HEIGHT &&
      xzOverlap(ctrl.position.x, ctrl.position.z, r, b)
    ) {
      ctrl.position.y = b.max.y;
      ctrl.groundY = b.max.y;
      continue;
    }

    if (axisX) {
      const penL = body.max.x - b.min.x;
      const penR = b.max.x - body.min.x;
      if (penL < penR) ctrl.position.x -= penL;
      else ctrl.position.x += penR;
      ctrl.velocityX = 0;
    } else {
      const penL = body.max.z - b.min.z;
      const penR = b.max.z - body.min.z;
      if (penL < penR) ctrl.position.z -= penL;
      else ctrl.position.z += penR;
      ctrl.velocityZ = 0;
    }
  }
}

/**
 * Resolve solid collision for one physics step on a WowControls-like actor.
 * Call after horizontal intent is applied to velocity; mutates position/velocity/onGround/groundY.
 *
 * @param {object} ctrl - WowControls instance
 * @param {AABB[]} solids
 * @param {number} dt
 * @param {{ jumped?: boolean }} [opts]
 */
export function collideWithWorld(ctrl, solids, dt, opts = {}) {
  const list = solids || [];
  const jumpReach = maxJumpHeight(ctrl.jumpSpeed, ctrl.gravity);

  if (opts.jumped) {
    ctrl.jumpStartY = ctrl.position.y;
  }

  ctrl.position.x += ctrl.velocityX * dt;
  resolveHorizontal(ctrl, list, true, jumpReach);
  ctrl.position.z += ctrl.velocityZ * dt;
  resolveHorizontal(ctrl, list, false, jumpReach);

  if (ctrl.onGround) {
    ctrl.velocityY = 0;
  } else {
    ctrl.velocityY -= ctrl.gravity * dt;
  }
  ctrl.position.y += ctrl.velocityY * dt;

  // Ceiling against overhangs / stacked undersides (skip vaultable ledges).
  if (ctrl.velocityY > 0) {
    const r = COLLIDER_RADIUS;
    const h = bodyHeight(ctrl.stance);
    const body = {
      min: {
        x: ctrl.position.x - r,
        y: ctrl.position.y + SKIN,
        z: ctrl.position.z - r,
      },
      max: {
        x: ctrl.position.x + r,
        y: ctrl.position.y + h,
        z: ctrl.position.z + r,
      },
    };
    for (const b of list) {
      if (canVault(ctrl, b, jumpReach)) continue;
      if (!aabbOverlap(body, b)) continue;
      if (body.max.y > b.min.y && ctrl.position.y + h - SKIN <= b.min.y + 0.2) {
        ctrl.position.y = b.min.y - h;
        ctrl.velocityY = 0;
      }
    }
  }

  const support = supportHeight(
    ctrl.position.x,
    ctrl.position.y,
    ctrl.position.z,
    COLLIDER_RADIUS,
    list,
  );
  ctrl.groundY = support;

  let onSupport = ctrl.velocityY <= 0 && ctrl.position.y <= support + SKIN;
  if (onSupport && support > (ctrl.jumpStartY ?? 0) + 0.01) {
    // Raised ledge: require feet near the top so mid-vault doesn't snap early.
    if (ctrl.position.y < support - 0.2) onSupport = false;
  }

  if (onSupport) {
    ctrl.position.y = support;
    const wasAir = !ctrl.onGround;
    ctrl.onGround = true;
    ctrl.velocityY = 0;
    if (wasAir) {
      ctrl.velocityX = 0;
      ctrl.velocityZ = 0;
    }
    return;
  }

  if (ctrl.position.y > support + SKIN) {
    ctrl.onGround = false;
  }
}
