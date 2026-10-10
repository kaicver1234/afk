'use strict';

// Helpers for getting past a server's antibot/verification stage.
//
// Two things live here: join cooldowns — a server that refuses the join with
// "denied... wait a few minutes" instead of showing a challenge — are
// recognised and timed, so reconnect attempts don't restart the server's own
// timer; and a client fingerprint that leaves no mineflayer defaults where an
// antibot expects the values a real client always sends.

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

module.exports = {
  isCooldownKick,
  parseCooldownMs,
  COOLDOWN_RE,
  DEFAULT_FINGERPRINT,
};
