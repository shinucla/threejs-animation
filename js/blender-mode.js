/**
 * Blender retarget workspace:
 * 1) Load target model (GLB / FBX) onto the stage
 * 2) Add animations one-by-one (FBX → map bones → Done)
 * 3) Save model + all clips to one GLB
 */
import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

function sanitize(name) {
  return THREE.PropertyBinding.sanitizeNodeName(name || '');
}

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function collectBones(root) {
  const bones = [];
  root.traverse((obj) => {
    if (obj.isBone) bones.push(obj);
  });
  return bones;
}

function findSkinnedMesh(root) {
  let best = null;
  let bestCount = -1;
  root.traverse((obj) => {
    if (!obj.isSkinnedMesh) return;
    const n = obj.skeleton?.bones?.length ?? 0;
    if (n > bestCount) {
      best = obj;
      bestCount = n;
    }
  });
  return best;
}

function stripMeshes(root) {
  const remove = [];
  root.traverse((obj) => {
    if (obj.isMesh || obj.isSkinnedMesh) remove.push(obj);
  });
  for (const obj of remove) {
    obj.parent?.remove(obj);
    obj.geometry?.dispose?.();
    const mats = obj.material
      ? Array.isArray(obj.material)
        ? obj.material
        : [obj.material]
      : [];
    for (const m of mats) m.dispose?.();
  }
  return remove.length;
}

function guessHipName(boneNames) {
  const preferred = ['mixamorigHips', 'Hips', 'hips', 'pelvis', 'Pelvis', 'root', 'Root'];
  for (const name of preferred) {
    if (boneNames.includes(name)) return name;
  }
  return boneNames[0] || '';
}

function autoMapNames(targetNames, sourceNames) {
  const sourceSet = new Set(sourceNames);
  const sourceLower = new Map(sourceNames.map((n) => [n.toLowerCase(), n]));
  const map = Object.create(null);
  for (const t of targetNames) {
    if (sourceSet.has(t)) {
      map[t] = t;
      continue;
    }
    const lower = sourceLower.get(t.toLowerCase());
    if (lower) {
      map[t] = lower;
      continue;
    }
    const stripped = t.replace(/^mixamorig/i, '');
    const hit = sourceNames.find(
      (s) => s.replace(/^mixamorig/i, '').toLowerCase() === stripped.toLowerCase(),
    );
    if (hit) map[t] = hit;
  }
  return map;
}

function uniqueClipName(desired, existing) {
  const base = (desired || 'Animation').trim() || 'Animation';
  if (!existing.has(base)) return base;
  let i = 2;
  while (existing.has(`${base}_${i}`)) i += 1;
  return `${base}_${i}`;
}

/** Preview / play scrub speed (1 = realtime). */
const PREVIEW_TIME_SCALE = 0.5;

/**
 * Freeze hips horizontal translation (X/Z). Y (height) is kept so jumps still
 * move vertically. Mixamo "In Place" is not a file flag — it's whether the
 * hips .position track contains travel; we bake the lock here.
 */
function applyInPlace(clip, hipBoneName) {
  if (!clip || !hipBoneName) return clip;
  for (const track of clip.tracks) {
    if (!(track instanceof THREE.VectorKeyframeTrack)) continue;
    if (!track.name.endsWith('.position')) continue;
    const bone = track.name.slice(0, -'.position'.length);
    const isHip =
      bone === hipBoneName ||
      track.name === `.bones[${hipBoneName}].position`;
    if (!isHip) continue;

    const values = track.values;
    if (values.length < 3) continue;
    const x0 = values[0];
    const z0 = values[2];
    for (let i = 0; i < values.length; i += 3) {
      values[i] = x0;
      values[i + 2] = z0;
    }
  }
  return clip;
}

/**
 * Apply per-bone local Euler offsets (degrees, XYZ) after retarget:
 * q' = correction * q
 */
function applyBoneAdjustments(clip, boneAdjust) {
  if (!clip || !boneAdjust) return clip;

  const q = new THREE.Quaternion();
  const corr = new THREE.Quaternion();
  const out = new THREE.Quaternion();
  const prev = new THREE.Quaternion();
  const euler = new THREE.Euler();

  for (const track of clip.tracks) {
    if (!(track instanceof THREE.QuaternionKeyframeTrack)) continue;
    if (!track.name.endsWith('.quaternion')) continue;
    const boneName = track.name.slice(0, -'.quaternion'.length);
    const adj = boneAdjust[boneName];
    if (!adj) continue;
    const rx = adj.rx || 0;
    const ry = adj.ry || 0;
    const rz = adj.rz || 0;
    if (rx === 0 && ry === 0 && rz === 0) continue;

    euler.set(
      THREE.MathUtils.degToRad(rx),
      THREE.MathUtils.degToRad(ry),
      THREE.MathUtils.degToRad(rz),
      'XYZ',
    );
    corr.setFromEuler(euler);

    for (let i = 0; i < track.values.length; i += 4) {
      q.fromArray(track.values, i);
      out.copy(corr).multiply(q);
      if (i >= 4) {
        prev.fromArray(track.values, i - 4);
        if (prev.dot(out) < 0) out.set(-out.x, -out.y, -out.z, -out.w);
      }
      out.toArray(track.values, i);
    }
  }
  return clip;
}

function emptyAdjust() {
  return { rx: 0, ry: 0, rz: 0 };
}

let nextEntryId = 1;

export class BlenderMode {
  constructor({ scene, camera, panel }) {
    this.scene = scene;
    this.camera = camera;
    this.panel = panel;
    this.addSheet = document.getElementById('blender-add-sheet');

    this.root = new THREE.Group();
    this.root.name = 'BlenderWorkspace';
    this.root.visible = false;
    scene.add(this.root);

    this.modelRoot = null;
    this.targetMesh = null;
    this.targetBones = [];
    this.hipName = '';
    this.modelFileName = '';

    /** @type {{ id: number, name: string, clip: THREE.AnimationClip, sourceLabel: string }[]} */
    this.entries = [];

    this.draft = null; // in-progress add-animation state
    this.mixer = null;
    this.previewAction = null;
    this.playingEntryId = null;

    this._savedCam = null;
    this.fbxLoader = new FBXLoader();
    this.gltfLoader = new GLTFLoader();
    this._orbit = { active: false, x: 0, y: 0, target: new THREE.Vector3(0, 0.9, 0) };

    this._bindDom();
    this._bindOrbit();
    this._refreshMainUi();
  }

  _bindOrbit() {
    const el = document.getElementById('container');
    if (!el) return;

    el.addEventListener('pointerdown', (e) => {
      if (!this.root.visible || e.button !== 0) return;
      if (e.target.closest?.('#blender-panel, #blender-add-sheet, #status-bar')) return;
      this._orbit.active = true;
      this._orbit.x = e.clientX;
      this._orbit.y = e.clientY;
      el.setPointerCapture?.(e.pointerId);
    });
    el.addEventListener('pointerup', () => {
      this._orbit.active = false;
    });
    el.addEventListener('pointermove', (e) => {
      if (!this._orbit.active || !this.root.visible) return;
      const dx = e.clientX - this._orbit.x;
      const dy = e.clientY - this._orbit.y;
      this._orbit.x = e.clientX;
      this._orbit.y = e.clientY;
      const offset = this.camera.position.clone().sub(this._orbit.target);
      const spherical = new THREE.Spherical().setFromVector3(offset);
      spherical.theta -= dx * 0.005;
      spherical.phi = THREE.MathUtils.clamp(spherical.phi - dy * 0.005, 0.15, Math.PI - 0.15);
      this.camera.position.copy(this._orbit.target).add(
        new THREE.Vector3().setFromSpherical(spherical),
      );
      this.camera.lookAt(this._orbit.target);
    });
    el.addEventListener(
      'wheel',
      (e) => {
        if (!this.root.visible) return;
        e.preventDefault();
        const offset = this.camera.position.clone().sub(this._orbit.target);
        const len = offset.length() * (1 + e.deltaY * 0.001);
        offset.setLength(THREE.MathUtils.clamp(len, 0.4, 40));
        this.camera.position.copy(this._orbit.target).add(offset);
      },
      { passive: false },
    );
  }

  _bindDom() {
    this.els = {
      modelFile: this.panel.querySelector('#blender-model-file'),
      modelStatus: this.panel.querySelector('#blender-model-status'),
      animList: this.panel.querySelector('#blender-anim-list'),
      animCount: this.panel.querySelector('#blender-anim-count'),
      addAnimBtn: this.panel.querySelector('#blender-add-anim'),
      exportGlb: this.panel.querySelector('#blender-export-glb'),
      status: this.panel.querySelector('#blender-status'),

      animFile: this.addSheet?.querySelector('#blender-anim-file'),
      animStatus: this.addSheet?.querySelector('#blender-anim-status'),
      clipSelect: this.addSheet?.querySelector('#blender-clip-select'),
      clipName: this.addSheet?.querySelector('#blender-clip-name'),
      mapList: this.addSheet?.querySelector('#blender-bone-map'),
      mapStats: this.addSheet?.querySelector('#blender-map-stats'),
      autoBtn: this.addSheet?.querySelector('#blender-auto-map'),
      clearBtn: this.addSheet?.querySelector('#blender-clear-map'),
      resetAdjustBtn: this.addSheet?.querySelector('#blender-reset-adjust'),
      previewBtn: this.addSheet?.querySelector('#blender-preview'),
      cancelBtn: this.addSheet?.querySelector('#blender-add-cancel'),
      doneBtn: this.addSheet?.querySelector('#blender-add-done'),
      addStatus: this.addSheet?.querySelector('#blender-add-status'),
      inplace: this.addSheet?.querySelector('#blender-inplace'),
    };

    this.els.modelFile?.addEventListener('change', (e) => this._onModelFile(e));
    this.els.addAnimBtn?.addEventListener('click', () => this._openAddSheet());
    this.els.exportGlb?.addEventListener('click', () => this._exportGlb());

    this.els.animFile?.addEventListener('change', (e) => this._onAnimFile(e));
    this.els.autoBtn?.addEventListener('click', () => this._autoMap());
    this.els.clearBtn?.addEventListener('click', () => this._clearMap());
    this.els.resetAdjustBtn?.addEventListener('click', () => this._resetAdjusts());
    this.els.previewBtn?.addEventListener('click', () => this._previewDraft());
    this.els.cancelBtn?.addEventListener('click', () => this._closeAddSheet(false));
    this.els.doneBtn?.addEventListener('click', () => this._commitDraft());
    this.els.inplace?.addEventListener('change', () => {
      if (!this.draft) return;
      this.draft.retargetedClip = null;
      this._setAddStatus(
        this.els.inplace.checked
          ? 'In place on — horizontal root motion will be locked.'
          : 'In place off — root travel from the FBX is kept.',
      );
    });
    this.els.clipSelect?.addEventListener('change', () => {
      if (!this.draft) return;
      this.draft.retargetedClip = null;
      const clip = this._selectedSourceClip();
      if (clip && this.els.clipName && !this.els.clipName.dataset.touched) {
        this.els.clipName.value = clip.name || 'Animation';
      }
      this._setAddStatus('Clip changed — preview or Done to retarget.');
    });
    this.els.clipName?.addEventListener('input', () => {
      if (this.els.clipName) this.els.clipName.dataset.touched = '1';
    });
  }

  setActive(active) {
    if (this.panel) {
      this.panel.hidden = !active;
      if (active) {
        this.panel.removeAttribute('hidden');
        this.panel.style.display = 'flex';
      } else {
        this.panel.style.display = '';
      }
    }
    this.root.visible = active;

    if (!active) {
      this._closeAddSheet(false);
      this._stopPreview();
    }

    if (active) {
      this._savedCam = {
        position: this.camera.position.clone(),
        quaternion: this.camera.quaternion.clone(),
        near: this.camera.near,
        far: this.camera.far,
      };
      this.camera.position.set(2.2, 1.4, 2.8);
      this.camera.near = 0.05;
      this.camera.far = 200;
      this.camera.updateProjectionMatrix();
      this.camera.lookAt(0, 0.9, 0);
      if (this.modelRoot) this._fitCamera();
    } else if (this._savedCam) {
      this.camera.position.copy(this._savedCam.position);
      this.camera.quaternion.copy(this._savedCam.quaternion);
      this.camera.near = this._savedCam.near;
      this.camera.far = this._savedCam.far;
      this.camera.updateProjectionMatrix();
      this._savedCam = null;
    }
  }

  update(delta) {
    if (this.mixer) this.mixer.update(delta);
  }

  _setStatus(msg) {
    if (this.els.status) this.els.status.textContent = msg;
  }

  _setAddStatus(msg) {
    if (this.els.addStatus) this.els.addStatus.textContent = msg;
  }

  _refreshMainUi() {
    const hasModel = !!this.targetMesh;
    const n = this.entries.length;
    if (this.els.animCount) this.els.animCount.textContent = String(n);
    if (this.els.addAnimBtn) this.els.addAnimBtn.disabled = !hasModel;
    if (this.els.exportGlb) this.els.exportGlb.disabled = !hasModel || n < 1;
    this._renderAnimList();
  }

  _renderAnimList() {
    const list = this.els.animList;
    if (!list) return;
    list.innerHTML = '';
    if (!this.entries.length) {
      list.innerHTML = '<p class="blender-empty">No animations yet.</p>';
      return;
    }
    for (const entry of this.entries) {
      const row = document.createElement('div');
      row.className = 'blender-anim-item';
      if (entry.id === this.playingEntryId) row.classList.add('is-playing');

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = entry.name;
      name.title = entry.sourceLabel;

      const dur = document.createElement('span');
      dur.className = 'dur';
      dur.textContent = `${entry.clip.duration.toFixed(2)}s`;

      const playBtn = document.createElement('button');
      playBtn.type = 'button';
      playBtn.className = 'btn btn-ghost';
      playBtn.textContent = 'Play';
      playBtn.addEventListener('click', () => this._playEntry(entry.id));

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn btn-ghost';
      delBtn.textContent = '×';
      delBtn.title = 'Remove';
      delBtn.addEventListener('click', () => this._removeEntry(entry.id));

      row.append(name, dur, playBtn, delBtn);
      // fix grid: name | dur | play | delete — update CSS to 4 cols or nest buttons
      row.style.gridTemplateColumns = '1fr auto auto auto';
      list.appendChild(row);
    }
  }

  async _onModelFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      this._setStatus(`Loading ${file.name}…`);
      this._closeAddSheet(false);
      this._stopPreview();

      if (this.modelRoot) {
        this.root.remove(this.modelRoot);
        this.modelRoot = null;
      }
      this.entries = [];
      this.targetMesh = null;
      this.targetBones = [];

      const lower = file.name.toLowerCase();
      let root;
      if (lower.endsWith('.glb') || lower.endsWith('.gltf')) {
        root = await this._readGltf(file);
      } else if (lower.endsWith('.fbx')) {
        root = await this._readFbx(file);
        // Mixamo FBX is usually cm
        root.scale.setScalar(0.01);
        root.updateMatrixWorld(true);
      } else {
        throw new Error('Use a .glb, .gltf, or .fbx model file.');
      }

      root.traverse((obj) => {
        if (obj.name) obj.name = sanitize(obj.name);
      });

      this.modelRoot = root;
      this.root.add(root);
      this.targetMesh = findSkinnedMesh(root);
      if (!this.targetMesh) {
        this.els.modelStatus.textContent = 'No skinned mesh found.';
        this._setStatus('Model needs a SkinnedMesh.');
        this._refreshMainUi();
        return;
      }

      this.targetMesh.skeleton.pose();
      root.updateMatrixWorld(true);
      root.skeleton = this.targetMesh.skeleton;

      this.targetBones = collectBones(root).map((b) => b.name);
      this.hipName = guessHipName(this.targetBones);
      this.modelFileName = file.name;

      this._fitCamera();
      this.els.modelStatus.textContent = `${file.name} · ${this.targetBones.length} bones · hip ${this.hipName || '—'}`;
      this._setStatus('Model on stage. Add animations, then Save GLB.');
      this._refreshMainUi();
    } catch (err) {
      console.error(err);
      this.els.modelStatus.textContent = 'Failed to load.';
      this._setStatus(String(err.message || err));
      this._refreshMainUi();
    }
  }

  async _readFbx(file) {
    const buffer = await file.arrayBuffer();
    return this.fbxLoader.parse(buffer, '');
  }

  async _readGltf(file) {
    const buffer = await file.arrayBuffer();
    const gltf = await this.gltfLoader.parseAsync(buffer, '');
    return gltf.scene;
  }

  _fitCamera() {
    if (!this.modelRoot) return;
    const box = new THREE.Box3().setFromObject(this.modelRoot);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z, 0.5);
    this._orbit.target.copy(center);
    this.camera.position.set(
      center.x + radius * 1.6,
      center.y + radius * 0.6,
      center.z + radius * 1.8,
    );
    this.camera.lookAt(center);
  }

  _openAddSheet() {
    if (!this.targetMesh) {
      this._setStatus('Load a model first.');
      return;
    }
    this.draft = {
      animRoot: null,
      sourceBones: [],
      sourceClips: [],
      boneMap: Object.create(null),
      boneAdjust: Object.create(null), // targetBone -> { rx, ry, rz } degrees
      retargetedClip: null,
      sourceFileName: '',
    };
    if (this.els.animFile) this.els.animFile.value = '';
    if (this.els.clipName) {
      this.els.clipName.value = '';
      delete this.els.clipName.dataset.touched;
    }
    if (this.els.clipSelect) this.els.clipSelect.innerHTML = '';
    if (this.els.animStatus) {
      this.els.animStatus.textContent = 'Embedded meshes are ignored — skeleton + clips only.';
    }
    this._renderMap();
    this._setAddStatus('Choose an animation FBX.');
    if (this.addSheet) {
      this.addSheet.hidden = false;
      this.addSheet.removeAttribute('hidden');
      this.addSheet.style.display = 'flex';
    }
  }

  _closeAddSheet(keepPreview) {
    if (this.addSheet) {
      this.addSheet.hidden = true;
      this.addSheet.style.display = '';
    }
    this.draft = null;
    if (!keepPreview) this._stopPreview();
  }

  async _onAnimFile(event) {
    const file = event.target.files?.[0];
    if (!file || !this.draft) return;

    try {
      this._setAddStatus(`Loading ${file.name}…`);
      const fbx = await this._readFbx(file);
      fbx.traverse((obj) => {
        if (obj.name) obj.name = sanitize(obj.name);
      });

      const stripped = stripMeshes(fbx);
      const bones = collectBones(fbx);
      if (!bones.length) throw new Error('Animation FBX has no bones.');

      fbx.skeleton = new THREE.Skeleton(bones);
      fbx.updateMatrixWorld(true);

      this.draft.animRoot = fbx;
      this.draft.sourceBones = bones.map((b) => b.name);
      this.draft.sourceClips = fbx.animations?.length ? [...fbx.animations] : [];
      this.draft.sourceFileName = file.name;
      this.draft.retargetedClip = null;
      this.draft.boneMap = Object.create(null);
      this.draft.boneAdjust = Object.create(null);

      if (this.els.clipSelect) {
        this.els.clipSelect.innerHTML = '';
        if (!this.draft.sourceClips.length) {
          const opt = document.createElement('option');
          opt.value = '';
          opt.textContent = 'No clips in file';
          this.els.clipSelect.appendChild(opt);
        } else {
          this.draft.sourceClips.forEach((clip, i) => {
            const opt = document.createElement('option');
            opt.value = String(i);
            opt.textContent = `${clip.name || `Clip ${i}`} (${clip.duration.toFixed(2)}s)`;
            this.els.clipSelect.appendChild(opt);
          });
        }
      }

      const first = this.draft.sourceClips[0];
      if (this.els.clipName && first) {
        this.els.clipName.value = first.name || file.name.replace(/\.fbx$/i, '');
        delete this.els.clipName.dataset.touched;
      }

      this.els.animStatus.textContent = `${file.name} · ${this.draft.sourceBones.length} bones · ${this.draft.sourceClips.length} clip(s)${stripped ? ` · ignored ${stripped} mesh(es)` : ''}`;
      this._autoMap();
      this._setAddStatus('Map bones, Preview, then Done.');
    } catch (err) {
      console.error(err);
      this.els.animStatus.textContent = 'Failed to load.';
      this._setAddStatus(String(err.message || err));
    }
  }

  _selectedSourceClip() {
    if (!this.draft) return null;
    const i = Number(this.els.clipSelect?.value ?? 0);
    return this.draft.sourceClips[i] || null;
  }

  _autoMap() {
    if (!this.draft || !this.targetBones.length || !this.draft.sourceBones.length) {
      this._setAddStatus('Load model and animation first.');
      return;
    }
    this.draft.boneMap = autoMapNames(this.targetBones, this.draft.sourceBones);
    // Keep adjusts only for bones that are still mapped.
    const nextAdjust = Object.create(null);
    for (const target of Object.keys(this.draft.boneMap)) {
      nextAdjust[target] = this.draft.boneAdjust[target]
        ? { ...this.draft.boneAdjust[target] }
        : emptyAdjust();
    }
    this.draft.boneAdjust = nextAdjust;
    this.draft.retargetedClip = null;
    this.hipName = guessHipName(this.targetBones);
    this._renderMap();
    const n = Object.keys(this.draft.boneMap).length;
    this._setAddStatus(`Auto-mapped ${n} / ${this.targetBones.length} bones.`);
  }

  _clearMap() {
    if (!this.draft) return;
    this.draft.boneMap = Object.create(null);
    this.draft.boneAdjust = Object.create(null);
    this.draft.retargetedClip = null;
    this._renderMap();
    this._setAddStatus('Bone map cleared.');
  }

  _resetAdjusts() {
    if (!this.draft) return;
    for (const target of Object.keys(this.draft.boneMap)) {
      this.draft.boneAdjust[target] = emptyAdjust();
    }
    this.draft.retargetedClip = null;
    this._renderMap();
    this._setAddStatus('Rotation offsets reset to 0.');
    this._scheduleLivePreview();
  }

  _setBoneAdjust(targetName, axis, value) {
    if (!this.draft) return;
    if (!this.draft.boneMap[targetName]) return;
    if (!this.draft.boneAdjust[targetName]) {
      this.draft.boneAdjust[targetName] = emptyAdjust();
    }
    const n = Number(value);
    this.draft.boneAdjust[targetName][axis] = Number.isFinite(n) ? n : 0;
    this.draft.retargetedClip = null;
    this._scheduleLivePreview();
  }

  _nudgeBoneAdjust(targetName, axis, delta) {
    if (!this.draft?.boneMap[targetName]) return;
    const cur = this.draft.boneAdjust[targetName] || emptyAdjust();
    this._setBoneAdjust(targetName, axis, (cur[axis] || 0) + delta);
    this._renderMap();
  }

  _scheduleLivePreview() {
    if (!this.previewAction) return;
    clearTimeout(this._livePreviewTimer);
    this._livePreviewTimer = setTimeout(() => {
      if (this.draft && this.previewAction) this._previewDraft({ quiet: true });
    }, 120);
  }

  _renderMap() {
    const list = this.els.mapList;
    if (!list) return;
    list.innerHTML = '';

    if (!this.targetBones.length) {
      list.innerHTML = '<p class="blender-empty">Load a target model first.</p>';
      return;
    }
    if (!this.draft?.sourceBones?.length) {
      list.innerHTML = '<p class="blender-empty">Load an animation FBX to map bones.</p>';
      if (this.els.mapStats) this.els.mapStats.textContent = '';
      return;
    }

    const sourceOptions = ['', ...this.draft.sourceBones];
    for (const targetName of this.targetBones) {
      const mapped = !!this.draft.boneMap[targetName];
      const adj = this.draft.boneAdjust[targetName] || emptyAdjust();

      const row = document.createElement('div');
      row.className = 'blender-map-row';

      const main = document.createElement('div');
      main.className = 'blender-map-main';

      const left = document.createElement('span');
      left.className = 'blender-map-target';
      left.textContent = targetName;
      left.title = targetName;

      const select = document.createElement('select');
      select.dataset.target = targetName;
      for (const src of sourceOptions) {
        const opt = document.createElement('option');
        opt.value = src;
        opt.textContent = src || '— unmapped —';
        if ((this.draft.boneMap[targetName] || '') === src) opt.selected = true;
        select.appendChild(opt);
      }
      select.addEventListener('change', () => {
        if (select.value) {
          this.draft.boneMap[targetName] = select.value;
          if (!this.draft.boneAdjust[targetName]) {
            this.draft.boneAdjust[targetName] = emptyAdjust();
          }
        } else {
          delete this.draft.boneMap[targetName];
          delete this.draft.boneAdjust[targetName];
        }
        this.draft.retargetedClip = null;
        this._updateMapStats();
        this._renderMap();
        this._scheduleLivePreview();
      });

      main.append(left, select);

      const adjust = document.createElement('div');
      adjust.className = 'blender-map-adjust';
      if (!mapped) adjust.hidden = true;

      for (const axis of ['rx', 'ry', 'rz']) {
        const wrap = document.createElement('label');
        wrap.className = 'blender-axis';
        const tag = document.createElement('span');
        tag.textContent = axis.toUpperCase();
        const input = document.createElement('input');
        input.type = 'number';
        input.step = '1';
        input.value = String(adj[axis] || 0);
        input.title = `${axis.toUpperCase()} offset degrees (local)`;
        input.addEventListener('change', () => {
          this._setBoneAdjust(targetName, axis, input.value);
        });
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            this._setBoneAdjust(targetName, axis, input.value);
            this._previewDraft({ quiet: true });
          }
        });
        wrap.append(tag, input);
        adjust.appendChild(wrap);
      }

      const twistBtn = document.createElement('button');
      twistBtn.type = 'button';
      twistBtn.className = 'btn';
      twistBtn.textContent = '+180Y';
      twistBtn.title = 'Add 180° around local Y (common limb twist fix)';
      twistBtn.addEventListener('click', () => {
        this._nudgeBoneAdjust(targetName, 'ry', 180);
      });

      const zeroBtn = document.createElement('button');
      zeroBtn.type = 'button';
      zeroBtn.className = 'btn btn-ghost';
      zeroBtn.textContent = '0';
      zeroBtn.title = 'Zero this bone’s offsets';
      zeroBtn.addEventListener('click', () => {
        this.draft.boneAdjust[targetName] = emptyAdjust();
        this.draft.retargetedClip = null;
        this._renderMap();
        this._scheduleLivePreview();
      });

      adjust.append(twistBtn, zeroBtn);
      row.append(main, adjust);
      list.appendChild(row);
    }
    this._updateMapStats();
  }

  _updateMapStats() {
    if (!this.els.mapStats || !this.draft) return;
    const n = Object.keys(this.draft.boneMap).length;
    const tuned = Object.values(this.draft.boneAdjust || {}).filter(
      (a) => a && (a.rx || a.ry || a.rz),
    ).length;
    this.els.mapStats.textContent =
      tuned > 0
        ? `${n} / ${this.targetBones.length} mapped · ${tuned} tuned`
        : `${n} / ${this.targetBones.length} mapped`;
  }

  _buildRetargetedClip() {
    if (!this.targetMesh || !this.draft?.animRoot) {
      throw new Error('Load model and animation first.');
    }
    const sourceClip = this._selectedSourceClip();
    if (!sourceClip) throw new Error('No animation clip selected.');
    if (!Object.keys(this.draft.boneMap).length) {
      throw new Error('Map at least one bone (try Auto-map).');
    }

    const hip = this.hipName || guessHipName(this.targetBones);
    const names = Object.create(null);
    for (const [target, source] of Object.entries(this.draft.boneMap)) {
      names[target] = source;
    }

    const probe = SkeletonUtils.clone(this.modelRoot);
    const probeMesh = findSkinnedMesh(probe);
    if (!probeMesh) throw new Error('Clone lost skinned mesh.');
    probeMesh.skeleton.pose();
    probe.updateMatrixWorld(true);

    const probeNames = Object.create(null);
    for (const bone of probeMesh.skeleton.bones) {
      if (names[bone.name]) probeNames[bone.name] = names[bone.name];
    }

    const retargeted = SkeletonUtils.retargetClip(probeMesh, this.draft.animRoot, sourceClip, {
      hip,
      names: probeNames,
      useTargetMatrix: true,
      preserveBonePositions: true,
      useFirstFramePosition: true,
      fps: 30,
    });

    const tracks = retargeted.tracks.map((track) => {
      const cloned = track.clone();
      const match = track.name.match(/^\.bones\[(.+)\]\.(.+)$/);
      if (match) cloned.name = `${match[1]}.${match[2]}`;
      return cloned;
    });

    const desired =
      this.els.clipName?.value?.trim() ||
      sourceClip.name ||
      'Animation';
    let clip = new THREE.AnimationClip(desired, retargeted.duration, tracks);

    applyBoneAdjustments(clip, this.draft.boneAdjust);

    if (this.els.inplace?.checked) {
      applyInPlace(clip, hip);
    }

    this.draft.retargetedClip = clip;
    return clip;
  }

  _stopPreview() {
    if (this.previewAction) {
      this.previewAction.stop();
      this.previewAction = null;
    }
    if (this.mixer) {
      this.mixer.stopAllAction();
      this.mixer = null;
    }
    this.playingEntryId = null;
    if (this.targetMesh?.skeleton) {
      this.targetMesh.skeleton.pose();
      this.modelRoot?.updateMatrixWorld(true);
    }
    this._renderAnimList();
  }

  _previewDraft(opts = {}) {
    try {
      // Always rebuild so inplace / bone adjusts are applied.
      this.draft.retargetedClip = null;
      const clip = this._buildRetargetedClip();
      this._stopPreview();
      this.mixer = new THREE.AnimationMixer(this.modelRoot);
      this.previewAction = this.mixer.clipAction(clip);
      this.previewAction.reset();
      this.previewAction.setEffectiveTimeScale(PREVIEW_TIME_SCALE);
      this.previewAction.setLoop(THREE.LoopRepeat, Infinity);
      this.previewAction.play();
      if (!opts.quiet) {
        const inplace = this.els.inplace?.checked ? ', in-place' : '';
        const tuned = Object.values(this.draft.boneAdjust || {}).filter(
          (a) => a && (a.rx || a.ry || a.rz),
        ).length;
        const tune = tuned ? `, ${tuned} bone offset(s)` : '';
        this._setAddStatus(
          `Previewing “${clip.name}” @ ${PREVIEW_TIME_SCALE}x${inplace}${tune} (${clip.duration.toFixed(2)}s).`,
        );
      }
    } catch (err) {
      console.error(err);
      this._setAddStatus(String(err.message || err));
    }
  }

  _playEntry(id) {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry || !this.modelRoot) return;
    this._stopPreview();
    this.mixer = new THREE.AnimationMixer(this.modelRoot);
    this.previewAction = this.mixer.clipAction(entry.clip);
    this.previewAction.reset();
    this.previewAction.setEffectiveTimeScale(PREVIEW_TIME_SCALE);
    this.previewAction.setLoop(THREE.LoopRepeat, Infinity);
    this.previewAction.play();
    this.playingEntryId = id;
    this._renderAnimList();
    this._setStatus(`Playing “${entry.name}” @ ${PREVIEW_TIME_SCALE}x.`);
  }

  _removeEntry(id) {
    this.entries = this.entries.filter((e) => e.id !== id);
    if (this.playingEntryId === id) this._stopPreview();
    this._refreshMainUi();
    this._setStatus(`Removed animation. ${this.entries.length} remaining.`);
  }

  _commitDraft() {
    try {
      const clip = this.draft?.retargetedClip || this._buildRetargetedClip();
      const existing = new Set(this.entries.map((e) => e.name));
      const name = uniqueClipName(clip.name, existing);
      clip.name = name;

      this.entries.push({
        id: nextEntryId++,
        name,
        clip,
        sourceLabel: this.draft.sourceFileName || 'FBX',
      });

      this._closeAddSheet(true);
      this._playEntry(this.entries[this.entries.length - 1].id);
      this._refreshMainUi();
      this._setStatus(`Added “${name}”. ${this.entries.length} animation(s) ready.`);
    } catch (err) {
      console.error(err);
      this._setAddStatus(String(err.message || err));
    }
  }

  async _exportGlb() {
    try {
      if (!this.modelRoot || !this.targetMesh) {
        throw new Error('Load a target model first.');
      }
      if (!this.entries.length) {
        throw new Error('Add at least one animation.');
      }

      this._stopPreview();
      const exportRoot = SkeletonUtils.clone(this.modelRoot);
      exportRoot.updateMatrixWorld(true);
      const clips = this.entries.map((e) => e.clip);

      const base = (this.modelFileName || 'retargeted').replace(/\.[^.]+$/, '');
      const exporter = new GLTFExporter();
      const buffer = await exporter.parseAsync(exportRoot, {
        binary: true,
        animations: clips,
      });
      downloadBlob(`${base}.glb`, new Blob([buffer], { type: 'model/gltf-binary' }));
      this._setStatus(`Saved ${base}.glb with ${clips.length} animation(s).`);
    } catch (err) {
      console.error(err);
      this._setStatus(String(err.message || err));
    }
  }
}
