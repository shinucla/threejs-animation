/**
 * Retarget a Mixamo (or Mixamo-named) FBX animation onto a target skinned root.
 */
import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

export function sanitizeTree(root) {
  root.traverse((obj) => {
    if (obj.name) obj.name = THREE.PropertyBinding.sanitizeNodeName(obj.name);
  });
}

export function findSkinnedMesh(root) {
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

export function collectBones(root) {
  const bones = [];
  root.traverse((obj) => {
    if (obj.isBone) bones.push(obj);
  });
  return bones;
}

/** Drop meshes from an animation-only FBX; keep skeleton. */
export function stripMeshes(root) {
  const remove = [];
  root.traverse((obj) => {
    if (obj.isMesh || obj.isSkinnedMesh) remove.push(obj);
  });
  for (const obj of remove) {
    obj.parent?.remove(obj);
  }
  return remove.length;
}

function guessHipName(boneNames) {
  for (const name of ['mixamorigHips', 'Hips', 'hips', 'pelvis', 'Pelvis']) {
    if (boneNames.includes(name)) return name;
  }
  return boneNames[0] || 'mixamorigHips';
}

/**
 * Freeze hips root translation to the first keyframe (X/Y/Z).
 * Mixamo idle/run often bob on Y; the character capsule owns world height.
 * @param {THREE.AnimationClip} clip
 * @param {string} hipBoneName
 */
export function applyInPlace(clip, hipBoneName = 'mixamorigHips') {
  for (const track of clip.tracks) {
    if (!(track instanceof THREE.VectorKeyframeTrack)) continue;
    if (!track.name.endsWith('.position')) continue;
    const bone = track.name.slice(0, -'.position'.length);
    if (bone !== hipBoneName) continue;
    const values = track.values;
    if (values.length < 3) continue;
    const x0 = values[0];
    const y0 = values[1];
    const z0 = values[2];
    for (let i = 0; i < values.length; i += 3) {
      values[i] = x0;
      values[i + 1] = y0;
      values[i + 2] = z0;
    }
  }
  return clip;
}

/**
 * @param {THREE.Object3D} targetRoot - model that owns the skinned mesh
 * @param {THREE.Object3D} animFbx - loaded animation FBX (will strip meshes)
 * @param {object} [opts]
 * @param {string} [opts.clipName]
 * @param {boolean} [opts.inPlace=true]
 * @param {boolean} [opts.rotationOnly=false] - drop position tracks (e.g. jump height from physics)
 */
export function retargetMixamoClip(targetRoot, animFbx, opts = {}) {
  const {
    clipName = 'Anim',
    inPlace = true,
    rotationOnly = false,
    fps = 30,
  } = opts;

  sanitizeTree(animFbx);
  stripMeshes(animFbx);

  const sourceBones = collectBones(animFbx);
  if (!sourceBones.length) throw new Error('Animation FBX has no bones');
  animFbx.skeleton = new THREE.Skeleton(sourceBones);
  animFbx.updateMatrixWorld(true);

  const raw = animFbx.animations?.[0];
  if (!raw) throw new Error('Animation FBX has no clips');

  const targetMesh = findSkinnedMesh(targetRoot);
  if (!targetMesh?.skeleton) throw new Error('Target has no skinned mesh');

  const names = Object.create(null);
  for (const bone of targetMesh.skeleton.bones) {
    names[bone.name] = bone.name;
  }
  const hip = guessHipName(Object.keys(names));

  const probe = SkeletonUtils.clone(targetRoot);
  const probeMesh = findSkinnedMesh(probe);
  probeMesh.skeleton.pose();
  probe.updateMatrixWorld(true);

  const retargeted = SkeletonUtils.retargetClip(probeMesh, animFbx, raw, {
    hip,
    names,
    useTargetMatrix: true,
    preserveBonePositions: true,
    useFirstFramePosition: true,
    fps,
  });

  let tracks = retargeted.tracks.map((track) => {
    const cloned = track.clone();
    const match = track.name.match(/^\.bones\[(.+)\]\.(.+)$/);
    if (match) cloned.name = `${match[1]}.${match[2]}`;
    return cloned;
  });

  if (rotationOnly) {
    tracks = tracks.filter((t) => t.name.endsWith('.quaternion'));
  }

  const clip = new THREE.AnimationClip(clipName, retargeted.duration, tracks);
  if (inPlace && !rotationOnly) applyInPlace(clip, hip);
  return clip;
}
