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
const VIEW_DISTANCE = 3;          // chunks — 5×5 columns around the bot
const SETTLE_MS = 25;             // let the GL queue drain between shots
const TEXTURE_TIMEOUT_MS = 10000; // block atlas loads async; don't shoot untextured
const INIT_TIMEOUT_MS = 60000;

// Body-relative views, in order. Turns are applied to the THREE camera yaw,
// where +90° is a left turn (camera basis looks down -Z at yaw 0).
const RELATIVE_TURNS = [
  { label: 'Front', turn: 0 },
  { label: 'Left', turn: Math.PI / 2 },
  { label: 'Right', turn: -Math.PI / 2 },
  { label: 'Back', turn: Math.PI },
];

const wait = ms => new Promise(r => setTimeout(r, ms));

function floored(pos) {
  return { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
}

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
  await waitForTextures(viewer);

  // The first draw on headless-gl compiles shaders and uploads buffers and can
  // come out as an empty frame — prime the pipeline once before real captures.
  try { renderer.render(viewer.scene, viewer.camera); } catch (_) {}
  await wait(100);

  info.viewer = { forMc: mc, canvas, renderer, viewer, worldView };
  return info.viewer;
}

// The block atlas is loaded off-thread and assigned to the shared material
// whenever it lands. Rendering before that gives flat-coloured blocks.
function waitForTextures(viewer) {
  if (viewer.world.material.map) return Promise.resolve();
  return withTimeout(new Promise((resolve, reject) => {
    const check = setInterval(() => {
      if (viewer.world.material.map) { clearInterval(check); resolve(); }
    }, 100);
    setTimeout(() => { clearInterval(check); reject(new Error('Block textures did not load')); }, TEXTURE_TIMEOUT_MS);
  }), TEXTURE_TIMEOUT_MS + 2000, 'Texture load');
}

// One JPEG from the bot's eyes. Camera position is set directly (the tween-based
// setFirstPersonCamera would leave it at its old spot — TWEEN only advances when
// updated every frame), so shots always come from where the player stands.
async function shootOne(R, position, yaw, pitch) {
  const cam = R.viewer.camera;
  cam.position.set(position.x, position.y + R.viewer.playerHeight, position.z);
  cam.rotation.set(pitch, yaw, 0, 'ZYX');
  cam.updateMatrixWorld();
  R.renderer.render(R.viewer.scene, R.viewer.camera);
  await wait(SETTLE_MS);
  return getBufferFromStreamSafe(R.renderer.domElement.createJPEGStream({ quality: 92 }));
}

async function getBufferFromStreamSafe(stream) {
  const { getBufferFromStream } = pvViewer;
  return withTimeout(getBufferFromStream(stream), 15000, 'Image encode');
}

// Four shots from exactly where the bot stands: forward as it currently
// faces, then left, right, behind. Returns [{ buffer, label }, ...].
// Never moves the player; restores its yaw after.
async function takeFourScreenshots(info) {
  ensureLoaded();
  const R = await getRenderer(info);
  const mc = info.mcBot;
  if (!mc || info.status !== 'online') throw new Error('Bot went offline during render');

  // The cached renderer may hold the world as it looked when it was built —
  // after a teleport or a respawn that's the wrong place entirely. Re-sync the
  // loaded chunks with where the player actually is before shooting.
  try {
    await withTimeout(R.worldView.updatePosition(mc.entity.position, true), INIT_TIMEOUT_MS, 'Chunk refresh');
    await withTimeout(R.viewer.waitForChunksToRender(), INIT_TIMEOUT_MS, 'Chunk render');
  } catch (e) {
    // A half-finished refresh can leave the scene inconsistent — rebuild next time.
    destroyViewer(info);
    throw new Error(`Screenshot chunk refresh failed: ${e.message}`);
  }

  const pos = floored(mc.entity.position);
  // mineflayer's entity.yaw is already in the THREE camera convention (the
  // viewer's own examples feed bot.entity.yaw straight into camera.rotation):
  // yaw 0 faces -Z, +PI/2 faces -X. So a positive turn of PI/2 looks LEFT.
  const baseYaw = mc.entity.yaw || 0;
  const out = [];
  try {
    for (const dir of RELATIVE_TURNS) {
      const buf = await shootOne(R, pos, baseYaw + dir.turn, 0);
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
  // Detach from the bot with the same helper that attached, so a rebuilt
  // viewer doesn't stack duplicate listeners on the same connection.
  try { if (v.forMc && v.worldView) v.worldView.removeListenersFromBot(v.forMc); } catch (_) {}
  try { v.worldView?.removeAllListeners?.(); } catch (_) {}
  try {
    v.renderer.dispose();
    v.renderer.forceContextLoss?.();
  } catch (_) {}
  try { v.canvas.width = 0; v.canvas.height = 0; } catch (_) {}
}

module.exports = { getRenderer, takeFourScreenshots, destroyViewer };
