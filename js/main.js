import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { WowControls } from './wow-controls.js';

const PI = Math.PI;
const PI90 = Math.PI / 2;
const FADE = 0.35;

let scene, renderer, camera, floor, clock;
let group, followGroup, model, mixer;
let actions, currentAction = 'Idle';
let controls;

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

function loadModel() {
  const loader = new GLTFLoader();
  loader.load('assets/models/Soldier.glb', (gltf) => {
    model = gltf.scene;
    group.add(model);

    model.traverse((object) => {
      if (!object.isMesh) return;
      if (object.name === 'vanguard_Mesh') {
        object.castShadow = true;
        object.receiveShadow = true;
        object.material.metalness = 1.0;
        object.material.roughness = 0.2;
        object.material.color.set(1, 1, 1);
        object.material.metalnessMap = object.material.map;
      } else {
        object.material.metalness = 1;
        object.material.roughness = 0;
        object.material.transparent = true;
        object.material.opacity = 0.8;
        object.material.color.set(1, 1, 1);
      }
    });

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
  });
}

function crossFadeTo(next) {
  if (!actions || currentAction === next) return;

  const current = actions[currentAction];
  const target = actions[next];
  currentAction = next;

  target.reset();
  target.setEffectiveWeight(1);
  target.play();
  current.crossFadeTo(target, FADE, true);
}

function updateCharacter(delta) {
  if (!controls) return;

  controls.update(delta);

  const play = controls.moving ? 'Run' : 'Idle';
  crossFadeTo(play);

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
