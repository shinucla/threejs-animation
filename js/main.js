import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { WowControls } from './wow-controls.js';

const PI = Math.PI;
const PI90 = Math.PI / 2;
const FADE = 0.35;

let scene, renderer, camera, floor, clock;
let group, followGroup, model, mixer;
let actions, currentAction = 'Idle';
let controls;

/** Mixamo jump plays on its own embedded Vanguard — no retarget. */
let jumpModel = null;
let jumpMixer = null;
let jumpAction = null;

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
    walkSpeed: 5, // run velocity (matches three.js walk demo runVelocity)
    jumpSpeed: 4.5,
    gravity: 12,
    eyeHeight: 1.0,
  });
  controls.attach(renderer.domElement);
  controls.distance = 5;
  controls.yaw = Math.PI;
  controls.pitch = 0.45;
  controls.facing = Math.PI;

  window.addEventListener('resize', onWindowResize);

  new HDRLoader()
    .setPath('assets/textures/equirectangular/')
    .load('lobe.hdr', (texture) => {
      texture.mapping = THREE.EquirectangularReflectionMapping;
      scene.environment = texture;
      scene.environmentIntensity = 1.5;
      addFloor();
      loadModel();
    });
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

function loadModel() {
  const loader = new GLTFLoader();
  loader.load('assets/models/Soldier.glb', (gltf) => {
    model = gltf.scene;
    group.add(model);
    styleVanguardMaterials(model);

    mixer = new THREE.AnimationMixer(model);

    const byName = Object.fromEntries(
      gltf.animations.map((clip) => [clip.name, clip]),
    );

    // Same Soldier.glb as webgl_animation_multiple: Idle=0, Run=1, Walk=3.
    const idleClip = byName.Idle ?? gltf.animations[0];
    const runClip = byName.Run ?? gltf.animations[1];

    actions = {
      Idle: mixer.clipAction(idleClip),
      Run: mixer.clipAction(runClip),
    };

    for (const name of Object.keys(actions)) {
      actions[name].enabled = true;
      actions[name].setEffectiveTimeScale(1);
      if (name !== 'Idle') actions[name].setEffectiveWeight(0);
    }

    actions.Idle.play();
    currentAction = 'Idle';
    loadJumpModel();
  });
}

/**
 * Load Mixamo jump with embedded Vanguard skin. On jump we swap visibility to
 * this model and play the clip natively (correct bind — no retarget).
 *
 * scale 0.01 + yaw π matches Soldier.glb hips/head under Character.
 * Quaternion tracks only; WowControls owns jump height.
 */
function loadJumpModel() {
  new FBXLoader().load('assets/animations/mixamo-jump-with-skin.fbx', (fbx) => {
    const raw = fbx.animations[0];
    if (!raw) return;

    fbx.traverse((obj) => {
      if (obj.name) obj.name = THREE.PropertyBinding.sanitizeNodeName(obj.name);
    });

    let mesh = null;
    fbx.traverse((obj) => {
      if (obj.isSkinnedMesh && obj.name === 'vanguard_Mesh') mesh = obj;
    });
    if (!mesh?.skeleton) return;

    mesh.skeleton.pose();
    fbx.updateMatrixWorld(true);

    fbx.scale.setScalar(0.01);
    fbx.rotation.y = Math.PI; // Mixamo +Z forward → Soldier −Z forward
    fbx.visible = false;
    styleVanguardMaterials(fbx);
    group.add(fbx);
    jumpModel = fbx;

    jumpMixer = new THREE.AnimationMixer(fbx);

    const jumpClip = new THREE.AnimationClip(
      'Jump',
      raw.duration,
      raw.tracks.filter((track) => track.name.endsWith('.quaternion')),
    );

    jumpAction = jumpMixer.clipAction(jumpClip);
    jumpAction.setLoop(THREE.LoopOnce, 1);
    jumpAction.clampWhenFinished = true;
  });
}

function showSoldier() {
  if (model) model.visible = true;
  if (jumpModel) jumpModel.visible = false;
  if (jumpAction) {
    jumpAction.stop();
    jumpAction.setEffectiveWeight(0);
  }
}

function showJumpModel() {
  if (model) model.visible = false;
  if (jumpModel) jumpModel.visible = true;
}

function crossFadeTo(next, fade = FADE) {
  if (!actions?.[next] || currentAction === next) return;

  if (currentAction === 'Jump') showSoldier();

  const current = actions[currentAction];
  const target = actions[next];
  currentAction = next;

  target.reset();
  target.setEffectiveWeight(1);
  target.play();
  if (current && current !== jumpAction) current.crossFadeTo(target, fade, true);
}

function playJump() {
  if (!jumpAction || !jumpModel) return;

  for (const action of Object.values(actions)) {
    action.stop();
    action.setEffectiveWeight(0);
  }

  showJumpModel();
  jumpAction.reset();
  jumpAction.setEffectiveWeight(1);
  jumpAction.play();
  currentAction = 'Jump';
}

function updateCharacter(delta) {
  if (!controls) return;

  controls.update(delta);

  if (controls.justJumped && jumpAction) {
    playJump();
  } else if (!(currentAction === 'Jump' && !controls.onGround)) {
    crossFadeTo(controls.moving ? 'Run' : 'Idle', currentAction === 'Jump' ? 0.15 : FADE);
  }

  group.position.set(controls.position.x, controls.position.y, controls.position.z);
  group.rotation.y = controls.facing;

  followGroup.position.copy(group.position);

  const camPos = controls.getCameraPosition();
  const target = controls.getTarget();
  camera.position.set(camPos.x, camPos.y, camPos.z);
  camera.lookAt(target.x, target.y, target.z);

  if (floor && controls.floorDecale) {
    const dx = controls.position.x - floor.position.x;
    const dz = controls.position.z - floor.position.z;
    if (Math.abs(dx) > controls.floorDecale) floor.position.x += dx;
    if (Math.abs(dz) > controls.floorDecale) floor.position.z += dz;
  }

  if (mixer) mixer.update(delta);
  if (jumpMixer) jumpMixer.update(delta);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
  const delta = clock.getDelta();
  updateCharacter(delta);
  renderer.render(scene, camera);
}
