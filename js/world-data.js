/**
 * World JSON layout matching engine8 pkg/worlddata (version 1).
 * Browser: load via fetch; save via download (no server write).
 */

export const WORLD_VERSION = 1;
export const WORLD_URL = 'assets/world/world.json';
export const BOX_SIZE = 1;

/** @returns {{ version: number, boxes: object[], character?: object, enemies: object[], ball?: object }} */
export function emptyWorld() {
  return { version: WORLD_VERSION, boxes: [], enemies: [] };
}

export async function loadWorld(url = WORLD_URL) {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (res.status === 404) return emptyWorld();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return normalizeWorld(data);
  } catch (err) {
    if (err?.message?.includes('404')) return emptyWorld();
    console.warn('loadWorld:', err);
    return emptyWorld();
  }
}

export function normalizeWorld(data) {
  const w = emptyWorld();
  if (!data || typeof data !== 'object') return w;
  w.version = data.version || WORLD_VERSION;
  w.boxes = Array.isArray(data.boxes) ? data.boxes.map(normalizeBox) : [];
  w.enemies = Array.isArray(data.enemies) ? data.enemies.map(normalizeEnemy) : [];
  if (data.character) {
    w.character = {
      x: num(data.character.x),
      y: num(data.character.y),
      z: num(data.character.z),
      yaw: num(data.character.yaw),
    };
  }
  if (data.ball) {
    w.ball = {
      x: num(data.ball.x),
      y: num(data.ball.y),
      z: num(data.ball.z),
    };
  }
  return w;
}

function normalizeBox(b) {
  return { x: num(b?.x), y: num(b?.y), z: num(b?.z) };
}

function normalizeEnemy(e) {
  return {
    x: num(e?.x),
    y: num(e?.y),
    z: num(e?.z),
    yaw: num(e?.yaw),
  };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function downloadWorld(world, filename = 'world.json') {
  const payload = {
    version: WORLD_VERSION,
    boxes: world.boxes || [],
    enemies: world.enemies || [],
  };
  if (world.character) payload.character = world.character;
  if (world.ball) payload.ball = world.ball;

  const text = `${JSON.stringify(payload, null, 2)}\n`;
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Snap hit point + normal to voxel minimum corner (engine8 SnapVoxelCorner). */
export function snapVoxelCorner(point, normal, size = BOX_SIZE) {
  const p = point.clone().addScaledVector(normal, 0.01);
  return {
    x: Math.floor(p.x / size) * size,
    y: Math.floor(p.y / size) * size,
    z: Math.floor(p.z / size) * size,
  };
}
