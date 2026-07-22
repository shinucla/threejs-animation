/**
 * Voxel-painter style world editor (ported from engine8 RunEditor).
 *
 * Tools (user mapping):
 *   1 — soldier spawn
 *   2 — boxes (Shift+LMB removes)
 *   3 — stormtrooper enemies (Shift+LMB removes nearest)
 *
 * Camera: RMB orbit · wheel zoom · W/S/Q/E pan · Space/X raise/lower
 * Ctrl+S save (download) · Ctrl+Z undo · [ / ] VPG via host
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import {
  BOX_SIZE,
  downloadWorld,
  emptyWorld,
  loadWorld,
  snapVoxelCorner,
  WORLD_URL,
} from './world-data.js';
import { setWorldBoxes } from './world-solids.js';

export const TOOL_SOLDIER = 'soldier';
export const TOOL_BOX = 'box';
export const TOOL_ENEMY = 'enemy';

const BOX_COLOR = 0xfeb74c;
const GHOST_OPACITY = 0.45;
const ENEMY_URL = 'assets/enemy/Stormtrooper.glb';
const BOX_TEX_URL = 'assets/world/square-outline-textured.png';
const CLICK_PX = 5;

export class EditorMode {
  /**
   * @param {object} opts
   * @param {THREE.Scene} opts.scene
   * @param {THREE.PerspectiveCamera} opts.camera
   * @param {HTMLElement} opts.domElement
   * @param {THREE.Group} opts.soldierGroup — run-mode character root
   * @param {import('./wow-controls.js').WowControls} opts.controls
   * @param {(msg: string, ms?: number) => void} [opts.onToast]
   * @param {(info: object) => void} [opts.onHud]
   * @param {() => void} [opts.onVpgNudge] — optional; host may handle VPG itself
   */
  constructor(opts) {
    this.scene = opts.scene;
    this.camera = opts.camera;
    this.dom = opts.domElement;
    this.soldierGroup = opts.soldierGroup;
    this.controls = opts.controls;
    this.onToast = opts.onToast || (() => {});
    this.onHud = opts.onHud || (() => {});

    this.active = false;
    this.tool = TOOL_BOX;
    this.hasCharacter = false;
    this.characterYaw = 0;
    this.boxes = []; // {x,y,z}
    this.enemies = []; // {x,y,z,yaw, root}
    this.undo = [];

    this.root = new THREE.Group();
    this.root.name = 'EditorWorld';
    this.root.visible = false;
    this.scene.add(this.root);

    this.boxGroup = new THREE.Group();
    this.root.add(this.boxGroup);
    this.enemyGroup = new THREE.Group();
    this.root.add(this.enemyGroup);

    this.boxMeshes = []; // parallel to boxes[]
    this.boxMaterial = null;
    this.ghostMesh = null;
    this.enemyTemplate = null;
    this.enemyMixers = [];
    this.ready = false;

    this.orbit = {
      target: new THREE.Vector3(0, 1, 0),
      distance: 18,
      pitch: 0.85,
      yaw: 0.7,
      minPitch: (15 * Math.PI) / 180,
      maxPitch: 1.45,
      minDistance: 2,
      maxDistance: 60,
      sens: 0.005,
    };

    this.keys = new Set();
    this.pointer = { x: 0, y: 0, has: false };
    this.rmb = false;
    this.lmb = false;
    this.shift = false;
    this.dragStart = null;
    this.didDrag = false;
    this.pendingClick = false;

    this._raycaster = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    this._groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this._hitPoint = new THREE.Vector3();
    this._hitNormal = new THREE.Vector3(0, 1, 0);
    this._tmp = new THREE.Vector3();

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onWheel = this._onWheel.bind(this);
    this._onContextMenu = (e) => e.preventDefault();
    this._onBlur = () => this.keys.clear();
  }

  async init() {
    const loader = new THREE.TextureLoader();
    let map = null;
    try {
      map = await loader.loadAsync(BOX_TEX_URL);
      map.colorSpace = THREE.SRGBColorSpace;
      map.magFilter = THREE.NearestFilter;
      map.minFilter = THREE.NearestFilter;
    } catch (err) {
      console.warn('box texture:', err);
    }

    this.boxMaterial = new THREE.MeshStandardMaterial({
      color: BOX_COLOR,
      map,
      roughness: 0.55,
      metalness: 0,
    });

    const ghostMat = new THREE.MeshStandardMaterial({
      color: BOX_COLOR,
      transparent: true,
      opacity: GHOST_OPACITY,
      depthWrite: false,
      roughness: 0.55,
    });
    this.ghostMesh = new THREE.Mesh(new THREE.BoxGeometry(BOX_SIZE, BOX_SIZE, BOX_SIZE), ghostMat);
    this.ghostMesh.visible = false;
    // Geometry is centered; engine8 cubes sit on min-corner — offset by half size.
    this.ghostMesh.geometry.translate(BOX_SIZE / 2, BOX_SIZE / 2, BOX_SIZE / 2);
    this.root.add(this.ghostMesh);

    // World first so collision solids exist before the heavy enemy GLB finishes.
    await this.loadFromUrl(WORLD_URL);

    try {
      const gltf = await new GLTFLoader().loadAsync(ENEMY_URL);
      this.enemyTemplate = gltf.scene;
      this.enemyTemplate.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });
      // Normalize height ~1.8m (Collada units vary).
      this.enemyTemplate.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(this.enemyTemplate);
      const size = box.getSize(new THREE.Vector3());
      if (size.y > 1e-3) {
        const s = 1.8 / size.y;
        this.enemyTemplate.scale.multiplyScalar(s);
        this.enemyTemplate.updateMatrixWorld(true);
        const box2 = new THREE.Box3().setFromObject(this.enemyTemplate);
        this.enemyTemplate.position.y -= box2.min.y;
      }
      this._enemyClips = gltf.animations || [];
    } catch (err) {
      console.warn('stormtrooper load:', err);
      this.onToast(`Stormtrooper failed: ${err.message || err}`, 5000);
    }

    this.ready = true;
    this._emitHud();
  }

  setActive(active) {
    this.active = !!active;
    this.root.visible = this.active || this.boxes.length > 0 || this.enemies.length > 0;
    // Always keep world geometry in scene for run mode; only bind input when editing.
    if (this.active) {
      this._attachInput();
      this.controls.enabled = false;
      this.keys.clear();
      this._applySoldierVisibility();
      this._syncCameraFromOrbit();
      this._emitHud();
      this.onToast('Editor — 1 soldier · 2 boxes · 3 enemies · Ctrl+S save');
    } else {
      this._detachInput();
      this.ghostMesh.visible = false;
      this.keys.clear();
      // Leaving editor: soldier always visible in run if placed.
      if (this.soldierGroup) this.soldierGroup.visible = true;
    }
  }

  /** Solid AABBs for run-mode collision (placed voxel boxes). */
  getSolidAABBs() {
    // Prefer live boxes; keep world-solids registry in sync for controls.
    return this.boxes.map((b) => ({
      min: { x: b.x, y: b.y, z: b.z },
      max: { x: b.x + BOX_SIZE, y: b.y + BOX_SIZE, z: b.z + BOX_SIZE },
    }));
  }

  _syncSolids() {
    setWorldBoxes(this.boxes);
  }

  /** Whether the world root should stay visible outside the editor. */
  setWorldVisible(visible) {
    this.root.visible = !!visible;
  }

  update(dt) {
    if (!this.active) {
      this._updateEnemyAnims(dt);
      return;
    }
    if (dt > 0.05) dt = 0.05;

    this._updateOrbitCamera(dt);
    this._updateGhost();

    if (this.pendingClick) {
      this.pendingClick = false;
      if (!this.didDrag) this._handleClick();
    }

    this._updateEnemyAnims(dt);
    this._emitHud();
  }

  getWorldData() {
    const w = emptyWorld();
    w.boxes = this.boxes.map((b) => ({ x: b.x, y: b.y, z: b.z }));
    w.enemies = this.enemies.map((e) => ({
      x: e.x,
      y: e.y,
      z: e.z,
      yaw: e.yaw,
    }));
    if (this.hasCharacter) {
      w.character = {
        x: this.controls.position.x,
        y: this.controls.position.y,
        z: this.controls.position.z,
        yaw: (this.characterYaw * 180) / Math.PI,
      };
    }
    return w;
  }

  applyWorld(data) {
    this._clearBoxes();
    this._clearEnemies();
    this.undo = [];

    const w = data || emptyWorld();
    for (const b of w.boxes || []) this._addBox(b.x, b.y, b.z, false);
    for (const e of w.enemies || []) this._addEnemy(e.x, e.y, e.z, e.yaw || 0, false);

    if (w.character) {
      this.hasCharacter = true;
      this.controls.position.x = w.character.x;
      this.controls.position.y = w.character.y;
      this.controls.position.z = w.character.z;
      this.characterYaw = ((w.character.yaw || 0) * Math.PI) / 180;
      this.controls.facing = this.characterYaw;
      if (this.soldierGroup) {
        this.soldierGroup.position.set(
          this.controls.position.x,
          this.controls.position.y,
          this.controls.position.z,
        );
        this.soldierGroup.rotation.y = this.characterYaw;
      }
    } else {
      this.hasCharacter = false;
    }
    this._applySoldierVisibility();
    this.root.visible = this.active || this.boxes.length > 0 || this.enemies.length > 0;
    this._syncSolids();
    this._emitHud();
  }

  async loadFromUrl(url = WORLD_URL) {
    const w = await loadWorld(url);
    this.applyWorld(w);
    this.onToast(
      `Loaded world · boxes ${w.boxes.length} · enemies ${w.enemies.length}`,
      2200,
    );
  }

  save() {
    downloadWorld(this.getWorldData());
    this.onToast('Saved world.json (download)');
  }

  // —— internals ——

  _attachInput() {
    if (this._bound) return;
    this._bound = true;
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    this.dom.addEventListener('pointerdown', this._onPointerDown);
    window.addEventListener('pointerup', this._onPointerUp);
    window.addEventListener('pointermove', this._onPointerMove);
    this.dom.addEventListener('wheel', this._onWheel, { passive: false });
    this.dom.addEventListener('contextmenu', this._onContextMenu);
  }

  _detachInput() {
    if (!this._bound) return;
    this._bound = false;
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    this.dom.removeEventListener('pointerdown', this._onPointerDown);
    window.removeEventListener('pointerup', this._onPointerUp);
    window.removeEventListener('pointermove', this._onPointerMove);
    this.dom.removeEventListener('wheel', this._onWheel);
    this.dom.removeEventListener('contextmenu', this._onContextMenu);
  }

  _onKeyDown(e) {
    if (!this.active) return;
    this.shift = e.shiftKey;
    if (e.code === 'BracketLeft' || e.code === 'BracketRight') e.preventDefault();
    if (e.code === 'Space') e.preventDefault();

    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS') {
      e.preventDefault();
      this.save();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
      e.preventDefault();
      this._undo();
      return;
    }

    if (!e.repeat) {
      if (e.code === 'Digit1' || e.code === 'Numpad1') {
        this.tool = TOOL_SOLDIER;
        this.onToast('Tool: soldier');
      } else if (e.code === 'Digit2' || e.code === 'Numpad2') {
        this.tool = TOOL_BOX;
        this.onToast('Tool: boxes');
      } else if (e.code === 'Digit3' || e.code === 'Numpad3') {
        this.tool = TOOL_ENEMY;
        this.onToast('Tool: stormtrooper');
      }
    }

    this.keys.add(e.code);
  }

  _onKeyUp(e) {
    this.shift = e.shiftKey;
    this.keys.delete(e.code);
  }

  _onPointerDown(e) {
    this.pointer.x = e.clientX;
    this.pointer.y = e.clientY;
    this.pointer.has = true;
    if (e.button === 2) this.rmb = true;
    if (e.button === 0) {
      this.lmb = true;
      this.dragStart = { x: e.clientX, y: e.clientY };
      this.didDrag = false;
    }
    try {
      this.dom.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }

  _onPointerUp(e) {
    if (e.button === 2) this.rmb = false;
    if (e.button === 0) {
      this.lmb = false;
      if (this.dragStart && !this.didDrag) this.pendingClick = true;
      this.dragStart = null;
    }
  }

  _onPointerMove(e) {
    if (this.pointer.has) {
      const dx = e.clientX - this.pointer.x;
      const dy = e.clientY - this.pointer.y;
      if (this.rmb) {
        this.orbit.yaw -= dx * this.orbit.sens;
        this.orbit.pitch += dy * this.orbit.sens;
        this.orbit.pitch = clamp(
          this.orbit.pitch,
          this.orbit.minPitch,
          this.orbit.maxPitch,
        );
      }
      if (this.lmb && this.dragStart) {
        const ddx = e.clientX - this.dragStart.x;
        const ddy = e.clientY - this.dragStart.y;
        if (Math.hypot(ddx, ddy) > CLICK_PX) this.didDrag = true;
      }
    }
    this.pointer.x = e.clientX;
    this.pointer.y = e.clientY;
    this.pointer.has = true;
  }

  _onWheel(e) {
    e.preventDefault();
    this.orbit.distance = clamp(
      this.orbit.distance + Math.sign(e.deltaY) * 0.8,
      this.orbit.minDistance,
      this.orbit.maxDistance,
    );
  }

  _updateOrbitCamera(dt) {
    const o = this.orbit;
    let speed = 10;
    if (o.distance > 1) speed *= o.distance / 18;

    const yaw = o.yaw;
    const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const move = new THREE.Vector3();

    if (this.keys.has('KeyW')) move.add(fwd);
    if (this.keys.has('KeyS') && !this.keys.has('ControlLeft') && !this.keys.has('ControlRight')) {
      move.sub(fwd);
    }
    if (this.keys.has('KeyQ')) move.sub(right);
    if (this.keys.has('KeyE')) move.add(right);
    if (this.keys.has('Space')) move.y += 1;
    if (this.keys.has('KeyX')) move.y -= 1;

    if (move.lengthSq() > 1e-8) {
      move.normalize().multiplyScalar(speed * dt);
      o.target.add(move);
    }
    if (o.target.y < 0) o.target.y = 0;

    this._syncCameraFromOrbit();
  }

  _syncCameraFromOrbit() {
    const o = this.orbit;
    const cp = Math.cos(o.pitch);
    this.camera.position.set(
      o.target.x + Math.sin(o.yaw) * cp * o.distance,
      o.target.y + Math.sin(o.pitch) * o.distance,
      o.target.z + Math.cos(o.yaw) * cp * o.distance,
    );
    this.camera.lookAt(o.target);
  }

  _pick() {
    if (!this.pointer.has) return null;
    const rect = this.dom.getBoundingClientRect();
    this._ndc.x = ((this.pointer.x - rect.left) / rect.width) * 2 - 1;
    this._ndc.y = -((this.pointer.y - rect.top) / rect.height) * 2 + 1;
    this._raycaster.setFromCamera(this._ndc, this.camera);

    let best = null;
    const hits = this._raycaster.intersectObjects(this.boxMeshes, false);
    if (hits.length) {
      const h = hits[0];
      best = {
        point: h.point.clone(),
        normal: h.face
          ? h.face.normal.clone().transformDirection(h.object.matrixWorld).normalize()
          : new THREE.Vector3(0, 1, 0),
        index: this.boxMeshes.indexOf(h.object),
        t: h.distance,
      };
    }

    const groundHit = this._raycaster.ray.intersectPlane(this._groundPlane, this._hitPoint);
    if (groundHit) {
      const t = this._raycaster.ray.origin.distanceTo(this._hitPoint);
      if (!best || t < best.t) {
        best = {
          point: this._hitPoint.clone(),
          normal: new THREE.Vector3(0, 1, 0),
          index: -1,
          t,
        };
      }
    }
    return best;
  }

  _pickStand() {
    const hit = this._pick();
    if (!hit) return null;
    if (hit.normal.y > 0.5) {
      return { x: hit.point.x, y: hit.point.y, z: hit.point.z };
    }
    if (hit.index >= 0 && hit.index < this.boxes.length) {
      const b = this.boxes[hit.index];
      return { x: hit.point.x, y: b.y + BOX_SIZE, z: hit.point.z };
    }
    return { x: hit.point.x, y: 0, z: hit.point.z };
  }

  _updateGhost() {
    if (this.tool !== TOOL_BOX) {
      this.ghostMesh.visible = false;
      return;
    }
    const hit = this._pick();
    if (!hit) {
      this.ghostMesh.visible = false;
      return;
    }
    const corner = snapVoxelCorner(hit.point, hit.normal);
    this.ghostMesh.position.set(corner.x, corner.y, corner.z);
    this.ghostMesh.visible = true;
  }

  _handleClick() {
    if (this.tool === TOOL_BOX) {
      this._clickBox();
      return;
    }
    const stand = this._pickStand();
    if (!stand) return;
    if (this.tool === TOOL_ENEMY) {
      this._clickEnemy(stand);
      return;
    }
    if (this.tool === TOOL_SOLDIER) {
      this._clickSoldier(stand);
    }
  }

  _clickBox() {
    const hit = this._pick();
    if (!hit) return;
    if (this.shift) {
      if (hit.index < 0) return;
      const b = this.boxes[hit.index];
      this.undo.push({ kind: 'removeBox', box: { ...b } });
      this._removeBoxAt(hit.index);
      this.onToast(`Removed box (${b.x},${b.y},${b.z})`);
    } else {
      const corner = snapVoxelCorner(hit.point, hit.normal);
      if (this._hasBox(corner.x, corner.y, corner.z)) return;
      this._addBox(corner.x, corner.y, corner.z, true);
      this.onToast(`Placed box (${corner.x},${corner.y},${corner.z})`);
    }
  }

  _clickSoldier(stand) {
    const prev = {
      had: this.hasCharacter,
      x: this.controls.position.x,
      y: this.controls.position.y,
      z: this.controls.position.z,
      yaw: this.characterYaw,
    };
    this.undo.push({ kind: 'setCharacter', ...prev });
    this.hasCharacter = true;
    this.controls.position.x = stand.x;
    this.controls.position.y = stand.y;
    this.controls.position.z = stand.z;
    this.controls.groundY = stand.y;
    this.characterYaw = this.controls.facing;
    if (this.soldierGroup) {
      this.soldierGroup.position.set(stand.x, stand.y, stand.z);
      this.soldierGroup.rotation.y = this.characterYaw;
    }
    this._applySoldierVisibility();
    this.onToast(`Soldier at (${stand.x.toFixed(1)}, ${stand.z.toFixed(1)})`);
  }

  _clickEnemy(stand) {
    if (this.shift) {
      const idx = this._nearestEnemy(stand.x, stand.y, stand.z, 1.5);
      if (idx < 0) return;
      const removed = this.enemies[idx];
      this.undo.push({
        kind: 'removeEnemy',
        enemy: { x: removed.x, y: removed.y, z: removed.z, yaw: removed.yaw },
        index: idx,
      });
      this._removeEnemyAt(idx);
      this.onToast(`Removed enemy ${idx}`);
    } else {
      const en = { x: stand.x, y: stand.y, z: stand.z, yaw: 0 };
      this._addEnemy(en.x, en.y, en.z, en.yaw, true);
      this.onToast(`Enemy at (${en.x.toFixed(1)}, ${en.z.toFixed(1)})`);
    }
  }

  _undo() {
    const op = this.undo.pop();
    if (!op) {
      this.onToast('Nothing to undo');
      return;
    }
    switch (op.kind) {
      case 'placeBox':
        this._removeBoxAtPos(op.box.x, op.box.y, op.box.z);
        break;
      case 'removeBox':
        this._addBox(op.box.x, op.box.y, op.box.z, false);
        break;
      case 'setCharacter':
        this.hasCharacter = op.had;
        if (op.had) {
          this.controls.position.x = op.x;
          this.controls.position.y = op.y;
          this.controls.position.z = op.z;
          this.characterYaw = op.yaw;
          this.controls.facing = op.yaw;
          if (this.soldierGroup) {
            this.soldierGroup.position.set(op.x, op.y, op.z);
            this.soldierGroup.rotation.y = op.yaw;
          }
        }
        this._applySoldierVisibility();
        break;
      case 'placeEnemy':
        if (op.index >= 0 && op.index < this.enemies.length) this._removeEnemyAt(op.index);
        break;
      case 'removeEnemy':
        this._addEnemy(op.enemy.x, op.enemy.y, op.enemy.z, op.enemy.yaw, false);
        break;
      default:
        break;
    }
    this.onToast('Undo');
    this._emitHud();
  }

  _addBox(x, y, z, recordUndo) {
    if (this._hasBox(x, y, z)) return;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(BOX_SIZE, BOX_SIZE, BOX_SIZE),
      this.boxMaterial,
    );
    mesh.geometry.translate(BOX_SIZE / 2, BOX_SIZE / 2, BOX_SIZE / 2);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.boxGroup.add(mesh);
    this.boxMeshes.push(mesh);
    this.boxes.push({ x, y, z });
    if (recordUndo) this.undo.push({ kind: 'placeBox', box: { x, y, z } });
    this.root.visible = true;
    this._syncSolids();
  }

  _removeBoxAt(i) {
    if (i < 0 || i >= this.boxes.length) return;
    const mesh = this.boxMeshes[i];
    this.boxGroup.remove(mesh);
    mesh.geometry.dispose();
    this.boxMeshes.splice(i, 1);
    this.boxes.splice(i, 1);
    this._syncSolids();
  }

  _removeBoxAtPos(x, y, z) {
    const i = this.boxes.findIndex((b) => b.x === x && b.y === y && b.z === z);
    if (i >= 0) this._removeBoxAt(i);
  }

  _hasBox(x, y, z) {
    return this.boxes.some((b) => b.x === x && b.y === y && b.z === z);
  }

  _clearBoxes() {
    while (this.boxes.length) this._removeBoxAt(0);
  }

  _addEnemy(x, y, z, yaw, recordUndo) {
    if (!this.enemyTemplate) {
      this.onToast('Stormtrooper not loaded');
      return;
    }
    const root = SkeletonUtils.clone(this.enemyTemplate);
    root.position.set(x, y, z);
    root.rotation.y = yaw;
    this.enemyGroup.add(root);

    let mixer = null;
    if (this._enemyClips?.length) {
      mixer = new THREE.AnimationMixer(root);
      const clip = this._enemyClips[0];
      const action = mixer.clipAction(clip);
      action.play();
    }

    const entry = { x, y, z, yaw, root, mixer };
    this.enemies.push(entry);
    if (mixer) this.enemyMixers.push(mixer);
    if (recordUndo) {
      this.undo.push({
        kind: 'placeEnemy',
        enemy: { x, y, z, yaw },
        index: this.enemies.length - 1,
      });
    }
    this.root.visible = true;
  }

  _removeEnemyAt(i) {
    if (i < 0 || i >= this.enemies.length) return;
    const e = this.enemies[i];
    this.enemyGroup.remove(e.root);
    if (e.mixer) {
      e.mixer.stopAllAction();
      const mi = this.enemyMixers.indexOf(e.mixer);
      if (mi >= 0) this.enemyMixers.splice(mi, 1);
    }
    this.enemies.splice(i, 1);
  }

  _clearEnemies() {
    while (this.enemies.length) this._removeEnemyAt(0);
  }

  _nearestEnemy(x, y, z, maxDist) {
    let best = -1;
    let bestD = maxDist;
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      const d = Math.hypot(e.x - x, e.y - y, e.z - z);
      if (d <= bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  _updateEnemyAnims(dt) {
    for (const m of this.enemyMixers) m.update(dt);
  }

  _applySoldierVisibility() {
    if (!this.soldierGroup) return;
    if (this.active) {
      this.soldierGroup.visible = this.hasCharacter;
    } else {
      this.soldierGroup.visible = true;
    }
  }

  _emitHud() {
    this.onHud({
      tool: this.tool,
      boxes: this.boxes.length,
      enemies: this.enemies.length,
      hasCharacter: this.hasCharacter,
    });
  }
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
