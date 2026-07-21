/**
 * World-of-Warcraft style third-person controls
 * (ported from engine2-voxel-vpg camera + scene input).
 *
 * W/S     — move along character facing
 * Q/E     — strafe relative to facing
 * A/D     — turn (camera+character; character-only with LMB; strafe with RMB)
 * LMB drag — orbit camera only
 * RMB drag — orbit camera and steer facing
 * Wheel   — zoom
 * Space   — jump
 */

export class WowControls {
  constructor(options = {}) {
    this.yaw = Math.PI;
    this.pitch = 0.55;
    this.distance = 5;
    this.minDistance = 1.5;
    this.maxDistance = 12;
    this.minPitch = -0.2;
    this.maxPitch = 1.45;

    this.walkSpeed = options.walkSpeed ?? 1.8;
    this.jumpSpeed = options.jumpSpeed ?? 4.5;
    this.gravity = options.gravity ?? 12;
    this.turnSpeed = options.turnSpeed ?? 1.8;
    this.orbitSensitivity = options.orbitSensitivity ?? 0.005;
    this.zoomSensitivity = options.zoomSensitivity ?? 0.35;
    this.eyeHeight = options.eyeHeight ?? 1.0;
    this.groundY = options.groundY ?? 0;

    this.position = { x: 0, y: 0, z: 0 };
    this.facing = Math.PI;
    this.velocityX = 0;
    this.velocityZ = 0;
    this.velocityY = 0;
    this.onGround = true;
    this.moving = false;

    this.keys = new Set();
    this.lmb = false;
    this.rmb = false;
    this.pointerX = 0;
    this.pointerY = 0;
    this.deltaX = 0;
    this.deltaY = 0;
    this.scrollY = 0;
    this.hasPointer = false;

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onWheel = this._onWheel.bind(this);
    this._onContextMenu = (e) => e.preventDefault();
    this._onBlur = () => this.keys.clear();
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
  }

  detach() {
    if (!this.dom) return;
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    this.dom.removeEventListener('pointerdown', this._onPointerDown);
    window.removeEventListener('pointerup', this._onPointerUp);
    window.removeEventListener('pointermove', this._onPointerMove);
    this.dom.removeEventListener('wheel', this._onWheel);
    this.dom.removeEventListener('contextmenu', this._onContextMenu);
  }

  /** Eye / look-at target for the orbit camera. */
  getTarget() {
    return {
      x: this.position.x,
      y: this.position.y + this.eyeHeight,
      z: this.position.z,
    };
  }

  /** Camera eye position from spherical orbit params. */
  getCameraPosition() {
    const target = this.getTarget();
    const cp = Math.cos(this.pitch);
    return {
      x: target.x + Math.sin(this.yaw) * cp * this.distance,
      y: target.y + Math.sin(this.pitch) * this.distance,
      z: target.z + Math.cos(this.yaw) * cp * this.distance,
    };
  }

  update(dt) {
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

    const dragging = this.lmb || this.rmb;
    if (dragging && (this.deltaX !== 0 || this.deltaY !== 0)) {
      this.yaw -= this.deltaX * this.orbitSensitivity;
      this.pitch += this.deltaY * this.orbitSensitivity;
      this.pitch = clamp(this.pitch, this.minPitch, this.maxPitch);
    }
    this.deltaX = 0;
    this.deltaY = 0;

    // RMB drag steers facing with the camera.
    if (this.rmb) {
      this.facing = this.yaw;
    }

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
    const forward = { x: -Math.sin(facing), z: -Math.cos(facing) };
    const right = { x: Math.cos(facing), z: -Math.sin(facing) };

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
      if (len > 1e-6) {
        this.velocityX = (moveX / len) * this.walkSpeed;
        this.velocityZ = (moveZ / len) * this.walkSpeed;
      } else {
        this.velocityX = 0;
        this.velocityZ = 0;
        wantMove = false;
      }
    }

    if (this.keys.has('Space') && this.onGround) {
      this.velocityY = this.jumpSpeed;
      this.onGround = false;
    }

    if (this.onGround) {
      this.velocityY = 0;
    } else {
      this.velocityY -= this.gravity * dt;
    }

    this.position.x += this.velocityX * dt;
    this.position.z += this.velocityZ * dt;
    this.position.y += this.velocityY * dt;

    if (this.onGround) {
      this.position.y = this.groundY;
      this.velocityY = 0;
    } else if (this.velocityY <= 0 && this.position.y <= this.groundY) {
      this.position.y = this.groundY;
      this.velocityX = 0;
      this.velocityY = 0;
      this.velocityZ = 0;
      this.onGround = true;
    }

    this.moving = this.onGround && wantMove;
  }

  _onKeyDown(e) {
    if (e.code === 'Space') e.preventDefault();
    this.keys.add(e.code);
  }

  _onKeyUp(e) {
    this.keys.delete(e.code);
  }

  _onPointerDown(e) {
    if (e.button === 0) this.lmb = true;
    if (e.button === 2) this.rmb = true;
    this.pointerX = e.clientX;
    this.pointerY = e.clientY;
    this.hasPointer = true;
    try {
      this.dom.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }

  _onPointerUp(e) {
    if (e.button === 0) this.lmb = false;
    if (e.button === 2) this.rmb = false;
  }

  _onPointerMove(e) {
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
    e.preventDefault();
    // Browser: wheel up => negative deltaY. Accumulate so +scrollY zooms out.
    this.scrollY += Math.sign(e.deltaY);
  }
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
