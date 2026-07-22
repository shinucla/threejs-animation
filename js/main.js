import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { WowControls } from './wow-controls.js';
import { BlenderMode } from './blender-mode.js';
import {
  findSkinnedMesh,
  retargetMixamoClip,
  sanitizeTree,
} from './mixamo-retarget.js';

const PI = Math.PI;
const PI90 = Math.PI / 2;
const FADE = 0.35;
const _boneWorld = new THREE.Vector3();

let scene, renderer, camera, floor, clock;
let group, followGroup, model, mixer;
let actions, currentAction = 'Idle';
let controls;
let blenderMode = null;
let appMode = 'run';
let soldierMesh = null;

const ANIM_SOURCES = {
  Idle: 'assets/animations/mixamo-idle.fbx',
  Run: 'assets/animations/mixamo-run.fbx',
  Jump: 'assets/animations/mixamo-jump.fbx',
  Crouch: 'assets/animations/mixamo-crouch.fbx',
  Prone: 'assets/animations/mixamo-prone.fbx',
};

init();

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

  controls = new WowControls({
    walkSpeed: 5,
    jumpSpeed: 4.5,
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

  if (mode === 'editor') {
    showToast('Editor — coming soon');
    return;
  }

  const changed = mode !== appMode;
  appMode = mode;

  document.body.classList.toggle('mode-blender', mode === 'blender');
  document.body.classList.toggle('mode-run', mode === 'run');

  const runVisible = mode === 'run';
  if (group) group.visible = runVisible;
  if (followGroup) followGroup.visible = runVisible;
  if (floor) floor.visible = runVisible;
  if (scene) scene.fog = runVisible ? new THREE.Fog(0x5e5d5d, 2, 20) : null;

  if (controls) controls.enabled = runVisible;

  if (blenderMode) {
    blenderMode.setActive(mode === 'blender');
  } else if (mode === 'blender') {
    const panel = document.getElementById('blender-panel');
    if (panel) {
      panel.hidden = false;
      panel.style.display = 'flex';
    }
  }

  if (mode === 'run' && changed && actions?.Idle) {
    crossFadeTo('Idle', 0.1);
  }
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

function updateCharacter(delta) {
  if (!controls || appMode !== 'run') return;

  controls.update(delta);

  if (controls.justJumped && actions?.Jump) {
    playJump();
  } else if (!(currentAction === 'Jump' && !controls.onGround)) {
    const next = desiredLocomotionAction();
    const fade = currentAction === 'Jump' ? 0.15 : FADE;
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

  const camPos = controls.getCameraPosition();
  const target = controls.getTarget();
  camera.position.set(camPos.x, camPos.y, camPos.z);
  camera.lookAt(target.x, target.y, target.z);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
  const delta = clock.getDelta();

  if (appMode === 'run') {
    updateCharacter(delta);
  } else if (appMode === 'blender' && blenderMode) {
    blenderMode.update(delta);
  }

  renderer.render(scene, camera);
}
