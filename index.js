'use strict';

const { Bot, InlineKeyboard } = require('grammy');
const mineflayer = require('mineflayer');
const { DEFAULT_FINGERPRINT, isCooldownKick, parseCooldownMs } = require('./antibot');
const autoEat = require('./autoeat');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const v8 = require('v8');

// Load .env into process.env without pulling in a dependency.
// Real environment variables always win, so a service definition can override the file.
(function loadEnv() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([\w.-]+)\s*=\s*(.*)$/.exec(line);
      if (!m || line.trimStart().startsWith('#')) continue;
      const key = m[1];
      let val = m[2].trim().replace(/\s+#.*$/, '');
      if (/^(['"]).*\1$/.test(val)) val = val.slice(1, -1);
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch (e) { console.error('loadEnv:', e.message); }
})();

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN not set — put it in .env next to index.js:');
  console.error('  TELEGRAM_BOT_TOKEN=123456:ABC...');
  process.exit(1);
}

// Where runtime state lives. On a hosting platform the app directory is wiped on
// every deploy, so DATA_DIR should point at a mounted volume (e.g. /data).
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA = path.join(DATA_DIR, 'userdata.json');
const DATA_TMP = DATA + '.tmp';

if (DATA_DIR !== __dirname) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); }
  catch (e) { console.error('DATA_DIR not writable:', e.message); }
  console.log('State file:', DATA);
}

const mcBots = new Map();
const chatStates = new Map();
const forwardMap = new Map();
const activeBot = new Map();
const captures = new Map();
// chatId -> { lines, timer } — server chat is batched so a busy server can't trip Telegram's rate limit.
const outbox = new Map();

const bot = new Bot(TOKEN);

let loading = false;

let saveTimer = null;      // pending debounced write
let savedPayload = null;   // last payload that actually reached disk
let pendingPayload = null; // newest payload waiting to be written
const SAVE_DEBOUNCE_MS = 400;

// The payload is only a few KB; the expensive part was doing a synchronous
// write on every single UI action (saveData is called ~30 places). Writes are
// now coalesced: identical state never hits disk twice, and a burst of changes
// costs one write a moment later. The write itself stays atomic (tmp + rename).
function writeState(payload) {
  try {
    fs.writeFileSync(DATA_TMP, payload, 'utf8');
    fs.renameSync(DATA_TMP, DATA);
    savedPayload = payload;
  } catch (e) { console.error('saveData:', e.message); }
  pendingPayload = null;
}

function saveData() {
  if (loading) return;
  const out = {
    bots: [...mcBots.values()].map(b => ({
      name: b.name, host: b.host, port: b.port,
      version: b.version, chatId: b.chatId, ownerUsername: b.ownerUsername,
      paused: !b.autoReconnect,
      loginCmd: b.loginCmd || null,
      loginEnabled: b.loginEnabled !== false,
      ncLogin: b.ncLogin || null,
      ncSecond: b.ncSecond || null,
      ncThird: b.ncThird || null,
      ncEnabled: b.ncEnabled === true,
      afkMode: b.afkMode || 'off',
      afkIntervalMs: b.afkIntervalMs || DEFAULT_AFK_INTERVAL_MS,
      autoChatMsg: b.autoChatMsg || null,
      autoChatEnabled: b.autoChatEnabled !== false,
      autoChatIntervalMs: b.autoChatIntervalMs || DEFAULT_AUTOCHAT_INTERVAL_MS,
      autoEat: b.autoEat === true,
      // A restart must not hand the server a fresh join inside a cooldown it set.
      cooldownUntil: b.cooldownUntil && b.cooldownUntil > Date.now() ? b.cooldownUntil : 0,
      cooldownWaits: b.cooldownWaits || 0,
    })),
    forwards: Object.fromEntries([...forwardMap].map(([u, s]) => [u, [...s]])),
    active: Object.fromEntries([...activeBot]),
  };
  const payload = JSON.stringify(out);
  if (payload === savedPayload) { // identical to what's on disk — nothing to do
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    pendingPayload = null;
    return;
  }
  pendingPayload = payload;
  if (saveTimer) return; // a write is already scheduled
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (pendingPayload != null) writeState(pendingPayload);
  }, SAVE_DEBOUNCE_MS);
}

// Write any pending state right now — used on shutdown, where the debounce
// timer would otherwise lose the last few changes to process.exit().
function flushSave() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (pendingPayload != null) writeState(pendingPayload);
}

function loadData() {
  if (!fs.existsSync(DATA)) { fs.writeFileSync(DATA, JSON.stringify({ bots: [], forwards: {} }), 'utf8'); return; }
  loading = true;
  try {
    const raw = JSON.parse(fs.readFileSync(DATA, 'utf8'));
    for (const [u, ids] of Object.entries(raw.forwards || {})) forwardMap.set(u, new Set(ids));
    for (const [chatId, name] of Object.entries(raw.active || {})) activeBot.set(Number(chatId), name);
    // Collected first, dialed out after the loop so joins to one server can be
    // staggered (see scheduleStaggeredStarts/scheduleStaggeredCooldowns).
    const pendingStarts = [];
    const pendingCooldowns = [];
    for (const b of (raw.bots || [])) {
      // One corrupt record must not cost us every other bot's restoration.
      try {
        const opts = {
          loginCmd: b.loginCmd || null,
          loginEnabled: b.loginEnabled !== false,
          ncLogin: b.ncLogin || null,
          ncSecond: b.ncSecond || null,
          ncThird: b.ncThird || null,
          ncEnabled: b.ncEnabled === true,
          afkMode: AFK_MODES.has(b.afkMode) ? b.afkMode : 'off',
          afkIntervalMs: clampInterval(b.afkIntervalMs),
          autoChatMsg: typeof b.autoChatMsg === 'string' && b.autoChatMsg ? b.autoChatMsg : null,
          autoChatEnabled: b.autoChatEnabled !== false,
          autoChatIntervalMs: clampChatInterval(b.autoChatIntervalMs),
          autoEat: b.autoEat === true,
        };
        const cooldownUntil = Number(b.cooldownUntil) || 0;
        if (b.paused) {
          // Restore it as a known-but-offline bot; don't dial out on startup.
          mcBots.set(b.name, {
            name: b.name, host: b.host, port: b.port, version: b.version,
            chatId: b.chatId, ownerUsername: b.ownerUsername || null,
            mcBot: null, status: 'offline',
            connectedAt: null, error: 'Was disconnected before last shutdown',
            autoReconnect: false, reconnectAttempts: 0, reconnectTimer: null,
            cooldownUntil, cooldownWaits: Number(b.cooldownWaits) || 0,
            ...opts,
          });
        } else if (cooldownUntil > Date.now()) {
          // The antibot had this IP on a timer when we shut down. Joining now would
          // restart that timer, so come back when it has expired.
          const delay = Math.min(COOLDOWN_MAX_MS, cooldownUntil - Date.now());
          const entry = {
            name: b.name, host: b.host, port: b.port, version: b.version,
            chatId: b.chatId, ownerUsername: b.ownerUsername || null,
            mcBot: null, status: 'offline',
            connectedAt: null, error: `Antibot cooldown — waiting ${humanInterval(delay)}`,
            autoReconnect: true, reconnectAttempts: 0, reconnectTimer: null,
            cooldownUntil, cooldownWaits: Number(b.cooldownWaits) || 0,
            ...opts,
          };
          mcBots.set(b.name, entry);
          pendingCooldowns.push({ entry, b, opts, delay });
        } else {
          pendingStarts.push({ b, opts });
        }
      } catch (e) {
        console.error(`loadData: skipping bot ${JSON.stringify(b && b.name)} — ${e.message}`);
      }
    }
    // Staggered startup: bots sharing one server never dial out at once — the
    // first (by name) connects right away, the rest wait their slot. Without
    // this, a process restart rejoins every bot in the same tick and hammers a
    // freshly restarted server into rate-limiting the IP.
    scheduleStaggeredStarts(pendingStarts);
    scheduleStaggeredCooldowns(pendingCooldowns);
  } catch (e) { console.error('loadData:', e.message); }
  loading = false;
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const uptime = ms => {
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
};

const dot = s => s === 'online' ? '[ON]' : s === 'connecting' ? '[...]' : s === 'error' ? '[ERR]' : '[OFF]';
const norm = u => String(u || '').replace(/^@/, '').toLowerCase();
const ownerTag = b => b.ownerUsername ? `@${b.ownerUsername}` : `#${b.chatId}`;

const notify = (chatId, text) => bot.api.sendMessage(chatId, text, { parse_mode: 'HTML' }).catch(() => {});

// Flatten anything the server might hand us — a ChatMessage, a raw JSON string,
// or a nested {text, extra:[...]} tree — into plain readable text.
function readChat(input) {
  if (input == null) return '';
  let node = input;

  if (typeof node === 'string') {
    const s = node.trim();
    if (!s.startsWith('{') && !s.startsWith('[')) return stripCodes(s);
    try { node = JSON.parse(s); } catch (_) { return stripCodes(s); }
  }

  // mineflayer's ChatMessage renders the whole component tree itself.
  if (typeof node?.toAnsi === 'function') {
    try {
      const s = stripCodes(node.toAnsi());
      if (s) return s;
    } catch (_) {}
  }

  // Try toString() method if available
  if (typeof node?.toString === 'function' && node.toString !== Object.prototype.toString) {
    try {
      const s = stripCodes(node.toString());
      if (s && s !== '[object Object]') return s;
    } catch (_) {}
  }

  const walk = n => {
    if (n == null) return '';
    if (typeof n === 'string') return n;
    if (Array.isArray(n)) return n.map(walk).join('');
    let out = '';
    if (typeof n.text === 'string') out += n.text;
    else if (typeof n.translate === 'string') out += n.translate;
    else if (typeof n.reason === 'string') out += n.reason;
    else if (typeof n.message === 'string') out += n.message;
    if (Array.isArray(n.with)) out += ' ' + n.with.map(walk).join(' ');
    if (Array.isArray(n.extra)) out += n.extra.map(walk).join('');
    return out;
  };

  const flat = stripCodes(walk(node));
  if (flat) return flat;
  
  // Last resort: try to extract any string values from the object
  try {
    if (typeof node === 'object') {
      const values = Object.values(node).filter(v => typeof v === 'string').join(' ');
      if (values) return stripCodes(values);
    }
    return stripCodes(String(node));
  } catch (_) { return ''; }
}

const stripCodes = s => String(s)
  .replace(/\x1b\[[0-9;]*m/g, '')
  .replace(/§[0-9a-fk-or]/gi, '')
  .replace(/[ \t]+/g, ' ')
  .trim();

// Telegram commands owned by this bot — never relayed to Minecraft.
const RESERVED = new Set([
  'start', 'help', 'forward', 'unforward', 'forwards',
  'cmd', 'say', 'use', 'console', 'bots', 'afk', 'setlogin', 'click', 'where', 'players', 'status',
]);
const MC_MAX_LEN = 256;
const SEND_GAP_MS = 400;
const CAPTURE_MS = 20000;
const MAX_BOTS_PER_OWNER = 10;
const STATE_TTL_MS = 10 * 60 * 1000;

// --- anti-AFK ---
// 'jump'  → hop in place
// 'walk'  → step one block forward, then one block back
// 'both'  → jump while stepping
const AFK_MODES = new Set(['off', 'jump', 'walk', 'both']);
const AFK_LABEL = { off: 'Off', jump: 'Jump only', walk: 'Walk 1 block', both: 'Jump + Walk' };
const DEFAULT_AFK_INTERVAL_MS = 60000;
const MIN_AFK_INTERVAL_MS = 5000;
const MAX_AFK_INTERVAL_MS = 30 * 60 * 1000;
// --- auto-chat (scheduled message) ---
const DEFAULT_AUTOCHAT_INTERVAL_MS = 30 * 60 * 1000;   // 30 minutes
const MIN_AUTOCHAT_INTERVAL_MS = 60 * 1000;            // never faster than 1/min — spam kicks
const MAX_AUTOCHAT_INTERVAL_MS = 24 * 60 * 60 * 1000;  // 24h ceiling
// One block at walking speed is ~230ms; a little more guarantees the full block.
const AFK_STEP_MS = 350;
const AFK_JUMP_MS = 500;

const clampInterval = ms => {
  const n = Number(ms);
  if (!Number.isFinite(n)) return DEFAULT_AFK_INTERVAL_MS;
  return Math.min(Math.max(Math.round(n), MIN_AFK_INTERVAL_MS), MAX_AFK_INTERVAL_MS);
};

const humanInterval = ms => {
  if (ms % 60000 === 0) return `${ms / 60000}m`;
  if (ms >= 60000) {
    const m = Math.floor(ms / 60000), s = Math.round((ms % 60000) / 1000);
    return s ? `${m}m ${s}s` : `${m}m`;
  }
  return `${Math.round(ms / 1000)}s`;
};

// "30s", "2m", "90" (bare number = seconds) → ms
function parseInterval(raw) {
  const m = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes)?$/i.exec(String(raw).trim());
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] || 's').toLowerCase();
  const ms = unit.startsWith('m') ? n * 60000 : n * 1000;
  if (ms < MIN_AFK_INTERVAL_MS || ms > MAX_AFK_INTERVAL_MS) return null;
  return Math.round(ms);
}

// "20", "45m", "2h", "1h30m", "90m" → ms. A bare number means minutes here —
// auto-chat intervals are minutes-to-hours, not seconds.
function parseChatInterval(raw) {
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  let total = 0, matched = false;
  const re = /(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)?/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m[0] === '') break;
    const n = parseFloat(m[1]);
    if (!Number.isFinite(n) || n <= 0) return null;
    const unit = m[2] || 'm';
    if (unit.startsWith('h')) total += n * 3600000;
    else if (unit.startsWith('s')) total += n * 1000;
    else total += n * 60000;
    matched = true;
  }
  if (!matched) return null;
  if (total < MIN_AUTOCHAT_INTERVAL_MS || total > MAX_AUTOCHAT_INTERVAL_MS) return null;
  return Math.round(total);
}

// --- auto-login ---
// Servers running AuthMe/nLogin ask for /login after every join. We replay the
// saved command when the server prompts, and once as a fallback if it never does.
const LOGIN_PROMPT_RE = /\b(login|log in|logg?ed in|register|authenticat|password|ramz|senha|contrase|войти|парол)/i;
const LOGIN_OK_RE = /\b(logged in|login success|successfully logged|authenticated|welcome back|already logged)/i;
const LOGIN_FALLBACK_MS = 4000;
const LOGIN_MAX_TRIES = 3;
const LOGIN_RETRY_MS = 6000;

// Batch outgoing server chat: one Telegram message per chat per window.
const FLUSH_MS = 2500;
const MAX_BATCH_LINES = 25;
const MAX_BATCH_CHARS = 3500;

// Writing "auto" as the version makes minecraft-protocol ping the server first and
// join on whatever protocol it reports. Useful when a proxy (Via*) answers for
// several versions and a hardcoded guess gets rejected at the handshake.
const AUTO_VERSION = 'auto';

function enqueueOut(chatId, line) {
  let box = outbox.get(chatId);
  if (!box) { box = { lines: [], timer: null }; outbox.set(chatId, box); }
  if (box.lines.length < 200) box.lines.push(line);
  if (box.timer) return;
  box.timer = setTimeout(() => flushOut(chatId), FLUSH_MS);
}

function flushOut(chatId) {
  const box = outbox.get(chatId);
  if (!box) return;
  box.timer = null;
  if (!box.lines.length) { outbox.delete(chatId); return; }

  const batch = [];
  let chars = 0;
  while (box.lines.length && batch.length < MAX_BATCH_LINES) {
    const next = box.lines[0];
    if (chars + next.length + 1 > MAX_BATCH_CHARS && batch.length) break;
    batch.push(box.lines.shift());
    chars += next.length + 1;
  }
  const dropped = box.lines.length > 100 ? box.lines.splice(0, box.lines.length - 100).length : 0;
  const text = batch.join('\n') + (dropped ? `\n… ${dropped} more line(s) dropped` : '');

  bot.api.sendMessage(chatId, text.slice(0, 4000)).catch(() => {});
  if (box.lines.length) box.timer = setTimeout(() => flushOut(chatId), FLUSH_MS);
  else outbox.delete(chatId);
}

// Bots this chat/user is allowed to drive: the chat that registered them, or the owner by @username.
function controllableBots(ctx) {
  const u = norm(ctx.from?.username);
  return [...mcBots.values()].filter(b => b.chatId === ctx.chat.id || (u && norm(b.ownerUsername) === u));
}

function canControl(ctx, info) {
  if (!info) return false;
  if (info.chatId === ctx.chat.id) return true;
  const u = norm(ctx.from?.username);
  return !!u && u === norm(info.ownerUsername);
}

// Conversation state expires so a stray message an hour later isn't parsed as bot details.
function setState(chatId, state) {
  state.expires = Date.now() + STATE_TTL_MS;
  chatStates.set(chatId, state);
}

function getState(chatId) {
  const s = chatStates.get(chatId);
  if (!s) return null;
  if (s.expires && Date.now() > s.expires) { chatStates.delete(chatId); return null; }
  return s;
}

// States and capture windows expire on paper immediately, but were only
// reaped when the same chat/bot came back. Sweep periodically so a chat (or a
// quiet bot) that never returns can't leave entries behind forever.
const STATE_SWEEP_MS = 5 * 60 * 1000;
const sweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, s] of chatStates) if (s.expires && now > s.expires) chatStates.delete(id);
  for (const [nm, c] of captures) if (now > c.until) captures.delete(nm);
}, STATE_SWEEP_MS);
if (sweepTimer.unref) sweepTimer.unref();

// --- heap watchdog ---------------------------------------------------------
// This process is meant to stay up for weeks, so a slow leak used to stay
// invisible until the runtime aborted with "heap out of memory". Log the live
// heap now and then, and when it crosses 80% of V8's own limit say so in the
// chats that own bots — a regression shows up as a message, not a crash.
const HEAP_LOG_MS = 15 * 60 * 1000;
const HEAP_WARN_RATIO = 0.8;
const HEAP_WARN_GAP_MS = 30 * 60 * 1000;
let heapWarnedAt = 0;
const heapTimer = setInterval(() => {
  const { heapUsed, rss } = process.memoryUsage();
  const limit = v8.getHeapStatistics().heap_size_limit || 0;
  const used = heapUsed / 1048576;
  console.log(`[memory] heap ${used.toFixed(0)}/${(limit / 1048576).toFixed(0)} MB (${limit ? Math.round(used / (limit / 1048576) * 100) : 0}%) · rss ${(rss / 1048576).toFixed(0)} MB · bots ${mcBots.size}`);
  if (!limit || heapUsed < limit * HEAP_WARN_RATIO) return;
  if (Date.now() - heapWarnedAt < HEAP_WARN_GAP_MS) return;
  heapWarnedAt = Date.now();
  const text = `⚠️ <b>Memory warning</b> — this service is using <b>${Math.round(heapUsed / limit * 100)}%</b> of its heap ` +
    `(${used.toFixed(0)} of ${(limit / 1048576).toFixed(0)} MB) with ${mcBots.size} bot(s).\n\n` +
    `It will reconnect every bot automatically after a restart; if the number keeps climbing, restart it from the host panel.`;
  for (const chatId of new Set([...mcBots.values()].map(b => b.chatId).filter(Boolean))) notify(chatId, text);
}, HEAP_LOG_MS);
if (heapTimer.unref) heapTimer.unref();

// Space sends out so a burst never trips the server's chat-spam kick.
function queueSend(info, text, front = false) {
  if (!info.sendQueue) info.sendQueue = [];
  if (front) info.sendQueue.unshift(text);
  else info.sendQueue.push(text);
  if (info.sendTimer) return;
  const flush = () => {
    const next = info.sendQueue.shift();
    if (next === undefined) { info.sendTimer = null; return; }
    try { info.mcBot?.chat(next); } catch (e) { info.error = `Send failed: ${e.message}`; }
    info.sendTimer = setTimeout(flush, SEND_GAP_MS);
  };
  flush();
}

// Mirror the bot's incoming chat back to this Telegram chat for a short window,
// so you can see the server's reply to the command you just sent.
const captureFor = (name, chatId) => captures.set(name, { chatId, until: Date.now() + CAPTURE_MS });

function relay(ctx, info, text) {
  if (!canControl(ctx, info)) return ctx.reply(`<b>${esc(info.name)}</b> isn't yours to control.`, { parse_mode: 'HTML' });
  if (info.status !== 'online' || !info.mcBot) {
    return ctx.reply(`<b>${esc(info.name)}</b> is <b>${info.status}</b> - connect it first.`, {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('Manage', `manage:${info.name}`),
    });
  }
  if (text.length > MC_MAX_LEN) return ctx.reply(`Too long - Minecraft caps messages at ${MC_MAX_LEN} characters.`);

  queueSend(info, text);
  captureFor(info.name, ctx.chat.id);
  activeBot.set(ctx.chat.id, info.name);
  saveData();

  const kind = text.startsWith('/') ? 'Command sent' : 'Message sent';
  return ctx.reply(`${kind} as <b>${esc(info.name)}</b>:\n<code>${esc(text)}</code>\n\n<i>Listening for the server's reply for ${CAPTURE_MS / 1000}s...</i>`, { parse_mode: 'HTML' });
}

// Which bot should this chat's command go to?
function pickBot(ctx) {
  const mine = controllableBots(ctx);
  if (!mine.length) return { error: `You have no bots here. Use <b>Add Bot</b> from /start first.` };

  const chosen = activeBot.get(ctx.chat.id);
  const hit = mine.find(b => b.name === chosen);
  if (hit) return { info: hit };
  if (mine.length === 1) return { info: mine[0] };

  const kb = new InlineKeyboard();
  let col = 0;
  for (const b of mine) { kb.text(`${dot(b.status)} ${b.name}`, `use:${b.name}`); if (++col % 2 === 0) kb.row(); }
  return { error: `You have ${mine.length} bots - pick which one sends the command:`, keyboard: kb };
}

function mainMenuText(ctx) {
  const mine = ctx ? controllableBots(ctx) : [...mcBots.values()];
  let online = 0;
  for (const b of mine) if (b.status === 'online') online++;
  return `<b>Minecraft Bot Manager</b>\n\nConnect fake offline players to any Minecraft server.\nSupports ViaVersion · ViaBackwards · ViaRewind\n\n<b>Your bots:</b> ${mine.length} registered | ${online} online`;
}

const mainMenuKeyboard = () => new InlineKeyboard()
  .text('Add Bot', 'add_bot').text('Bots', 'list_bots').row()
  .text('Commands', 'cmd_help').text('Forwarding', 'fwd_help').row()
  .text('Status', 'status').text('Help', 'help').text('Refresh', 'refresh_menu');

function botListText(ctx) {
  const mine = controllableBots(ctx);
  if (!mine.length) return `<b>No bots of yours here</b>\n\nPress <b>Add Bot</b> to connect one.`;
  const lines = [`<b>Your bots (${mine.length})</b>\n`];
  for (const b of mine) {
    const ut = b.connectedAt && b.status === 'online' ? `  | ${uptime(Date.now() - b.connectedAt)}` : '';
    const afk = b.afkMode && b.afkMode !== 'off' ? `  | AFK: ${AFK_LABEL[b.afkMode]}/${humanInterval(b.afkIntervalMs)}` : '';
    const lg = b.loginCmd ? (b.loginEnabled === false ? '  [Login: OFF]' : '  [Login: ON]') : '';
    lines.push(`${dot(b.status)} <b>${esc(b.name)}</b>  <i>(${esc(ownerTag(b))})</i>\n    Server: <code>${esc(b.host)}:${b.port}</code>  Ver: <code>${esc(b.version)}</code>${ut}${afk}${lg}`);
  }
  return lines.join('\n');
}

function botListKeyboard(ctx) {
  const kb = new InlineKeyboard();
  let col = 0;
  for (const b of controllableBots(ctx)) {
    kb.text(`${dot(b.status)} ${b.name}`, `manage:${b.name}`);
    if (++col % 2 === 0) kb.row();
  }
  if (col % 2) kb.row();
  return kb.text('Add Bot', 'add_bot').text('Refresh', 'list_bots').row().text('< Back', 'main_menu');
}

function botManageText(b) {
  const ut = b.connectedAt && b.status === 'online' ? `\n<b>Uptime:</b> ${uptime(Date.now() - b.connectedAt)}` : '';
  const err = b.error ? `\n<b>Last event:</b> <code>${esc(b.error)}</code>` : '';
  const cd = b.cooldownUntil && b.cooldownUntil > Date.now()
    ? `\n<b>AntiBot cooldown:</b> ${humanInterval(b.cooldownUntil - Date.now())} left (refusals: ${b.cooldownWaits || 1})`
    : '';
  const afk = b.afkMode && b.afkMode !== 'off'
    ? `\n<b>Anti-AFK:</b> ${AFK_LABEL[b.afkMode]} every <b>${humanInterval(b.afkIntervalMs)}</b>`
    : `\n<b>Anti-AFK:</b> off`;
  const food = b.status === 'online' && b.mcBot?.food != null ? `\n<b>Hunger:</b> ${Math.round(b.mcBot.food)} / 20` : '';
  const eat = b.autoEat ? `\n<b>Auto-Eat:</b> on (eats to heal when hurt)` : `\n<b>Auto-Eat:</b> off`;
  const login = b.loginCmd
    ? `\n<b>Auto-login:</b> ${b.loginEnabled === false ? 'saved but <b>disabled</b>' : 'on'} - <code>${esc(maskLogin(b.loginCmd))}</code>`
    : `\n<b>Auto-login:</b> not set`;
  const ac = b.autoChatMsg
    ? `\n<b>Auto-chat:</b> ${b.autoChatEnabled === false ? 'saved but <b>paused</b>' : 'on'} - every <b>${humanInterval(clampChatInterval(b.autoChatIntervalMs))}</b>`
    : `\n<b>Auto-chat:</b> not set`;
  return `${dot(b.status)} <b>${esc(b.name)}</b>  <i>(${esc(ownerTag(b))})</i>\n\n<b>Server:</b> <code>${esc(b.host)}:${b.port}</code>\n<b>Version:</b> <code>${esc(b.version)}</code>\n<b>Status:</b> <b>${b.status}</b>${ut}${food}${eat}${afk}${login}${ac}${cd}${err}`;
}

// Never echo the password back into a chat log in full.
function maskLogin(cmd) {
  return String(cmd).replace(/(\S+)$/, m => (m.length <= 2 ? '••' : m[0] + '•'.repeat(Math.min(m.length - 1, 8))));
}

function botManageKeyboard(name) {
  const b = mcBots.get(name);
  const kb = new InlineKeyboard();
  if (b?.status === 'online' || b?.status === 'connecting') kb.text('Disconnect', `disconnect:${name}`);
  else kb.text('Reconnect', `reconnect:${name}`);
  kb.text('Console', `console:${name}`).text('Hotbar', `hotbar:${name}`).row();
  kb.text('📍 Where', `where:${name}`).row();
  kb.text(`Auto-Eat: ${b?.autoEat ? 'ON' : 'OFF'}`, `autoeat:${name}`).row();
  kb.text(`Anti-AFK: ${AFK_LABEL[b?.afkMode || 'off']}`, `afk:${name}`).row();
  kb.text(b?.loginCmd ? 'Auto-login' : 'Set auto-login', `login:${name}`).row();
  kb.text(`Auto-chat: ${b?.autoChatMsg ? (b?.autoChatEnabled === false ? 'PAUSED' : 'ON') : 'OFF'}`, `ac:${name}`).row();
  kb.text('Neocraft', `neocraft:${name}`).row();
  return kb.text('Remove', `confirm_remove:${name}`).text('Refresh', `manage:${name}`).row().text('< Back', 'list_bots');
}

function hotbarMenuText(b) {
  const mc = b.mcBot;
  const online = b.status === 'online' && mc;
  const cur = online && mc.quickBarSlot != null ? mc.quickBarSlot : null;
  const rows = [];
  for (let i = 0; i < 9; i++) {
    const item = online ? mc.inventory?.slots?.[(mc.QUICK_BAR_START ?? 36) + i] : null;
    const label = item ? `${item.count > 1 ? `${item.count}x ` : ''}${item.displayName || item.name}` : 'empty';
    rows.push(`${cur === i ? '[*]' : '[ ]'} <b>${i + 1}</b>. ${esc(label)}`);
  }
  return `<b>Hotbar - ${esc(b.name)}</b>\n\nCurrent slot: <b>${cur == null ? '-' : cur + 1}</b>\nTap a slot to hold that item (pickaxe / axe / ...).\n\n${rows.join('\n')}`;
}

function hotbarMenuKeyboard(name) {
  const b = mcBots.get(name);
  const cur = b?.mcBot?.quickBarSlot;
  const kb = new InlineKeyboard();
  for (let i = 0; i < 9; i++) {
    kb.text(`${cur === i ? '[*]' : ''}${i + 1}`, `slot:${name}:${i}`);
    if ((i + 1) % 3 === 0) kb.row();
  }
  return kb.text('< Back', `manage:${name}`);
}

function afkMenuText(b) {
  return `<b>Anti-AFK - ${esc(b.name)}</b>\n\nKeeps the player from being kicked for idling.\n\n<b>Mode:</b> ${AFK_LABEL[b.afkMode || 'off']}\n<b>Every:</b> ${humanInterval(b.afkIntervalMs)}\n\n<b>Jump only</b> - hops in place\n<b>Walk 1 block</b> - steps one block forward, then back\n<b>Jump + Walk</b> - both together\n\nPick a mode, then an interval:`;
}

function afkMenuKeyboard(name) {
  const b = mcBots.get(name);
  const cur = b?.afkMode || 'off';
  const iv = b?.afkIntervalMs || DEFAULT_AFK_INTERVAL_MS;
  const mark = m => (m === cur ? '[*] ' : '');
  const ivMark = ms => (ms === iv ? '[*] ' : '');
  return new InlineKeyboard()
    .text(`${mark('off')}Off`, `afkmode:${name}:off`).text(`${mark('jump')}Jump only`, `afkmode:${name}:jump`).row()
    .text(`${mark('walk')}Walk 1 block`, `afkmode:${name}:walk`).text(`${mark('both')}Jump + Walk`, `afkmode:${name}:both`).row()
    .text(`${ivMark(15000)}15s`, `afkint:${name}:15000`).text(`${ivMark(30000)}30s`, `afkint:${name}:30000`).text(`${ivMark(60000)}1m`, `afkint:${name}:60000`).row()
    .text(`${ivMark(120000)}2m`, `afkint:${name}:120000`).text(`${ivMark(300000)}5m`, `afkint:${name}:300000`).text(`${ivMark(600000)}10m`, `afkint:${name}:600000`).row()
    .text('Custom interval', `afkcustom:${name}`).row()
    .text('Do it now', `afknow:${name}`).text('< Back', `manage:${name}`);
}

function loginMenuText(b) {
  if (!b.loginCmd) {
    return `<b>Auto-login - ${esc(b.name)}</b>\n\nNo command saved yet.\n\nSave the exact command your server needs after joining, e.g.\n<code>/login 1597311</code>\n<code>/register pass pass</code>\n\nIt is replayed automatically every time this bot connects or reconnects - and only when the server actually asks for a login.`;
  }
  return `<b>Auto-login - ${esc(b.name)}</b>\n\n<b>Command:</b> <code>${esc(maskLogin(b.loginCmd))}</code>\n<b>Status:</b> ${b.loginEnabled === false ? 'disabled' : 'enabled'}\n\nSent on every (re)connect when the server prompts for a login, with a ${LOGIN_FALLBACK_MS / 1000}s fallback if it stays quiet. Retries up to ${LOGIN_MAX_TRIES}x if the server doesn't confirm.`;
}

function loginMenuKeyboard(name) {
  const b = mcBots.get(name);
  const kb = new InlineKeyboard().text(b?.loginCmd ? 'Change command' : 'Set command', `loginset:${name}`).row();
  if (b?.loginCmd) {
    kb.text(b.loginEnabled === false ? 'Enable' : 'Disable', `logintoggle:${name}`).text('Clear', `loginclear:${name}`).row();
    kb.text('Send now', `loginnow:${name}`).row();
  }
  return kb.text('< Back', `manage:${name}`);
}

function acMenuText(b) {
  const iv = humanInterval(clampChatInterval(b.autoChatIntervalMs));
  if (!b.autoChatMsg) {
    return `<b>Auto-chat - ${esc(b.name)}</b>\n\nNo message saved yet.\n\nThe bot repeats a message in server chat on a fixed interval - useful for reminders, keep-alive chatter or any command.\n\n<b>Every:</b> ${iv}\n\nSet a message first, then pick an interval:`;
  }
  return `<b>Auto-chat - ${esc(b.name)}</b>\n\n<b>Message:</b> <code>${esc(b.autoChatMsg)}</code>\n<b>Every:</b> ${iv}\n<b>Status:</b> ${b.autoChatEnabled === false ? 'paused' : 'running'}\n\nSent only while the bot is online. Start the message with <code>/</code> and it runs as a command.`;
}

function acMenuKeyboard(name) {
  const b = mcBots.get(name);
  const iv = b?.autoChatIntervalMs || DEFAULT_AUTOCHAT_INTERVAL_MS;
  const ivMark = ms => (ms === iv ? '[*] ' : '');
  const kb = new InlineKeyboard()
    .text(b?.autoChatMsg ? '✏️ Change message' : '✏️ Set message', `acmsg:${name}`).row()
    .text(`${ivMark(600000)}10m`, `acint:${name}:600000`).text(`${ivMark(1800000)}30m`, `acint:${name}:1800000`).row()
    .text(`${ivMark(3600000)}1h`, `acint:${name}:3600000`).text(`${ivMark(7200000)}2h`, `acint:${name}:7200000`).row()
    .text('Custom interval', `accustom:${name}`).row();
  if (b?.autoChatMsg) {
    if (b?.status === 'online') kb.text('▶️ Send now', `acnow:${name}`).row();
    kb.text(b?.autoChatEnabled === false ? '▶️ Resume' : '⏸ Pause', `actoggle:${name}`).text('🗑 Clear', `acclear:${name}`).row();
  }
  return kb.text('< Back', `manage:${name}`);
}

function neocraftMenuText(b) {
  const status = b.ncEnabled === true ? 'enabled' : 'disabled';
  const login = b.ncLogin ? `<code>${esc(maskLogin(b.ncLogin))}</code>` : '<i>not set</i>';
  const second = b.ncSecond ? `<code>${esc(b.ncSecond)}</code>` : '<i>not set</i>';
  const third = b.ncThird ? `<code>${esc(b.ncThird)}</code>` : '<i>not set</i>';
  return `<b>Neocraft server - ${esc(b.name)}</b>\n\nOn every join it logs in, switches you into survival, then runs a 3rd command 5 minutes later.\n\n<b>Login command:</b> ${login}\n<b>2nd command:</b> ${second}\n<b>3rd command (after 5 min):</b> ${third}\n<b>Status:</b> ${status}\n\nLogin answers the server's own prompt (fallback ~2s after joining, retried up to 3x while unconfirmed). The 2nd command goes out ~3s after login is confirmed and repeats once more ~15s later for assurance; the 3rd runs 5 minutes after the 2nd.\nThe whole chain re-runs on every join and announces each step here.`;
}

function neocraftMenuKeyboard(name) {
  const b = mcBots.get(name);
  const kb = new InlineKeyboard();
  kb.text(b?.ncLogin ? 'Change login' : 'Set login', `ncsetlogin:${name}`).text(b?.ncSecond ? 'Change 2nd cmd' : 'Set 2nd cmd', `ncsetsecond:${name}`).row();
  kb.text(b?.ncThird ? 'Change 3rd cmd' : 'Set 3rd cmd (5 min)', `ncsetthird:${name}`).row();
  kb.text(b?.ncEnabled ? 'Disable' : 'Enable', `nctoggle:${name}`).row();
  if (b?.ncLogin || b?.ncSecond || b?.ncThird) kb.text('Clear', `ncclear:${name}`).row();
  return kb.text('< Back', `manage:${name}`);
}

// --- auto-chat (scheduled message) ---
// Repeats a saved message (or command) in server chat on a fixed interval.
// Sends go through the shared send queue.

const clampChatInterval = ms => {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_AUTOCHAT_INTERVAL_MS;
  return Math.min(Math.max(Math.round(n), MIN_AUTOCHAT_INTERVAL_MS), MAX_AUTOCHAT_INTERVAL_MS);
};

function stopAutoChat(info) {
  if (info.autoChatTimer) { clearTimeout(info.autoChatTimer); info.autoChatTimer = null; }
}

function autoChatTick(info) {
  const live = mcBots.get(info.name);
  // A respawned bot object replaces this one; let that one own the timer.
  if (!live || live !== info) return;
  if (!info.autoChatMsg || info.autoChatEnabled === false) return;
  if (info.status === 'online' && info.mcBot) {
    try { queueSend(info, info.autoChatMsg); }
    catch (e) { info.error = `Auto-chat: ${e.message}`; }
  }
  scheduleAutoChat(info);
}

// (Re)arm the repeating auto-chat send for this bot. The interval carries ±10%
// jitter so the timing doesn't look machine-made to players or plugins.
function scheduleAutoChat(info) {
  stopAutoChat(info);
  if (!info.autoChatMsg || info.autoChatEnabled === false) return;
  const base = clampChatInterval(info.autoChatIntervalMs);
  const jitter = Math.floor(base * 0.1);
  const delay = base + (jitter ? Math.floor((Math.random() - 0.5) * jitter * 2) : 0);
  info.autoChatTimer = setTimeout(() => autoChatTick(info), delay);
}

function stopAfk(info) {
  // Invalidate every callback a pulse may still have pending.
  info.afkGen = (info.afkGen || 0) + 1;
  if (info.afkTimer) { clearTimeout(info.afkTimer); info.afkTimer = null; }
  if (info.afkStepTimers) { for (const t of info.afkStepTimers) clearTimeout(t); info.afkStepTimers = []; }
  const mc = info.mcBot;
  if (mc) {
    // sneak/sprint too: stopping mid-pulse must not leave the player creeping.
    for (const c of ['forward', 'back', 'jump', 'sneak', 'sprint']) { try { mc.setControlState(c, false); } catch (_) {} }
  }
}

function stopLogin(info) {
  if (info.loginTimer) { clearTimeout(info.loginTimer); info.loginTimer = null; }
  if (info.loginRetryTimer) { clearTimeout(info.loginRetryTimer); info.loginRetryTimer = null; }
  info.loginTries = 0;
  info.loginDone = false;
}

function stopNeocraft(info) {
  if (info.ncTimer1) { clearTimeout(info.ncTimer1); info.ncTimer1 = null; }
  if (info.ncTimer2) { clearTimeout(info.ncTimer2); info.ncTimer2 = null; }
  if (info.ncTimer2b) { clearTimeout(info.ncTimer2b); info.ncTimer2b = null; }
  if (info.ncTimer3) { clearTimeout(info.ncTimer3); info.ncTimer3 = null; }
  if (info.ncLoginRetryTimer) { clearTimeout(info.ncLoginRetryTimer); info.ncLoginRetryTimer = null; }
  info.ncLoginTries = 0;
  info.ncLoginDone = false;
  info.ncSecondSends = 0;
  info.ncSurvivalDone = false;
}

function destroyBot(info) {
  if (info.reconnectTimer) { clearTimeout(info.reconnectTimer); info.reconnectTimer = null; }
  if (info.sendTimer) { clearTimeout(info.sendTimer); info.sendTimer = null; }
  if (info.probeTimer) { clearTimeout(info.probeTimer); info.probeTimer = null; }
  info.sendQueue = [];
  stopAfk(info);
  stopLogin(info);
  stopNeocraft(info);
  stopAutoChat(info);
  if (info.eatDisposer) { try { info.eatDisposer(); } catch (_) {} info.eatDisposer = null; }
  if (info.mcBot) {
    const mc = info.mcBot;
    info.mcBot = null;
    // Detach only this manager's listeners (see spawnBot). mineflayer's own
    // bot-level listeners include physics' `bot.on('end', cleanup)`, the only
    // thing that clears its 20 Hz tick interval — removeAllListeners() here let
    // that interval keep running and hold the whole Bot (world, chunks, entities)
    // in memory after every reconnect, until the heap ran out.
    if (info.detachListeners) info.detachListeners();
    // quit() can emit 'error' on a half-open socket; an unhandled one would crash us.
    mc.on('error', () => {});
    try { mc.quit(); } catch (_) {}
  }
}

// One anti-AFK pulse. Jump hops in place; walk steps a block forward then a block
// back, so the player ends up where it started and never wanders off.
// Enhanced with more human-like randomization and varied behaviors.
function afkPulse(info) {
  const mc = info.mcBot;
  if (!mc || info.status !== 'online') return;
  const mode = info.afkMode || 'off';
  if (mode === 'off') return;

  // New generation: any callback left pending by an earlier pulse (or by a
  // stopAfk that raced this one) sees a changed gen and no-ops. The timer list
  // also starts fresh here — it was previously only cleared by stopAfk, so
  // fired timers piled up for the whole lifetime of the connection.
  const gen = (info.afkGen = (info.afkGen || 0) + 1);
  info.afkStepTimers = [];
  const at = (ms, fn) => info.afkStepTimers.push(setTimeout(() => {
    if (info.afkGen !== gen || info.mcBot !== mc || info.status !== 'online') return;
    try { fn(); } catch (e) { info.error = `Anti-AFK: ${e.message}`; }
  }, ms));

  const wantJump = mode === 'jump' || mode === 'both';
  const wantWalk = mode === 'walk' || mode === 'both';

  try {
    // Face a new direction with varying pitch - more human-like
    const yaw = Math.random() * Math.PI * 2;
    const pitch = (Math.random() - 0.5) * 0.8; // Wider pitch range
    mc.look(yaw, pitch, Math.random() > 0.5); // Sometimes force, sometimes smooth
    
    // Occasionally look up or down more (like checking surroundings)
    if (Math.random() > 0.7) {
      at(200 + Math.floor(Math.random() * 300), () => {
        mc.look(yaw + (Math.random() - 0.5) * 0.5, (Math.random() - 0.5) * 1.2, true);
      });
    }
  } catch (_) {}

  // Add random sneak action occasionally (10% chance)
  if (Math.random() > 0.9) {
    try { mc.setControlState('sneak', true); } catch (_) {}
    at(100 + Math.floor(Math.random() * 200), () => mc.setControlState('sneak', false));
  }

  if (wantJump) {
    // Vary jump duration slightly for more natural feel
    const jumpDuration = AFK_JUMP_MS + Math.floor((Math.random() - 0.5) * 100);
    try { mc.setControlState('jump', true); } catch (_) {}
    at(jumpDuration, () => mc.setControlState('jump', false));
  }

  if (wantWalk) {
    // Add slight randomization to walk timing
    const stepDuration = AFK_STEP_MS + Math.floor((Math.random() - 0.5) * 50);
    
    try { mc.setControlState('forward', true); } catch (_) {}
    at(stepDuration, () => {
      mc.setControlState('forward', false);
      // Small pause before going back (more human). Tracked through at() so a
      // stopAfk during the pause can't leave the player walking backward.
      at(50 + Math.floor(Math.random() * 100), () => mc.setControlState('back', true));
    });
    at(stepDuration * 2 + 50, () => mc.setControlState('back', false));
    
    // Second hop on the way back keeps 'both' lively across the whole pulse.
    if (wantJump) {
      const secondJumpDelay = stepDuration + 60 + Math.floor(Math.random() * 100);
      at(secondJumpDelay, () => mc.setControlState('jump', true));
      at(secondJumpDelay + AFK_JUMP_MS, () => mc.setControlState('jump', false));
    }
    
    // Occasionally sprint for a moment (5% chance - like accidentally pressing sprint)
    if (Math.random() > 0.95) {
      at(100, () => {
        mc.setControlState('sprint', true);
        at(200 + Math.floor(Math.random() * 300), () => mc.setControlState('sprint', false));
      });
    }
  }
}

// (Re)arm the repeating pulse for this bot according to its current mode.
// Add randomization to make intervals less predictable and more human-like.
function scheduleAfk(info) {
  if (info.afkTimer) { clearTimeout(info.afkTimer); info.afkTimer = null; }
  if (!info.afkMode || info.afkMode === 'off') return;
  const baseInterval = clampInterval(info.afkIntervalMs);
  const tick = () => {
    const live = mcBots.get(info.name);
    // A respawned bot object replaces this one; let that one own the timer.
    if (!live || live !== info) return;
    if (info.status === 'online' && info.mcBot) afkPulse(info);
    
    // Add ±15% randomization to interval for more natural timing
    const variance = baseInterval * 0.15;
    const randomizedInterval = baseInterval + Math.floor((Math.random() - 0.5) * variance * 2);
    info.afkTimer = setTimeout(tick, randomizedInterval);
  };
  
  // Start with a slightly randomized first delay
  const firstDelay = baseInterval + Math.floor(Math.random() * 3000);
  info.afkTimer = setTimeout(tick, firstDelay);
}

function setAfk(info, mode, intervalMs) {
  if (mode !== undefined) info.afkMode = AFK_MODES.has(mode) ? mode : 'off';
  if (intervalMs !== undefined) info.afkIntervalMs = clampInterval(intervalMs);
  stopAfk(info);
  scheduleAfk(info);
  saveData();
}

// Fire the saved login command. Jumps the send queue so it lands before anything
// the user typed while the bot was still connecting.
// When the Neocraft flow is enabled it owns the login command, so it takes
// precedence over the plain auto-login one.
function sendLogin(info, why) {
  const cmd = (info.ncEnabled && info.ncLogin) ? info.ncLogin : info.loginCmd;
  if (!cmd || info.loginEnabled === false) return false;
  if (info.status !== 'online' || !info.mcBot) return false;
  if (info.loginTries >= LOGIN_MAX_TRIES) return false;
  info.loginTries = (info.loginTries || 0) + 1;
  if (info.loginTimer) { clearTimeout(info.loginTimer); info.loginTimer = null; }
  queueSend(info, cmd, true);
  info.error = `Auto-login sent (${why}, try ${info.loginTries})`;

  // If the server never confirms, try again — some plugins swallow the first attempt.
  if (info.loginRetryTimer) clearTimeout(info.loginRetryTimer);
  info.loginRetryTimer = setTimeout(() => {
    info.loginRetryTimer = null;
    if (info.loginDone) return;
    sendLogin(info, 'retry');
  }, LOGIN_RETRY_MS);
  return true;
}

// --- neocraft timing ---
const NC_LOGIN_DELAY_MS = 2000;        // join fallback: send login if the server never prompts
const NC_LOGIN_RETRY_MS = 8000;        // resend login while the server hasn't confirmed it
const NC_LOGIN_MAX_TRIES = 3;          // login attempts per connection before giving up
const NC_AFTER_LOGIN_MS = 3000;        // 2nd command this soon after the server confirms login
const NC_SECOND_DELAY_MS = 10000;      // fallback: 2nd command this long after login if never confirmed
const NC_SECOND_RESEND_MS = 15000;     // gap between 2nd-command repeats while unconfirmed
const NC_SECOND_MAX_TRIES = 4;         // stop repeating the 2nd command after this many sends
const NC_THIRD_DELAY_MS = 5 * 60000;   // 3rd command 5 minutes after the 2nd (or the login if no 2nd)

// Neocraft's real chat lines are Finglish. The prompt asks for /login; success is
// "Dar hal-e enteghal be Lobby..." plus a small-caps "WELCOME ... NEOCRAFT"
// banner. "Khosh bargashti" is printed BOTH before and after login, so it must
// never count as a confirmation. /survival is confirmed by "Connecting to Survival..".
const NC_LOGGED_IN_RE = /(dar hal[-\s]?e enteghal|enteghal be lobby|(ᴡᴇʟᴄᴏᴍᴇ|welcome)[\s\S]{0,40}neocraft)/i;
const NC_SURVIVAL_OK_RE = /connecting to[\s\S]{0,30}survival|survival[\s\S]{0,30}(connected|joined)|switched to survival/i;

// Neocraft server auto-flow: log in, switch into survival, then run a 3rd
// command after 5 minutes. The login reacts to the server's own prompt (with a
// join fallback + retries while it stays unconfirmed); the 2nd command goes out
// once login is confirmed (with a timed fallback for silent servers) and is
// repeated once more for assurance, in case the first one landed while the
// server was still moving the player into the lobby. A fresh join re-arms the
// whole chain, so a bot that falls out and lands back in the lobby logs in and
// re-runs the 2nd command by itself.
function sendNcLogin(info, why) {
  if (!info.ncEnabled || !info.ncLogin) return false;
  if (info.ncLoginDone) return false;
  if (info.status !== 'online' || !info.mcBot) return false;
  if ((info.ncLoginTries || 0) >= NC_LOGIN_MAX_TRIES) return false;
  info.ncLoginTries = (info.ncLoginTries || 0) + 1;
  // The join fallback has served its purpose once we send for any reason.
  if (info.ncTimer1) { clearTimeout(info.ncTimer1); info.ncTimer1 = null; }
  queueSend(info, info.ncLogin, true);
  info.error = `Neocraft login sent (${why}, try ${info.ncLoginTries})`;
  if (info.ncLoginTries === 1) {
    notify(info.chatId, `🏰 <b>${esc(info.name)}</b> — login sent (<code>${esc(maskLogin(info.ncLogin))}</code>)${info.ncSecond ? `; <code>${esc(info.ncSecond)}</code> follows after login.` : ''}`);
  } else {
    console.log(`[${info.name}] Neocraft login retry ${info.ncLoginTries} (${why})`);
  }

  // The server hasn't confirmed yet — keep retrying while it keeps asking.
  if (info.ncLoginRetryTimer) clearTimeout(info.ncLoginRetryTimer);
  info.ncLoginRetryTimer = setTimeout(() => {
    info.ncLoginRetryTimer = null;
    if (info.ncLoginDone) return;
    if (mcBots.get(info.name) !== info) return;
    sendNcLogin(info, 'retry');
  }, NC_LOGIN_RETRY_MS);

  // Fallback: some servers never send a recognizable "logged in" line.
  // If confirmation never comes, still send the 2nd command on a timer.
  if (info.ncSecond && !info.ncSecondSends && !info.ncTimer2) {
    info.ncTimer2 = setTimeout(() => {
      info.ncTimer2 = null;
      if (mcBots.get(info.name) !== info) return;
      if (info.ncSecondSends) return;
      sendNcSecond(info, 'fallback');
    }, NC_SECOND_DELAY_MS);
  } else if (!info.ncSecond && !info.ncTimer3) {
    armNcThird(info, Date.now());
  }
  return true;
}

// The server confirmed the login — stop retrying it and send the 2nd command
// after a short pause so the server finishes dropping the player into the lobby.
function onNcLoginConfirmed(info) {
  if (!info.ncEnabled || !info.ncLogin) return;
  if (info.ncLoginDone) return;
  info.ncLoginDone = true;
  if (info.ncLoginRetryTimer) { clearTimeout(info.ncLoginRetryTimer); info.ncLoginRetryTimer = null; }
  if (info.ncTimer1) { clearTimeout(info.ncTimer1); info.ncTimer1 = null; }
  info.error = 'Neocraft login confirmed';
  if (!info.ncSecond) {
    if (!info.ncTimer3) armNcThird(info, Date.now());
    return;
  }
  if (info.ncSecondSends) return; // the fallback already sent it; its resend is armed
  if (info.ncTimer2) clearTimeout(info.ncTimer2);
  info.ncTimer2 = setTimeout(() => {
    info.ncTimer2 = null;
    if (mcBots.get(info.name) !== info) return;
    if (info.ncSecondSends) return;
    sendNcSecond(info, 'after login');
  }, NC_AFTER_LOGIN_MS);
}

function sendNcSecond(info, why) {
  if (!info.ncEnabled || !info.ncSecond) return false;
  if (info.ncSurvivalDone) return false;
  if (info.status !== 'online' || !info.mcBot) return false;
  if ((info.ncSecondSends || 0) >= NC_SECOND_MAX_TRIES) return false;
  queueSend(info, info.ncSecond);
  info.ncSecondSends = (info.ncSecondSends || 0) + 1;
  info.error = `Neocraft 2nd command sent (${why}, try ${info.ncSecondSends})`;
  if (info.ncSecondSends === 1) {
    notify(info.chatId, `🏰 <b>${esc(info.name)}</b> — 2nd command sent (${why}): <code>${esc(info.ncSecond)}</code>${info.ncThird ? `; <code>${esc(info.ncThird)}</code> follows in ${NC_THIRD_DELAY_MS / 60000} min.` : ''}`);
    armNcThird(info, Date.now());
  } else {
    console.log(`[${info.name}] Neocraft 2nd command resend ${info.ncSecondSends} (${why})`);
  }
  // Keep repeating until the server answers with "Connecting to Survival..".
  // A command that lands while the lobby is still moving the player gets lost,
  // so one blind send is not enough.
  if (info.ncTimer2b) clearTimeout(info.ncTimer2b);
  info.ncTimer2b = setTimeout(() => {
    info.ncTimer2b = null;
    if (mcBots.get(info.name) !== info) return;
    if (info.ncSurvivalDone) return;
    sendNcSecond(info, 'assurance resend');
  }, NC_SECOND_RESEND_MS);
  return true;
}

// The server answered the 2nd command — stop repeating it.
function onNcSurvivalConfirmed(info) {
  if (!info.ncEnabled || !info.ncSecond) return;
  if (info.ncSurvivalDone) return;
  info.ncSurvivalDone = true;
  if (info.ncTimer2) { clearTimeout(info.ncTimer2); info.ncTimer2 = null; }
  if (info.ncTimer2b) { clearTimeout(info.ncTimer2b); info.ncTimer2b = null; }
  info.error = 'Neocraft survival confirmed';
  notify(info.chatId, `🏰 <b>${esc(info.name)}</b> — in Survival, stopping repeats.`);
}

function armNcThird(info, from) {
  if (!info.ncThird) return;
  if (info.ncTimer3) clearTimeout(info.ncTimer3);
  const wait = Math.max(0, NC_THIRD_DELAY_MS - (Date.now() - (from || Date.now())));
  info.ncTimer3 = setTimeout(() => {
    info.ncTimer3 = null;
    if (mcBots.get(info.name) !== info) return;
    if (info.status !== 'online' || !info.mcBot) return;
    queueSend(info, info.ncThird);
    info.error = 'Neocraft 3rd command sent';
    notify(info.chatId, `🏰 <b>${esc(info.name)}</b> — 3rd command sent: <code>${esc(info.ncThird)}</code>`);
  }, wait);
}

function scheduleNeocraft(info) {
  if (!info.ncEnabled || !info.ncLogin) return;
  if (info.ncLoginDone || (info.ncLoginTries || 0) > 0) {
    // The login phase already ran (e.g. the 3rd command was added mid-session):
    // just make sure it gets armed if it now exists.
    if (info.ncThird && !info.ncTimer3 && (!info.ncSecond || info.ncSecondSends)) armNcThird(info, Date.now());
    return;
  }
  if (info.ncTimer1) clearTimeout(info.ncTimer1);
  info.ncTimer1 = setTimeout(() => {
    info.ncTimer1 = null;
    if (mcBots.get(info.name) !== info) return;
    if (info.status !== 'online' || !info.mcBot) return;
    sendNcLogin(info, 'fallback');
  }, NC_LOGIN_DELAY_MS);
}

// Inbound-activity-driven connectivity probe. The spawn handler timestamps
// every packet that arrives; a lightweight check runs every PROBE_CHECK_MS and
// only opens a TCP probe when nothing has arrived for PROBE_SILENCE_MS. A
// healthy connection (keepalives ~every 15s) therefore costs zero extra
// connections instead of one every few minutes — which also keeps us from
// looking like a bot to connection-counting antibots — while a half-open socket
// (host sleep, NAT drop, dead link) is still caught well before the protocol
// library's 60s keepalive watchdog fires.
const PROBE_CHECK_MS = 30000;   // cadence of the inbound-activity check
const PROBE_SILENCE_MS = 25000; // inbound quiet longer than this ⇒ open a probe
const PROBE_DEAD_MS = 10000;          // 10s of stalls = the path is dead, not lag
// Must stay ABOVE PROBE_DEAD_MS: a stalled connect is cut by this socket timeout,
// and the error handler only treats an error as "dead path" once PROBE_DEAD_MS
// has elapsed since the probe started. With the timeout below the threshold
// (it was 8s vs 10s), a blackholed path was always silently closed as "too fast
// to judge" and the dead-path branch could never fire.
const PROBE_SOCKET_TIMEOUT_MS = 12000;
// Fixed reconnect interval (user preference): always retry after ~4s instead of
// escalating the backoff. A tiny jitter keeps retries off a perfect beat so the
// pattern doesn't look automated. When several bots share one server,
// staggerExtraMs() adds a per-bot slot on top (see below) — a lone bot still
// rejoins on the plain ~4s beat.
const RECONNECT_FIXED_MS = 4000;
const RECONNECT_FIXED_JITTER = 1000;
const reconnectDelay = n =>
  RECONNECT_FIXED_MS + Math.floor(Math.random() * RECONNECT_FIXED_JITTER);

// True for the keepalive watchdog error (“client timed out after … milliseconds”).
const isTimeoutError = e =>
  /timed out after \d+ milliseconds/.test(e?.message || String(e));

// How long to wait before the next attempt. Every attempt uses the same fixed
// ~4s gap, so a server that just keeps dropping the join (no captcha, no
// cooldown message) gets retried on a steady beat forever instead of the bot
// parking itself for long stretches between tries.
const retryDelay = (n, timeout) => reconnectDelay(n);

// Staggered rejoins after a mass drop. When a server restarts, every bot on it
// falls out at once; retrying all of them on the same ~4s beat hammers the
// server the moment it comes back and can trip its rate limit. So when other
// bots on the same host:port are also down and set to retry, each bot waits its
// own slot on top of the normal delay. The slot is the bot's index in the
// sorted names of the down group, so it is stable across retry rounds with no
// shared ledger that could go stale and park a lone bot behind dead entries.
const STAGGER_SLOT_MS = 7000;
const STAGGER_JITTER_MS = 3000;

function staggerExtraMs(host, port, name) {
  const h = String(host).toLowerCase();
  const downNames = [];
  for (const b of mcBots.values()) {
    if (b.name === name) continue; // self is always counted below
    if (String(b.host).toLowerCase() !== h || Number(b.port) !== Number(port)) continue;
    if (b.status === 'online') continue;
    if (!b.autoReconnect) continue; // parked by the user — not rejoining
    if (b.status === 'error' && !b.reconnectTimer) continue; // gave up — not rejoining
    downNames.push(b.name);
  }
  downNames.push(name); // this bot is rejoining — it always holds a slot
  if (downNames.length < 2) return 0; // just us — keep the plain ~4s beat
  downNames.sort();
  const slot = downNames.indexOf(name);
  return slot * STAGGER_SLOT_MS + Math.floor(Math.random() * STAGGER_JITTER_MS);
}

// Group startup joins by server so a process restart never dials out to one
// server from every bot in the same tick. The first bot (by name) connects
// right away; the rest wait their slot. Placeholders with status 'offline' keep
// the bots visible (and manually reconnectable) during the wait.
function scheduleStaggeredStarts(list) {
  const byServer = new Map();
  for (const p of list) {
    const key = `${String(p.b.host).toLowerCase()}:${p.b.port}`;
    if (!byServer.has(key)) byServer.set(key, []);
    byServer.get(key).push(p);
  }
  for (const group of byServer.values()) {
    // Plain code-unit sort — the same ordering staggerExtraMs() uses, so the
    // startup slot order matches the retry slot order for the same bot set.
    group.sort((a, b) => (String(a.b.name) < String(b.b.name) ? -1 : String(a.b.name) > String(b.b.name) ? 1 : 0));
    if (group.length > 1) console.log(`[stagger] ${group.length} bots on ${String(group[0].b.host).toLowerCase()}:${group[0].b.port} — spreading startup joins`);
    group.forEach((p, i) => {
      const { b, opts } = p;
      if (i === 0) {
        spawnBot(b.name, b.host, b.port, b.version, b.chatId, b.ownerUsername, opts);
        return;
      }
      const wait = i * STAGGER_SLOT_MS + Math.floor(Math.random() * STAGGER_JITTER_MS);
      const entry = {
        name: b.name, host: b.host, port: b.port, version: b.version,
        chatId: b.chatId, ownerUsername: b.ownerUsername || null,
        mcBot: null, status: 'offline',
        connectedAt: null, error: `Starting in ${Math.round(wait / 1000)}s (staggered rejoin with ${group.length} bots on this server)`,
        autoReconnect: true, reconnectAttempts: 0, reconnectTimer: null,
        cooldownUntil: 0, cooldownWaits: Number(b.cooldownWaits) || 0,
        ...opts,
      };
      mcBots.set(b.name, entry);
      entry.reconnectTimer = setTimeout(() => {
        const latest = mcBots.get(b.name);
        if (latest !== entry || !entry.autoReconnect) return;
        entry.reconnectTimer = null;
        // Read the live entry, not the startup snapshot: the user may have
        // changed settings (AFK, login, auto-chat…) while waiting for the slot.
        spawnBot(b.name, b.host, b.port, b.version, b.chatId, b.ownerUsername, {
          loginCmd: entry.loginCmd, loginEnabled: entry.loginEnabled,
          ncLogin: entry.ncLogin, ncSecond: entry.ncSecond, ncThird: entry.ncThird, ncEnabled: entry.ncEnabled,
          afkMode: entry.afkMode, afkIntervalMs: entry.afkIntervalMs,
          autoChatMsg: entry.autoChatMsg, autoChatEnabled: entry.autoChatEnabled, autoChatIntervalMs: entry.autoChatIntervalMs,
          autoEat: entry.autoEat,
        });
      }, wait);
      if (entry.reconnectTimer.unref) entry.reconnectTimer.unref();
    });
  }
}

// Same staggering for joins that were parked behind an antibot cooldown across
// a restart: without it, bots that share one IP's cooldown all rejoin in the
// same tick when it expires.
function scheduleStaggeredCooldowns(list) {
  const byServer = new Map();
  for (const p of list) {
    const key = `${String(p.b.host).toLowerCase()}:${p.b.port}`;
    if (!byServer.has(key)) byServer.set(key, []);
    byServer.get(key).push(p);
  }
  for (const group of byServer.values()) {
    group.sort((a, b) => (String(a.entry.name) < String(b.entry.name) ? -1 : String(a.entry.name) > String(b.entry.name) ? 1 : 0));
    group.forEach((p, i) => {
      const extra = i === 0 ? 0 : i * STAGGER_SLOT_MS + Math.floor(Math.random() * STAGGER_JITTER_MS);
      const total = p.delay + extra;
      if (extra > 0) p.entry.error = `Antibot cooldown — waiting ${humanInterval(total)} (incl. staggered rejoin)`;
      p.entry.reconnectTimer = setTimeout(() => {
        const latest = mcBots.get(p.b.name);
        if (latest !== p.entry || !p.entry.autoReconnect) return;
        p.entry.reconnectTimer = null;
        p.entry.cooldownUntil = 0;
        // Read the live entry, not the startup snapshot: the user may have
        // changed settings while parked behind the cooldown.
        const e = p.entry;
        spawnBot(p.b.name, p.b.host, p.b.port, p.b.version, p.b.chatId, p.b.ownerUsername, {
          loginCmd: e.loginCmd, loginEnabled: e.loginEnabled,
          ncLogin: e.ncLogin, ncSecond: e.ncSecond, ncThird: e.ncThird, ncEnabled: e.ncEnabled,
          afkMode: e.afkMode, afkIntervalMs: e.afkIntervalMs,
          autoChatMsg: e.autoChatMsg, autoChatEnabled: e.autoChatEnabled, autoChatIntervalMs: e.autoChatIntervalMs,
          autoEat: e.autoEat,
        });
      }, total);
      if (p.entry.reconnectTimer.unref) p.entry.reconnectTimer.unref();
    });
  }
}

// Half-open socket guardian. While a bot is "online" we probe the outbound TCP
// path to its server once a minute or so; if the path is dead (host asleep, NAT
// dropped, link down) we quit the connection early instead of waiting for the
// keepalive watchdog to kill it 60s later. A few stalls are just lag — only a
// sustained one counts as dead, and a single wall of dropped probes never
// triggers more than one drop.
function pollConnectivity(info) {
  if (!info || info.status !== 'online' || !info.mcBot) return;
  const started = Date.now();
  const s = net.connect({ host: info.host, port: info.port });
  s.setTimeout(PROBE_SOCKET_TIMEOUT_MS);
  const done = id => { try { s.destroy(); } catch (_) {} };

  const gate = () => mcBots.get(info.name) === info && info.mcBot;

  s.on('error', () => {
    if (Date.now() - started < PROBE_DEAD_MS) return done();
    if (!gate()) return done(); // already down — let the normal path handle it
    if (info.probeDown) return done(); // one drop per dead spell
    info.probeDown = true;
    info.error = 'Connection stalled — no server data for a while; reconnecting';
    info.mcBot.quit('connectivityLost');
    done();
  });
  s.on('timeout', () => { try { s.emit('error', new Error('probe timeout')); } catch (_) {} });
  s.on('connect', () => { info.probeDown = false; done(); });
}

// When the server says "you are denied, wait a few minutes", retrying early is
// counter-productive: most antibots restart the timer on every rejected attempt,
// so a fast retry loop can never get in. Sit out the window the server named
// (plus a margin), and don't burn a reconnect attempt on a wait we were told to
// take — otherwise every refused attempt burns a reconnect on a wait we were told to take.
const COOLDOWN_DEFAULT_MS = 5 * 60000;  // "a few minutes" with no number given
const COOLDOWN_MIN_MS = 60000;          // never trust a suspiciously short cooldown
const COOLDOWN_MAX_MS = 20 * 60000;     // cap so a bot is never parked for hours
const COOLDOWN_MARGIN = 1.25;           // wait a bit past the stated window
const COOLDOWN_MAX_WAITS = 5;           // give up after this many refusals in a row

const cooldownWait = statedMs => {
  const base = statedMs == null ? COOLDOWN_DEFAULT_MS : statedMs;
  const ms = Math.round(base * COOLDOWN_MARGIN) + Math.floor(Math.random() * 15000);
  return Math.min(COOLDOWN_MAX_MS, Math.max(COOLDOWN_MIN_MS, ms));
};

async function spawnBot(name, host, port, version, chatId, ownerUsername, opts = {}) {
  const ex = mcBots.get(name);
  if (ex) destroyBot(ex);

  const info = {
    name, host, port, version, chatId,
    ownerUsername: ownerUsername || null,
    mcBot: null, status: 'connecting',
    connectedAt: Date.now(),
    error: null,
    autoReconnect: true,
    reconnectAttempts: ex?.reconnectAttempts ?? 0,
    wasEverOnline: ex?.wasEverOnline ?? false, // Track if bot ever successfully spawned
    reconnectTimer: null,
    // Carried across reconnects so settings survive a dropped connection.
    loginCmd: opts.loginCmd !== undefined ? opts.loginCmd : (ex?.loginCmd ?? null),
    loginEnabled: opts.loginEnabled !== undefined ? opts.loginEnabled : (ex?.loginEnabled !== false),
    loginTries: 0, loginDone: false, loginTimer: null, loginRetryTimer: null,
    ncLogin: opts.ncLogin !== undefined ? opts.ncLogin : (ex?.ncLogin ?? null),
    ncSecond: opts.ncSecond !== undefined ? opts.ncSecond : (ex?.ncSecond ?? null),
    ncThird: opts.ncThird !== undefined ? opts.ncThird : (ex?.ncThird ?? null),
    ncEnabled: opts.ncEnabled !== undefined ? opts.ncEnabled : (ex?.ncEnabled === true),
    ncTimer1: null, ncTimer2: null, ncTimer2b: null, ncTimer3: null,
    ncLoginRetryTimer: null, ncLoginTries: 0, ncLoginDone: false, ncSecondSends: 0, ncSurvivalDone: false,
    afkMode: opts.afkMode !== undefined ? opts.afkMode : (ex?.afkMode ?? 'off'),
    afkIntervalMs: clampInterval(opts.afkIntervalMs !== undefined ? opts.afkIntervalMs : ex?.afkIntervalMs),
    autoChatMsg: opts.autoChatMsg !== undefined ? opts.autoChatMsg : (ex?.autoChatMsg ?? null),
    autoChatEnabled: opts.autoChatEnabled !== undefined ? opts.autoChatEnabled : (ex?.autoChatEnabled !== false),
    autoChatIntervalMs: clampChatInterval(opts.autoChatIntervalMs !== undefined ? opts.autoChatIntervalMs : ex?.autoChatIntervalMs),
    autoChatTimer: null,
    autoEat: opts.autoEat !== undefined ? opts.autoEat : (ex?.autoEat === true),
    eatBusy: false, eatWarnedAt: 0, eatDisposer: null,
    afkTimer: null, afkStepTimers: [],
    // Cooldown refusals carry across reconnects: the server's timer doesn't
    // reset just because we made a new socket.
    cooldownWaits: ex?.cooldownWaits ?? 0,
    cooldownUntil: ex?.cooldownUntil ?? 0,
    // Connectivity-safety state.
    probeTimer: null,        // pollConnectivity loop
    probeDown: false,        // set while a probe found the path dead
    timeoutConnected: false, // was this connection killed by the keepalive timeout?
  };
  mcBots.set(name, info);

  let mcBot;
  try {
    // Look like an ordinary vanilla client. Everything here is a value a real
    // player sends anyway — the point is not to leave mineflayer's blanks where
    // an antibot expects a client fingerprint.
    
    const botOptions = {
      host,
      port,
      username: name,
      // 'auto' → let minecraft-protocol ping the server and match its protocol.
      // Joining on the wrong version is rejected before any antibot even runs.
      version: version === AUTO_VERSION ? false : version,
      auth: 'offline',
      hideErrors: false,
      // Keepalive watchdog: this is ~6× the vanilla keepalive rate, which is the
      // margin minecraft-protocol's own docs recommend. If no keep_alive packet
      // arrives for that long, the socket is truly dead and the error handler
      // below reconnects with fresh ones — pollConnectivity() usually detects the
      // death first, so this mostly catches a silently-blackholed link.
      checkTimeoutInterval: 60000,
      brand: DEFAULT_FINGERPRINT.brand,
      locale: DEFAULT_FINGERPRINT.locale,
      mainHand: DEFAULT_FINGERPRINT.mainHand,
      viewDistance: DEFAULT_FINGERPRINT.viewDistance,
      skinParts: DEFAULT_FINGERPRINT.skinParts,
      difficulty: 2,
      physicsEnabled: true,
      loadInternalPlugins: true,
    };
    
    mcBot = mineflayer.createBot(botOptions);
  } catch (e) { info.status = 'error'; info.error = e.message; return; }
  info.mcBot = mcBot;

  const ownerNorm = norm(ownerUsername);

  // mineflayer emits 'error' asynchronously; without this the process dies on
  // a socket error that arrives before our listener is attached.
  mcBot.on('error', () => {});

  // ---- listener bookkeeping -------------------------------------------------
  // Everything this manager attaches to the bot is recorded so teardown removes
  // exactly ours. This matters more than it looks: mineflayer's plugins register
  // bot-level listeners too — physics clears its 20 Hz tick interval from
  // `bot.on('end')` — so `bot.removeAllListeners()` silently disarmed that
  // cleanup, leaving a live interval that kept the whole Bot (world + chunks +
  // entities, ~0.7 MB) reachable. Repeated reconnects then grew the heap until
  // the process died with "Ineffective mark-compacts near heap limit".
  const ownListeners = [];
  const onBot = (event, fn) => { mcBot.on(event, fn); ownListeners.push([event, fn]); return fn; };
  const onceBot = (event, fn) => { mcBot.once(event, fn); ownListeners.push([event, fn]); return fn; };
  info.detachListeners = () => {
    for (const [event, fn] of ownListeners) { try { mcBot.off(event, fn); } catch (_) {} }
    ownListeners.length = 0;
    // The inbound-activity stamp lives on the raw protocol client, not the bot.
    if (info.inboundListener) {
      try { mcBot._client.off('packet', info.inboundListener); } catch (_) {}
      info.inboundListener = null;
    }
  };

  function scheduleReconnect() {
    const current = mcBots.get(name);
    if (!current || current !== info || !current.autoReconnect) return;

    // A cooldown the server itself asked for. Waiting it out is not a failed
    // attempt — but a server that keeps refusing us forever has to stop somewhere too.
    const now = Date.now();
    if (current.cooldownUntil > now) {
      if (current.cooldownWaits > COOLDOWN_MAX_WAITS) {
        current.status = 'error';
        current.error = 'Antibot kept refusing the join (cooldown)';
        saveData();
        notify(chatId,
          `❌ <b>${esc(name)}</b> — the antibot refused ${current.cooldownWaits} joins in a row.\n\n` +
          `The server is rate-limiting this IP rather than showing a captcha. Things that actually help:\n` +
          `• join once from a real client on this connection, then start the bot\n` +
          `• check the name is registered (some antibots refuse unknown names)\n` +
          `• if it's a proxy/VPN IP, try another host\n\n` +
          `Use 🟢 Reconnect when you want to try again.`);
        return;
      }
      const cdDelay = current.cooldownUntil - now;
      // Same stagger as normal retries: bots sharing this IP's cooldown would
      // otherwise all rejoin in the same tick when it expires and trip it again.
      const stagger = staggerExtraMs(host, port, name);
      const delay = cdDelay + stagger;
      const staggerNote = stagger > 0 ? ' — staggered rejoin with the other bots on this server' : '';
      current.status = 'offline';
      current.error = `Antibot cooldown — waiting ${Math.round(delay / 1000)}s`;
      saveData();
      notify(chatId,
        `⏳ <b>${esc(name)}</b> — the antibot is rate-limiting this IP, not asking for a captcha.\n` +
        `Waiting <b>${humanInterval(delay)}</b> before the next try${staggerNote} (retrying sooner restarts the server's own timer).`);
      current.reconnectTimer = setTimeout(() => {
        const latest = mcBots.get(name);
        if (!latest || latest !== info || !latest.autoReconnect) return;
        spawnBot(name, host, port, version, chatId, ownerUsername, {
          loginCmd: info.loginCmd, loginEnabled: info.loginEnabled,
          ncLogin: info.ncLogin, ncSecond: info.ncSecond, ncThird: info.ncThird, ncEnabled: info.ncEnabled,
          afkMode: info.afkMode, afkIntervalMs: info.afkIntervalMs,
          autoEat: info.autoEat,
        });
      }, delay);
      return;
    }

    current.reconnectAttempts++;
    const isTimeout = !!current.timeoutConnected;
    // When several bots on this same server fell together (a server restart),
    // spread their rejoins so they don't all hammer the server the moment it
    // comes back and trip its rate limit. A lone bot keeps the plain ~4s beat.
    const stagger = staggerExtraMs(host, port, name);
    const delay = retryDelay(current.reconnectAttempts, isTimeout) + stagger;
    const marker = isTimeout ? ' (no keepalive — server stalled or restarting)' : '';
    const staggerNote = stagger > 0 ? ' — staggered rejoin with the other bots on this server' : '';
    // Fixed retries can run for a long time; announce the first three
    // attempts, then only every 15th (~once a minute) so a long outage can't
    // flood the chat. Every attempt still goes to the log.
    const att = current.reconnectAttempts;
    if (att <= 3 || att % 15 === 0) {
      notify(chatId, `🔄 <b>${esc(name)}</b> reconnecting in ${Math.round(delay / 1000)}s (attempt ${att})${marker}${staggerNote}…`);
    } else {
      console.log(`[${name}] reconnect attempt ${att} (notification throttled)`);
    }
    current.reconnectTimer = setTimeout(() => {
      const latest = mcBots.get(name);
      if (!latest || latest !== info || !latest.autoReconnect) return;
      spawnBot(name, host, port, version, chatId, ownerUsername, {
        loginCmd: info.loginCmd, loginEnabled: info.loginEnabled,
        ncLogin: info.ncLogin, ncSecond: info.ncSecond, ncThird: info.ncThird, ncEnabled: info.ncEnabled,
        afkMode: info.afkMode, afkIntervalMs: info.afkIntervalMs,
        autoEat: info.autoEat,
      });
    }, delay);
  }

  // Anything that ends this connection funnels through here exactly once.
  function markDown(status, errText, tgText) {
    if (mcBots.get(name) !== info) return;
    if (info.down) return;
    info.down = true;
    stopAfk(info);
    stopLogin(info);
    stopNeocraft(info);
    if (info.eatDisposer) { try { info.eatDisposer(); } catch (_) {} info.eatDisposer = null; }
    info.status = status;
    info.error = errText;
    info.mcBot = null;
    if (info.probeTimer) { clearTimeout(info.probeTimer); info.probeTimer = null; }
    if (info.sendTimer) { clearTimeout(info.sendTimer); info.sendTimer = null; }
    info.sendQueue = [];
    // Only this manager's listeners may go: mineflayer's plugins keep their own
    // bot-level listeners (physics clears its tick interval from 'end'), and
    // wiping those out was what leaked a whole Bot per reconnect.
    info.detachListeners();
    // If the socket is somehow still open (a kick that was never followed by a
    // real 'end'), close it now — mineflayer's per-connection cleanup runs on
    // 'end' and must not be left waiting for a stalled socket.
    if (mcBot._client && !mcBot._client.ended) { try { mcBot.quit(); } catch (_) {} }
    saveData();
    if (tgText) notify(chatId, tgText);
    
    scheduleReconnect();
  }

  // 1. Resource packs. Accepting them on join keeps servers that require the
  //    pack from kicking the player for never answering the request.
  onBot('resourcePack', () => {
    if (mcBots.get(name) !== info) return;
    try { mcBot.acceptResourcePack(); } catch (_) {}
  });

  onceBot('spawn', () => {
    if (mcBots.get(name) !== info) return;
    info.status = 'online';
    info.connectedAt = Date.now();
    info.wasEverOnline = true; // Mark that we successfully connected
    info.reconnectAttempts = 0;
    info.error = null;
    info.loginTries = 0;
    info.loginDone = false;
    // We got in, so whatever cooldown the server had on us is over.
    info.cooldownWaits = 0;
    info.cooldownUntil = 0;
    info.cooldownStated = null;
    // The connection came up — this round no longer counts as a timeout.
    info.timeoutConnected = false;
    info.probeDown = false;
    saveData();

    // Auto-eat: watch the food bar for this connection.
    if (info.eatDisposer) { try { info.eatDisposer(); } catch (_) {} }
    info.eatDisposer = autoEat.attach(info);

    const afkNote = info.afkMode !== 'off' ? `\n🏃 Anti-AFK: ${AFK_LABEL[info.afkMode]} every ${humanInterval(info.afkIntervalMs)}` : '';
    const acNote = info.autoChatMsg && info.autoChatEnabled !== false ? `\n💬 Auto-chat: every ${humanInterval(clampChatInterval(info.autoChatIntervalMs))}` : '';
    const verNote = info.version === AUTO_VERSION && mcBot.version ? `\n🔧 Detected version: <code>${esc(mcBot.version)}</code>` : '';
    notify(chatId, `🟢 <b>${esc(name)}</b> connected to <code>${esc(host)}:${port}</code>!${verNote}${afkNote}${acNote}`);

    // Keep probing the outbound path. A bot that has been sitting for hours can
    // have a half-open socket (host asleep, NAT dropped, link died) with no
    // error until the server's keepalive watchdog fires — which then looks like
    // the server timed us out. Catching the dead path ourselves and reconnecting
    // with fresh sockets keeps sessions alive for days instead of hours.
    if (info.probeTimer) { clearTimeout(info.probeTimer); info.probeTimer = null; }
    // Timestamp every inbound packet so a healthy connection never costs a probe.
    info.lastInboundAt = Date.now();
    info.inboundListener = () => { info.lastInboundAt = Date.now(); };
    try { mcBot._client.on('packet', info.inboundListener); } catch (_) { info.inboundListener = null; }
    const armProbe = () => {
      if (mcBots.get(name) !== info || info.status !== 'online' || !info.mcBot) return;
      // Only dial out when inbound has gone quiet — quiet is the symptom of the
      // half-open sockets this probe exists to catch.
      if (Date.now() - (info.lastInboundAt || 0) > PROBE_SILENCE_MS) pollConnectivity(info);
      info.probeTimer = setTimeout(armProbe, PROBE_CHECK_MS);
      if (info.probeTimer.unref) info.probeTimer.unref();
    };
    armProbe();

    // Simulate human-like behavior after spawning
    const humanBehavior = () => {
      if (mcBots.get(name) !== info || !info.mcBot) return;
      
      try {
        const mc = info.mcBot;
        
        // 1. Initial look around (500-1500ms after spawn)
        setTimeout(() => {
          if (!mc || info.status !== 'online') return;
          mc.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.6, false);
        }, 500 + Math.floor(Math.random() * 1000));
        
        // 2. Another look in different direction (1500-2500ms)
        setTimeout(() => {
          if (!mc || info.status !== 'online') return;
          mc.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.5, true);
        }, 1500 + Math.floor(Math.random() * 1000));
        
        // 3. Small jump (like pressing space accidentally) (2000-3500ms)
        if (Math.random() > 0.5) { // 50% chance
          setTimeout(() => {
            if (!mc || info.status !== 'online') return;
            mc.setControlState('jump', true);
            setTimeout(() => {
              if (!mc || info.status !== 'online') return;
              mc.setControlState('jump', false);
            }, 100 + Math.floor(Math.random() * 150));
          }, 2000 + Math.floor(Math.random() * 1500));
        }
        
        // 4. Sneak for a moment (like checking player list) (3000-4500ms)
        if (Math.random() > 0.6) { // 40% chance
          setTimeout(() => {
            if (!mc || info.status !== 'online') return;
            mc.setControlState('sneak', true);
            setTimeout(() => {
              if (!mc || info.status !== 'online') return;
              mc.setControlState('sneak', false);
            }, 200 + Math.floor(Math.random() * 300));
          }, 3000 + Math.floor(Math.random() * 1500));
        }
        
        // 5. Final look adjustment (4000-5500ms)
        setTimeout(() => {
          if (!mc || info.status !== 'online') return;
          mc.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.3, true);
        }, 4000 + Math.floor(Math.random() * 1500));
        
      } catch (e) {
        console.error(`[${name}] Human behavior simulation error:`, e.message);
      }
    };
    
    // Start human-like behavior immediately
    humanBehavior();

    scheduleNeocraft(info);

    // Add a delay before starting auto-login and anti-AFK
    const startDelay = 2500 + Math.floor(Math.random() * 2500); // 2.5-5 seconds
    
    setTimeout(() => {
      if (mcBots.get(name) !== info || info.status !== 'online') return;

      // Give the server a moment to send its login prompt; if it doesn't, send anyway.
      // When the Neocraft flow is enabled it already owns the login command — don't
      // double-send it from the fallback path too.
      if (info.loginCmd && info.loginEnabled !== false && !(info.ncEnabled && info.ncLogin)) {
        const armLoginFallback = delay => {
          info.loginTimer = setTimeout(() => {
            info.loginTimer = null;
            if (info.loginDone || info.loginTries) return;
            sendLogin(info, 'fallback');
          }, delay);
        };
        armLoginFallback(LOGIN_FALLBACK_MS);
      }

      scheduleAfk(info);
      scheduleAutoChat(info);
    }, startDelay);
  });

  onBot('kicked', reason => {
    let r = 'unknown reason';
    let isAntiBot = false;
    let isTooFast = false;
    let rawReason = null;
    try {
      if (reason) {
        // Store raw reason for debugging
        rawReason = reason;
        
        // Try to read as chat message first
        r = readChat(reason);
        // If readChat fails or returns empty, try other methods
        if (!r || r === '[object Object]') {
          if (typeof reason === 'string') {
            r = reason;
          } else if (reason.text) {
            r = readChat(reason.text);
          } else if (reason.reason) {
            r = readChat(reason.reason);
          } else {
            // Last resort: stringify the object
            r = JSON.stringify(reason);
          }
        }
        // Detect common antibot patterns
        const lowerR = r.toLowerCase();
        if (/\b(antibot|anti-bot|captcha|verif|human check|not a robot|solve|challenge)\b/i.test(lowerR) ||
            lowerR.includes('compound') || lowerR.includes('denied from entering') ||
            lowerR.includes('bot detected') || lowerR.includes('failed the check') ||
            (lowerR.includes('denied') && !info.wasEverOnline && info.reconnectAttempts === 0)) {
          isAntiBot = true;
          
          // Log full reason object for antibot kicks to help debug
          console.log(`[${name}] AntiBot kick detected. Full reason:`, JSON.stringify(rawReason, null, 2));
          
          // Check for clickable links or special actions
          if (rawReason && typeof rawReason === 'object') {
            if (rawReason.clickEvent || rawReason.hoverEvent) {
              console.log(`[${name}] Interactive elements found:`, {
                clickEvent: rawReason.clickEvent,
                hoverEvent: rawReason.hoverEvent
              });
            }
            // Check in extra array too
            if (Array.isArray(rawReason.extra)) {
              for (const item of rawReason.extra) {
                if (item.clickEvent || item.hoverEvent) {
                  console.log(`[${name}] Interactive element in extra:`, {
                    clickEvent: item.clickEvent,
                    hoverEvent: item.hoverEvent
                  });
                }
              }
            }
          }
        }
        // Detect "too fast" reconnect messages
        if (lowerR.includes('too fast') || lowerR.includes('try again later') ||
            lowerR.includes('wait') && lowerR.includes('seconds')) {
          isTooFast = true;
        }
      }
    } catch (e) {
      r = 'Could not parse kick reason';
      console.error('Kick reason parse error:', e, 'Reason:', reason);
    }

    // Is this a refusal with a timer on it, rather than a challenge we can answer?
    // Those two look alike in chat but need opposite handling: a challenge wants a
    // fast reply, a cooldown wants us to disappear until it expires.
    const isCooldown = isCooldownKick(r);
    if (isCooldown) {
      const stated = parseCooldownMs(r);
      const wait = cooldownWait(stated);
      info.cooldownWaits = (info.cooldownWaits || 0) + 1;
      info.cooldownUntil = Date.now() + wait;
      info.cooldownStated = stated;
    }

    let emoji = '🔴';
    let prefix = 'was kicked';
    let extraInfo = '';

    if (isCooldown) {
      emoji = '⏳';
      prefix = 'refused by the antibot (cooldown)';
      const stated = info.cooldownStated;
      extraInfo = '\n\n⚠️ <b>This is a rate limit, not a captcha.</b>\n' +
        'The server put this IP on a timer' + (stated ? ` (it asked for ${humanInterval(stated)})` : '') +
        ' and never showed a challenge, so there is nothing to answer.\n' +
        `Next try in <b>${humanInterval(Math.max(0, info.cooldownUntil - Date.now()))}</b> — reconnecting sooner just restarts the server's timer.\n\n` +
        'If it keeps happening: join once with a real client from this connection, make sure the name is registered, and check the IP isn\'t a flagged VPN/proxy range.';
    } else if (isTooFast) {
      emoji = '⏱️';
      prefix = 'kicked (reconnected too fast)';
    } else if (isAntiBot) {
      emoji = '🛡️';
      prefix = 'rejected by the antibot';
      extraInfo = '\n\n⚠️ <b>The antibot rejected this join.</b>\n' +
        'It will retry with a longer gap. If the server keeps refusing, join once with a real client from this connection to pass the check yourself.';
    }
    
    markDown('offline', `Kicked: ${r}`, `${emoji} <b>${esc(name)}</b> ${prefix}:\n<code>${esc(r)}</code>${extraInfo}`);
  });

  onBot('error', err => {
    let msg = err?.message || String(err);
    if (err?.code === 'ECONNREFUSED') msg = 'Connection refused — server offline or wrong port';
    else if (err?.code === 'ECONNRESET') msg = 'Connection reset — check version or server is in online-mode';
    else if (err?.code === 'ENOTFOUND') msg = `Host not found: ${err.hostname || host}`;
    else if (err?.code === 'ETIMEDOUT') msg = 'Timed out — server may be offline';
    else if (err?.code === 'EAI_AGAIN') msg = 'DNS lookup failed — check the host name';

    if (isTimeoutError(err)) {
      // The keepalive watchdog: no keep_alive packet from the server for
      // 60s. That is not the bot being slow — the server stalled, restarted,
      // or the path to it died. Retry right away with fresh sockets.
      info.timeoutConnected = true;
      info.probeDown = false;
      markDown('offline',
        'Server stalled — no keepalive for 60s (server restart, lag or link loss)',
        `🟡 <b>${esc(name)}</b> — the server stopped answering (no keepalive for 60s).\n` +
        `Usually a server restart or lag spike, not a problem with this bot.\n` +
        `Retrying with a fresh connection in a moment…`);
      return;
    }
    info.timeoutConnected = false;
    markDown('error', msg, `🔴 <b>${esc(name)}</b> error: <code>${esc(msg)}</code>`);
  });

  onBot('end', reason => {
    if (info.status !== 'online' && info.status !== 'connecting') return;
    const rs = typeof reason === 'string' ? reason : '';
    if (rs === 'connectivityLost') {
      // Reconnect triggered by our stale-socket probe — keep the message that
      // explains why instead of the raw quit reason.
      markDown('offline', 'Connection stalled — server unresponsive for a while; reconnecting as a fresh client', null);
      return;
    }
    markDown('offline', rs || 'Connection closed', null);
  });

  onBot('death', () => {
    if (mcBots.get(name) !== info) return;
    info.error = 'Died — respawning';
    notify(chatId, `💀 <b>${esc(name)}</b> died. Respawning…`);
  });

  onBot('message', jsonMsg => {
    const clean = readChat(jsonMsg);
    if (!clean) return;

    // Auto-login: react the moment the server asks, and stop retrying once it confirms.
    // When the Neocraft flow is enabled it owns the login line — answering here
    // too would send it twice.
    if (info.loginCmd && info.loginEnabled !== false && !(info.ncEnabled && info.ncLogin)) {
      if (LOGIN_OK_RE.test(clean)) {
        stopLogin(info);
        info.loginDone = true;
      } else if (!info.loginDone && LOGIN_PROMPT_RE.test(clean)) {
        sendLogin(info, 'server prompt');
      }
    }

    // Neocraft flow owns the login line when enabled: it answers the server's
    // own prompt right away (instead of waiting for the blind join timer),
    // treats the lobby-transfer lines as the green light for the 2nd command,
    // and stops repeating /survival once the server confirms the transfer.
    if (info.ncEnabled && info.ncLogin) {
      if (info.ncSecond && !info.ncSurvivalDone && NC_SURVIVAL_OK_RE.test(clean)) {
        onNcSurvivalConfirmed(info);
      } else if (LOGIN_OK_RE.test(clean) || NC_LOGGED_IN_RE.test(clean)) {
        onNcLoginConfirmed(info);
      } else if (!info.ncLoginDone && LOGIN_PROMPT_RE.test(clean)) {
        sendNcLogin(info, 'server prompt');
      }
    }

    const targets = new Set(forwardMap.get(ownerNorm) || []);

    const cap = captures.get(name);
    if (cap) {
      if (Date.now() > cap.until) captures.delete(name);
      else targets.add(cap.chatId);
    }

    if (!targets.size) return;
    const text = `[${name} @ ${host}:${port}] ${clean}`;
    for (const gid of targets) enqueueOut(gid, text);
  });
}

bot.command('start', async ctx => {
  chatStates.delete(ctx.chat.id);
  await ctx.reply(mainMenuText(ctx), {
    parse_mode: 'HTML',
    reply_markup: mainMenuKeyboard(),
  });
});

const HELP_TEXT = () =>
  `⭐ <b>Help &amp; Usage</b>\n\n<b>➕ Adding a bot</b>\nPress <i>Add Bot</i> then send:\n<code>name  ip  port  [version]</code>\nUse <code>auto</code> as the version to detect the server's own.\n\n<b>Anti-AFK</b> 🏃\nOn a bot's manage screen press <b>Anti-AFK</b>:\n• <b>Jump only</b> — hops in place\n• <b>Walk 1 block</b> — one block forward, one back\n• <b>Jump + Walk</b> — both\nPick any interval from 15s to 30m, or a custom one.\n\n<b>Auto-login</b> 🔐\nPress <b>Set auto-login</b> and send the command your server needs, e.g. <code>/login 1597311</code>. It's saved for that bot and replayed on every reconnect, only when the server asks for it.\n\n<b>Commands</b>\n<code>/bots</code> — list your bots\n<code>/use [name]</code> — pick the bot that runs commands\n<code>/cmd [name] &lt;command&gt;</code> — send a command\n<code>/say &lt;text&gt;</code> — send plain chat\n<code>/click [name] &lt;slot&gt;</code> — click a GUI slot\n<code>/afk [name] &lt;off|jump|walk|both&gt; [interval]</code>\n<code>/setlogin [name] &lt;command&gt;</code>\n<code>/console [name]</code> — open a bot's console\n<code>/players [name]</code> — list everyone on the server\n<code>/status</code> — show host CPU and RAM usage\n<code>/forward @you</code> — forward server chat to a group\n\nAnything else starting with <code>/</code> goes straight to the server.`;

bot.command('help', async ctx => {
  await ctx.reply(HELP_TEXT(), {
    parse_mode: 'HTML',
    reply_markup: new InlineKeyboard().text('⌨️ Commands', 'cmd_help').text('📡 Forwarding', 'fwd_help').row().text('⬅️ Main Menu', 'main_menu'),
  });
});

bot.command('bots', async ctx => {
  await ctx.reply(botListText(ctx), { parse_mode: 'HTML', reply_markup: botListKeyboard(ctx) });
});

// "Where is the bot?" — position, world, health and uptime at a glance,
// for when the bot seems to have vanished or you just need its coordinates.
function whereText(info) {
  if (info.status !== 'online' || !info.mcBot) {
    return `📍 <b>${esc(info.name)}</b> is <b>${info.status}</b> — last known state:\n<code>${esc(info.error || 'none')}</code>`;
  }
  const b = info.mcBot;
  const p = b.entity?.position;
  if (!p) return `📍 <b>${esc(info.name)}</b> is online but its position isn't known yet.`;
  const dim = b.game?.dimension ? esc(b.game.dimension) : '?';
  const held = b.heldItem ? `${b.heldItem.count > 1 ? `${b.heldItem.count}x ` : ''}${esc(b.heldItem.displayName || b.heldItem.name)}` : 'empty hand';
  const ut = info.connectedAt ? uptime(Date.now() - info.connectedAt) : '?';
  return `📍 <b>${esc(info.name)}</b> — here's where it stands\n\n` +
    `<b>XYZ:</b> <code>${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}</code>\n` +
    `<b>World:</b> ${dim}\n` +
    `<b>Health:</b> ${Math.round(b.health ?? 0)}/20 · <b>Food:</b> ${Math.round(b.food ?? 0)}/20\n` +
    `<b>Holding:</b> ${held}\n` +
    `<b>Online for:</b> ${ut}\n\n` +
    `Server: <code>${esc(info.host)}:${info.port}</code>`;
}

const whereKeyboard = name => new InlineKeyboard()
  .text('🔄 Refresh', `where:${name}`)
  .text('⚙️ Manage', `manage:${name}`).row()
  .text('⌨️ Console', `console:${name}`);

bot.command('where', async ctx => {
  const parts = ctx.message.text.trim().split(/\s+/).slice(1);
  const { info, error, keyboard } = takeBotArg(ctx, parts);
  if (!info) return ctx.reply(error || 'No bot found.', { parse_mode: 'HTML', reply_markup: keyboard });
  if (!canControl(ctx, info)) return ctx.reply(`❌ <b>${esc(info.name)}</b> isn't yours to control.`, { parse_mode: 'HTML' });
  await ctx.reply(whereText(info), { parse_mode: 'HTML', reply_markup: whereKeyboard(info.name) });
});

function playersText(info) {
  if (info.status !== 'online' || !info.mcBot) {
    return `👥 <b>${esc(info.name)}</b> is <b>${info.status}</b> — no live player list.`;
  }
  const mc = info.mcBot;
  const me = (mc.username || info.name).toLowerCase();
  // bot.players is the server's tab list: everyone online, near or far.
  const rows = [];
  const seen = new Set();
  for (const p of Object.values(mc.players || {})) {
    if (!p || !p.username || seen.has(p.username)) continue;
    seen.add(p.username);
    const ping = Number.isFinite(p.ping) && p.ping >= 0 ? Math.round(p.ping) : null;
    rows.push({ name: p.username, ping, self: p.username.toLowerCase() === me });
  }
  if (!rows.length) return `👥 <b>${esc(info.name)}</b> — the server hasn't sent a player list yet.`;
  rows.sort((a, b) => a.name.localeCompare(b.name));
  const lines = rows.slice(0, 80).map((r, i) => {
    const bits = [];
    if (r.self) bits.push('this bot');
    if (r.ping != null) bits.push(`${r.ping}ms`);
    return `${i + 1}. <b>${esc(r.name)}</b>${bits.length ? ` <i>(${bits.join(' · ')})</i>` : ''}`;
  });
  const more = rows.length > 80 ? `\n… and ${rows.length - 80} more` : '';
  return `👥 <b>Players on ${esc(info.host)}:${info.port}</b> — <b>${rows.length}</b> online\n\n${lines.join('\n')}${more}`;
}

const playersKeyboard = name => new InlineKeyboard()
  .text('🔄 Refresh', `players:${name}`)
  .text('⚙️ Manage', `manage:${name}`).row();

// --- host status ---
// CPU/RAM of the machine this manager runs on (VPS / Docker / Railway) —
// not the Minecraft server itself, which exposes no resource stats over the protocol.
const CPU_SAMPLE_MS = 500;

const snapCpus = () => os.cpus().map(c => ({ ...c.times }));

function cpuUsage(a, b) {
  let idle = 0, total = 0;
  for (let i = 0; i < a.length && i < b.length; i++) {
    const idleD = b[i].idle - a[i].idle;
    const totD = (b[i].user - a[i].user) + (b[i].nice - a[i].nice) + (b[i].sys - a[i].sys) + (b[i].irq - a[i].irq) + idleD;
    idle += idleD;
    total += totD;
  }
  return total > 0 ? Math.max(0, Math.min(100, (1 - idle / total) * 100)) : 0;
}

const fmtMB = b => `${(b / 1048576).toFixed(0)} MB`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function statusText() {
  const before = snapCpus();
  await sleep(CPU_SAMPLE_MS);
  const cpu = cpuUsage(before, snapCpus());

  const totalMem = os.totalmem(), usedMem = totalMem - os.freemem();
  const memPct = totalMem ? (usedMem / totalMem) * 100 : 0;

  const { heapUsed, rss } = process.memoryUsage();
  const heapLimit = v8.getHeapStatistics().heap_size_limit || 0;
  const heapPct = heapLimit ? (heapUsed / heapLimit) * 100 : 0;

  let online = 0;
  for (const b of mcBots.values()) if (b.status === 'online') online++;

  const bar = pct => {
    const n = Math.round(pct / 10);
    return '█'.repeat(n) + '░'.repeat(10 - n);
  };

  return `<b>Server Status</b>\n\n` +
    `<b>CPU:</b> ${cpu.toFixed(1)}%  ${bar(cpu)} <i>(${os.cpus().length} cores)</i>\n` +
    `<b>RAM:</b> ${fmtMB(usedMem)} / ${fmtMB(totalMem)} (${memPct.toFixed(1)}%)  ${bar(memPct)}\n` +
    `<b>Bot process:</b> heap ${fmtMB(heapUsed)}${heapLimit ? ` / ${fmtMB(heapLimit)} (${heapPct.toFixed(0)}%)` : ''} · RSS ${fmtMB(rss)}\n\n` +
    `<b>Bots:</b> ${online} online / ${mcBots.size} registered\n` +
    `<b>Uptime:</b> bot ${uptime(process.uptime() * 1000)} · host ${uptime(os.uptime() * 1000)}`;
}

const statusKeyboard = () => new InlineKeyboard()
  .text('Refresh', 'status').row()
  .text('< Back', 'main_menu');

bot.command('status', async ctx => {
  const wait = await ctx.reply('Measuring CPU…', { parse_mode: 'HTML' }).catch(() => null);
  const text = await statusText();
  if (wait) {
    await bot.api.editMessageText(ctx.chat.id, wait.message_id, text, { parse_mode: 'HTML', reply_markup: statusKeyboard() }).catch(() => {});
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: statusKeyboard() });
  }
});

bot.command('players', async ctx => {
  const parts = ctx.message.text.trim().split(/\s+/).slice(1);
  const { info, error, keyboard } = takeBotArg(ctx, parts);
  if (!info) return ctx.reply(error || 'No bot found.', { parse_mode: 'HTML', reply_markup: keyboard });
  if (!canControl(ctx, info)) return ctx.reply(`❌ <b>${esc(info.name)}</b> isn't yours to control.`, { parse_mode: 'HTML' });
  await ctx.reply(playersText(info), { parse_mode: 'HTML', reply_markup: playersKeyboard(info.name) });
});

bot.command('console', async ctx => {
  const wanted = (ctx.message.text.trim().split(/\s+/)[1] || '').toLowerCase();
  const mine = controllableBots(ctx);
  if (!mine.length) return ctx.reply(`⚠️ You have no bots here. Use <b>➕ Add Bot</b> from /start first.`, { parse_mode: 'HTML' });

  const info = wanted ? mine.find(b => b.name.toLowerCase() === wanted) : (pickBot(ctx).info || null);
  if (!info) {
    const kb = new InlineKeyboard();
    let col = 0;
    for (const b of mine) { kb.text(`${dot(b.status)} ${b.name}`, `console:${b.name}`); if (++col % 2 === 0) kb.row(); }
    return ctx.reply(`⌨️ <b>Pick a bot to open its console:</b>`, { parse_mode: 'HTML', reply_markup: kb });
  }

  activeBot.set(ctx.chat.id, info.name);
  saveData();
  await ctx.reply(consoleText(info), { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('⚙️ Manage', `manage:${info.name}`) });
});

// Resolve "[botName] rest…" — the first word may name one of the caller's bots.
function takeBotArg(ctx, parts) {
  const named = parts.length ? controllableBots(ctx).find(b => b.name.toLowerCase() === parts[0].toLowerCase()) : null;
  if (named) return { info: named, rest: parts.slice(1) };
  const p = pickBot(ctx);
  return { info: p.info || null, rest: parts, error: p.error, keyboard: p.keyboard };
}

bot.command('afk', async ctx => {
  const parts = ctx.message.text.trim().split(/\s+/).slice(1);
  const { info, rest, error, keyboard } = takeBotArg(ctx, parts);
  if (!info) return ctx.reply(error, { parse_mode: 'HTML', reply_markup: keyboard });
  if (!canControl(ctx, info)) return ctx.reply(`❌ <b>${esc(info.name)}</b> isn't yours to control.`, { parse_mode: 'HTML' });

  if (!rest.length) {
    return ctx.reply(afkMenuText(info), { parse_mode: 'HTML', reply_markup: afkMenuKeyboard(info.name) });
  }

  const mode = rest[0].toLowerCase();
  if (!AFK_MODES.has(mode)) {
    return ctx.reply(`⚠️ Usage: <code>/afk [botName] &lt;off|jump|walk|both&gt; [interval]</code>\n\n<b>Examples:</b>\n<code>/afk jump 30s</code>\n<code>/afk walk 2m</code>\n<code>/afk Steve both 45s</code>`, { parse_mode: 'HTML' });
  }

  let intervalMs;
  if (rest[1]) {
    intervalMs = parseInterval(rest[1]);
    if (intervalMs === null) {
      return ctx.reply(`⚠️ Bad interval — use e.g. <code>30s</code>, <code>2m</code> (between ${MIN_AFK_INTERVAL_MS / 1000}s and ${MAX_AFK_INTERVAL_MS / 60000}m).`, { parse_mode: 'HTML' });
    }
  }

  setAfk(info, mode, intervalMs);
  const body = mode === 'off'
    ? `⛔ Anti-AFK turned <b>off</b> for <b>${esc(info.name)}</b>.`
    : `🏃 Anti-AFK for <b>${esc(info.name)}</b>: <b>${AFK_LABEL[mode]}</b> every <b>${humanInterval(info.afkIntervalMs)}</b>.`;
  await ctx.reply(body, { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('⚙️ Manage', `manage:${info.name}`) });
});

bot.command('setlogin', async ctx => {
  const parts = ctx.message.text.trim().split(/\s+/).slice(1);
  const { info, rest, error, keyboard } = takeBotArg(ctx, parts);
  if (!info) return ctx.reply(error, { parse_mode: 'HTML', reply_markup: keyboard });
  if (!canControl(ctx, info)) return ctx.reply(`❌ <b>${esc(info.name)}</b> isn't yours to control.`, { parse_mode: 'HTML' });

  const cmd = rest.join(' ').trim();
  if (!cmd) {
    return ctx.reply(loginMenuText(info), { parse_mode: 'HTML', reply_markup: loginMenuKeyboard(info.name) });
  }
  const res = applyLoginCmd(info, cmd);
  if (res.error) return ctx.reply(res.error, { parse_mode: 'HTML' });
  await ctx.reply(`🔐 Auto-login saved for <b>${esc(info.name)}</b>: <code>${esc(maskLogin(info.loginCmd))}</code>\n\n<i>Tip: delete your message so the password isn't left in the chat.</i>`, {
    parse_mode: 'HTML',
    reply_markup: new InlineKeyboard().text('▶️ Send now', `loginnow:${info.name}`).text('⚙️ Manage', `manage:${info.name}`),
  });
});

// Click a slot in whatever window the server opened — the answer to a GUI captcha.
bot.command('click', async ctx => {
  const parts = ctx.message.text.trim().split(/\s+/).slice(1);
  const { info, rest, error, keyboard } = takeBotArg(ctx, parts);
  if (!info) return ctx.reply(error, { parse_mode: 'HTML', reply_markup: keyboard });
  if (!canControl(ctx, info)) return ctx.reply(`❌ <b>${esc(info.name)}</b> isn't yours to control.`, { parse_mode: 'HTML' });
  if (info.status !== 'online' || !info.mcBot) return ctx.reply(`⚠️ <b>${esc(info.name)}</b> is <b>${info.status}</b>.`, { parse_mode: 'HTML' });

  const slot = parseInt(rest[0], 10);
  if (!Number.isInteger(slot) || slot < 0 || slot > 255) {
    return ctx.reply(`⚠️ Usage: <code>/click [botName] &lt;slot&gt;</code>\n\nThe slot numbers come from the GUI list this bot posted.`, { parse_mode: 'HTML' });
  }
  const win = info.mcBot.currentWindow;
  if (!win) return ctx.reply(`⚠️ <b>${esc(info.name)}</b> has no window open right now.`, { parse_mode: 'HTML' });

  try {
    await info.mcBot.clickWindow(slot, 0, 0);
    captureFor(info.name, ctx.chat.id);
    await ctx.reply(`🖱️ Clicked slot <b>${slot}</b> as <b>${esc(info.name)}</b>.\n\n<i>Watching the server's reply for ${CAPTURE_MS / 1000}s…</i>`, { parse_mode: 'HTML' });
  } catch (e) {
    await ctx.reply(`❌ Click failed: <code>${esc(e.message)}</code>`, { parse_mode: 'HTML' });
  }
});

function applyLoginCmd(info, cmd) {
  const clean = cmd.trim().replace(/\s+/g, ' ');
  if (!clean) return { error: '⚠️ Nothing to save.' };
  if (clean.length > MC_MAX_LEN) return { error: `❌ Too long — max ${MC_MAX_LEN} characters.` };
  if (/[\r\n]/.test(clean)) return { error: '❌ One line only.' };
  info.loginCmd = clean;
  info.loginEnabled = true;
  info.loginDone = false;
  info.loginTries = 0;
  saveData();
  return { ok: true };
}

function applyNcCmd(info, which, cmd) {
  const clean = cmd.trim().replace(/\s+/g, ' ');
  if (!clean) return { error: '⚠️ Nothing to save.' };
  if (clean.length > MC_MAX_LEN) return { error: `❌ Too long — max ${MC_MAX_LEN} characters.` };
  if (/[\r\n]/.test(clean)) return { error: '❌ One line only.' };
  if (which === 'login') info.ncLogin = clean;
  else if (which === 'second') info.ncSecond = clean;
  else info.ncThird = clean;
  saveData();
  return { ok: true };
}

const consoleText = info =>
  `⌨️ <b>Console — ${esc(info.name)}</b> ${dot(info.status)}\n\nCommands typed in this chat now run as this bot.\n\n<b>Send a server command:</b>\n<code>/tpa Appabol123</code>\n<code>/home</code>\n<code>/cmd /msg Steve hi</code>\n\n<b>Send plain chat:</b>\n<code>/say hello everyone</code>\n\nThe server's reply is mirrored back here for ${CAPTURE_MS / 1000}s after each send.`;

bot.command('forward', async ctx => {
  const raw = (ctx.message.text.trim().split(/\s+/)[1] || '');
  const target = norm(raw);
  const sender = norm(ctx.from.username);

  if (!target) return ctx.reply(`⚠️ Usage: <code>/forward @yourusername</code>`, { parse_mode: 'HTML' });
  if (!sender || sender !== target) return ctx.reply(`❌ You can only forward your own bots.\nUse <code>/forward @${esc(sender || 'yourusername')}</code>`, { parse_mode: 'HTML' });

  if (!forwardMap.has(target)) forwardMap.set(target, new Set());
  forwardMap.get(target).add(ctx.chat.id);
  saveData();

  let total = 0, online = 0;
  for (const b of mcBots.values()) {
    if (norm(b.ownerUsername) === target) { total++; if (b.status === 'online') online++; }
  }
  await ctx.reply(`✅ <b>Forwarding enabled!</b>\n\nThis chat will receive Minecraft chat from your bots.\n🤖 <b>${total}</b> bot(s) — <b>${online}</b> online\n\nTo stop: <code>/unforward @${esc(target)}</code>`, { parse_mode: 'HTML' });
});

bot.command('unforward', async ctx => {
  const raw = (ctx.message.text.trim().split(/\s+/)[1] || '');
  const target = norm(raw);
  const sender = norm(ctx.from.username);

  if (!target) return ctx.reply(`⚠️ Usage: <code>/unforward @yourusername</code>`, { parse_mode: 'HTML' });
  if (!sender || sender !== target) return ctx.reply(`❌ You can only manage your own subscriptions.`, { parse_mode: 'HTML' });

  const groups = forwardMap.get(target);
  if (!groups?.has(ctx.chat.id)) return ctx.reply(`⚠️ This chat is not subscribed to your bots.`, { parse_mode: 'HTML' });

  groups.delete(ctx.chat.id);
  if (!groups.size) forwardMap.delete(target);
  saveData();
  await ctx.reply(`✅ Stopped forwarding your bot messages to this chat.`, { parse_mode: 'HTML' });
});

bot.command('forwards', async ctx => {
  const chatId = ctx.chat.id;
  const active = [];
  for (const [username, groups] of forwardMap) {
    if (!groups.has(chatId)) continue;
    let total = 0, online = 0;
    for (const b of mcBots.values()) {
      if (norm(b.ownerUsername) === username) { total++; if (b.status === 'online') online++; }
    }
    active.push(`📡 <b>@${esc(username)}</b> — ${total} bot(s), ${online} online`);
  }
  if (!active.length) return ctx.reply(`📡 <b>No active forwards.</b>\n\nUse <code>/forward @yourusername</code> in this chat.`, { parse_mode: 'HTML' });
  await ctx.reply(`📡 <b>Active forwards:</b>\n\n` + active.join('\n'), { parse_mode: 'HTML' });
});

bot.command('use', async ctx => {
  const wanted = (ctx.message.text.trim().split(/\s+/)[1] || '').toLowerCase();
  const mine = controllableBots(ctx);
  if (!mine.length) return ctx.reply(`⚠️ You have no bots here. Use <b>➕ Add Bot</b> from /start first.`, { parse_mode: 'HTML' });

  if (!wanted) {
    const kb = new InlineKeyboard();
    let col = 0;
    for (const b of mine) { kb.text(`${dot(b.status)} ${b.name}`, `use:${b.name}`); if (++col % 2 === 0) kb.row(); }
    const cur = activeBot.get(ctx.chat.id);
    return ctx.reply(`⌨️ <b>Pick the bot that runs your commands</b>${cur ? `\n\nCurrently: <b>${esc(cur)}</b>` : ''}`, { parse_mode: 'HTML', reply_markup: kb });
  }

  const info = mine.find(b => b.name.toLowerCase() === wanted);
  if (!info) return ctx.reply(`❌ No bot of yours named <b>${esc(wanted)}</b>.`, { parse_mode: 'HTML' });

  activeBot.set(ctx.chat.id, info.name);
  saveData();
  await ctx.reply(`✅ Commands in this chat now run as <b>${esc(info.name)}</b> ${dot(info.status)}\n\nTry: <code>/tpa SomePlayer</code>`, { parse_mode: 'HTML' });
});

bot.command('cmd', async ctx => {
  const parts = ctx.message.text.trim().split(/\s+/).slice(1);
  if (!parts.length) {
    return ctx.reply(`⚠️ Usage: <code>/cmd [botName] &lt;command&gt;</code>\n\n<b>Examples:</b>\n<code>/cmd /tpa Appabol123</code>\n<code>/cmd Steve /home</code>`, { parse_mode: 'HTML' });
  }

  // First token may name the bot; otherwise the whole thing goes to the active bot.
  const named = controllableBots(ctx).find(b => b.name.toLowerCase() === parts[0].toLowerCase());
  let info = named;
  if (!info) {
    const p = pickBot(ctx);
    if (!p.info) return ctx.reply(p.error, { parse_mode: 'HTML', reply_markup: p.keyboard });
    info = p.info;
  }

  const body = (named ? parts.slice(1) : parts).join(' ');
  if (!body) return ctx.reply(`⚠️ Nothing to send after the bot name.`);
  await relay(ctx, info, body);
});

bot.command('say', async ctx => {
  const body = ctx.message.text.trim().split(/\s+/).slice(1).join(' ');
  if (!body) return ctx.reply(`⚠️ Usage: <code>/say hello everyone</code>`, { parse_mode: 'HTML' });

  const p = pickBot(ctx);
  if (!p.info) return ctx.reply(p.error, { parse_mode: 'HTML', reply_markup: p.keyboard });
  // Strip a leading slash so /say can never smuggle a command through.
  await relay(ctx, p.info, body.replace(/^\/+/, ''));
});

bot.on('callback_query:data', async ctx => {
  const data = ctx.callbackQuery.data;
  const chatId = ctx.chat.id;
  const edit = (text, kb) => ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb }).catch(() => {});
  const answer = (text = '') => ctx.answerCallbackQuery({ text, show_alert: false }).catch(() => {});

  if (data === 'main_menu' || data === 'refresh_menu') {
    chatStates.delete(chatId);
    await edit(mainMenuText(ctx), mainMenuKeyboard());
    return answer();
  }

  if (data === 'help') {
    await edit(
      HELP_TEXT(),
      new InlineKeyboard().text('⌨️ Commands', 'cmd_help').text('📡 Forwarding', 'fwd_help').row().text('⬅️ Main Menu', 'main_menu')
    );
    return answer();
  }

  if (data === 'fwd_help') {
    await edit(
      `📡 <b>Chat Forwarding</b>\n\nForward Minecraft chat from your bots to a Telegram group.\n\n<b>Setup:</b>\n1. Add this bot to your group\n2. In the group send: <code>/forward @yourusername</code>\n3. You must be the user named in the command\n\n<b>Commands (in the group):</b>\n<code>/forward @you</code> — start forwarding\n<code>/unforward @you</code> — stop\n<code>/forwards</code> — list active subscriptions\n\n<b>Format:</b>\n<code>[BotName @ host:port] message text</code>\n\n⚠️ Only you can subscribe to your own bots.`,
      new InlineKeyboard().text('ℹ️ General Help', 'help').row().text('⬅️ Main Menu', 'main_menu')
    );
    return answer();
  }

  if (data === 'cmd_help') {
    const cur = activeBot.get(chatId);
    await edit(
      `⌨️ <b>Running server commands</b>\n\nYour bot is a real player, so it can run whatever the server lets players run.\n\n<b>1. Pick the bot</b>\n<code>/use Steve</code>  (or just <code>/use</code> for a picker)\nWith one bot, it's picked automatically.\n\n<b>2. Type the command</b>\n<code>/tpa Appabol123</code>\n<code>/tpaccept</code>\n<code>/home</code>\n<code>/warp spawn</code>\n<code>/msg Steve hey</code>\n\n<b>Clashes with this bot's own commands</b>\n<code>/start</code>, <code>/help</code>, <code>/use</code>, <code>/say</code>, <code>/cmd</code>, <code>/bots</code>, <code>/console</code>, <code>/afk</code>, <code>/setlogin</code>, <code>/forward</code> belong to Telegram.\nTo send those to the server, wrap them:\n<code>/cmd /help</code>\n\n<b>Plain chat</b>\n<code>/say hello everyone</code>\n\nAfter each send, the server's reply is mirrored back here for ${CAPTURE_MS / 1000}s.${cur ? `\n\n📍 Active bot: <b>${esc(cur)}</b>` : ''}`,
      new InlineKeyboard().text('📋 Bots', 'list_bots').row().text('ℹ️ General Help', 'help').text('⬅️ Main Menu', 'main_menu')
    );
    return answer();
  }

  if (data === 'list_bots') {
    chatStates.delete(chatId);
    await edit(botListText(ctx), botListKeyboard(ctx));
    return answer();
  }

  if (data === 'status') {
    chatStates.delete(chatId);
    answer('Measuring CPU…');
    await edit(await statusText(), statusKeyboard());
    return;
  }

  if (data === 'add_bot') {
    const mine = controllableBots(ctx);
    if (mine.length >= MAX_BOTS_PER_OWNER) {
      return answer(`Limit reached — ${MAX_BOTS_PER_OWNER} bots max. Remove one first.`);
    }
    setState(chatId, { action: 'awaiting_bot_info' });
    await edit(
      `🔌 <b>Add a Bot</b>\n\nSend connection details in chat:\n<code>name  ip  port  [version]</code>\nor <code>name  ip:port  [version]</code>\n\n<b>Example:</b>\n<code>Steve mc.example.com 25565 1.20.4</code>\n\nVersion defaults to <code>1.20.4</code>. Write <code>auto</code> to let the bot detect the server's version — useful if a fixed version gets rejected.`,
      new InlineKeyboard().text('❌ Cancel', 'main_menu')
    );
    return answer('✏️ Type the bot details in chat!');
  }

  // Everything below acts on one named bot — resolve and authorize once.
  const sep = data.indexOf(':');
  if (sep === -1) return answer();
  const action = data.slice(0, sep);
  const rest = data.slice(sep + 1);
  // afkmode:Name:jump and afkint:Name:30000 carry a trailing argument.
  let name = rest, arg = null;
  if (action === 'afkmode' || action === 'afkint' || action === 'acint' || action === 'slot') {
    const i = rest.lastIndexOf(':');
    if (i !== -1) { name = rest.slice(0, i); arg = rest.slice(i + 1); }
  }

  const info = mcBots.get(name);
  if (!info) {
    await edit(botListText(ctx), botListKeyboard(ctx));
    return answer('Bot no longer exists');
  }
  if (!canControl(ctx, info)) return answer("❌ That bot isn't yours.");

  switch (action) {
    case 'manage':
      chatStates.delete(chatId);
      await edit(botManageText(info), botManageKeyboard(name));
      return answer();

    case 'hotbar':
      chatStates.delete(chatId);
      await edit(hotbarMenuText(info), hotbarMenuKeyboard(name));
      return answer();

    case 'slot': {
      if (info.status !== 'online' || !info.mcBot) {
        return answer(`⚠️ ${info.name} is ${info.status} — connect it first.`);
      }
      const idx = Number(arg);
      if (!Number.isInteger(idx) || idx < 0 || idx > 8) return answer('Invalid slot');
      try {
        info.mcBot.setQuickBarSlot(idx);
      } catch (e) {
        return answer(`Could not switch slot: ${e.message}`);
      }
      await edit(hotbarMenuText(info), hotbarMenuKeyboard(name));
      return answer(`✅ Holding slot ${idx + 1}`);
    }

    case 'autoeat': {
      info.autoEat = !info.autoEat;
      saveData();
      await edit(botManageText(info), botManageKeyboard(name));
      return answer(info.autoEat
        ? `Auto-Eat on — eats whenever health drops below full`
        : 'Auto-Eat off');
    }

    case 'neocraft':
      if (!info.ncLogin && !info.ncSecond) {
        setState(chatId, { action: 'awaiting_nc_login', name });
        await edit(
          `🏰 <b>Neocraft setup</b>\n\nSend the login command the server needs, e.g.\n<code>/login 1597311</code>`,
          new InlineKeyboard().text('❌ Cancel', `manage:${name}`)
        );
        return answer('✏️ Send the login command');
      }
      chatStates.delete(chatId);
      await edit(neocraftMenuText(info), neocraftMenuKeyboard(name));
      return answer();

    case 'ncsetlogin':
      setState(chatId, { action: 'awaiting_nc_login', name });
      await edit(
        `🏰 <b>Neocraft — set login</b>\n\nSend the login command exactly as the server needs it, e.g.\n<code>/login 1597311</code>`,
        new InlineKeyboard().text('❌ Cancel', `neocraft:${name}`)
      );
      return answer('✏️ Send the login command');

    case 'ncsetsecond':
      setState(chatId, { action: 'awaiting_nc_second', name });
      await edit(
        `🏰 <b>Neocraft — set 2nd command</b>\n\nSend the command that switches into survival, e.g.\n<code>/survival</code>`,
        new InlineKeyboard().text('❌ Cancel', `neocraft:${name}`)
      );
      return answer('✏️ Send the 2nd command');

    case 'ncsetthird':
      setState(chatId, { action: 'awaiting_nc_third', name });
      await edit(
        `🏰 <b>Neocraft — set 3rd command</b>\n\nSend the command to run 5 minutes after the 2nd, e.g.\n<code>/kit daily</code>`,
        new InlineKeyboard().text('❌ Cancel', `neocraft:${name}`)
      );
      return answer('✏️ Send the 3rd command');

    case 'nctoggle':
      info.ncEnabled = info.ncEnabled === true ? false : true;
      if (info.ncEnabled && info.status === 'online' && info.mcBot) scheduleNeocraft(info);
      else if (!info.ncEnabled) stopNeocraft(info);
      saveData();
      await edit(neocraftMenuText(info), neocraftMenuKeyboard(name));
      return answer(info.ncEnabled ? '🔛 Neocraft flow enabled' : '🔴 Neocraft flow disabled');

    case 'ncclear':
      info.ncLogin = null;
      info.ncSecond = null;
      info.ncThird = null;
      info.ncEnabled = false;
      stopNeocraft(info);
      saveData();
      await edit(neocraftMenuText(info), neocraftMenuKeyboard(name));
      return answer('🗑️ Neocraft settings cleared');

    case 'ncskipthird':
      chatStates.delete(chatId);
      info.ncEnabled = true;
      if (info.status === 'online' && info.mcBot) scheduleNeocraft(info);
      saveData();
      await edit(neocraftMenuText(info), neocraftMenuKeyboard(name));
      return answer('✅ Flow enabled without a 3rd command');

    case 'reconnect': {
      if (info.status === 'online' || info.status === 'connecting') return answer('Already ' + info.status);
      // An explicit reconnect overrides a pending antibot cooldown — the user is
      // telling us they want to try now.
      info.cooldownUntil = 0;
      info.cooldownWaits = 0;
      info.cooldownStated = null;
      
      spawnBot(name, info.host, info.port, info.version, info.chatId, info.ownerUsername, {
        loginCmd: info.loginCmd, loginEnabled: info.loginEnabled,
        ncLogin: info.ncLogin, ncSecond: info.ncSecond, ncThird: info.ncThird, ncEnabled: info.ncEnabled,
        afkMode: info.afkMode, afkIntervalMs: info.afkIntervalMs,
        autoEat: info.autoEat,
      });
      const fresh = mcBots.get(name);
      if (fresh) { fresh.autoReconnect = true; fresh.reconnectAttempts = 0; }
      saveData();
      await new Promise(r => setTimeout(r, 600));
      await edit(botManageText(mcBots.get(name) || info), botManageKeyboard(name));
      return answer('🟡 Reconnecting…');
    }

    case 'disconnect':
      info.autoReconnect = false;
      destroyBot(info);
      info.status = 'offline';
      info.error = 'Disconnected by user';
      saveData();
      await edit(botManageText(info), botManageKeyboard(name));
      return answer('🔴 Disconnected');

    case 'use':
      activeBot.set(chatId, name);
      saveData();
      return answer(`✅ Commands now run as ${name}`);

    case 'where': {
      chatStates.delete(chatId);
      await edit(whereText(info), whereKeyboard(name));
      return answer();
    }

    case 'players': {
      chatStates.delete(chatId);
      await edit(playersText(info), playersKeyboard(name));
      return answer();
    }

    case 'console':
      activeBot.set(chatId, name);
      saveData();
      await edit(consoleText(info), new InlineKeyboard().text('⬅️ Back', `manage:${name}`));
      return answer();

    // --- anti-AFK ---
    case 'afk':
      chatStates.delete(chatId);
      await edit(afkMenuText(info), afkMenuKeyboard(name));
      return answer();

    case 'afkmode': {
      if (!AFK_MODES.has(arg)) return answer('Unknown mode');
      setAfk(info, arg, undefined);
      await edit(afkMenuText(info), afkMenuKeyboard(name));
      return answer(arg === 'off' ? '⛔ Anti-AFK off' : `🏃 ${AFK_LABEL[arg]} every ${humanInterval(info.afkIntervalMs)}`);
    }

    case 'afkint': {
      const ms = clampInterval(arg);
      // Choosing an interval implies you want it running.
      setAfk(info, info.afkMode === 'off' ? 'jump' : undefined, ms);
      await edit(afkMenuText(info), afkMenuKeyboard(name));
      return answer(`⏱ Every ${humanInterval(info.afkIntervalMs)} · ${AFK_LABEL[info.afkMode]}`);
    }

    case 'afkcustom':
      setState(chatId, { action: 'awaiting_afk_interval', name });
      await edit(
        `✏️ <b>Custom interval — ${esc(name)}</b>\n\nSend how often the anti-AFK move should run:\n<code>20s</code>  <code>45s</code>  <code>3m</code>  <code>10m</code>\n\nA bare number means seconds. Allowed: ${MIN_AFK_INTERVAL_MS / 1000}s – ${MAX_AFK_INTERVAL_MS / 60000}m.`,
        new InlineKeyboard().text('❌ Cancel', `afk:${name}`)
      );
      return answer('✏️ Type the interval in chat');

    case 'afknow':
      if (info.status !== 'online' || !info.mcBot) return answer('Bot is not online');
      if (!info.afkMode || info.afkMode === 'off') return answer('Pick a mode first');
      afkPulse(info);
      return answer(`▶️ ${AFK_LABEL[info.afkMode]} sent`);

    // --- auto-chat ---
    case 'ac':
      chatStates.delete(chatId);
      await edit(acMenuText(info), acMenuKeyboard(name));
      return answer();

    case 'acmsg':
      setState(chatId, { action: 'awaiting_autochat_msg', name });
      await edit(
        `💬 <b>Auto-chat message — ${esc(name)}</b>\n\nSend the message the bot should repeat in server chat.\nStart it with <code>/</code> and it runs as a command instead.\n\nMax ${MC_MAX_LEN} characters, one line.`,
        new InlineKeyboard().text('❌ Cancel', `ac:${name}`)
      );
      return answer('✏️ Type the message in chat');

    case 'acint': {
      info.autoChatIntervalMs = clampChatInterval(Number(arg));
      info.autoChatEnabled = true;
      stopAutoChat(info);
      if (info.autoChatMsg && info.status === 'online') scheduleAutoChat(info);
      saveData();
      await edit(acMenuText(info), acMenuKeyboard(name));
      return answer(`⏱ Every ${humanInterval(info.autoChatIntervalMs)}`);
    }

    case 'accustom':
      setState(chatId, { action: 'awaiting_autochat_interval', name });
      await edit(
        `✏️ <b>Custom interval — ${esc(name)}</b>\n\nSend how often the message should be sent:\n<code>10m</code>  <code>30m</code>  <code>2h</code>  <code>1h30m</code>\n\nA bare number means minutes. Allowed: 1m – 24h.`,
        new InlineKeyboard().text('❌ Cancel', `ac:${name}`)
      );
      return answer('✏️ Type the interval in chat');

    case 'actoggle': {
      info.autoChatEnabled = !(info.autoChatEnabled !== false);
      stopAutoChat(info);
      if (info.autoChatEnabled && info.autoChatMsg && info.status === 'online') scheduleAutoChat(info);
      saveData();
      await edit(acMenuText(info), acMenuKeyboard(name));
      return answer(info.autoChatEnabled ? '▶️ Auto-chat resumed' : '⏸ Auto-chat paused');
    }

    case 'acnow':
      if (info.status !== 'online' || !info.mcBot) return answer('Bot is not online');
      if (!info.autoChatMsg) return answer('Set a message first');
      queueSend(info, info.autoChatMsg);
      return answer('💬 Message queued');

    case 'acclear':
      info.autoChatMsg = null;
      info.autoChatEnabled = true;
      stopAutoChat(info);
      saveData();
      await edit(acMenuText(info), acMenuKeyboard(name));
      return answer('🗑 Auto-chat message cleared');

    // --- auto-login ---
    case 'login':
      chatStates.delete(chatId);
      await edit(loginMenuText(info), loginMenuKeyboard(name));
      return answer();

    case 'loginset':
      setState(chatId, { action: 'awaiting_login_cmd', name });
      await edit(
        `🔐 <b>Set auto-login — ${esc(name)}</b>\n\nSend the exact command your server needs after joining:\n<code>/login 1597311</code>\n<code>/register mypass mypass</code>\n\nIt is stored for this bot and replayed on every reconnect, only when the server asks for a login.\n\n⚠️ Your message contains the password — delete it after sending.`,
        new InlineKeyboard().text('❌ Cancel', `login:${name}`)
      );
      return answer('✏️ Type the login command in chat');

    case 'logintoggle':
      if (!info.loginCmd) return answer('No command saved');
      info.loginEnabled = info.loginEnabled === false;
      if (!info.loginEnabled) stopLogin(info);
      saveData();
      await edit(loginMenuText(info), loginMenuKeyboard(name));
      return answer(info.loginEnabled ? '🔐 Auto-login enabled' : '🔓 Auto-login disabled');

    case 'loginclear':
      info.loginCmd = null;
      info.loginEnabled = true;
      stopLogin(info);
      saveData();
      await edit(loginMenuText(info), loginMenuKeyboard(name));
      return answer('🗑️ Login command cleared');

    case 'loginnow': {
      if (!info.loginCmd) return answer('No command saved');
      if (info.status !== 'online' || !info.mcBot) return answer('Bot is not online');
      info.loginTries = 0;
      info.loginDone = false;
      const sent = sendLogin(info, 'manual');
      if (sent) captureFor(name, chatId);
      return answer(sent ? '▶️ Login command sent' : 'Auto-login is disabled');
    }

    case 'confirm_remove':
      await edit(
        `⚠️ Remove <b>${esc(name)}</b>?\nThis will disconnect it from the server and forget its anti-AFK and login settings.`,
        new InlineKeyboard().text('✅ Yes, remove', `do_remove:${name}`).text('❌ Cancel', `manage:${name}`)
      );
      return answer();

    case 'do_remove':
      info.autoReconnect = false;
      destroyBot(info);
      mcBots.delete(name);
      if (activeBot.get(chatId) === name) activeBot.delete(chatId);
      saveData();
      await edit(botListText(ctx), botListKeyboard(ctx));
      return answer(`✅ ${name} removed`);

    default:
      return answer();
  }
});

bot.on('message:text', async ctx => {
  const chatId = ctx.chat.id;
  const state = getState(chatId);
  const text = ctx.message.text.trim();

  // --- Neocraft: set login command ---
  if (state?.action === 'awaiting_nc_login') {
    const info = mcBots.get(state.name);
    if (!info || !canControl(ctx, info)) {
      chatStates.delete(chatId);
      return ctx.reply(`⚠️ That bot is gone.`, { reply_markup: new InlineKeyboard().text('📋 Bots', 'list_bots') });
    }
    const res = applyNcCmd(info, 'login', text);
    if (res.error) {
      return ctx.reply(res.error, { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('❌ Cancel', `neocraft:${info.name}`) });
    }
    chatStates.delete(chatId);
    setState(chatId, { action: 'awaiting_nc_second', name: info.name });
    return ctx.reply(`🔐 Login command saved for <b>${esc(info.name)}</b>:\n<code>${esc(maskLogin(info.ncLogin))}</code>\n\nNow send the 2nd command that switches into survival, e.g.\n<code>/survival</code>`, {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('❌ Skip', `neocraft:${info.name}`),
    });
  }

  // --- Neocraft: set 2nd command ---
  if (state?.action === 'awaiting_nc_second') {
    const info = mcBots.get(state.name);
    if (!info || !canControl(ctx, info)) {
      chatStates.delete(chatId);
      return ctx.reply(`⚠️ That bot is gone.`, { reply_markup: new InlineKeyboard().text('📋 Bots', 'list_bots') });
    }
    const res = applyNcCmd(info, 'second', text);
    if (res.error) {
      return ctx.reply(res.error, { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('❌ Cancel', `neocraft:${info.name}`) });
    }
    chatStates.delete(chatId);
    setState(chatId, { action: 'awaiting_nc_third', name: info.name });
    return ctx.reply(`▶️ 2nd command saved for <b>${esc(info.name)}</b>:\n<code>${esc(info.ncSecond)}</code>\n\nNow send the <b>3rd command</b> — it runs <b>5 minutes</b> after the 2nd, e.g.\n<code>/kit daily</code>\n\nOr skip it:`, {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('⏭ Skip 3rd command', `ncskipthird:${info.name}`),
    });
  }

  // --- Neocraft: set 3rd command (runs 5 minutes after the 2nd) ---
  if (state?.action === 'awaiting_nc_third') {
    const info = mcBots.get(state.name);
    if (!info || !canControl(ctx, info)) {
      chatStates.delete(chatId);
      return ctx.reply(`⚠️ That bot is gone.`, { reply_markup: new InlineKeyboard().text('📋 Bots', 'list_bots') });
    }
    const res = applyNcCmd(info, 'third', text);
    if (res.error) {
      return ctx.reply(res.error, { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('❌ Cancel', `neocraft:${info.name}`) });
    }
    chatStates.delete(chatId);
    info.ncEnabled = true;
    if (info.status === 'online' && info.mcBot) scheduleNeocraft(info);
    saveData();
    return ctx.reply(`⏱ 3rd command saved for <b>${esc(info.name)}</b>:\n<code>${esc(info.ncThird)}</code>\n\nIt will run 5 minutes after the 2nd command.\nNeocraft flow is ready and enabled.`, {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('🏰 Neocraft', `neocraft:${info.name}`),
    });
  }

  // --- custom anti-AFK interval ---
  if (state?.action === 'awaiting_afk_interval') {
    const info = mcBots.get(state.name);
    if (!info || !canControl(ctx, info)) {
      chatStates.delete(chatId);
      return ctx.reply(`⚠️ That bot is gone.`, { reply_markup: new InlineKeyboard().text('📋 Bots', 'list_bots') });
    }
    const ms = parseInterval(text);
    if (ms === null) {
      return ctx.reply(`❌ Didn't understand that. Try <code>30s</code>, <code>90s</code> or <code>5m</code> (${MIN_AFK_INTERVAL_MS / 1000}s – ${MAX_AFK_INTERVAL_MS / 60000}m).`, {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text('❌ Cancel', `afk:${info.name}`),
      });
    }
    chatStates.delete(chatId);
    setAfk(info, info.afkMode === 'off' ? 'jump' : undefined, ms);
    return ctx.reply(`⏱ <b>${esc(info.name)}</b> — ${AFK_LABEL[info.afkMode]} every <b>${humanInterval(info.afkIntervalMs)}</b>.`, {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('🏃 Anti-AFK', `afk:${info.name}`).text('⚙️ Manage', `manage:${info.name}`),
    });
  }

  // --- saved login command ---
  if (state?.action === 'awaiting_login_cmd') {
    const info = mcBots.get(state.name);
    if (!info || !canControl(ctx, info)) {
      chatStates.delete(chatId);
      return ctx.reply(`⚠️ That bot is gone.`, { reply_markup: new InlineKeyboard().text('📋 Bots', 'list_bots') });
    }
    const res = applyLoginCmd(info, text);
    if (res.error) {
      return ctx.reply(res.error, { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('❌ Cancel', `login:${info.name}`) });
    }
    chatStates.delete(chatId);
    const kb = new InlineKeyboard();
    if (info.status === 'online') kb.text('▶️ Send now', `loginnow:${info.name}`);
    kb.text('⚙️ Manage', `manage:${info.name}`);
    return ctx.reply(`🔐 Saved for <b>${esc(info.name)}</b>: <code>${esc(maskLogin(info.loginCmd))}</code>\n\nIt will be sent automatically whenever this bot joins and the server asks for a login.\n\n⚠️ <i>Delete your last message — it contains the password.</i>`, {
      parse_mode: 'HTML',
      reply_markup: kb,
    });
  }

  // --- auto-chat message ---
  if (state?.action === 'awaiting_autochat_msg') {
    const info = mcBots.get(state.name);
    if (!info || !canControl(ctx, info)) {
      chatStates.delete(chatId);
      return ctx.reply(`⚠️ That bot is gone.`, { reply_markup: new InlineKeyboard().text('📋 Bots', 'list_bots') });
    }
    const clean = text.trim().replace(/\s+/g, ' ');
    if (!clean) {
      return ctx.reply('⚠️ Empty message — send the text the bot should repeat.', {
        reply_markup: new InlineKeyboard().text('❌ Cancel', `ac:${info.name}`),
      });
    }
    if (clean.length > MC_MAX_LEN) {
      return ctx.reply(`❌ Too long — Minecraft caps messages at ${MC_MAX_LEN} characters. Send a shorter one.`, {
        reply_markup: new InlineKeyboard().text('❌ Cancel', `ac:${info.name}`),
      });
    }
    chatStates.delete(chatId);
    info.autoChatMsg = clean;
    info.autoChatEnabled = true;
    stopAutoChat(info);
    if (info.status === 'online') scheduleAutoChat(info);
    saveData();
    return ctx.reply(`💬 Saved for <b>${esc(info.name)}</b>:\n<code>${esc(clean)}</code>\n\nIt will be sent every <b>${humanInterval(clampChatInterval(info.autoChatIntervalMs))}</b> while the bot is online.`, {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('💬 Auto-chat', `ac:${info.name}`).text('⚙️ Manage', `manage:${info.name}`),
    });
  }

  // --- auto-chat custom interval ---
  if (state?.action === 'awaiting_autochat_interval') {
    const info = mcBots.get(state.name);
    if (!info || !canControl(ctx, info)) {
      chatStates.delete(chatId);
      return ctx.reply(`⚠️ That bot is gone.`, { reply_markup: new InlineKeyboard().text('📋 Bots', 'list_bots') });
    }
    const ms = parseChatInterval(text);
    if (ms === null) {
      return ctx.reply(`❌ Didn't understand that. Try <code>10m</code>, <code>2h</code> or <code>1h30m</code> (1m – 24h).`, {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text('❌ Cancel', `ac:${info.name}`),
      });
    }
    chatStates.delete(chatId);
    info.autoChatIntervalMs = ms;
    info.autoChatEnabled = true;
    stopAutoChat(info);
    if (info.autoChatMsg && info.status === 'online') scheduleAutoChat(info);
    saveData();
    return ctx.reply(`⏱ <b>${esc(info.name)}</b> — auto-chat every <b>${humanInterval(ms)}</b>.`, {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('💬 Auto-chat', `ac:${info.name}`).text('⚙️ Manage', `manage:${info.name}`),
    });
  }

  if (state?.action !== 'awaiting_bot_info') {
    // Anything else that looks like a slash command and isn't ours goes straight to the server.
    const m = /^\/([a-zA-Z0-9_]+)(?:@\w+)?(\s|$)/.exec(text);
    if (!m || RESERVED.has(m[1].toLowerCase())) return;

    const p = pickBot(ctx);
    if (!p.info) return ctx.reply(p.error, { parse_mode: 'HTML', reply_markup: p.keyboard });
    // Drop the @BotName suffix Telegram adds in groups; the server wouldn't understand it.
    return relay(ctx, p.info, text.replace(/^(\/[a-zA-Z0-9_]+)@\w+/, '$1'));
  }

  chatStates.delete(chatId);

  const parts = text.split(/\s+/);
  const name = parts[0];
  const rawHost = parts[1] || '';
  let host, port, version;

  if (rawHost.includes(':')) {
    const idx = rawHost.lastIndexOf(':');
    host = rawHost.slice(0, idx);
    port = parseInt(rawHost.slice(idx + 1), 10);
    version = parts[2] || '1.20.4';
  } else {
    host = rawHost;
    port = parseInt(parts[2] || '', 10);
    version = parts[3] || '1.20.4';
  }

  const backKb = new InlineKeyboard().text('➕ Try Again', 'add_bot').text('⬅️ Main Menu', 'main_menu');
  if (!name || !host || !port) return ctx.reply(`❌ Missing info.\n<code>name  ip  port  [version]</code>`, { parse_mode: 'HTML', reply_markup: backKb });
  if (isNaN(port) || port < 1 || port > 65535) return ctx.reply(`❌ Invalid port (1–65535).`, { parse_mode: 'HTML', reply_markup: backKb });
  if (!/^[a-zA-Z0-9_]{1,16}$/.test(name)) return ctx.reply(`❌ Invalid username — letters, numbers, underscores, max 16.`, { parse_mode: 'HTML', reply_markup: backKb });
  if (!/^[a-zA-Z0-9.-]{1,253}$/.test(host)) return ctx.reply(`❌ Invalid host — letters, numbers, dots and dashes only.`, { parse_mode: 'HTML', reply_markup: backKb });
  if (!/^(?:auto|[0-9][0-9a-zA-Z.\-_]{0,20})$/.test(version)) return ctx.reply(`❌ Invalid version — e.g. <code>1.20.4</code>, or <code>auto</code> to detect it.`, { parse_mode: 'HTML', reply_markup: backKb });

  const mine = controllableBots(ctx);
  if (mine.length >= MAX_BOTS_PER_OWNER && !mine.some(b => b.name === name)) {
    return ctx.reply(`⚠️ You already have ${MAX_BOTS_PER_OWNER} bots — remove one first.`, { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('📋 Bots', 'list_bots') });
  }

  const existing = mcBots.get(name);
  if (existing) {
    // Names are the Minecraft username, so they're global. Don't let one user
    // take over — or accidentally clobber — someone else's registered bot.
    if (!canControl(ctx, existing)) {
      return ctx.reply(`⚠️ The name <b>${esc(name)}</b> is already registered by someone else here. Pick a different username.`, {
        parse_mode: 'HTML',
        reply_markup: backKb,
      });
    }
    if (existing.status === 'online' || existing.status === 'connecting') {
      return ctx.reply(`⚠️ <b>${esc(name)}</b> is already ${existing.status}.`, {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text('📋 List Bots', 'list_bots').text('⬅️ Main Menu', 'main_menu'),
      });
    }
  }

  const ownerUsername = ctx.from.username || null;
  const msg = await ctx.reply(`🟡 Connecting <b>${esc(name)}</b> to <code>${esc(host)}:${port}</code> [<code>${esc(version)}</code>]…`, { parse_mode: 'HTML' });

  spawnBot(name, host, port, version, chatId, ownerUsername, {
    loginCmd: existing?.loginCmd ?? null,
    loginEnabled: existing?.loginEnabled !== false,
    ncLogin: existing?.ncLogin ?? null,
    ncSecond: existing?.ncSecond ?? null,
    ncThird: existing?.ncThird ?? null,
    ncEnabled: existing?.ncEnabled === true,
    afkMode: existing?.afkMode ?? 'off',
    afkIntervalMs: existing?.afkIntervalMs ?? DEFAULT_AFK_INTERVAL_MS,
    autoChatMsg: existing?.autoChatMsg ?? null,
    autoChatEnabled: existing?.autoChatEnabled !== false,
    autoChatIntervalMs: existing?.autoChatIntervalMs ?? DEFAULT_AUTOCHAT_INTERVAL_MS,
    autoEat: existing?.autoEat === true,
  });
  activeBot.set(chatId, name);
  saveData();

  setTimeout(async () => {
    const info = mcBots.get(name);
    if (!info) return;
    const kb = new InlineKeyboard()
      .text('🏃 Anti-AFK', `afk:${name}`).text('🔐 Auto-login', `login:${name}`).row()
      .text(`${dot(info.status)} Manage ${info.name}`, `manage:${name}`).row()
      .text('📋 List Bots', 'list_bots').text('⬅️ Main Menu', 'main_menu');
    await bot.api.editMessageText(
      chatId, msg.message_id,
      `${botManageText(info)}\n\n<i>Set up anti-AFK so the server doesn't kick it for idling, and save a login command if the server needs one.</i>`,
      { parse_mode: 'HTML', reply_markup: kb }
    ).catch(() => {});
  }, 3000);
});

bot.catch(err => console.error('Update error:', err.error?.message ?? err.message ?? err));

// A single mineflayer parse error must not take the whole manager down.
process.on('uncaughtException', err => {
  console.error('uncaughtException:', err?.stack || err?.message || err);
});
process.on('unhandledRejection', reason => {
  console.error('unhandledRejection:', reason?.stack || reason?.message || reason);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} — disconnecting ${mcBots.size} bot(s)…`);
  try { flushSave(); } catch (_) {}
  for (const info of mcBots.values()) {
    // Keep autoReconnect as-is so bots come back up on the next start.
    if (info.reconnectTimer) clearTimeout(info.reconnectTimer);
    stopAfk(info);
    stopAutoChat(info);
    stopLogin(info);
    if (info.eatDisposer) { try { info.eatDisposer(); } catch (_) {} info.eatDisposer = null; }
    if (info.sendTimer) clearTimeout(info.sendTimer);
    if (info.mcBot) {
      if (info.detachListeners) info.detachListeners();
      info.mcBot.on('error', () => {});
      try { info.mcBot.quit(); } catch (_) {}
    }
  }
  for (const box of outbox.values()) if (box.timer) clearTimeout(box.timer);
  bot.stop().catch(() => {}).finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

console.log('🚀 Minecraft Bot Manager starting…');
loadData();

if (mcBots.size) {
  const off = [...mcBots.values()].filter(b => !b.autoReconnect).length;
  console.log(`↩️  Restored ${mcBots.size} bot(s)${off ? ` (${off} left disconnected)` : ''}`);
}

bot.api.setMyCommands([
  { command: 'start', description: 'Open the main menu' },
  { command: 'bots', description: 'List your bots' },
  { command: 'where', description: "Show where a bot is (XYZ, world, health)" },
  { command: 'use', description: 'Pick which bot runs your commands' },
  { command: 'cmd', description: 'Send a command to the server' },
  { command: 'say', description: 'Send plain chat as the bot' },
  { command: 'afk', description: 'Anti-AFK: off | jump | walk | both [interval]' },
  { command: 'setlogin', description: 'Save the login command for a bot' },
  { command: 'console', description: "Open a bot's console" },
  { command: 'players', description: 'List everyone online on the server' },
  { command: 'status', description: 'Show host CPU and RAM usage' },
  { command: 'click', description: 'Click a slot in an open GUI (captcha)' },
  { command: 'forward', description: 'Forward server chat to this group' },
  { command: 'unforward', description: 'Stop forwarding here' },
  { command: 'forwards', description: 'List active forwards' },
  { command: 'help', description: 'Help and usage' },
]).catch(() => {});

Promise.resolve(bot.start({ onStart: info => console.log(`✅ Running as @${info.username}`) }))
  .catch(err => {
    const msg = err?.description || err?.message || String(err);
    console.error(`❌ Telegram refused the connection: ${msg}`);
    if (/401|unauthorized/i.test(msg)) console.error('   Check TELEGRAM_BOT_TOKEN in .env — get a fresh one from @BotFather.');
    process.exit(1);
  });