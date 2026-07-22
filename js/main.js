import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { WowControls } from './wow-controls.js';
import { BlenderMode } from './blender-mode.js';
import { EditorMode } from './editor-mode.js';
import { VPGLayer } from './vpg-layer.js';
import { getWorldSolidCount } from './world-solids.js';
import {
  findSkinnedMesh,
  retargetMixamoClip,
  sanitizeTree,
} from './mixamo-retarget.js';

const PI = Math.PI;
const PI90 = Math.PI / 2;
const FADE = 0.35;
/** Matches engine2 scene.go: held [ / ] nudge VPG by ±0.35 per second. */
const VPG_NUDGE_PER_SEC = 0.35;
const _boneWorld = new THREE.Vector3();
const _drawSize = new THREE.Vector2();

let scene, renderer, camera, floor, clock;
let group, followGroup, model, mixer;
let actions, currentAction = 'Idle';
let controls;
let vpgLayer;
let lastLoggedVPG = -1;
let lastLoggedSolids = -1;
let blenderMode = null;
let editorMode = null;
let appMode = 'run';
let soldierMesh = null;

const ANIM_SOURCES = {
  Idle: 'assets/animations/mixamo-idle.fbx',
  Run: 'assets/animations/mixamo-run.fbx',
  Jump: 'assets/animations/mixamo-jump2.fbx',
  Crouch: 'assets/animations/mixamo-crouch.fbx',
  Prone: 'assets/animations/mixamo-prone.fbx',
};

const WEAPON_URL = 'assets/models/AK-47.fbx';

let weapon = null;

init();

function findBoneByNames(root, names) {
  const want = new Set(names);
  let found = null;
  root.traverse((obj) => {
    if (found || !obj.isBone) return;
    if (want.has(obj.name)) found = obj;
  });
  return found;
}

/** Grip in Mixamo RightHand cm space (rotation tuned by hand). */
function applyAkGrip(gun) {
  const m = new THREE.Matrix4()
    .makeTranslation(2, 6, 4)
    .multiply(new THREE.Matrix4().makeRotationX(-PI90 * 1.0))
    .multiply(new THREE.Matrix4().makeRotationZ(-PI90 * 1.0))
    .multiply(new THREE.Matrix4().makeRotationY(-PI90 * 1.0));
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  m.decompose(pos, quat, scl);
  gun.position.copy(pos);
  gun.quaternion.copy(quat);
  // Mesh pivot is not at the pistol grip — slide along barrel (~forearm length)
  // so the handle sits in the hand instead of near the elbow.
    gun.translateZ(-1);
    gun.translateX(25);
}

/**
 * Parent a static prop to the Mixamo right hand.
 * Soldier root is scaled 0.01 (cm→m); bone-local units stay in cm.
 */
async function mountAk47(soldierRoot) {
  const hand = findBoneByNames(soldierRoot, [
    'mixamorigRightHand',
    'RightHand',
    'mixamorig_RightHand',
  ]);
  if (!hand) throw new Error('RightHand bone not found on soldier');

  const gun = await loadFbx(WEAPON_URL);
  sanitizeTree(gun);

  gun.updateMatrixWorld(true);
  const size = new THREE.Box3().setFromObject(gun).getSize(new THREE.Vector3());
  const longest = Math.max(size.x, size.y, size.z, 1e-3);
  // 140cm * 2/3 ≈ 93cm bone-local after the 2× upsizing.
  const targetCm = 93;
  if (longest < 5) {
    // Authored in meters.
    gun.scale.multiplyScalar((targetCm / longest) * 100);
  } else {
    gun.scale.multiplyScalar(targetCm / longest);
  }

  gun.traverse((obj) => {
    if (!obj.isMesh) return;
    obj.castShadow = true;
    obj.receiveShadow = true;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of mats) {
      if (!m) continue;
      m.side = THREE.DoubleSide;
      if (m.map) m.map.colorSpace = THREE.SRGBColorSpace;
    }
  });

  hand.add(gun);
  applyAkGrip(gun);
  weapon = gun;
  return gun;
}

function init() {
  const container = document.getElementById('container');

  camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);

  clock = new THREE.Clock();

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x5e5d5d);
  scene.fog = new THREE.Fog(0x5e5d5d, 2, 20);

  group = new THREE.Group();
  scene.add(group);

  followGroup = new THREE.Group();
  scene.add(followGroup);

  const dirLight = new THREE.DirectionalLight(0xffffff, 5);
  dirLight.position.set(-2, 5, -3);
  dirLight.castShadow = true;
  const cam = dirLight.shadow.camera;
  cam.top = cam.right = 2;
  cam.bottom = cam.left = -2;
  cam.near = 3;
  cam.far = 8;
  dirLight.shadow.mapSize.set(1024, 1024);
  followGroup.add(dirLight);
  followGroup.add(dirLight.target);

  scene.add(new THREE.AmbientLight(0xffffff, 0.35));

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setAnimationLoop(animate);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.5;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  container.appendChild(renderer.domElement);

  vpgLayer = new VPGLayer(renderer);
  updateVpgHud(true);

  controls = new WowControls({
    walkSpeed: 5,
    // Apex cut by ~1/3 vs prior 5.0 (height ∝ v² → v *= √(2/3)).
    jumpSpeed: 4.08,
    // Run-jump travel ≈ 3 box widths.
    jumpForwardScale: 0.72,
    gravity: 12,
    eyeHeight: 1.0,
  });
  controls.attach(renderer.domElement);
  controls.distance = 5;
  // Camera behind on −Z; Mixamo mesh faces +Z, so facing=0 shows the back.
  controls.yaw = Math.PI;
  controls.pitch = 0.45;
  controls.facing = 0;

  window.addEventListener('resize', onWindowResize);

  window.addEventListener('app:set-mode', (e) => {
    setAppMode(e.detail?.mode);
  });

  blenderMode = new BlenderMode({
    scene,
    camera,
    panel: document.getElementById('blender-panel'),
  });

  editorMode = new EditorMode({
    scene,
    camera,
    domElement: renderer.domElement,
    soldierGroup: group,
    controls,
    onToast: showToast,
    onHud: updateEditorHud,
  });
  editorMode.init().catch((err) => {
    console.error(err);
    showToast(`Editor init failed: ${err.message || err}`, 6000);
  });

  const blenderKey = new THREE.DirectionalLight(0xfff2dd, 2.2);
  blenderKey.position.set(3, 5, 2);
  blenderMode.root.add(blenderKey);
  blenderMode.root.add(new THREE.HemisphereLight(0xb8c4d4, 0x3a3228, 0.7));

  new HDRLoader()
    .setPath('assets/textures/equirectangular/')
    .load('lobe.hdr', (texture) => {
      texture.mapping = THREE.EquirectangularReflectionMapping;
      scene.environment = texture;
      scene.environmentIntensity = 1.5;
      addFloor();
      loadSoldier();
    });
}

function showToast(message, ms = 2200) {
  window.dispatchEvent(
    new CustomEvent('app:toast', { detail: { message, ms } }),
  );
  if (!window.__appChrome) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => {
      toast.hidden = true;
    }, ms);
  }
}

function setAppMode(mode) {
  if (!mode) return;

  const changed = mode !== appMode;
  appMode = mode;

  document.body.classList.toggle('mode-blender', mode === 'blender');
  document.body.classList.toggle('mode-editor', mode === 'editor');
  document.body.classList.toggle('mode-run', mode === 'run');

  const playfieldVisible = mode === 'run' || mode === 'editor';
  if (group) group.visible = playfieldVisible;
  if (followGroup) followGroup.visible = playfieldVisible;
  if (floor) floor.visible = playfieldVisible;
  if (scene) {
    scene.fog = playfieldVisible ? new THREE.Fog(0x5e5d5d, 2, 20) : null;
  }

  if (controls) controls.enabled = mode === 'run';

  if (blenderMode) {
    blenderMode.setActive(mode === 'blender');
  } else if (mode === 'blender') {
    const panel = document.getElementById('blender-panel');
    if (panel) {
      panel.hidden = false;
      panel.style.display = 'flex';
    }
  }

  if (editorMode) {
    editorMode.setActive(mode === 'editor');
    editorMode.setWorldVisible(playfieldVisible);
  }

  const editorHud = document.getElementById('editor-hud');
  if (editorHud) editorHud.hidden = mode !== 'editor';

  if (mode === 'run' && changed && actions?.Idle) {
    crossFadeTo('Idle', 0.1);
  }
}

function updateEditorHud(info) {
  const el = document.getElementById('editor-hud');
  if (!el || !info) return;
  el.textContent =
    `tool:${info.tool} · boxes:${info.boxes} · char:${info.hasCharacter ? 'yes' : 'no'} · ` +
    `enemies:${info.enemies} · Ctrl+S save · Ctrl+Z undo`;
}

function addFloor() {
  const size = 50;
  const repeat = 16;
  const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();

  const floorT = new THREE.TextureLoader().load(
    'assets/textures/floors/FloorsCheckerboard_S_Diffuse.jpg',
  );
  floorT.colorSpace = THREE.SRGBColorSpace;
  floorT.repeat.set(repeat, repeat);
  floorT.wrapS = floorT.wrapT = THREE.RepeatWrapping;
  floorT.anisotropy = maxAnisotropy;

  const floorN = new THREE.TextureLoader().load(
    'assets/textures/floors/FloorsCheckerboard_S_Normal.jpg',
  );
  floorN.repeat.set(repeat, repeat);
  floorN.wrapS = floorN.wrapT = THREE.RepeatWrapping;
  floorN.anisotropy = maxAnisotropy;

  const mat = new THREE.MeshStandardMaterial({
    map: floorT,
    normalMap: floorN,
    normalScale: new THREE.Vector2(0.5, 0.5),
    color: 0x404040,
    depthWrite: false,
    roughness: 0.85,
  });

  const g = new THREE.PlaneGeometry(size, size, 50, 50);
  g.rotateX(-PI90);

  floor = new THREE.Mesh(g, mat);
  floor.receiveShadow = true;
  scene.add(floor);

  controls.floorDecale = (size / repeat) * 4;

  const bulbGeometry = new THREE.SphereGeometry(0.05, 16, 8);
  const bulbLight = new THREE.PointLight(0xffee88, 2, 500, 2);
  const bulbMat = new THREE.MeshStandardMaterial({
    emissive: 0xffffee,
    emissiveIntensity: 1,
    color: 0x000000,
  });
  bulbLight.add(new THREE.Mesh(bulbGeometry, bulbMat));
  bulbLight.position.set(1, 0.1, -3);
  bulbLight.castShadow = true;
  floor.add(bulbLight);
}

function styleVanguardMaterials(root) {
  root.traverse((object) => {
    if (!object.isMesh) return;
    if (object.name === 'vanguard_Mesh') {
      object.castShadow = true;
      object.receiveShadow = true;
      object.material.metalness = 1.0;
      object.material.roughness = 0.2;
      object.material.color.set(1, 1, 1);
      if (object.material.map) object.material.metalnessMap = object.material.map;
    } else {
      object.material.metalness = 1;
      object.material.roughness = 0;
      object.material.transparent = true;
      object.material.opacity = 0.8;
      object.material.color.set(1, 1, 1);
    }
  });
}

function loadFbx(url) {
  return new Promise((resolve, reject) => {
    new FBXLoader().load(url, resolve, undefined, reject);
  });
}

/**
 * Load t-soldier and retarget Mixamo idle/run/jump/crouch/prone onto it.
 */
async function loadSoldier() {
  try {
    showToast('Loading t-soldier + Mixamo anims…', 4000);

    const soldier = await loadFbx('assets/models/t-soldier.fbx');
    sanitizeTree(soldier);

    soldierMesh = findSkinnedMesh(soldier);
    if (!soldierMesh?.skeleton) {
      throw new Error('t-soldier.fbx has no skinned mesh');
    }
    soldierMesh.skeleton.pose();
    soldier.updateMatrixWorld(true);

    // Mixamo cm → meters. Mesh faces +Z; world yaw comes only from group.facing.
    soldier.scale.setScalar(0.01);
    soldier.updateMatrixWorld(true);

    styleVanguardMaterials(soldier);
    model = soldier;
    group.add(model);
    mixer = new THREE.AnimationMixer(model);

    const clips = {};
    for (const [name, url] of Object.entries(ANIM_SOURCES)) {
      const fbx = await loadFbx(url);
      clips[name] = retargetMixamoClip(model, fbx, {
        clipName: name,
        inPlace: true,
        // Jump height comes from WowControls; keep rotation only.
        rotationOnly: name === 'Jump',
      });
    }

    actions = {
      Idle: mixer.clipAction(clips.Idle),
      Run: mixer.clipAction(clips.Run),
      Jump: mixer.clipAction(clips.Jump),
      Crouch: mixer.clipAction(clips.Crouch),
      Prone: mixer.clipAction(clips.Prone),
    };

    for (const [name, action] of Object.entries(actions)) {
      action.enabled = true;
      action.setEffectiveTimeScale(1);
      if (name === 'Jump') {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      } else {
        action.setLoop(THREE.LoopRepeat, Infinity);
      }
      if (name !== 'Idle') action.setEffectiveWeight(0);
    }

    actions.Idle.play();
    currentAction = 'Idle';

    try {
      await mountAk47(model);
    } catch (weaponErr) {
      console.warn(weaponErr);
      showToast(`AK-47 mount failed: ${weaponErr.message || weaponErr}`, 5000);
    }

    showToast('t-soldier ready');
  } catch (err) {
    console.error(err);
    showToast(`Failed to load soldier: ${err.message || err}`, 8000);
  }
}

function desiredLocomotionAction() {
  if (!controls) return 'Idle';
  if (controls.stance === 'prone') return 'Prone';
  if (controls.stance === 'crouch') return 'Crouch';
  if (controls.moving) return 'Run';
  return 'Idle';
}

function crossFadeTo(next, fade = FADE) {
  if (!actions?.[next] || currentAction === next) return;

  const current = actions[currentAction];
  const target = actions[next];
  currentAction = next;

  target.reset();
  target.setEffectiveWeight(1);
  target.play();
  if (current) current.crossFadeTo(target, fade, true);
}

function playJump() {
  const jump = actions?.Jump;
  if (!jump) return;

  for (const [name, action] of Object.entries(actions)) {
    if (name === 'Jump') continue;
    action.stop();
    action.setEffectiveWeight(0);
  }

  jump.reset();
  jump.setEffectiveWeight(1);
  // Native clip speed — do not stretch the ~16-frame jump to fill hang time.
  jump.setEffectiveTimeScale(1);
  jump.play();
  currentAction = 'Jump';
}

/**
 * Lowest bone world-Y on the posed skeleton (feet when standing, body when prone).
 * SkinnedMesh geometry AABBs ignore the current pose, so bones are the reliable contact.
 */
function getSkeletonMinY(root) {
  let minY = Infinity;
  root.traverse((obj) => {
    if (!obj.isBone) return;
    obj.getWorldPosition(_boneWorld);
    if (_boneWorld.y < minY) minY = _boneWorld.y;
  });
  return minY;
}

/**
 * Keep the mesh from sinking under the floor.
 * On ground: pin the lowest bone to groundY (feet / prone contact).
 * In air (jump): only push up if something dips below the plane; after landing, pin again.
 */
function keepModelAboveGround() {
  if (!model || !controls) return;

  model.updateMatrixWorld(true);
  const minY = getSkeletonMinY(model);
  if (!Number.isFinite(minY)) return;

  const groundY = controls.groundY;
  const sink = minY - groundY;
  if (controls.onGround) {
    if (Math.abs(sink) > 1e-5) model.position.y -= sink;
  } else if (sink < 0) {
    model.position.y -= sink;
  }
}

function updateVpg(delta, keySet) {
  if (!vpgLayer || !keySet) return;

  let deltaVpg = 0;
  if (keySet.has('BracketLeft')) deltaVpg -= VPG_NUDGE_PER_SEC * delta;
  if (keySet.has('BracketRight')) deltaVpg += VPG_NUDGE_PER_SEC * delta;
  if (deltaVpg !== 0) vpgLayer.addGranularity(deltaVpg);

  updateVpgHud(false);
}

function updateVpgHud(force) {
  if (!vpgLayer || !renderer) return;
  const v = vpgLayer.getGranularity();
  const solids = getWorldSolidCount();
  if (
    !force &&
    Math.abs(v - lastLoggedVPG) < 0.01 &&
    solids === lastLoggedSolids
  ) {
    return;
  }
  lastLoggedVPG = v;
  lastLoggedSolids = solids;

  renderer.getDrawingBufferSize(_drawSize);
  const [vw, vh] = vpgLayer.virtualResolution(_drawSize.x, _drawSize.y);
  const el = document.getElementById('vpg');
  if (el) {
    el.textContent = `VPG ${v.toFixed(2)} · ${vw}×${vh} · solids ${solids}`;
  }
}

function updateCharacter(delta) {
  if (!controls || appMode !== 'run') return;

  controls.update(delta);
  updateVpg(delta, controls.keys);

  if (controls.justJumped && actions?.Jump) {
    playJump();
  } else if (currentAction === 'Jump' && !controls.onGround) {
    // Stay on Jump until landing (last frame clamps). Never restart mid-air.
  } else {
    const next = desiredLocomotionAction();
    const fade = currentAction === 'Jump' ? 0.12 : FADE;
    crossFadeTo(next, fade);
  }

  group.position.set(controls.position.x, controls.position.y, controls.position.z);
  group.rotation.y = controls.facing;

  followGroup.position.copy(group.position);

  if (floor && controls.floorDecale) {
    const dx = controls.position.x - floor.position.x;
    const dz = controls.position.z - floor.position.z;
    if (Math.abs(dx) > controls.floorDecale) floor.position.x += dx;
    if (Math.abs(dz) > controls.floorDecale) floor.position.z += dz;
  }

  if (mixer) mixer.update(delta);
  keepModelAboveGround();

  // Keep world props animating in run mode.
  if (editorMode) editorMode.update(delta);

  const camPos = controls.getCameraPosition();
  const target = controls.getTarget();
  camera.position.set(camPos.x, camPos.y, camPos.z);
  camera.lookAt(target.x, target.y, target.z);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  updateVpgHud(true);
}

function animate() {
  const delta = clock.getDelta();

  if (appMode === 'run') {
    updateCharacter(delta);
  } else if (appMode === 'editor' && editorMode) {
    editorMode.update(delta);
    updateVpg(delta, editorMode.keys);
    if (mixer) mixer.update(delta);
  } else if (appMode === 'blender' && blenderMode) {
    blenderMode.update(delta);
  }

  // Pass 1: full-res scene into VPG target (constant 3D cost).
  renderer.getDrawingBufferSize(_drawSize);
  vpgLayer.beginScene(_drawSize.x, _drawSize.y);
  renderer.render(scene, camera);

  // Pass 2: virtual-pixel presentation to the canvas.
  vpgLayer.present(_drawSize.x, _drawSize.y);
}
