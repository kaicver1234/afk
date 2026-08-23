'use strict';

// Helpers for getting past a server's antibot/verification stage.
//
// The expensive part is the map captcha: antibot plugins draw a code onto a
// filled map and give it to the player on join. A real client renders it in the
// hand; we only ever receive palette-indexed patches, so we stitch them into a
// 128x128 buffer and encode a PNG (via zlib, no image dependency) that can be
// sent to Telegram for a human to read.
const zlib = require('zlib');

// Minecraft's map palette: 62 base colours, each stored at four brightness
// levels, so palette index = base * 4 + shade.
const BASE_COLORS = [
  0, 0, 0, 127, 178, 56, 247, 233, 163, 199, 199, 199, 255, 0, 0, 160, 160, 255,
  167, 167, 167, 0, 124, 0, 255, 255, 255, 164, 168, 184, 151, 109, 77, 112, 112, 112,
  64, 64, 255, 143, 119, 72, 255, 252, 245, 216, 127, 51, 178, 76, 216, 102, 153, 216,
  229, 229, 51, 127, 204, 25, 242, 127, 165, 76, 76, 76, 153, 153, 153, 76, 127, 153,
  127, 63, 178, 51, 76, 178, 102, 76, 51, 102, 127, 51, 153, 51, 51, 25, 25, 25,
  250, 238, 77, 92, 219, 213, 74, 128, 255, 0, 217, 58, 129, 86, 49, 112, 2, 0,
  209, 177, 161, 159, 82, 36, 149, 87, 108, 112, 108, 138, 186, 133, 36, 103, 117, 53,
  160, 77, 78, 57, 41, 35, 135, 107, 98, 87, 92, 92, 122, 73, 88, 76, 62, 92,
  76, 50, 35, 76, 82, 42, 142, 60, 46, 37, 22, 16, 189, 48, 49, 148, 63, 97,
  92, 25, 29, 22, 126, 134, 58, 142, 140, 86, 44, 62, 20, 180, 133, 100, 100, 100,
  216, 175, 147, 127, 167, 150,
];
const SHADES = [180, 220, 255, 135];

const PALETTE = (() => {
  const bases = BASE_COLORS.length / 3;
  const out = new Uint8Array(bases * 4 * 3);
  for (let base = 0; base < bases; base++) {
    const r = BASE_COLORS[base * 3], g = BASE_COLORS[base * 3 + 1], b = BASE_COLORS[base * 3 + 2];
    for (let s = 0; s < 4; s++) {
      const m = SHADES[s];
      const i = (base * 4 + s) * 3;
      out[i] = (r * m / 255) | 0;
      out[i + 1] = (g * m / 255) | 0;
      out[i + 2] = (b * m / 255) | 0;
    }
  }
  return out;
})();

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// rgb: width*height*3 bytes. Nearest-neighbour upscaled so a 128px captcha is
// actually readable on a phone.
function encodePng(rgb, width, height, scale = 3) {
  const w = width * scale, h = height * scale;
  const stride = w * 3;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter: none
    const sy = (y / scale) | 0;
    for (let x = 0; x < w; x++) {
      const si = (sy * width + ((x / scale) | 0)) * 3;
      const di = rowStart + 1 + x * 3;
      raw[di] = rgb[si];
      raw[di + 1] = rgb[si + 1];
      raw[di + 2] = rgb[si + 2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// Collects the patches a server sends for every map id and turns the finished
// picture into a single PNG. Servers send maps in slices (often one column at a
// time), so we wait for a short quiet period before deciding the image is
// complete. A verification lobby usually hands out a whole wall of maps at once
// (item frames forming one big picture), so all of them are stitched into one
// contact sheet instead of one message per map id.
const MAP_SIZE = 128;
const MAP_QUIET_MS = 700;
const MAP_MIN_PIXELS = 40; // fewer painted pixels than this: not a captcha
const MAP_MAX_WAIT_MS = 6000; // a server that refreshes maps forever must not stall the send
const MAP_MAX_TILES = 64;     // hard cap on how many maps go into one sheet
const MAP_TARGET_PX = 1280;   // longest edge of the finished image

class MapCaptcha {
  constructor(onImage, {
    quietMs = MAP_QUIET_MS,
    minPixels = MAP_MIN_PIXELS,
    maxWaitMs = MAP_MAX_WAIT_MS,
  } = {}) {
    this.onImage = onImage;
    this.quietMs = quietMs;
    this.minPixels = minPixels;
    this.maxWaitMs = maxWaitMs;
    this.maps = new Map(); // id -> { pixels, painted }
    this.timer = null;
    this.deadline = 0;
    this.lastSig = null;
  }

  // Feed a decoded clientbound `map` packet. Safe to call with anything.
  feed(packet) {
    try {
      if (!packet) return;
      const id = packet.itemDamage ?? packet.mapId ?? packet.id;
      if (id == null) return;
      const cols = packet.columns, rows = packet.rows;
      const data = packet.data;
      if (!cols || !rows || !data || !data.length) return;

      let entry = this.maps.get(id);
      if (!entry) {
        if (this.maps.size >= MAP_MAX_TILES) return;
        entry = { pixels: new Uint8Array(MAP_SIZE * MAP_SIZE), painted: 0 };
        this.maps.set(id, entry);
      }

      const ox = packet.x | 0, oy = packet.y | 0;
      for (let cy = 0; cy < rows; cy++) {
        for (let cx = 0; cx < cols; cx++) {
          const px = ox + cx, py = oy + cy;
          if (px < 0 || px >= MAP_SIZE || py < 0 || py >= MAP_SIZE) continue;
          const v = data[cy * cols + cx];
          if (v === undefined) continue;
          const di = py * MAP_SIZE + px;
          if (entry.pixels[di] === 0 && v !== 0) entry.painted++;
          else if (entry.pixels[di] !== 0 && v === 0) entry.painted--;
          entry.pixels[di] = v;
        }
      }

      this._arm();
    } catch (_) { /* a malformed map packet must never break the connection */ }
  }

  // One timer for the whole batch: every new packet pushes the flush back by
  // quietMs, but never past maxWaitMs after the first packet of the batch.
  _arm() {
    const now = Date.now();
    if (!this.deadline) this.deadline = now + this.maxWaitMs;
    const at = Math.min(now + this.quietMs, this.deadline);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.deadline = 0;
      this._flush();
    }, Math.max(0, at - now));
    if (this.timer.unref) this.timer.unref();
  }

  _flush() {
    // Keep only the maps that actually have something drawn on them, in the
    // order the server handed them out — that is the order they were placed.
    const tiles = [];
    for (const [id, entry] of this.maps) {
      if (entry.painted < this.minPixels) continue;
      tiles.push({ id, entry });
    }
    if (!tiles.length) return;

    // Don't re-send an identical picture (servers refresh maps on a timer).
    let sig = tiles.length;
    for (const { id, entry } of tiles) {
      sig = (sig * 31 + id) | 0;
      for (let i = 0; i < entry.pixels.length; i++) sig = (sig * 31 + entry.pixels[i]) | 0;
    }
    if (sig === this.lastSig) return;
    this.lastSig = sig;

    // Lay the tiles out in as square a grid as possible.
    const cols = Math.ceil(Math.sqrt(tiles.length));
    const rows = Math.ceil(tiles.length / cols);
    const w = cols * MAP_SIZE, h = rows * MAP_SIZE;

    const rgb = Buffer.alloc(w * h * 3, 0xff);
    tiles.forEach((tile, n) => {
      const gx = (n % cols) * MAP_SIZE, gy = ((n / cols) | 0) * MAP_SIZE;
      const px = tile.entry.pixels;
      for (let y = 0; y < MAP_SIZE; y++) {
        for (let x = 0; x < MAP_SIZE; x++) {
          const v = px[y * MAP_SIZE + x];
          if (v === 0) continue; // unpainted → keep white, easier to read than black
          const p = v * 3;
          if (p + 2 >= PALETTE.length) continue;
          const di = ((gy + y) * w + gx + x) * 3;
          rgb[di] = PALETTE[p];
          rgb[di + 1] = PALETTE[p + 1];
          rgb[di + 2] = PALETTE[p + 2];
        }
      }
    });

    // Upscale so the result is readable on a phone, without going huge.
    const scale = Math.max(1, Math.min(4, Math.round(MAP_TARGET_PX / Math.max(w, h))));

    let png;
    try { png = encodePng(rgb, w, h, scale); } catch (_) { return; }
    const ids = tiles.map(t => t.id);
    const painted = tiles.reduce((a, t) => a + t.entry.painted, 0);
    try { this.onImage(png, { id: ids[0], ids, tiles: tiles.length, cols, rows, painted }); } catch (_) {}
  }

  clear() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.deadline = 0;
    this.lastSig = null;
    this.maps.clear();
  }
}

// Does this line look like an antibot/verification stage rather than normal chat?
const VERIFY_HINT_RE = /\b(antibot|anti-?bot|captcha|verif|human|not a robot|solve|challenge)\b/i;

// Servers in a verification lobby usually spell out exactly what to type.
// We only ever replay something the server itself printed in plain text —
// anything we can't read confidently is handed to the user instead.
const VERIFY_PATTERNS = [
  // "type /verify 1234", "run /captcha ABCD", "use /verify code"
  /(?:type|write|send|run|use|enter|execute)\s*:?\s*[«"'\[]?\s*(\/[a-z][\w-]{0,20}(?:\s+[\w-]{1,24}){0,2})/i,
  // "/verify 1234" appearing on a line that also mentions verification
  /(\/(?:verify|captcha|antibot|human|confirm|code)\b(?:\s+[\w-]{1,24}){0,2})/i,
  // "your code is: A1B2" / "code: A1B2" → typed as plain chat
  /\b(?:code|captcha|answer)\s*(?:is)?\s*[:=]\s*[«"'\[]?\s*([A-Za-z0-9]{3,12})\b/i,
];

function findVerifyCommand(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (!VERIFY_HINT_RE.test(s) && !/^\s*\/(?:verify|captcha|antibot)\b/i.test(s)) return null;

  for (const re of VERIFY_PATTERNS) {
    const m = re.exec(s);
    if (!m) continue;
    let cmd = m[1].trim().replace(/[«»"'\]\[.,!?]+$/, '');
    if (!cmd) continue;
    // A bare code has to be typed as-is; a slash command keeps its slash.
    if (!cmd.startsWith('/') && !/^[A-Za-z0-9]{3,12}$/.test(cmd)) continue;
    if (cmd.startsWith('/')) cmd = trimSentence(cmd);
    if (cmd.length > 64) continue;
    return cmd;
  }
  return null;
}

// "/verify 4821 to" → "/verify 4821". The regex grabs up to two trailing words,
// so drop everything from the first word that's clearly prose.
const STOP_WORDS = new Set([
  'to', 'in', 'on', 'and', 'or', 'the', 'a', 'an', 'now', 'please', 'then',
  'chat', 'this', 'that', 'so', 'if', 'you', 'your', 'is', 'be', 'we', 'it',
  'with', 'for', 'of', 'at', 'as', 'do', 'not', 'within', 'before', 'after',
  'seconds', 'second', 'secs', 'sec', 'minutes', 'minute', 'here', 'there',
]);

function trimSentence(cmd) {
  const parts = cmd.split(' ');
  const out = [parts[0]];
  for (let i = 1; i < parts.length; i++) {
    const w = parts[i];
    if (STOP_WORDS.has(w.toLowerCase())) break;
    out.push(w);
  }
  return out.join(' ');
}

// Client fingerprint. Mineflayer's defaults are fine but leave a few fields at
// values a real player never has; these make the join look like a vanilla
// client without changing any behaviour the server can rely on.
const DEFAULT_FINGERPRINT = {
  brand: 'vanilla',
  locale: 'en_US',
  mainHand: 'right',
  viewDistance: 'far',
  skinParts: {
    showCape: true,
    showJacket: true,
    showLeftSleeve: true,
    showRightSleeve: true,
    showLeftPants: true,
    showRightPants: true,
    showHat: true,
  },
};

// --- join cooldowns -------------------------------------------------------
// A lot of antibots don't challenge a suspicious join at all — they just refuse
// it and put the IP on a timer ("you are denied from entering, wait a few
// minutes"). Retrying inside that window is worse than doing nothing: on most
// implementations every rejected attempt restarts the timer, so a bot that
// retries every 15s can never get in. These helpers recognise that class of
// kick and work out how long the server actually asked us to wait.
const COOLDOWN_RE = new RegExp([
  'denied from entering',
  'denied (?:access )?(?:from|to) (?:the )?(?:server|network)',
  'please wait',
  'wait a (?:few|couple)',
  'try again (?:later|in|after)',
  'too fast',
  'too many (?:attempts|connections|requests|joins)',
  'slow down',
  'rate.?limit',
  'cool.?down',
  'throttl',
  'blacklist',
  'temporar(?:y|ily) (?:banned|blocked|denied)',
].join('|'), 'i');

const isCooldownKick = text => COOLDOWN_RE.test(String(text || ''));

const UNIT_MS = {
  ms: 1, milli: 1,
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: 60000, min: 60000, mins: 60000, minute: 60000, minutes: 60000,
  h: 3600000, hr: 3600000, hrs: 3600000, hour: 3600000, hours: 3600000,
};

// A number the server named, e.g. "wait 30 seconds", "try again in 5 minutes",
// "2m remaining". Vague wordings get a sensible stand-in instead of nothing.
const DURATION_PATTERNS = [
  /(?:wait|again|retry|in|after|for)\D{0,12}?(\d{1,4})\s*(ms|milli|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)\b/i,
  /(\d{1,4})\s*(ms|milli|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)\b\s*(?:remaining|left|to go)/i,
];

const VAGUE_MS = [
  [/\ba (?:few|couple of) (?:more )?minutes?\b|\ba couple minutes?\b/i, 5 * 60000],
  [/\ba (?:few|couple of) (?:more )?seconds?\b|\ba moment\b|\bshortly\b/i, 30000],
  [/\ban? hour\b/i, 60 * 60000],
];

// Returns the wait in ms, or null when the text names no duration at all.
function parseCooldownMs(text) {
  const s = String(text || '').replace(/\s+/g, ' ');
  if (!s) return null;

  for (const re of DURATION_PATTERNS) {
    const m = re.exec(s);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    const unit = UNIT_MS[m[2].toLowerCase()];
    if (!Number.isFinite(n) || n <= 0 || !unit) continue;
    const ms = n * unit;
    if (ms > 6 * 3600000) continue; // a "wait 9999 hours" is a ban, not a cooldown
    return ms;
  }

  for (const [re, ms] of VAGUE_MS) if (re.test(s)) return ms;
  return null;
}

module.exports = {
  MapCaptcha,
  encodePng,
  findVerifyCommand,
  isCooldownKick,
  parseCooldownMs,
  COOLDOWN_RE,
  VERIFY_HINT_RE,
  DEFAULT_FINGERPRINT,
  PALETTE,
};
