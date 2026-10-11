'use strict';

// Backup / restore of manager state.
//
// A backup is the exact JSON the state file would contain (bots + forwarding
// subscriptions + active picks), sent to the owner as a document. Restoring
// must be safe against ANY file the user might attach — not just one we
// wrote — so every field is type-checked and clamped here before it can
// reach the live Maps in index.js. Anything unrecognised is skipped, never
// guessed at.
//
// Deliberately NOT restored:
//   cooldownUntil / cooldownWaits — an antibot cooldown belongs to one IP at
//   one moment in time; replaying it after a restore would park fresh joins
//   behind a timer that has often already expired, or one that belongs to a
//   server the bot is no longer on.

const NAME_RE = /^[a-zA-Z0-9_]{1,16}$/;
const HOST_RE = /^[a-zA-Z0-9.-]{1,253}$/;
const VERSION_RE = /^(?:auto|[0-9][0-9a-zA-Z.\-_]{0,20})$/;
const USER_RE = /^[a-zA-Z0-9_]{1,32}$/;
const AFK_MODES = new Set(['off', 'jump', 'walk', 'both']);
const CMD_MAX = 256;        // MC_MAX_LEN in index.js
const MAX_BOTS = 64;        // sanity cap — a person-sized backup
const MAX_FORWARD_IDS = 64; // per subscribed username

// One-line command/text fields: a newline inside a stored command would change
// its meaning when replayed, so such a value is dropped rather than silently
// joined into one line.
function line(v, max) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || /[\r\n]/.test(s)) return null;
  return s.length > max ? s.slice(0, max) : s;
}

function port(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

function positiveInt(v) {
  return Number.isFinite(v) && v > 0 ? Math.round(v) : null;
}

function sanitizeBot(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const name = typeof raw.name === 'string' && NAME_RE.test(raw.name) ? raw.name : null;
  const host = typeof raw.host === 'string' && HOST_RE.test(raw.host) ? raw.host.toLowerCase() : null;
  const p = port(raw.port);
  if (!name || !host || !p) return null;
  const version = typeof raw.version === 'string' && VERSION_RE.test(raw.version) ? raw.version : '1.20.4';
  return {
    name, host, port: p, version,
    ownerUsername: typeof raw.ownerUsername === 'string' && USER_RE.test(raw.ownerUsername) ? raw.ownerUsername : null,
    paused: raw.paused === true,
    loginCmd: line(raw.loginCmd, CMD_MAX),
    loginEnabled: raw.loginEnabled !== false,
    ncLogin: line(raw.ncLogin, CMD_MAX),
    ncSecond: line(raw.ncSecond, CMD_MAX),
    ncThird: line(raw.ncThird, CMD_MAX),
    ncEnabled: raw.ncEnabled === true,
    afkMode: AFK_MODES.has(raw.afkMode) ? raw.afkMode : 'off',
    afkIntervalMs: positiveInt(raw.afkIntervalMs),
    autoChatMsg: line(raw.autoChatMsg, CMD_MAX),
    autoChatEnabled: raw.autoChatEnabled !== false,
    autoChatIntervalMs: positiveInt(raw.autoChatIntervalMs),
    autoEat: raw.autoEat === true,
  };
}

// rawText -> { ok: false, error } | { ok: true, bots, forwards, active, skipped }
function validateBackup(rawText) {
  let data;
  try { data = JSON.parse(String(rawText)); }
  catch (_) { return { ok: false, error: 'That file is not valid JSON.' }; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: 'That file is not a McAfk backup (unexpected JSON shape).' };
  }

  const bots = [];
  let invalid = 0;
  const list = Array.isArray(data.bots) ? data.bots.slice(0, MAX_BOTS) : [];
  for (const raw of list) {
    const b = sanitizeBot(raw);
    if (b) bots.push(b); else invalid++;
  }

  // forwards: { username: [chatId, ...] }
  const forwards = {};
  if (data.forwards && typeof data.forwards === 'object' && !Array.isArray(data.forwards)) {
    for (const [u, ids] of Object.entries(data.forwards)) {
      const key = String(u).replace(/^@/, '').toLowerCase();
      if (!USER_RE.test(key) || !Array.isArray(ids)) continue;
      const good = [];
      for (const id of ids.slice(0, MAX_FORWARD_IDS)) {
        if (typeof id !== 'number' && typeof id !== 'string') continue; // Number(null)/Number('') are 0
        const n = Number(id);
        if (Number.isFinite(n) && n !== 0) good.push(n);
      }
      if (good.length) forwards[key] = good;
    }
  }

  // active: { chatId: botName }
  const active = {};
  if (data.active && typeof data.active === 'object' && !Array.isArray(data.active)) {
    for (const [cid, nm] of Object.entries(data.active)) {
      const id = Number(cid);
      if (Number.isFinite(id) && typeof nm === 'string' && NAME_RE.test(nm)) active[id] = nm;
    }
  }

  if (!bots.length && !Object.keys(forwards).length) {
    return { ok: false, error: 'No bots or forwards found in that file — is it really a McAfk backup?' };
  }

  return { ok: true, bots, forwards, active, skipped: invalid };
}

module.exports = { validateBackup };
