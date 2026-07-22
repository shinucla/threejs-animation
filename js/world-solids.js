/**
 * Shared solid AABBs for run-mode collision.
 * Editor writes here whenever voxels change; WowControls reads every physics step.
 * Avoids depending on init order / closures over editorMode.
 */
import { boxesToAABBs } from './collision.js';

/** @type {import('./collision.js').AABB[]} */
let solids = [];

export function setWorldBoxes(boxes) {
  solids = boxesToAABBs(boxes || []);
}

export function getWorldSolids() {
  return solids;
}

export function getWorldSolidCount() {
  return solids.length;
}
