'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const esc = value => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const safeName = value => /^[a-zA-Z0-9_]{1,16}$/.test(String(value || ''));
const json = (res, status, value) => {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
};
const page = (res, body, type = 'text/html; charset=utf-8') => {
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
};
const readBody = req => new Promise((resolve, reject) => {
  let raw = '';
  req.on('data', chunk => { raw += chunk; if (raw.length > 10000) reject(new Error('Request body too large')); });
  req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (_) { reject(new Error('Invalid JSON')); } });
  req.on('error', reject);
});

function snapshot(info, viewerPath) {
  const mc = info.mcBot;
  const p = mc?.entity?.position;
  const inventory = mc?.inventory?.slots?.filter(Boolean).map(item => ({
    name: item.name, displayName: item.displayName, count: item.count, slot: item.slot,
  })) || [];
  return {
    name: info.name, host: info.host, port: info.port, version: info.version,
    status: info.status, error: info.error || null, connectedAt: info.connectedAt || null,
    uptimeMs: info.connectedAt && info.status === 'online' ? Date.now() - info.connectedAt : 0,
    position: p ? { x: Number(p.x.toFixed(2)), y: Number(p.y.toFixed(2)), z: Number(p.z.toFixed(2)) } : null,
    yaw: mc?.entity?.yaw ?? null, pitch: mc?.entity?.pitch ?? null,
    health: mc?.health ?? null, food: mc?.food ?? null, gameMode: mc?.game?.gameMode ?? null,
    dimension: mc?.game?.dimension ?? null, heldItem: mc?.heldItem?.displayName || mc?.heldItem?.name || null,
    afkMode: info.afkMode || 'off', afkIntervalMs: info.afkIntervalMs || null,
    autoEat: info.autoEat === true, autoChat: info.autoChatMsg ? { enabled: info.autoChatEnabled !== false, message: info.autoChatMsg, intervalMs: info.autoChatIntervalMs } : null,
    loginConfigured: !!info.loginCmd, inventory,
    gameUrl: viewerPath ? `${viewerPath}${viewerPath.endsWith('/') ? '' : '/'}` : null,
  };
}

const DASHBOARD = `<!doctype html>
<html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mineflayer Control Center</title><style>
:root{color-scheme:dark;--bg:#0b1020;--panel:#151d31;--line:#283653;--text:#edf2ff;--muted:#9aa8c7;--blue:#5b9cff;--green:#38d39f;--red:#ff6b7a;--yellow:#ffc857}*{box-sizing:border-box}body{margin:0;background:linear-gradient(135deg,#0b1020,#111b32);font:15px system-ui,sans-serif;color:var(--text)}header{padding:22px 5%;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:12px}h1{margin:0;font-size:24px}main{max-width:1500px;margin:auto;padding:24px 5%}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:18px}.card,.panel{background:rgba(21,29,49,.94);border:1px solid var(--line);border-radius:16px;padding:18px;box-shadow:0 12px 35px #05091455}.card h2{margin:0 0 8px}.muted{color:var(--muted)}.online{color:var(--green)}.offline,.error{color:var(--red)}.connecting{color:var(--yellow)}button,input{border:1px solid var(--line);border-radius:9px;padding:10px 12px;background:#0d1528;color:var(--text);font:inherit}button{cursor:pointer;background:#203458}button:hover{filter:brightness(1.25)}button.danger{background:#542633}button.primary{background:#245493}.toolbar,.controls,.form{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}.stats{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:14px}.stat{background:#0d1528;padding:9px;border-radius:9px}.stat small{display:block;color:var(--muted)}pre{white-space:pre-wrap;word-break:break-word;background:#0a1020;padding:12px;border-radius:10px;direction:ltr;text-align:left}.modal{position:fixed;inset:0;background:#0009;display:grid;place-items:center;padding:18px}.modal>div{width:min(1000px,100%);max-height:95vh;overflow:auto}.game{width:100%;height:min(70vh,700px);border:1px solid var(--line);border-radius:12px;background:#050810}.gamebox{position:relative}.gamebox .game{display:block}.gamekeys{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;justify-content:center}.gamekeys button{min-width:52px;touch-action:none}.hidden{display:none}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:currentColor;margin-left:7px}.toast{position:fixed;bottom:20px;left:20px;background:#23375f;padding:12px 16px;border-radius:10px;display:none}</style></head>
<body><header><h1>🤖 Mineflayer Control Center</h1><div><span id="clock" class="muted"></span> <button onclick="logout()">خروج</button></div></header><main>
<section class="panel"><h2>افزودن ربات</h2><div class="form"><input id="name" placeholder="نام بازیکن" maxlength="16"><input id="host" placeholder="آدرس سرور"><input id="port" placeholder="پورت" value="25565" type="number"><input id="version" placeholder="نسخه یا auto" value="auto"><button class="primary" onclick="addBot()">اتصال</button></div></section><br><div id="bots" class="grid"></div>
</main><div id="modal" class="modal hidden"><div class="panel"><button onclick="closeModal()">بستن</button><div id="modalBody"></div></div></div><div id="toast" class="toast"></div>
<script>
const token=localStorage.getItem('mineflayer_token')||prompt('WEB_TOKEN را وارد کنید:');if(token)localStorage.setItem('mineflayer_token',token);
const headers=()=>({'content-type':'application/json','authorization':'Bearer '+(localStorage.getItem('mineflayer_token')||'')});
const el=id=>document.getElementById(id);
async function api(path,method='GET',body){const r=await fetch(path,{method,headers:headers(),body:body===undefined?undefined:JSON.stringify(body)});if(r.status===401){localStorage.removeItem('mineflayer_token');location.reload();throw Error('دسترسی غیرمجاز')}const x=await r.json().catch(()=>({}));if(!r.ok)throw Error(x.error||'خطا');return x}
const esc=s=>String(s??'').replace(/[&<>]/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[x]));
const fmtMs=ms=>{let s=Math.floor(ms/1000),m=Math.floor(s/60),h=Math.floor(m/60);return h?(h+'س '+(m%60)+'د'):m?(m+'د '+(s%60)+'ث'):(s+'ث')};
function toast(s){const x=el('toast');x.textContent=s;x.style.display='block';setTimeout(()=>x.style.display='none',2500)}
async function refresh(){try{const bs=await api('/api/bots');el('bots').innerHTML=bs.map(b=>card(b)).join('');el('clock').textContent=new Date().toLocaleTimeString('fa-IR')}catch(e){toast(e.message)}}
function card(b){const p=b.position?(b.position.x+', '+b.position.y+', '+b.position.z):'-';return '<article class="card"><h2><span class="dot '+b.status+'"></span>'+esc(b.name)+' <small class="'+b.status+'">'+esc(b.status)+'</small></h2><div class="muted">'+esc(b.host)+':'+b.port+' · '+esc(b.version)+'</div><div class="stats"><div class="stat"><small>موقعیت</small>'+p+'</div><div class="stat"><small>سلامت / غذا</small>'+(b.health??'-')+' / '+(b.food??'-')+'</div><div class="stat"><small>جهان</small>'+esc(b.dimension||'-')+'</div><div class="stat"><small>مدت اتصال</small>'+(b.uptimeMs?fmtMs(b.uptimeMs):'-')+'</div></div><p class="muted">'+esc(b.error||'بدون خطا')+'</p><div class="controls" data-name="'+esc(b.name)+'"><button onclick="act(this.parentNode.dataset.name,\"reconnect\")">اتصال مجدد</button><button onclick="act(this.parentNode.dataset.name,\"disconnect\")">قطع</button><button onclick="consoleView(this.parentNode.dataset.name)">کنسول</button><button onclick="controls(this.parentNode.dataset.name)">کنترل</button><button class="primary" onclick="play(this.parentNode.dataset.name)">🎮 بازی سه‌بعدی</button><button onclick="inventory(this.parentNode.dataset.name)">موجودی</button><button onclick="shot(this.parentNode.dataset.name)">📸 تصویر</button><button class="danger" onclick="removeBot(this.parentNode.dataset.name)">حذف</button></div></article>'}
async function addBot(){try{await api('/api/bots','POST',{name:el('name').value,host:el('host').value,port:Number(el('port').value),version:el('version').value||'auto'});toast('ربات در حال اتصال است');refresh()}catch(e){toast(e.message)}}
async function act(n,a,extra={}){try{await api('/api/bots/'+encodeURIComponent(n)+'/action','POST',{action:a,...extra});toast('انجام شد');refresh()}catch(e){toast(e.message)}}
async function removeBot(n){if(confirm('این ربات حذف شود؟'))act(n,'remove')}
function open(title,html){el('modal').classList.remove('hidden');el('modalBody').innerHTML='<h2>'+title+'</h2>'+html}function closeModal(){el('modal').classList.add('hidden')}
function controls(n){const btn=(label,c)=>'<button onpointerdown="hold(\\''+n+'\\',\\''+c+'\\',true,event)" onpointerup="hold(\\''+n+'\\',\\''+c+'\\',false,event)" onpointercancel="hold(\\''+n+'\\',\\''+c+'\\',false,event)">'+label+'</button>';open('کنترل '+esc(n),'<div class="controls">'+btn('جلو','forward')+''+btn('عقب','back')+''+btn('چپ','left')+''+btn('راست','right')+''+btn('پرش','jump')+''+btn('نشست','sneak')+''+btn('دویدن','sprint')+''+btn('استفاده','use')+'<button onclick="act(\\''+n+'\\',\\'attack\\')">⚔️ ضربه</button><button onclick="act(\\''+n+'\\',\\'stopControls\\')">توقف حرکت</button></div><div class="form"><input id="chat" placeholder="پیام یا command"><button onclick="sendChat(\\''+n+'\\')">ارسال</button></div><div class="form"><input id="yaw" placeholder="yaw رادیان"><input id="pitch" placeholder="pitch رادیان"><button onclick="look(\\''+n+'\\')">چرخش دوربین</button></div>');bindKeyboard(n)}
function hold(n,c,state,e){if(e)e.preventDefault();act(n,'control',{control:c,state})}function bindKeyboard(n){const map={w:'forward',s:'back',a:'left',d:'right',' ':'jump',shift:'sneak'};window.onkeydown=e=>{const c=map[e.key.toLowerCase()];if(c&&!e.repeat){e.preventDefault();hold(n,c,true,e)}};window.onkeyup=e=>{const c=map[e.key.toLowerCase()];if(c){e.preventDefault();hold(n,c,false,e)}}}
async function sendChat(n){const v=el('chat').value;if(v)act(n,'chat',{text:v})}async function look(n){act(n,'look',{yaw:Number(el('yaw').value||0),pitch:Number(el('pitch').value||0)})}function play(n){api('/api/bots').then(bs=>{const b=bs.find(x=>x.name===n);if(!b||!b.gameUrl)return toast('ربات باید آنلاین باشد');open('🎮 بازی با '+esc(n),'<div class="gamebox"><iframe class="game" allow="autoplay" src="'+esc(b.gameUrl)+'"></iframe></div><div class="gamekeys"><button onpointerdown="hold(\\''+n+'\\',\\'forward\\',true,event)" onpointerup="hold(\\''+n+'\\',\\'forward\\',false,event)">▲</button><button onpointerdown="hold(\\''+n+'\\',\\'left\\',true,event)" onpointerup="hold(\\''+n+'\\',\\'left\\',false,event)">◀</button><button onclick="act(\\''+n+'\\',\\'stopControls\\')">■</button><button onpointerdown="hold(\\''+n+'\\',\\'right\\',true,event)" onpointerup="hold(\\''+n+'\\',\\'right\\',false,event)">▶</button><button onpointerdown="hold(\\''+n+'\\',\\'back\\',true,event)" onpointerup="hold(\\''+n+'\\',\\'back\\',false,event)">▼</button><button onclick="act(\\''+n+'\\',\\'control\\',{control:\\'jump\\',state:true})">␣ پرش</button><button onclick="act(\\''+n+'\\',\\'attack\\')">⚔️ ضربه</button><button onclick="act(\\''+n+'\\',\\'useItem\\')">🖱 استفاده</button></div>')})}
async function consoleView(n){try{const b=(await api('/api/bots')).find(x=>x.name===n);open('کنسول '+esc(n),'<pre>'+esc(JSON.stringify(b,null,2))+'</pre><p>برای اجرای دستور از بخش کنترل استفاده کنید.</p>')}catch(e){toast(e.message)}}
async function inventory(n){try{const b=await api('/api/bots/'+encodeURIComponent(n)+'/inventory');open('موجودی '+esc(n),'<pre>'+esc(JSON.stringify(b,null,2))+'</pre>')}catch(e){toast(e.message)}}
async function shot(n){try{const r=await fetch('/api/bots/'+encodeURIComponent(n)+'/screenshot',{headers:headers()});if(!r.ok)throw Error('تصویر آماده نیست');const blob=await r.blob();open('تصویر '+esc(n),'<img style="max-width:100%" src="'+URL.createObjectURL(blob)+'">')}catch(e){toast(e.message)}}
setInterval(refresh,3000);refresh();
function logout(){localStorage.removeItem('mineflayer_token');location.reload()}
</script></body></html>`;

function startWeb(options) {
  const token = options.token || crypto.randomBytes(24).toString('hex');
  const port = Number(options.port || 3000);
  const publicDir = path.join(__dirname, 'node_modules', 'prismarine-viewer', 'public');
  const viewerSessions = new Map();
  const viewerKey = name => crypto.createHash('sha256').update(`${token}:${name}`).digest('hex').slice(0, 32);
  const viewerPath = name => `/game/${encodeURIComponent(name)}/${viewerKey(name)}`;
  options.viewerPath = viewerPath;

  // prismarine-viewer already contains the complete browser renderer and its
  // Socket.IO protocol. We attach one isolated Socket.IO endpoint per bot to
  // this same HTTP server instead of opening extra Railway ports.
  function ensureViewer(info, route) {
    const existing = viewerSessions.get(info.name);
    if (existing && existing.mc === info.mcBot) return existing;
    if (existing) closeViewer(info.name);
    let Server, WorldView;
    try {
      Server = require('socket.io').Server;
      ({ WorldView } = require('prismarine-viewer/viewer/lib/worldView'));
    } catch (e) {
      throw new Error(`Web 3D viewer unavailable: ${e.message}`);
    }
    const io = new Server(server, { path: `${route}/socket.io`, serveClient: false });
    const sockets = new Map();
    io.on('connection', socket => {
      if (!info.mcBot || info.status !== 'online') return socket.disconnect(true);
      socket.emit('version', info.mcBot.version);
      const mc = info.mcBot;
      const worldView = new WorldView(mc.world, 6, mc.entity.position, socket);
      const onMove = () => {
        if (info.mcBot !== mc || info.status !== 'online') return;
        socket.emit('position', { pos: mc.entity.position, yaw: mc.entity.yaw, addMesh: true });
        worldView.updatePosition(mc.entity.position);
      };
      sockets.set(socket.id, { socket, worldView, mc, onMove });
      worldView.init(mc.entity.position).catch(() => {});
      worldView.listenToBot(mc);
      mc.on('move', onMove);
      onMove();
      socket.on('disconnect', () => {
        mc.removeListener('move', onMove);
        try { worldView.removeListenersFromBot(mc); } catch (_) {}
        sockets.delete(socket.id);
      });
    });
    const session = { io, sockets, route, mc: info.mcBot };
    viewerSessions.set(info.name, session);
    return session;
  }

  function closeViewer(name) {
    const session = viewerSessions.get(name);
    if (!session) return;
    for (const { socket, worldView, mc, onMove } of session.sockets.values()) {
      try { mc.removeListener('move', onMove); worldView.removeListenersFromBot(mc); } catch (_) {}
      try { socket.disconnect(true); } catch (_) {}
    }
    try { session.io.close(); } catch (_) {}
    viewerSessions.delete(name);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/' && req.method === 'GET') return page(res, DASHBOARD);
    // The viewer page and its bundled assets are only reachable through a
    // per-bot, token-derived path. The browser bundle computes its Socket.IO
    // path from window.location.pathname, so keep the trailing slash intact.
    const gameMatch = /^\/game\/([^/]+)\/([a-f0-9]{32})(\/.*)?$/.exec(url.pathname);
    if (gameMatch && req.method === 'GET') {
      const name = decodeURIComponent(gameMatch[1]);
      const route = `/game/${encodeURIComponent(name)}/${gameMatch[2]}`;
      if (gameMatch[2] !== viewerKey(name)) return page(res, 'Not found', 'text/plain; charset=utf-8');
      const info = options.get(name);
      if (!info) return page(res, 'Bot not found', 'text/plain; charset=utf-8');
      if (!info.mcBot || info.status !== 'online') return page(res, 'Bot is offline', 'text/plain; charset=utf-8');
      try { ensureViewer(info, route); } catch (e) { return page(res, e.message, 'text/plain; charset=utf-8'); }
      const asset = gameMatch[3] || '/';
      if (asset === '/' || asset === '/index.html') {
        const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
        return page(res, html);
      }
      const relative = asset.slice(1);
      if (!relative || relative.includes('..') || path.isAbsolute(relative)) return page(res, 'Not found', 'text/plain; charset=utf-8');
      const file = path.join(publicDir, relative);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return page(res, 'Not found', 'text/plain; charset=utf-8');
      const ext = path.extname(file).toLowerCase();
      const types = { '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.json': 'application/json' };
      return page(res, fs.readFileSync(file), types[ext] || 'application/octet-stream');
    }
    if (url.pathname.startsWith('/api/')) {
      const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const authBuf = Buffer.from(auth);
      const tokenBuf = Buffer.from(token);
      if (!auth || authBuf.length !== tokenBuf.length || !crypto.timingSafeEqual(authBuf, tokenBuf)) return json(res, 401, { error: 'Unauthorized' });
      try { return await routeApi(req, res, url, options); } catch (e) { return json(res, 400, { error: e.message }); }
    }
    res.writeHead(404);res.end('Not found');
  });
  server.listen(port, options.host || '0.0.0.0', () => console.log(`🌐 Web control panel: http://0.0.0.0:${port} (token: ${token})`));
  return { server, token, viewerPath };
}

async function routeApi(req, res, url, o) {
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length === 2 && parts[1] === 'bots' && req.method === 'GET') return json(res, 200, o.list().map(info => snapshot(info, o.viewerPath ? o.viewerPath(info.name) : null)));
  if (parts.length === 2 && parts[1] === 'bots' && req.method === 'POST') {
    const b = await readBody(req); if (!safeName(b.name)) throw Error('نام بازیکن نامعتبر است');
    const port = Number(b.port || 25565); if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('پورت نامعتبر است');
    if (!/^[a-zA-Z0-9.-]{1,253}$/.test(String(b.host || ''))) throw Error('آدرس سرور نامعتبر است');      await o.connect({ name: b.name, host: b.host, port, version: b.version || 'auto' }); return json(res, 201, { ok: true });
  }
  if (parts.length >= 3 && parts[1] === 'bots') {
    const name = decodeURIComponent(parts[2]); const info = o.get(name); if (!info) return json(res, 404, { error: 'Bot not found' });
    if (parts[3] === 'inventory' && req.method === 'GET') return json(res, 200, snapshot(info).inventory);
    if (parts[3] === 'screenshot' && req.method === 'GET') { const buf = await o.screenshot(info); res.writeHead(200, {'content-type':'image/jpeg','cache-control':'no-store'}); return res.end(buf); }
    if (parts[3] === 'action' && req.method === 'POST') { const body = await readBody(req); const result = await o.action(info, body); return json(res, 200, result || { ok: true }); }
  }
  return json(res, 404, { error: 'Not found' });
}

module.exports = { startWeb, snapshot };
