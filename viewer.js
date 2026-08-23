'use strict';

// Headless first-person screenshots for a mineflayer bot, via prismarine-viewer's
// core Viewer + node-canvas-webgl (no browser, no express). The renderer is
// expensive to create (worker threads + WebGL context), so one instance per bot
// is created lazily on the first screenshot and reused until the bot disconnects.
//
// Requires global.THREE and global.Worker before prismarine-viewer loads — set
// at module load below. Native deps: gl (headless-gl) and canvas.

let THREE = null;
let pvViewer = null;
let canvasWebgl = null;
let loadErr = null;

function ensureLoaded() {
  if (pvViewer) return true;
  if (loadErr) throw loadErr;
  try {
    global.THREE = require('three');
    global.Worker = require('worker_threads').Worker;
    const pv = require('prismarine-viewer');
    pvViewer = pv.viewer;
    THREE = global.THREE;
    canvasWebgl = require('node-canvas-webgl/lib');
    return true;
  } catch (e) {
    loadErr = new Error(`Screenshot renderer unavailable: ${e.message}`);
    throw loadErr;
  }
}

const WIDTH = 512;
const HEIGHT = 512;
const VIEW_DISTANCE = 2;          // chunks — keep small, memory budget is tight
const SETTLE_MS = 120;            // camera position tween (~50ms) + chunk meshes
const INIT_TIMEOUT_MS = 60000;

// Minecraft yaw: 0 = south (+Z), positive counter-clockwise viewed from above.
const COMPASS = [
  { label: 'South', yaw: 0 },
  { label: 'West', yaw: Math.PI / 2 },
  { label: 'North', yaw: Math.PI },
  { label: 'East', yaw: -Math.PI / 2 },
];

const wait = ms => new Promise(r => setTimeout(r, ms));

function withTimeout(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms)),
  ]);
}

// Build (or reuse) the renderer bound to this bot's current connection.
async function getRenderer(info) {
  ensureLoaded();
  const mc = info.mcBot;
  if (!mc || info.status !== 'online') throw new Error('Bot is not online');

  if (info.viewer) {
    // A respawned mcBot means a new world — rebuild instead of rendering stale chunks.
    if (info.viewer.forMc === mc) return info.viewer;
    destroyViewer(info);
  }

  const { version } = mc;
  if (!version || typeof version !== 'string') throw new Error('Server version unknown — cannot render');

  let canvas, renderer, viewer, worldView;
  try {
    canvas = canvasWebgl.createCanvas(WIDTH, HEIGHT);
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    viewer = new pvViewer.Viewer(renderer);
  } catch (e) {
    throw new Error(`Could not start the 3D renderer (missing GL libraries?): ${e.message}`);
  }

  if (!viewer.setVersion(version)) {
    throw new Error(`Minecraft version ${version} is not supported by the renderer`);
  }

  worldView = new pvViewer.WorldView(mc.world, VIEW_DISTANCE, mc.entity.position);
  viewer.listen(worldView);
  worldView.listenToBot(mc);
  await withTimeout(worldView.init(mc.entity.position), INIT_TIMEOUT_MS, 'World load');
  await withTimeout(viewer.world.waitForChunksToRender(), INIT_TIMEOUT_MS, 'Chunk render');

  info.viewer = { forMc: mc, canvas, renderer, viewer, worldView };
  return info.viewer;
}

// One JPEG from the bot's eyes. Absolute yaw so each shot faces a compass point.
async function shootOne(R, position, yaw, pitch) {
  R.viewer.setFirstPersonCamera(position, yaw, pitch);
  R.viewer.update();
  await wait(SETTLE_MS);
  R.renderer.render(R.viewer.scene, R.viewer.camera);
  return getBufferFromStreamSafe(R.renderer.domElement.createJPEGStream({ quality: 90 }));
}

async function getBufferFromStreamSafe(stream) {
  const { getBufferFromStream } = pvViewer;
  return withTimeout(getBufferFromStream(stream), 15000, 'Image encode');
}

// Four clean shots from where the player stands, facing N/E/S/W.
// Returns [{ buffer, label }, ...]. Never moves the player; restores its yaw after.
async function takeFourScreenshots(info) {
  ensureLoaded();
  const R = await getRenderer(info);
  const mc = info.mcBot;
  if (!mc || info.status !== 'online') throw new Error('Bot went offline during render');

  const pos = mc.entity.position.clone();
  const out = [];
  try {
    for (const dir of COMPASS) {
      const buf = await shootOne(R, pos, dir.yaw, 0);
      out.push({ buffer: buf, label: dir.label });
    }
  } catch (e) {
    // A failed GL context or dead worker won't recover — force a fresh init next time.
    destroyViewer(info);
    throw new Error(`Screenshot render failed: ${e.message}`);
  }

  // Point the player back where it was looking (server-visible state).
  try { mc.look(mc.entity.yaw, mc.entity.pitch, true); } catch (_) {}
  return out;
}

function destroyViewer(info) {
  const v = info.viewer;
  if (!v) return;
  info.viewer = null;
  try { v.worldView?.removeListeners?.(v.worldView.bot); } catch (_) {}
  try { v.worldView?.removeAllListeners?.(); } catch (_) {}
  try {
    v.renderer.dispose();
    v.renderer.forceContextLoss?.();
  } catch (_) {}
  try { v.canvas.width = 0; v.canvas.height = 0; } catch (_) {}
}

module.exports = { getRenderer, takeFourScreenshots, destroyViewer };
