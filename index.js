'use strict';

const { Bot, InlineKeyboard, InputFile } = require('grammy');
const mineflayer = require('mineflayer');
const { MapCaptcha, findVerifyCommand, VERIFY_HINT_RE, DEFAULT_FINGERPRINT,
  isCooldownKick, parseCooldownMs } = require('./antibot');
const autoEat = require('./autoeat');
const fs = require('fs');
const net = require('net');
const path = require('path');

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
      ncEnabled: b.ncEnabled === true,
      afkMode: b.afkMode || 'off',
      afkIntervalMs: b.afkIntervalMs || DEFAULT_AFK_INTERVAL_MS,
      autoEat: b.autoEat === true,
      // A restart must not hand the server a fresh join inside a cooldown it set.
      cooldownUntil: b.cooldownUntil && b.cooldownUntil > Date.now() ? b.cooldownUntil : 0,
      cooldownWaits: b.cooldownWaits || 0,
    })),
    forwards: Object.fromEntries([...forwardMap].map(([u, s]) => [u, [...s]])),
    active: Object.fromEntries([...activeBot]),
  };
  try {
    fs.writeFileSync(DATA_TMP, JSON.stringify(out), 'utf8');
    fs.renameSync(DATA_TMP, DATA);
  } catch (e) { console.error('saveData:', e.message); }
}

function loadData() {
  if (!fs.existsSync(DATA)) { fs.writeFileSync(DATA, JSON.stringify({ bots: [], forwards: {} }), 'utf8'); return; }
  loading = true;
  try {
    const raw = JSON.parse(fs.readFileSync(DATA, 'utf8'));
    for (const [u, ids] of Object.entries(raw.forwards || {})) forwardMap.set(u, new Set(ids));
    for (const [chatId, name] of Object.entries(raw.active || {})) activeBot.set(Number(chatId), name);
    for (const b of (raw.bots || [])) {
      const opts = {
        loginCmd: b.loginCmd || null,
        loginEnabled: b.loginEnabled !== false,
        ncLogin: b.ncLogin || null,
        ncSecond: b.ncSecond || null,
        ncEnabled: b.ncEnabled === true,
        afkMode: AFK_MODES.has(b.afkMode) ? b.afkMode : 'off',
        afkIntervalMs: clampInterval(b.afkIntervalMs),
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
        entry.reconnectTimer = setTimeout(() => {
          const latest = mcBots.get(b.name);
          if (latest !== entry || !entry.autoReconnect) return;
          entry.cooldownUntil = 0;
          spawnBot(b.name, b.host, b.port, b.version, b.chatId, b.ownerUsername, opts);
        }, delay);
        if (entry.reconnectTimer.unref) entry.reconnectTimer.unref();
      } else {
        spawnBot(b.name, b.host, b.port, b.version, b.chatId, b.ownerUsername, opts);
      }
    }
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

const notifyPhoto = (chatId, buf, caption) =>
  bot.api.sendPhoto(chatId, new InputFile(buf, 'captcha.png'), { caption, parse_mode: 'HTML' })
    .catch(() => notify(chatId, caption + '\n\n⚠️ (Telegram refused the image)'));

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
  'cmd', 'say', 'use', 'console', 'bots', 'afk', 'setlogin', 'click',
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

// --- auto-login ---
// Servers running AuthMe/nLogin ask for /login after every join. We replay the
// saved command when the server prompts, and once as a fallback if it never does.
const LOGIN_PROMPT_RE = /\b(login|log in|logg?ed in|register|authenticat|password|senha|contrase|войти|парол)/i;
const LOGIN_OK_RE = /\b(logged in|login success|successfully logged|authenticated|welcome back|already logged)/i;
const LOGIN_FALLBACK_MS = 4000;
const LOGIN_MAX_TRIES = 3;
const LOGIN_RETRY_MS = 6000;

// Batch outgoing server chat: one Telegram message per chat per window.
const FLUSH_MS = 2500;
const MAX_BATCH_LINES = 25;
const MAX_BATCH_CHARS = 3500;

// --- antibot / verification ---
// Servers that run an antibot hold new joins in a verification lobby: they send a
// title, an action-bar line, a chat instruction, or a map-rendered captcha, and
// kick anyone who doesn't answer. We surface all of that to Telegram, and when
// the server states the answer in plain text we replay it ourselves.
const VERIFY_RELAY_MS = 120000;      // how long after join we treat titles/action bars as antibot traffic
const VERIFY_AUTO_MAX = 3;           // don't spam a command the server ignores
const VERIFY_AUTO_GAP_MS = 2500;     // minimum spacing between auto-verify attempts
const VERIFY_DEDUPE_MS = 8000;       // same instruction seen twice → relay once

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
  .text('Help', 'help').text('Refresh', 'refresh_menu');

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
  const vf = b.verifyLastCmd ? `\n<b>AntiBot:</b> answered <code>${esc(b.verifyLastCmd)}</code>` : '';
  const cd = b.cooldownUntil && b.cooldownUntil > Date.now()
    ? `\n<b>AntiBot cooldown:</b> ${humanInterval(b.cooldownUntil - Date.now())} left (refusals: ${b.cooldownWaits || 1})`
    : '';
  const afk = b.afkMode && b.afkMode !== 'off'
    ? `\n<b>Anti-AFK:</b> ${AFK_LABEL[b.afkMode]} every <b>${humanInterval(b.afkIntervalMs)}</b>`
    : `\n<b>Anti-AFK:</b> off`;
  const food = b.status === 'online' && b.mcBot?.food != null ? `\n<b>Hunger:</b> ${Math.round(b.mcBot.food)} / 20` : '';
  const eat = b.autoEat ? `\n<b>Auto-Eat:</b> on (eats below ${autoEat.EAT_AT_FOOD}/20)` : `\n<b>Auto-Eat:</b> off`;
  const login = b.loginCmd
    ? `\n<b>Auto-login:</b> ${b.loginEnabled === false ? 'saved but <b>disabled</b>' : 'on'} - <code>${esc(maskLogin(b.loginCmd))}</code>`
    : `\n<b>Auto-login:</b> not set`;
  return `${dot(b.status)} <b>${esc(b.name)}</b>  <i>(${esc(ownerTag(b))})</i>\n\n<b>Server:</b> <code>${esc(b.host)}:${b.port}</code>\n<b>Version:</b> <code>${esc(b.version)}</code>\n<b>Status:</b> <b>${b.status}</b>${ut}${food}${eat}${afk}${login}${vf}${cd}${err}`;
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
  kb.text('📸 Screenshot', `shot:${name}`).row();
  kb.text(`🍖 Auto-Eat: ${b?.autoEat ? 'ON' : 'OFF'}`, `autoeat:${name}`).row();
  kb.text(`Anti-AFK: ${AFK_LABEL[b?.afkMode || 'off']}`, `afk:${name}`).row();
  kb.text(b?.loginCmd ? 'Auto-login' : 'Set auto-login', `login:${name}`).row();
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

function neocraftMenuText(b) {
  const status = b.ncEnabled === true ? 'enabled' : 'disabled';
  const login = b.ncLogin ? `<code>${esc(maskLogin(b.ncLogin))}</code>` : '<i>not set</i>';
  const second = b.ncSecond ? `<code>${esc(b.ncSecond)}</code>` : '<i>not set</i>';
  return `<b>Neocraft server - ${esc(b.name)}</b>\n\nOn every join it logs in, then switches you into survival.\n\n<b>Login command:</b> ${login}\n<b>2nd command:</b> ${second}\n<b>Status:</b> ${status}\n\nTiming: login ~2s after joining (or right after an antibot challenge clears), 2nd command ~5-6s after that.`;
}

function neocraftMenuKeyboard(name) {
  const b = mcBots.get(name);
  const kb = new InlineKeyboard();
  kb.text(b?.ncLogin ? 'Change login' : 'Set login', `ncsetlogin:${name}`).text(b?.ncSecond ? 'Change 2nd cmd' : 'Set 2nd cmd', `ncsetsecond:${name}`).row();
  kb.text(b?.ncEnabled ? 'Disable' : 'Enable', `nctoggle:${name}`).row();
  if (b?.ncLogin || b?.ncSecond) kb.text('Clear', `ncclear:${name}`).row();
  return kb.text('< Back', `manage:${name}`);
}

function stopAfk(info) {
  if (info.afkTimer) { clearTimeout(info.afkTimer); info.afkTimer = null; }
  if (info.afkStepTimers) { for (const t of info.afkStepTimers) clearTimeout(t); info.afkStepTimers = []; }
  const mc = info.mcBot;
  if (mc) {
    for (const c of ['forward', 'back', 'jump']) { try { mc.setControlState(c, false); } catch (_) {} }
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
}

function destroyBot(info) {
  if (info.reconnectTimer) { clearTimeout(info.reconnectTimer); info.reconnectTimer = null; }
  if (info.sendTimer) { clearTimeout(info.sendTimer); info.sendTimer = null; }
  if (info.probeTimer) { clearTimeout(info.probeTimer); info.probeTimer = null; }
  info.sendQueue = [];
  stopAfk(info);
  stopLogin(info);
  stopNeocraft(info);
  stopVerify(info);
  if (info.eatDisposer) { try { info.eatDisposer(); } catch (_) {} info.eatDisposer = null; }
  try { require('./viewer').destroyViewer(info); } catch (_) {}
  if (info.mcBot) {
    const mc = info.mcBot;
    info.mcBot = null;
    mc.removeAllListeners();
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
  // Hold still while an antibot challenge is in flight — some of them fail a player
  // that moves during the check.
  if (verifyHold(info)) return;

  if (!info.afkStepTimers) info.afkStepTimers = [];
  const at = (ms, fn) => info.afkStepTimers.push(setTimeout(() => {
    if (info.mcBot !== mc || info.status !== 'online') return;
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
      // Small pause before going back (more human)
      setTimeout(() => {
        if (info.mcBot !== mc || info.status !== 'online') return;
        mc.setControlState('back', true);
      }, 50 + Math.floor(Math.random() * 100));
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
        setTimeout(() => {
          if (info.mcBot !== mc) return;
          mc.setControlState('sprint', false);
        }, 200 + Math.floor(Math.random() * 300));
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
function sendLogin(info, why) {
  if (!info.loginCmd || info.loginEnabled === false) return false;
  if (info.status !== 'online' || !info.mcBot) return false;
  if (info.loginTries >= LOGIN_MAX_TRIES) return false;
  info.loginTries = (info.loginTries || 0) + 1;
  if (info.loginTimer) { clearTimeout(info.loginTimer); info.loginTimer = null; }
  queueSend(info, info.loginCmd, true);
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

// Neocraft server auto-flow: log in, then switch into survival, with fixed delays.
function sendNcFlow(info) {
  if (info.status !== 'online' || !info.mcBot) return;
  queueSend(info, info.ncLogin, true);
  info.error = 'Neocraft login sent';
  if (info.ncSecond) {
    const secondDelay = 5000 + Math.floor(Math.random() * 1000); // 5–6s after login
    info.ncTimer2 = setTimeout(() => {
      info.ncTimer2 = null;
      if (info.status !== 'online' || !info.mcBot) return;
      queueSend(info, info.ncSecond);
      info.error = 'Neocraft 2nd command sent';
    }, secondDelay);
  }
}

function scheduleNeocraft(info) {
  if (!info.ncEnabled || !info.ncLogin) return;
  if (info.ncTimer1) clearTimeout(info.ncTimer1);
  if (info.ncTimer2) clearTimeout(info.ncTimer2);
  info.ncTimer1 = setTimeout(() => {
    info.ncTimer1 = null;
    if (info.status !== 'online' || !info.mcBot) return;
    // Don't fire the login into an antibot lobby — a pending challenge has to
    // clear first, or the auth plugin never sees the command. Wait once, then send.
    if (verifyHold(info)) {
      info.ncTimer1 = setTimeout(() => {
        info.ncTimer1 = null;
        if (info.status !== 'online' || !info.mcBot) return;
        sendNcFlow(info);
      }, VERIFY_HOLD_MS);
      return;
    }
    sendNcFlow(info);
  }, 2000);
}

// --- antibot verification ---
// One place that decides what to do with anything that might be a verification
// challenge, wherever it arrived from (chat, title, action bar, or a map image).
//
// Rule: we only ever send back a command the server itself printed. If the
// challenge needs a human (an image captcha, a numeric puzzle, a click), we
// forward it to Telegram and let the user answer with /cmd.
function stopVerify(info) {
  if (info.mapCaptcha) { info.mapCaptcha.clear(); info.mapCaptcha = null; }
  info.verifySeen = null;
  info.verifyPending = null;
  info.verifyLastSeenAt = 0;
}

// True while a join is new enough that titles/action bars are probably the
// antibot talking rather than normal gameplay HUD noise.
const inVerifyWindow = info =>
  info.connectedAt != null && Date.now() - info.connectedAt < VERIFY_RELAY_MS;

// True right after a challenge was seen and before anything suggests we're through.
// While this holds we keep the player still: several antibots score movement during
// their check, and a bot that hops around mid-captcha fails it.
const VERIFY_HOLD_MS = 15000;
const verifyHold = info => !!info.verifyLastSeenAt && Date.now() - info.verifyLastSeenAt < VERIFY_HOLD_MS;

function relayVerify(info, text, source) {
  const clean = String(text || '').trim();
  if (!clean) return;

  // The same instruction usually arrives on several channels at once.
  if (!info.verifySeen) info.verifySeen = new Map();
  const now = Date.now();
  for (const [k, t] of info.verifySeen) if (now - t > VERIFY_DEDUPE_MS) info.verifySeen.delete(k);
  const key = clean.toLowerCase();
  if (info.verifySeen.has(key)) return;
  info.verifySeen.set(key, now);
  info.verifyLastSeenAt = now;

  notify(info.chatId, `🛡️ <b>${esc(info.name)}</b> — verification (${esc(source)}):\n<code>${esc(clean.slice(0, 500))}</code>`);
  tryAutoVerify(info, clean);
}

function tryAutoVerify(info, text) {
  const cmd = findVerifyCommand(text);
  if (!cmd) return false;
  if (info.status !== 'online' || !info.mcBot) {
    // Challenge arrived while the join was still in the lobby — we can't chat yet,
    // so keep the source line and re-run this once we're in.
    info.verifyPending = text;
    return false;
  }

  info.verifyTries = info.verifyTries || 0;
  if (info.verifyTries >= VERIFY_AUTO_MAX) return false;
  const now = Date.now();
  if (info.verifyLastAt && now - info.verifyLastAt < VERIFY_AUTO_GAP_MS) return false;
  // Never send the identical command twice — if it didn't work once, it won't now.
  if (info.verifyLastCmd === cmd) return false;

  info.verifyTries++;
  info.verifyLastAt = now;
  info.verifyLastCmd = cmd;
  info.verifyPending = null;
  queueSend(info, cmd, true);
  notify(info.chatId, `🤖 <b>${esc(info.name)}</b> answered the antibot automatically:\n<code>${esc(cmd)}</code>`);
  return true;
}

// How often to probe the outbound TCP path to the host while "online". Catches
// a half-open socket (host sleep, NAT drop, dead link) in under 5 minutes, so
// the watchdog of the protocol library doesn't have to kill us later.
const PROBE_INTERVAL_MS = 4 * 60000;
const PROBE_DEAD_MS = 10000;          // 10s of stalls = the path is dead, not lag
const PROBE_SOCKET_TIMEOUT_MS = 8000;
// Fixed reconnect interval (user preference): always retry after ~4s instead of
// escalating the backoff. A tiny jitter keeps retries off a perfect beat so the
// pattern doesn't look automated, but the gap stays at ~4s on every attempt.
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
    ncEnabled: opts.ncEnabled !== undefined ? opts.ncEnabled : (ex?.ncEnabled === true),
    ncTimer1: null, ncTimer2: null,
    afkMode: opts.afkMode !== undefined ? opts.afkMode : (ex?.afkMode ?? 'off'),
    afkIntervalMs: clampInterval(opts.afkIntervalMs !== undefined ? opts.afkIntervalMs : ex?.afkIntervalMs),
    autoEat: opts.autoEat !== undefined ? opts.autoEat : (ex?.autoEat === true),
    eatBusy: false, eatWarnedAt: 0, eatDisposer: null,
    afkTimer: null, afkStepTimers: [],
    // Antibot state — reset on every fresh connection attempt.
    verifyTries: 0, verifyLastAt: 0, verifyLastCmd: null,
    verifySeen: null, mapCaptcha: null,
    verifyPending: null, verifyLastSeenAt: 0,
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
      const delay = current.cooldownUntil - now;
      current.status = 'offline';
      current.error = `Antibot cooldown — waiting ${Math.round(delay / 1000)}s`;
      saveData();
      notify(chatId,
        `⏳ <b>${esc(name)}</b> — the antibot is rate-limiting this IP, not asking for a captcha.\n` +
        `Waiting <b>${humanInterval(delay)}</b> before the next try (retrying sooner restarts the server's own timer).`);
      current.reconnectTimer = setTimeout(() => {
        const latest = mcBots.get(name);
        if (!latest || latest !== info || !latest.autoReconnect) return;
        spawnBot(name, host, port, version, chatId, ownerUsername, {
          loginCmd: info.loginCmd, loginEnabled: info.loginEnabled,
          ncLogin: info.ncLogin, ncSecond: info.ncSecond, ncEnabled: info.ncEnabled,
          afkMode: info.afkMode, afkIntervalMs: info.afkIntervalMs,
          autoEat: info.autoEat,
        });
      }, delay);
      return;
    }

    current.reconnectAttempts++;
    const isTimeout = !!current.timeoutConnected;
    const delay = retryDelay(current.reconnectAttempts, isTimeout);
    const marker = isTimeout ? ' (no keepalive — server stalled or restarting)' : '';
    notify(chatId, `🔄 <b>${esc(name)}</b> reconnecting in ${Math.round(delay / 1000)}s (attempt ${current.reconnectAttempts})${marker}…`);
    current.reconnectTimer = setTimeout(() => {
      const latest = mcBots.get(name);
      if (!latest || latest !== info || !latest.autoReconnect) return;
      spawnBot(name, host, port, version, chatId, ownerUsername, {
        loginCmd: info.loginCmd, loginEnabled: info.loginEnabled,
        ncLogin: info.ncLogin, ncSecond: info.ncSecond, ncEnabled: info.ncEnabled,
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
    stopVerify(info);
    if (info.eatDisposer) { try { info.eatDisposer(); } catch (_) {} info.eatDisposer = null; }
    try { require('./viewer').destroyViewer(info); } catch (_) {}
    info.status = status;
    info.error = errText;
    info.mcBot = null;
    if (info.probeTimer) { clearTimeout(info.probeTimer); info.probeTimer = null; }
    if (info.sendTimer) { clearTimeout(info.sendTimer); info.sendTimer = null; }
    info.sendQueue = [];
    mcBot.removeAllListeners();
    mcBot.on('error', () => {});
    saveData();
    if (tgText) notify(chatId, tgText);
    
    scheduleReconnect();
  }

  // --- antibot surfaces -------------------------------------------------
  // A verification stage can talk to the client on four channels. Chat is handled
  // in the 'message' listener further down; the other three are wired here.

  // 1. Resource packs. Some antibots require the pack to be accepted before they
  //    let the player through, and mineflayer never answers on its own — an
  //    unanswered request is an instant kick on those servers.
  mcBot.on('resourcePack', () => {
    if (mcBots.get(name) !== info) return;
    try { mcBot.acceptResourcePack(); } catch (_) {}
  });

  // 2. Titles and the action bar — where most antibots print the instruction,
  //    because a bot that only reads chat never sees it.
  mcBot.on('title', (text, type) => {
    if (mcBots.get(name) !== info) return;
    const clean = readChat(text);
    if (!clean) return;
    if (inVerifyWindow(info) || VERIFY_HINT_RE.test(clean)) relayVerify(info, clean, type || 'title');
  });

  mcBot.on('actionBar', msg => {
    if (mcBots.get(name) !== info) return;
    const clean = readChat(msg);
    if (!clean) return;
    if (inVerifyWindow(info) || VERIFY_HINT_RE.test(clean)) relayVerify(info, clean, 'action bar');
  });

  // 3. GUI captchas. Some antibots open a chest and ask the player to click a
  //    specific item. We can't read the picture, so list what's in the window and
  //    let the user click a slot with /click.
  mcBot.on('windowOpen', window => {
    if (mcBots.get(name) !== info) return;
    if (!inVerifyWindow(info)) return;
    try {
      const title = readChat(window.title) || `window #${window.id}`;
      const items = (window.slots || [])
        .map((it, i) => (it ? `${i}: ${it.count}× ${it.name}${it.customName ? ' "' + readChat(it.customName) + '"' : ''}` : null))
        .filter(Boolean)
        .slice(0, 40);
      notify(info.chatId,
        `📦 <b>${esc(name)}</b> — the server opened a GUI (possible captcha):\n<b>${esc(title)}</b>\n\n` +
        (items.length ? `<code>${esc(items.join('\n'))}</code>\n\n` : '<i>(empty)</i>\n\n') +
        `Click a slot with:\n<code>/click ${esc(name)} &lt;slot&gt;</code>`);
    } catch (_) {}
  });

  // 4. Map captchas. The code is drawn onto filled maps, so there is no text to
  //    read — stitch every map the server sent into one picture and let the user
  //    read it in Telegram.
  info.mapCaptcha = new MapCaptcha((png, meta) => {
    if (mcBots.get(name) !== info) return;
    const which = meta.tiles > 1
      ? `map captcha (${meta.tiles} maps, ${meta.cols}×${meta.rows})`
      : `map captcha (map #${meta.id})`;
    notifyPhoto(
      info.chatId, png,
      `🖼️ <b>${esc(name)}</b> — ${which}\n\nRead the code and send it back:\n<code>/cmd ${esc(name)} /verify CODE</code>\nor plain chat: <code>/say CODE</code>`
    );
  });
  mcBot._client?.on('map', packet => {
    if (mcBots.get(name) !== info) return;
    info.mapCaptcha?.feed(packet);
  });

  mcBot.once('spawn', () => {
    if (mcBots.get(name) !== info) return;
    info.status = 'online';
    info.connectedAt = Date.now();
    info.wasEverOnline = true; // Mark that we successfully connected
    info.reconnectAttempts = 0;
    info.error = null;
    info.loginTries = 0;
    info.loginDone = false;
    info.verifyTries = 0;
    info.verifyLastAt = 0;
    info.verifyLastCmd = null;
    info.verifySeen = null;
    info.verifyPending = null;
    info.verifyLastSeenAt = 0;
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
    const verNote = info.version === AUTO_VERSION && mcBot.version ? `\n🔧 Detected version: <code>${esc(mcBot.version)}</code>` : '';
    notify(chatId, `🟢 <b>${esc(name)}</b> connected to <code>${esc(host)}:${port}</code>!${verNote}${afkNote}`);

    // Keep probing the outbound path. A bot that has been sitting for hours can
    // have a half-open socket (host asleep, NAT dropped, link died) with no
    // error until the server's keepalive watchdog fires — which then looks like
    // the server timed us out. Catching the dead path ourselves and reconnecting
    // with fresh sockets keeps sessions alive for days instead of hours.
    if (info.probeTimer) { clearTimeout(info.probeTimer); info.probeTimer = null; }
    const armProbe = () => {
      if (mcBots.get(name) !== info || info.status !== 'online' || !info.mcBot) return;
      pollConnectivity(info);
      info.probeTimer = setTimeout(armProbe, PROBE_INTERVAL_MS);
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
            if (verifyHold(info)) return; // stay put while a challenge is pending
            mc.setControlState('jump', true);
            setTimeout(() => {
              if (!mc) return;
              mc.setControlState('jump', false);
            }, 100 + Math.floor(Math.random() * 150));
          }, 2000 + Math.floor(Math.random() * 1500));
        }
        
        // 4. Sneak for a moment (like checking player list) (3000-4500ms)
        if (Math.random() > 0.6) { // 40% chance
          setTimeout(() => {
            if (!mc || info.status !== 'online') return;
            if (verifyHold(info)) return;
            mc.setControlState('sneak', true);
            setTimeout(() => {
              if (!mc) return;
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

      // A challenge that arrived before we could chat gets answered now.
      if (info.verifyPending) {
        const pending = info.verifyPending;
        info.verifyPending = null;
        tryAutoVerify(info, pending);
      }

      // Give the server a moment to send its login prompt; if it doesn't, send anyway.
      if (info.loginCmd && info.loginEnabled !== false) {
        const armLoginFallback = (delay, deferred) => {
          info.loginTimer = setTimeout(() => {
            info.loginTimer = null;
            if (info.loginDone || info.loginTries) return;
            // Don't fire /login into an antibot lobby — the challenge has to clear
            // first, or the auth plugin never sees the command. Wait once, then send.
            if (!deferred && info.verifyLastAt && Date.now() - info.verifyLastAt < 10000) {
              armLoginFallback(8000, true);
              return;
            }
            sendLogin(info, deferred ? 'fallback after verification' : 'fallback');
          }, delay);
        };
        armLoginFallback(LOGIN_FALLBACK_MS, false);
      }

      scheduleAfk(info);
    }, startDelay);
  });

  mcBot.on('kicked', reason => {
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
        if (VERIFY_HINT_RE.test(lowerR) ||
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
      prefix = 'AntiBot verification required';
      extraInfo = '\n\n⚠️ <b>The antibot rejected this join.</b>\n' +
        'It will retry with a longer gap. If the server prints an instruction or shows a map captcha, it gets forwarded here — answer it with <code>/cmd ' + esc(name) + ' /verify CODE</code>.\n' +
        'If nothing arrives at all, join once with a real client to see what the server asks for.';
    }
    
    markDown('offline', `Kicked: ${r}`, `${emoji} <b>${esc(name)}</b> ${prefix}:\n<code>${esc(r)}</code>${extraInfo}`);
  });

  mcBot.on('error', err => {
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

  mcBot.on('end', reason => {
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

  mcBot.on('death', () => {
    if (mcBots.get(name) !== info) return;
    info.error = 'Died — respawning';
    notify(chatId, `💀 <b>${esc(name)}</b> died. Respawning…`);
  });

  mcBot.on('message', jsonMsg => {
    const clean = readChat(jsonMsg);
    if (!clean) return;

    // Antibot first: a verification lobby usually blocks /login until it passes,
    // so answering the challenge has to happen before anything else we send.
    if (VERIFY_HINT_RE.test(clean) || (inVerifyWindow(info) && findVerifyCommand(clean))) {
      relayVerify(info, clean, 'chat');
    }

    // Auto-login: react the moment the server asks, and stop retrying once it confirms.
    if (info.loginCmd && info.loginEnabled !== false) {
      if (LOGIN_OK_RE.test(clean)) {
        stopLogin(info);
        info.loginDone = true;
      } else if (!info.loginDone && LOGIN_PROMPT_RE.test(clean) && !VERIFY_HINT_RE.test(clean)) {
        // An antibot line can say "authenticate"/"verify" without being the auth
        // plugin's prompt. Sending /login there wastes an attempt and, on some
        // setups, counts as a failed check — so let the challenge clear first.
        sendLogin(info, 'server prompt');
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
  `⭐ <b>Help &amp; Usage</b>\n\n<b>➕ Adding a bot</b>\nPress <i>Add Bot</i> then send:\n<code>name  ip  port  [version]</code>\nUse <code>auto</code> as the version to detect the server's own.\n\n<b>🛡️ AntiBot servers</b>\nOn join the bot accepts the resource pack, and watches chat, titles, the action bar, GUIs and map images for a verification challenge. If the server spells out a command, it's answered automatically; otherwise the challenge is forwarded here so you can answer it:\n<code>/cmd &lt;bot&gt; /verify CODE</code>\n<code>/click &lt;bot&gt; &lt;slot&gt;</code>\n\n<b>Anti-AFK</b> 🏃\nOn a bot's manage screen press <b>Anti-AFK</b>:\n• <b>Jump only</b> — hops in place\n• <b>Walk 1 block</b> — one block forward, one back\n• <b>Jump + Walk</b> — both\nPick any interval from 15s to 30m, or a custom one.\n\n<b>Auto-login</b> 🔐\nPress <b>Set auto-login</b> and send the command your server needs, e.g. <code>/login 1597311</code>. It's saved for that bot and replayed on every reconnect, only when the server asks for it — and never while an antibot challenge is still pending.\n\n<b>Commands</b>\n<code>/bots</code> — list your bots\n<code>/use [name]</code> — pick the bot that runs commands\n<code>/cmd [name] &lt;command&gt;</code> — send a command\n<code>/say &lt;text&gt;</code> — send plain chat\n<code>/click [name] &lt;slot&gt;</code> — click a GUI slot\n<code>/afk [name] &lt;off|jump|walk|both&gt; [interval]</code>\n<code>/setlogin [name] &lt;command&gt;</code>\n<code>/console [name]</code> — open a bot's console\n<code>/forward @you</code> — forward server chat to a group\n\nAnything else starting with <code>/</code> goes straight to the server.`;

bot.command('help', async ctx => {
  await ctx.reply(HELP_TEXT(), {
    parse_mode: 'HTML',
    reply_markup: new InlineKeyboard().text('⌨️ Commands', 'cmd_help').text('📡 Forwarding', 'fwd_help').row().text('⬅️ Main Menu', 'main_menu'),
  });
});

bot.command('bots', async ctx => {
  await ctx.reply(botListText(ctx), { parse_mode: 'HTML', reply_markup: botListKeyboard(ctx) });
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
  else info.ncSecond = clean;
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
  if (action === 'afkmode' || action === 'afkint' || action === 'slot') {
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

    case 'shot': {
      if (info.status !== 'online' || !info.mcBot) {
        return answer(`⚠️ ${info.name} is ${info.status} — connect it first.`);
      }
      if (info.shotBusy) return answer('📸 Already rendering — wait a moment.');
      info.shotBusy = true;
      await answer('📸 Rendering 4 views…');
      try {
        const viewer = require('./viewer');
        const shots = await viewer.takeFourScreenshots(info);
        const caption = `📸 <b>${esc(name)}</b> — 4 directions from where it stands\n` +
          shots.map((s, i) => `${i + 1}. ${s.label}`).join(' · ');
        // Album: one message, four photos. Caption lives on the first item.
        const media = shots.map((s, i) => ({
          type: 'photo',
          media: new InputFile(s.buffer, `shot-${i + 1}.jpg`),
          ...(i === 0 ? { caption, parse_mode: 'HTML' } : {}),
        }));
        await bot.api.sendMediaGroup(chatId, media).catch(async () => {
          // Album refused (rare) — fall back to four single photos.
          for (const [i, s] of shots.entries()) {
            await notifyPhoto(chatId, s.buffer, `${i + 1}. ${s.label} — ${esc(name)}`);
          }
        });
      } catch (e) {
        // A broken GL context won't recover — drop the cached renderer.
        try { require('./viewer').destroyViewer(info); } catch (_) {}
        notify(chatId, `📸 <b>${esc(name)}</b> — screenshot failed:\n<code>${esc(e.message)}</code>`);
      } finally {
        info.shotBusy = false;
      }
      return answer();
    }

    case 'autoeat': {
      info.autoEat = !info.autoEat;
      saveData();
      await edit(botManageText(info), botManageKeyboard(name));
      return answer(info.autoEat
        ? `🍖 Auto-Eat on — eats when hunger ≤ ${autoEat.EAT_AT_FOOD}/20`
        : '🍖 Auto-Eat off');
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
      info.ncEnabled = false;
      stopNeocraft(info);
      saveData();
      await edit(neocraftMenuText(info), neocraftMenuKeyboard(name));
      return answer('🗑️ Neocraft settings cleared');

    case 'reconnect': {
      if (info.status === 'online' || info.status === 'connecting') return answer('Already ' + info.status);
      // An explicit reconnect overrides a pending antibot cooldown — the user is
      // telling us they want to try now.
      info.cooldownUntil = 0;
      info.cooldownWaits = 0;
      info.cooldownStated = null;
      
      spawnBot(name, info.host, info.port, info.version, info.chatId, info.ownerUsername, {
        loginCmd: info.loginCmd, loginEnabled: info.loginEnabled,
        ncLogin: info.ncLogin, ncSecond: info.ncSecond, ncEnabled: info.ncEnabled,
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
    info.ncEnabled = true;
    if (info.status === 'online' && info.mcBot) scheduleNeocraft(info);
    saveData();
    return ctx.reply(`▶️ 2nd command saved for <b>${esc(info.name)}</b>:\n<code>${esc(info.ncSecond)}</code>\n\nNeocraft flow is ready and enabled.`, {
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
    ncEnabled: existing?.ncEnabled === true,
    afkMode: existing?.afkMode ?? 'off',
    afkIntervalMs: existing?.afkIntervalMs ?? DEFAULT_AFK_INTERVAL_MS,
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
  try { saveData(); } catch (_) {}
  for (const info of mcBots.values()) {
    // Keep autoReconnect as-is so bots come back up on the next start.
    if (info.reconnectTimer) clearTimeout(info.reconnectTimer);
    stopAfk(info);
    stopLogin(info);
    stopVerify(info);
    if (info.eatDisposer) { try { info.eatDisposer(); } catch (_) {} info.eatDisposer = null; }
    try { require('./viewer').destroyViewer(info); } catch (_) {}
    if (info.sendTimer) clearTimeout(info.sendTimer);
    if (info.mcBot) { info.mcBot.removeAllListeners(); info.mcBot.on('error', () => {}); try { info.mcBot.quit(); } catch (_) {} }
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
  { command: 'use', description: 'Pick which bot runs your commands' },
  { command: 'cmd', description: 'Send a command to the server' },
  { command: 'say', description: 'Send plain chat as the bot' },
  { command: 'afk', description: 'Anti-AFK: off | jump | walk | both [interval]' },
  { command: 'setlogin', description: 'Save the login command for a bot' },
  { command: 'console', description: "Open a bot's console" },
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