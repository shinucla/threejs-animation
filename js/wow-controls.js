/**
 * World-of-Warcraft style third-person controls
 * (ported from engine2-voxel-vpg camera + scene input).
 *
 * W/S     — move along character facing
 * Q/E     — strafe relative to facing
 * A/D     — turn (camera+character; character-only with LMB; strafe with RMB)
 * LMB drag — orbit camera only (aim holds last position)
 * RMB drag — orbit camera, steer facing, aim snaps to upper-center
 * (no buttons) — aim follows mouse pointer
 * Wheel   — zoom
 * Space   — jump
 * 1       — fire (hold for ~5 shots/s)
 * [ / ]   — decrease / increase VPG
 */
import { collideWithWorld } from './collision.js';
import { getWorldSolids } from './world-solids.js';
import { hitscanWorld, inflateSolids, rmbAimClientPoint } from './shooting.js';

export class WowControls {
  constructor(options = {}) {
    this.yaw = Math.PI;
    this.pitch = 0.55;
    this.distance = 5;
    this.minDistance = 1.5;
    this.maxDistance = 12;
    /**
     * Actual camera distance after LOS pull-in (smoothly follows clearDist).
     * Ideal orbit distance stays in `distance` (wheel zoom).
     */
    this.cameraDistance = 5;
    /** Closest the camera may pull in when blocked. */
    this.minCollisionDistance = options.minCollisionDistance ?? 0.55;
    /** Skin so the lens sits just in front of a hit surface. */
    this.cameraCollisionSkin = options.cameraCollisionSkin ?? 0.22;
    // Pitch is elevation from horizontal; keep camera ≥15° above the ground plane.
    this.minPitch = options.minPitch ?? Math.PI / 12;
    this.maxPitch = options.maxPitch ?? 1.45;

    this.walkSpeed = options.walkSpeed ?? 1.8;
    this.jumpSpeed = options.jumpSpeed ?? 4.5;
    /** Horizontal speed kept when leaving the ground (1 = full run carry). */
    this.jumpForwardScale = options.jumpForwardScale ?? 0.72;
    this.gravity = options.gravity ?? 12;
    this.turnSpeed = options.turnSpeed ?? 1.8;
    this.orbitSensitivity = options.orbitSensitivity ?? 0.005;
    this.zoomSensitivity = options.zoomSensitivity ?? 0.35;
    this.eyeHeight = options.eyeHeight ?? 1.0;
    this.groundY = options.groundY ?? 0;
    /** Feet Y when the current jump began (vault reach). */
    this.jumpStartY = 0;
    /** Optional () => AABB[] — falls back to shared world solids registry. */
    this.getSolids = options.getSolids ?? getWorldSolids;

    this.position = { x: 0, y: 0, z: 0 };
    this.facing = Math.PI;
    this.velocityX = 0;
    this.velocityZ = 0;
    this.velocityY = 0;
    this.onGround = true;
    this.moving = false;
    /** True for the update() that starts a jump (space while grounded). */
    this.justJumped = false;
    /** Stance: 'stand' | 'crouch' | 'prone' */
    this.stance = 'stand';
    this.crouchSpeedScale = options.crouchSpeedScale ?? 0.45;
    this.proneSpeedScale = options.proneSpeedScale ?? 0.2;

    this.keys = new Set();
    this.lmb = false;
    this.rmb = false;
    this.pointerX = 0;
    this.pointerY = 0;
    this.deltaX = 0;
    this.deltaY = 0;
    this.scrollY = 0;
    this.hasPointer = false;
    /** When false, update() skips input and movement (other modes own the canvas). */
    this.enabled = true;
    /** Previous-frame Space state for edge-triggered jumps. */
    this._spaceDown = false;
    /** After a jump, Space must be released before another jump can start. */
    this._jumpArm = true;

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onWheel = this._onWheel.bind(this);
    this._onContextMenu = (e) => e.preventDefault();
    this._onBlur = () => this.keys.clear();
    this._onPointerLockChange = this._onPointerLockChange.bind(this);
    this._rmbLockPending = false;
  }

  attach(domElement) {
    this.dom = domElement;
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    domElement.addEventListener('pointerdown', this._onPointerDown);
    window.addEventListener('pointerup', this._onPointerUp);
    window.addEventListener('pointermove', this._onPointerMove);
    domElement.addEventListener('wheel', this._onWheel, { passive: false });
    domElement.addEventListener('contextmenu', this._onContextMenu);
    document.addEventListener('pointerlockchange', this._onPointerLockChange);
  }

  detach() {
    if (!this.dom) return;
    this._endRmbPointerLock();
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    this.dom.removeEventListener('pointerdown', this._onPointerDown);
    window.removeEventListener('pointerup', this._onPointerUp);
    window.removeEventListener('pointermove', this._onPointerMove);
    this.dom.removeEventListener('wheel', this._onWheel);
    this.dom.removeEventListener('contextmenu', this._onContextMenu);
    document.removeEventListener('pointerlockchange', this._onPointerLockChange);
  }

  /** Eye / look-at target for the orbit camera. */
  getTarget() {
    return {
      x: this.position.x,
      y: this.position.y + this.eyeHeight,
      z: this.position.z,
    };
  }

  /** Unit direction from look-at target toward the ideal orbit camera. */
  getCameraOrbitDir() {
    const cp = Math.cos(this.pitch);
    return {
      x: Math.sin(this.yaw) * cp,
      y: Math.sin(this.pitch),
      z: Math.cos(this.yaw) * cp,
    };
  }

  /** Camera eye position (LOS-adjusted distance). */
  getCameraPosition() {
    const target = this.getTarget();
    const dir = this.getCameraOrbitDir();
    const d = this.cameraDistance;
    return {
      x: target.x + dir.x * d,
      y: target.y + dir.y * d,
      z: target.z + dir.z * d,
    };
  }

  /**
   * Pull camera in along player→camera when boxes block LOS; ease back out
   * when the path is clear again.
   */
  _updateCameraCollision(dt) {
    const target = this.getTarget();
    const dir = this.getCameraOrbitDir();
    const desired = this.distance;
    const solids = typeof this.getSolids === 'function' ? this.getSolids() || [] : [];
    const inflated = inflateSolids(solids, 0.06);

    let clearDist = desired;
    if (inflated.length) {
      const hit = hitscanWorld(target, dir, inflated, desired);
      if (hit.hit && hit.t < desired - 0.01) {
        clearDist = Math.max(
          this.minCollisionDistance,
          hit.t - this.cameraCollisionSkin,
        );
      }
    }

    // Snap in quickly when blocked; ease out ("bounce back") when clear.
    const speed = clearDist < this.cameraDistance - 0.01 ? 22 : 6;
    const k = 1 - Math.exp(-speed * dt);
    this.cameraDistance += (clearDist - this.cameraDistance) * k;
  }

  update(dt) {
    if (!this.enabled) {
      this.justJumped = false;
      this.deltaX = 0;
      this.deltaY = 0;
      this.scrollY = 0;
      this.keys.clear();
      this._spaceDown = false;
      return;
    }

    if (dt > 0.05) dt = 0.05;

    if (this.scrollY !== 0) {
      // Positive scrollY = wheel down = zoom out (match engine2 Zoom(-sc)).
      this.distance = clamp(
        this.distance + this.scrollY * this.zoomSensitivity,
        this.minDistance,
        this.maxDistance,
      );
      this.scrollY = 0;
    }

    // LMB / RMB: orbit camera. RMB also locks facing (original WoW steer).
    const dragging = this.lmb || this.rmb;
    if (dragging && (this.deltaX !== 0 || this.deltaY !== 0)) {
      this.yaw -= this.deltaX * this.orbitSensitivity;
      this.pitch += this.deltaY * this.orbitSensitivity;
    }
    this.pitch = clamp(this.pitch, this.minPitch, this.maxPitch);
    this.deltaX = 0;
    this.deltaY = 0;

    // RMB drag steers facing with the camera. Camera yaw is π behind the
    // character's Mixamo +Z facing, so keep that offset when locking them.
    if (this.rmb) {
      this.facing = this.yaw + Math.PI;
    }

    // Keep player↔camera LOS: pull in through cover, ease back when clear.
    this._updateCameraCollision(dt);

    // A/D turn unless RMB (then A/D strafe with movement).
    if (!this.rmb) {
      let turn = 0;
      if (this.keys.has('KeyA')) turn += this.turnSpeed * dt;
      if (this.keys.has('KeyD')) turn -= this.turnSpeed * dt;
      if (turn !== 0) {
        this.facing += turn;
        if (!this.lmb) this.yaw += turn;
      }
    }

    const facing = this.facing;
    // Match Mixamo +Z forward (facing 0 → walk +Z). Right-handed strafe.
    const forward = { x: Math.sin(facing), z: Math.cos(facing) };
    const right = { x: -Math.cos(facing), z: Math.sin(facing) };

    let moveX = 0;
    let moveZ = 0;
    let wantMove = false;

    if (this.onGround) {
      if (this.keys.has('KeyW')) {
        moveX += forward.x;
        moveZ += forward.z;
        wantMove = true;
      }
      if (this.keys.has('KeyS')) {
        moveX -= forward.x;
        moveZ -= forward.z;
        wantMove = true;
      }
      if (this.keys.has('KeyQ')) {
        moveX -= right.x;
        moveZ -= right.z;
        wantMove = true;
      }
      if (this.keys.has('KeyE')) {
        moveX += right.x;
        moveZ += right.z;
        wantMove = true;
      }
      if (this.rmb) {
        if (this.keys.has('KeyA')) {
          moveX -= right.x;
          moveZ -= right.z;
          wantMove = true;
        }
        if (this.keys.has('KeyD')) {
          moveX += right.x;
          moveZ += right.z;
          wantMove = true;
        }
      }

      const len = Math.hypot(moveX, moveZ);
      const speedScale =
        this.stance === 'prone'
          ? this.proneSpeedScale
          : this.stance === 'crouch'
            ? this.crouchSpeedScale
            : 1;
      if (len > 1e-6) {
        this.velocityX = (moveX / len) * this.walkSpeed * speedScale;
        this.velocityZ = (moveZ / len) * this.walkSpeed * speedScale;
      } else {
        this.velocityX = 0;
        this.velocityZ = 0;
        wantMove = false;
      }
    }

    this.justJumped = false;
    let jumped = false;

    const spaceDown = this.keys.has('Space');
    const spacePressed = spaceDown && !this._spaceDown;
    this._spaceDown = spaceDown;
    if (!spaceDown) this._jumpArm = true;

    // Edge-trigger only — holding Space must not re-fire if onGround flickers mid-air.
    if (
      spacePressed &&
      this._jumpArm &&
      this.onGround &&
      this.stance !== 'prone'
    ) {
      this.stance = 'stand';
      this.velocityY = this.jumpSpeed;
      // Cut run carry so jumps don't sail as far forward.
      this.velocityX *= this.jumpForwardScale;
      this.velocityZ *= this.jumpForwardScale;
      this.onGround = false;
      this.justJumped = true;
      this._jumpArm = false;
      jumped = true;
    }

    const solids =
      typeof this.getSolids === 'function' ? this.getSolids() || [] : [];
    collideWithWorld(this, solids, dt, { jumped });

    this.moving = this.onGround && wantMove;
  }

  _onKeyDown(e) {
    if (!this.enabled) return;
    if (e.code === 'Space') e.preventDefault();
    // VPG adjust (engine2) — keep focus from leaving / page search.
    if (e.code === 'BracketLeft' || e.code === 'BracketRight') e.preventDefault();

    // Stance toggles (ignore key-repeat)
    if (!e.repeat) {
      if (e.code === 'KeyC') {
        e.preventDefault();
        if (this.stance === 'crouch') this.stance = 'stand';
        else this.stance = 'crouch';
      }
      if (e.code === 'KeyZ') {
        e.preventDefault();
        if (this.stance === 'prone') this.stance = 'stand';
        else this.stance = 'prone';
      }
    }

    this.keys.add(e.code);
  }

  _onKeyUp(e) {
    if (!this.enabled) {
      this.keys.delete(e.code);
      return;
    }
    this.keys.delete(e.code);
  }

  _pinPointerToAim() {
    if (!this.dom) return;
    const p = rmbAimClientPoint(this.dom);
    this.pointerX = p.x;
    this.pointerY = p.y;
    return p;
  }

  _beginRmbPointerLock() {
    const p = this._pinPointerToAim();
    const target = document.getElementById('rmb-lock-target');
    if (!target || !p) return;
    target.style.left = `${p.x}px`;
    target.style.top = `${p.y}px`;
    this._rmbLockPending = true;
    const req =
      target.requestPointerLock ||
      target.mozRequestPointerLock ||
      target.webkitRequestPointerLock;
    try {
      const ret = req?.call(target);
      if (ret && typeof ret.catch === 'function') {
        ret.catch(() => {
          this._rmbLockPending = false;
        });
      }
    } catch {
      this._rmbLockPending = false;
    }
  }

  _endRmbPointerLock() {
    this._rmbLockPending = false;
    const p = this._pinPointerToAim();
    const target = document.getElementById('rmb-lock-target');
    if (target && p) {
      target.style.left = `${p.x}px`;
      target.style.top = `${p.y}px`;
    }
    if (document.pointerLockElement) {
      document.exitPointerLock?.();
    }
  }

  _onPointerLockChange() {
    if (document.pointerLockElement) {
      this._rmbLockPending = false;
      this._pinPointerToAim();
      return;
    }
    // Unlock: OS cursor is warped to the lock-target center (aim reticle).
    this._rmbLockPending = false;
    this._pinPointerToAim();
  }

  _onPointerDown(e) {
    if (!this.enabled) return;
    if (e.button === 0) {
      this.lmb = true;
      this.pointerX = e.clientX;
      this.pointerY = e.clientY;
      this.hasPointer = true;
      try {
        this.dom.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      return;
    }
    if (e.button === 2) {
      this.rmb = true;
      this.hasPointer = true;
      this._beginRmbPointerLock();
    }
  }

  _onPointerUp(e) {
    if (e.button === 0) this.lmb = false;
    if (e.button === 2) {
      this.rmb = false;
      this._pinPointerToAim();
      this._endRmbPointerLock();
    }
  }

  _onPointerMove(e) {
    if (!this.enabled) return;
    if (this.rmb) {
      // Orbit from movement deltas; keep logical pointer on the aim reticle.
      this.deltaX += e.movementX;
      this.deltaY += e.movementY;
      this._pinPointerToAim();
      this.hasPointer = true;
      return;
    }
    if (!this.hasPointer) {
      this.pointerX = e.clientX;
      this.pointerY = e.clientY;
      this.hasPointer = true;
      return;
    }
    this.deltaX += e.clientX - this.pointerX;
    this.deltaY += e.clientY - this.pointerY;
    this.pointerX = e.clientX;
    this.pointerY = e.clientY;
  }

  _onWheel(e) {
    if (!this.enabled) return;
    e.preventDefault();
    // Browser: wheel up => negative deltaY. Accumulate so +scrollY zooms out.
    this.scrollY += Math.sign(e.deltaY);
  }
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
