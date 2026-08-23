// Temporary probe harness: stubs grammy + mineflayer, then drives index.js handlers.
const path = require('path');
const fs = require('fs');
const Module = require('module');
const EventEmitter = require('events');

process.env.TELEGRAM_BOT_TOKEN = '123:TEST';

// index.js persists to userdata.json next to itself. Start from a known-empty
// state so bot counts are deterministic, and put the real file back on exit.
const DATA = path.join(__dirname, 'userdata.json');
const SAVED = fs.existsSync(DATA) ? fs.readFileSync(DATA) : null;
fs.writeFileSync(DATA, JSON.stringify({ bots: [], forwards: {} }));
const restoreData = () => {
  try {
    if (SAVED === null) fs.unlinkSync(DATA);
    else fs.writeFileSync(DATA, SAVED);
  } catch (_) {}
};
process.on('exit', restoreData);

const handlers = { commands: {}, on: {} };
const sent = [];
const photos = [];
const mcBots = [];

class InlineKeyboard {
  constructor() { this.inline_keyboard = [[]]; }
  text(label, data) { this.inline_keyboard[this.inline_keyboard.length - 1].push({ text: label, callback_data: data }); return this; }
  row() { this.inline_keyboard.push([]); return this; }
}
class Bot {
  constructor() {
    this.api = {
      sendMessage: async (chatId, text) => { sent.push({ chatId, text }); return { message_id: sent.length }; },
      sendPhoto: async (chatId, file, o) => { photos.push({ chatId, file, caption: o?.caption }); return { message_id: sent.length }; },
      editMessageText: async () => ({}),
      setMyCommands: async () => true,
    };
  }
  command(name, fn) { handlers.commands[name] = fn; }
  on(ev, fn) { handlers.on[ev] = fn; }
  catch(fn) { this.errHandler = fn; }
  start() { return new Promise(() => {}); }
  stop() { return Promise.resolve(); }
}
class InputFile {
  constructor(data, name) { this.data = data; this.name = name; }
}

function stub(name, exports) {
  const resolved = require.resolve(name, { paths: [__dirname] });
  const m = new Module(resolved);
  m.exports = exports;
  m.loaded = true;
  require.cache[resolved] = m;
}

stub('grammy', { Bot, InlineKeyboard, InputFile });
stub('mineflayer', {
  createBot(opts) {
    if (opts.version === '1.99.9') throw new Error(`Server version '${opts.version}' is not supported`);
    const b = new EventEmitter();
    b.opts = opts;
    b.controls = [];
    b.chatted = [];
    b.packsAccepted = 0;
    b._client = new EventEmitter();
    b.acceptResourcePack = () => { b.packsAccepted++; };
    b.denyResourcePack = () => {};
    b.quit = () => { b.emit('end', 'quit'); };
    b.chat = t => b.chatted.push(t);
    b.setControlState = (c, v) => b.controls.push([Date.now(), c, v]);
    b.look = async () => {};
    b.entity = { yaw: 0, pitch: 0 };
    mcBots.push(b);
    return b;
  },
});

require(path.join(__dirname, 'index.js'));

const ctx = (over = {}) => ({
  chat: { id: 100 },
  from: { id: 7, username: 'tester' },
  message: { text: '/start', message_id: 1 },
  msg: { text: '/start' },
  reply: async (text, o) => { sent.push({ reply: text, o }); return { message_id: sent.length }; },
  answerCallbackQuery: async () => true,
  editMessageText: async () => true,
  ...over,
});

const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const results = [];
  const t = (label, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' :: ' + extra : ''}`);

  // 1. add a bot through the normal flow
  await handlers.on['callback_query:data'](ctx({ callbackQuery: { data: 'add_bot' } }));
  await handlers.on['message:text'](ctx({ message: { text: 'Steve mc.test.io 25565 1.20.4', message_id: 2 } }));
  t('bot created', mcBots.length === 1, mcBots.length ? JSON.stringify(mcBots[0].opts) : 'none');

  const mc = mcBots[0];
  mc.emit('spawn');
  await wait(20);

  // 2. anti-AFK 'both' second hop
  await handlers.commands['afk'](ctx({ message: { text: '/afk both 5s', message_id: 3 } }));
  mc.controls.length = 0;
  await handlers.on['callback_query:data'](ctx({ callbackQuery: { data: 'afknow:Steve' } }));
  await wait(1100);
  const jumps = mc.controls.filter(c => c[1] === 'jump');
  const hops = jumps.filter((c, i) => c[2] === true && (i === 0 || jumps[i - 1][2] === false)).length;
  t('both-mode produces 2 distinct hops', hops === 2, JSON.stringify(jumps.map(j => j.slice(1))) + ` distinctHops=${hops}`);

  // 3. channel post shape (no ctx.from, no ctx.message)
  try {
    await handlers.commands['forward'](ctx({ from: undefined, message: undefined, msg: { text: '/forward @x' } }));
    t('forward survives channel post (no ctx.from)', true);
  } catch (e) {
    t('forward survives channel post (no ctx.from)', false, e.constructor.name + ': ' + e.message);
  }
  try {
    await handlers.commands['bots'](ctx({ message: undefined, msg: { text: '/bots' } }));
    t('bots survives channel post', true);
  } catch (e) {
    t('bots survives channel post', false, e.constructor.name + ': ' + e.message);
  }

  // 4. invalid version must not crash the process
  await handlers.on['callback_query:data'](ctx({ callbackQuery: { data: 'add_bot' } }));
  try {
    await handlers.on['message:text'](ctx({ message: { text: 'Ghost mc.test.io 25565 1.99.9', message_id: 4 } }));
    t('unsupported version handled', true);
  } catch (e) {
    t('unsupported version handled', false, e.message);
  }

  // 5. login command without a leading slash is accepted and broadcast as public chat
  await handlers.commands['setlogin'](ctx({ message: { text: '/setlogin Steve login hunter2', message_id: 5 } }));
  mc.chatted.length = 0;
  await handlers.on['callback_query:data'](ctx({ callbackQuery: { data: 'loginnow:Steve' } }));
  await wait(50);
  t('non-slash login rejected', mc.chatted.length === 0, 'chatted=' + JSON.stringify(mc.chatted));

  // 6. mask leaks earlier tokens
  const shown = sent.map(s => s.reply || s.text).filter(Boolean).join('\n');
  t('password never shown in clear', !/hunter2/.test(shown), /hunter2/.test(shown) ? 'found "hunter2" in a Telegram reply' : '');

  // --- antibot ---

  // 7. resource pack requests are answered (an unanswered one is a kick on some servers)
  mc.emit('resourcePack', 'http://x/pack.zip', 'hash');
  t('resource pack auto-accepted', mc.packsAccepted === 1, 'accepted=' + mc.packsAccepted);

  // 8. a chat instruction with a readable command is replayed automatically
  //    (sends are spaced by SEND_GAP_MS, so allow the queue a full cycle)
  await wait(600);
  mc.chatted.length = 0;
  sent.length = 0;
  mc.emit('message', '[AntiBot] Please type /verify 4821 to prove you are human');
  await wait(700);
  t('chat challenge answered', mc.chatted.includes('/verify 4821'), 'chatted=' + JSON.stringify(mc.chatted));

  // 9. the same instruction repeated must not be sent twice
  mc.chatted.length = 0;
  mc.emit('message', '[AntiBot] Please type /verify 4821 to prove you are human');
  await wait(700);
  t('duplicate challenge not resent', mc.chatted.length === 0, 'chatted=' + JSON.stringify(mc.chatted));

  // 10. an instruction on the title / action bar is relayed too
  sent.length = 0;
  mc.emit('title', 'AntiBot: solve the captcha in your hand', 'subtitle');
  mc.emit('actionBar', 'Verification pending — read the map');
  await wait(50);
  const relayed = sent.map(s => s.text || '').join('\n');
  t('title relayed', /solve the captcha/.test(relayed), relayed.slice(0, 200));
  t('action bar relayed', /Verification pending/.test(relayed), relayed.slice(0, 200));

  // 11. a map captcha is stitched and sent as a photo
  photos.length = 0;
  for (let x = 0; x < 128; x++) {
    const col = Buffer.alloc(128, 0);
    for (let y = 40; y < 90; y++) col[y] = 34;
    mc._client.emit('map', { itemDamage: 3, columns: 1, rows: 128, x, y: 0, data: col });
  }
  await wait(900);
  t('map captcha delivered as image', photos.length === 1 && photos[0].file?.data?.length > 100,
    'photos=' + photos.length + (photos[0] ? ' bytes=' + photos[0].file.data.length : ''));

  // 11b. a wall of maps (one picture split over many item frames) must arrive as
  //      ONE full-size image, not one message per map id
  photos.length = 0;
  for (let id = 10; id < 33; id++) {
    for (let x = 0; x < 128; x++) {
      const col = Buffer.alloc(128, 0);
      for (let y = 30; y < 100; y++) col[y] = 34 + (id % 3);
      mc._client.emit('map', { itemDamage: id, columns: 1, rows: 128, x, y: 0, data: col });
    }
  }
  await wait(1200);
  t('23 maps collapse into one image', photos.length === 1,
    'photos=' + photos.length + (photos[0] ? ' caption=' + JSON.stringify(photos[0].caption?.slice(0, 60)) : ''));

  // 12. ordinary chat is never mistaken for a challenge
  mc.chatted.length = 0;
  mc.emit('message', 'Steve: hey does anyone have iron');
  mc.emit('message', 'Use /home to teleport back');
  await wait(80);
  t('normal chat not treated as a challenge', mc.chatted.length === 0, 'chatted=' + JSON.stringify(mc.chatted));

  // 13. the client fingerprint is filled in
  const o = mc.opts;
  t('client fingerprint set',
    o.brand === 'vanilla' && o.locale === 'en_US' && o.mainHand === 'right' && !!o.skinParts && o.checkTimeoutInterval === 60000,
    JSON.stringify({ brand: o.brand, locale: o.locale, mainHand: o.mainHand, keepalive: o.checkTimeoutInterval }));

  // 14. "auto" version is passed to mineflayer as false (ping-based detection)
  const before = mcBots.length;
  await handlers.on['callback_query:data'](ctx({ callbackQuery: { data: 'add_bot' } }));
  await handlers.on['message:text'](ctx({ message: { text: 'Auton mc.test.io 25565 auto', message_id: 9 } }));
  const auton = mcBots[before];
  t('auto version → version:false', !!auton && auton.opts.version === false,
    auton ? 'version=' + JSON.stringify(auton.opts.version) : 'bot not created');

  // 15. a GUI opened during the verification window is listed for the user
  sent.length = 0;
  mc.emit('windowOpen', {
    id: 5, title: 'Click the diamond',
    slots: [{ count: 1, name: 'diamond' }, null, { count: 3, name: 'stone' }],
  });
  await wait(50);
  const guiMsg = sent.map(s => s.text || '').join('\n');
  t('GUI captcha listed', /Click the diamond/.test(guiMsg) && /0: 1× diamond/.test(guiMsg), guiMsg.slice(0, 220));

  // 16. /click sends the click to the open window
  let clicked = null;
  mc.currentWindow = { id: 5 };
  mc.clickWindow = async (slot, b, mode) => { clicked = [slot, b, mode]; };
  await handlers.commands['click'](ctx({ message: { text: '/click Steve 0', message_id: 10 } }));
  await wait(30);
  t('/click forwards the slot', JSON.stringify(clicked) === '[0,0,0]', 'clicked=' + JSON.stringify(clicked));

  // 17. anti-AFK holds still while a challenge is pending, and resumes after
  await handlers.commands['afk'](ctx({ message: { text: '/afk both 5s', message_id: 11 } }));
  mc.emit('message', '[AntiBot] please type /verify 777 to continue');
  await wait(60);
  mc.controls.length = 0;
  await handlers.on['callback_query:data'](ctx({ callbackQuery: { data: 'afknow:Steve' } }));
  await wait(60);
  t('anti-AFK suppressed during challenge', mc.controls.length === 0, 'controls=' + JSON.stringify(mc.controls.map(c => c.slice(1))));

  // 18. a cooldown kick ("denied, wait a few minutes") must NOT trigger a fast
  //     retry — that restarts the server's own timer and can never succeed.
  const { isCooldownKick, parseCooldownMs } = require(path.join(__dirname, 'antibot.js'));
  t('cooldown kick recognised',
    isCooldownKick('You are currently denied from entering the server. Please wait a few minutes to be able to join the server again.'),
    '');
  t('challenge kick not treated as cooldown',
    !isCooldownKick('AntiBot: please type /verify 4821 to prove you are human'),
    '');
  t('stated duration parsed',
    parseCooldownMs('try again in 30 seconds') === 30000 &&
    parseCooldownMs('please wait 2 minutes') === 120000 &&
    parseCooldownMs('wait a few minutes to be able to join') === 300000 &&
    parseCooldownMs('you were kicked') === null,
    JSON.stringify([parseCooldownMs('try again in 30 seconds'), parseCooldownMs('please wait 2 minutes'),
      parseCooldownMs('wait a few minutes to be able to join'), parseCooldownMs('you were kicked')]));

  // 19. end-to-end: the kick reports a cooldown and schedules a long wait
  const before19 = mcBots.length;
  await handlers.on['callback_query:data'](ctx({ callbackQuery: { data: 'add_bot' } }));
  await handlers.on['message:text'](ctx({ message: { text: 'Cool mc.test.io 25565 1.20.4', message_id: 20 } }));
  const cool = mcBots[before19];
  sent.length = 0;
  cool.emit('kicked', 'Antibot\n\nYou are currently denied from entering the server.\nPlease wait a few minutes to be able to join the server again.');
  await wait(80);
  const kickMsg = sent.map(s => s.text || '').join('\n');
  t('cooldown kick reported as rate limit',
    /rate limit, not a captcha/i.test(kickMsg) && !/reconnecting in \d+s/.test(kickMsg),
    kickMsg.slice(0, 300));
  t('no fast retry scheduled during cooldown', mcBots.length === before19 + 1,
    'bots created=' + (mcBots.length - before19));

  console.log('\n' + results.join('\n') + '\n');
  process.exit(0);
})();
