require('dotenv').config();
const express = require('express');
const { botEvents, botRegistry, HOST, MC_PORT, scanInventoryAndChests, fetchServerInfo, botMaps } = require('./utils');

// ─── Bot lifecycle controllers (set after launch) ────────────────────────────
const controllers = {};

const app      = express();
const PORT_WEB = process.env.PORT || 3000;
app.use(express.json());

// ─── State ────────────────────────────────────────────────────────────────────
const MAX_LOGS = 300;
const logBuffer = [];

const BOT1 = process.env.BOT1_NAME || 'AfkBot';
const BOT2 = process.env.BOT2_NAME || 'KillBot';

const botStatus = {
  [BOT1]: { online: false, type: 'AFK Bot',  running: false },
  [BOT2]: { online: false, type: 'Kill Bot', running: false },
};
const stats = {
  [BOT1]: { ghastKills: 0, foodAte: 0, inventory: {}, chests: {} },
  [BOT2]: { ghastKills: 0, foodAte: 0, inventory: {}, chests: {} },
};
const coords = {
  [BOT1]: null,
  [BOT2]: null,
};

let serverInfo = null;

// ─── Event listeners ──────────────────────────────────────────────────────────
botEvents.on('log', (entry) => {
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOGS) logBuffer.shift();
  broadcast('log', entry);
});
botEvents.on('status', ({ username, online }) => {
  if (botStatus[username]) botStatus[username].online = online;
  broadcast('status', { username, online });
});
botEvents.on('ghastKill', ({ username, total }) => {
  if (stats[username]) stats[username].ghastKills = total;
  broadcast('stats', { username, stats: stats[username] });
});
botEvents.on('ate', ({ username }) => {
  if (stats[username]) stats[username].foodAte++;
  broadcast('stats', { username, stats: stats[username] });
});
botEvents.on('inventory', ({ username, counts }) => {
  if (stats[username]) stats[username].inventory = counts;
  broadcast('stats', { username, stats: stats[username] });
});
botEvents.on('chestScan', ({ username, chests, count }) => {
  if (stats[username]) stats[username].chests = chests;
  broadcast('chestScan', { username, chests, count });
  broadcast('stats', { username, stats: stats[username] });
});
botEvents.on('mapUpdate', ({ username, png, ts }) => {
  broadcast('mapUpdate', { username, png, ts });
});

botEvents.on('coords', ({ username, coords: c, ts }) => {
  coords[username] = { ...c, ts };
  broadcast('coords', { username, coords: coords[username] });
});

// ─── SSE ──────────────────────────────────────────────────────────────────────
const sseClients = new Set();
function broadcast(event, data) {
  sseClients.forEach(res => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
}

app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write(`event: init\ndata: ${JSON.stringify({ logs: logBuffer, status: botStatus, stats, coords, serverInfo, maps: botMaps })}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ─── API: Start/Stop ──────────────────────────────────────────────────────────
app.post('/bot/:name/start', (req, res) => {
  const name = req.params.name;
  if (!botStatus[name]) return res.json({ ok: false, reason: 'unknown bot' });
  if (botStatus[name].running) return res.json({ ok: false, reason: 'already running' });
  if (!controllers[name]) return res.json({ ok: false, reason: 'controller not ready' });
  botStatus[name].running = true;
  controllers[name].start();
  broadcast('control', { username: name, action: 'started' });
  res.json({ ok: true });
});

app.post('/bot/:name/stop', (req, res) => {
  const name = req.params.name;
  if (!botStatus[name]) return res.json({ ok: false, reason: 'unknown bot' });
  botStatus[name].running = false;
  botStatus[name].online  = false;
  if (controllers[name]) controllers[name].stop();
  broadcast('control', { username: name, action: 'stopped' });
  broadcast('status',  { username: name, online: false });
  res.json({ ok: true });
});

// ─── API: Send command to bot ─────────────────────────────────────────────────
app.post('/bot/:name/cmd', (req, res) => {
  const name = req.params.name;
  const { cmd } = req.body;
  if (!cmd) return res.json({ ok: false, reason: 'no command' });
  const bot = botRegistry[name];
  if (!bot) return res.json({ ok: false, reason: 'bot not connected' });
  try {
    bot.chat(cmd);
    const { emit } = require('./utils');
    emit(name, 'chat', `[CMD] ${cmd}`);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, reason: e.message });
  }
});

// ─── API: Force coords refresh ────────────────────────────────────────────────
app.post('/bot/:name/coords', (req, res) => {
  const name = req.params.name;
  const bot = botRegistry[name];
  if (!bot || !bot.entity) return res.json({ ok: false, reason: 'bot not connected' });
  try {
    const pos = bot.entity.position;
    const c = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z), ts: Date.now() };
    coords[name] = c;
    broadcast('coords', { username: name, coords: c });
    res.json({ ok: true, coords: c });
  } catch (e) {
    res.json({ ok: false, reason: e.message });
  }
});

// ─── API: Force chest scan ────────────────────────────────────────────────────
app.post('/bot/:name/chestscan', (req, res) => {
  const name = req.params.name;
  const bot = botRegistry[name];
  if (!bot) return res.json({ ok: false, reason: 'bot not connected' });
  const { emit } = require('./utils');
  emit(name, 'info', 'Manual chest scan triggered...');
  scanInventoryAndChests(bot, name).catch(() => {});
  res.json({ ok: true });
});

// ─── API: Get latest map for bot ─────────────────────────────────────────────
app.get('/bot/:name/map', (req, res) => {
  const name = req.params.name;
  const map = botMaps[name];
  if (!map) return res.json({ ok: false, reason: 'no map data yet — hold a map item in the bot\'s hand' });
  res.json({ ok: true, ...map });
});

// ─── API: Server info ─────────────────────────────────────────────────────────
app.get('/serverinfo', async (req, res) => {
  try {
    serverInfo = await fetchServerInfo();
    if (serverInfo) broadcast('serverInfo', serverInfo);
    res.json(serverInfo || { error: 'ping failed or timed out' });
  } catch(_) {
    res.json({ error: 'ping error' });
  }
});

// ─── Dashboard HTML ───────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.redirect('/dash');
});


// ─── Simple polling endpoint (alternative to SSE) ────────────────────────────
const eventQueue = [];
let eventId = 0;

// Mirror all broadcasts to event queue too
const _origBroadcast = broadcast;
// Already captured above — just push to queue on every broadcast
botEvents.on('log', (entry) => {
  eventQueue.push({ id: ++eventId, event: 'log', data: entry });
  if (eventQueue.length > 500) eventQueue.shift();
});

app.get('/poll', (req, res) => {
  const since = parseInt(req.query.since) || 0;
  const events = eventQueue.filter(e => e.id > since);
  res.json({
    lastId: eventId,
    events,
    state: {
      status: botStatus,
      stats,
      coords,
      serverInfo,
      bots: { [BOT1]: 'AFK Bot', [BOT2]: 'Kill Bot' },
      serverStart: Date.now() - process.uptime() * 1000,
    }
  });
});

// ─── Minimal /dash — polling based, no SSE ────────────────────────────────────
app.get('/dash', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MC Bot Console</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap');
:root {
  --bg:#080a0e; --panel:#0d1117; --panel2:#111827;
  --border:#1f2937; --border2:#374151;
  --text:#e2e8f0; --dim:#6b7280; --dim2:#9ca3af;
  --green:#22c55e; --green-bg:#052e16; --green-border:#166534;
  --red:#ef4444; --red-bg:#2d0a0a; --red-border:#7f1d1d;
  --yellow:#fbbf24; --cyan:#38bdf8; --cyan-bg:#0c1a2e;
  --purple:#a78bfa; --orange:#fb923c; --teal:#2dd4bf;
  --blue:#60a5fa;
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:'JetBrains Mono',monospace;font-size:13px;min-height:100vh;display:flex;flex-direction:column}

/* Header */
.header{background:var(--panel);border-bottom:1px solid var(--border);padding:10px 20px;display:flex;align-items:center;gap:12px;position:sticky;top:0;z-index:50}
.logo{font-size:16px;font-weight:700;color:var(--cyan);letter-spacing:3px}
.logo b{color:var(--green)}
.uptime{font-size:11px;color:var(--dim)}
#uptime{color:var(--cyan)}
.conn-wrap{margin-left:auto;display:flex;align-items:center;gap:8px}
.conn-dot{width:8px;height:8px;border-radius:50%;background:var(--yellow);animation:pulse 1.5s infinite}
.conn-dot.live{background:var(--green);box-shadow:0 0 8px var(--green);animation:none}
.conn-dot.dead{background:var(--red);animation:none}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.conn-text{font-size:11px;color:var(--dim2)}
.reconnect-btn{background:none;border:1px solid var(--border2);color:var(--dim2);font-family:inherit;font-size:11px;padding:3px 10px;border-radius:4px;cursor:pointer}
.reconnect-btn:hover{border-color:var(--cyan);color:var(--cyan)}

/* Server bar */
.server-bar{background:var(--panel2);border-bottom:1px solid var(--border);padding:8px 20px;display:flex;align-items:center;gap:12px}
.srv-favicon{width:36px;height:36px;border-radius:4px;background:var(--panel);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0;image-rendering:pixelated;overflow:hidden}
.srv-favicon img{width:100%;height:100%;image-rendering:pixelated}
.srv-info{flex:1;min-width:0}
.srv-motd{font-size:12px;color:var(--cyan);margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.srv-meta{display:flex;gap:16px;font-size:10px;color:var(--dim)}
.srv-meta span b{color:var(--dim2)}
.srv-meta .online-count{color:var(--green);font-weight:700}
.ping-btn{background:none;border:1px solid var(--border2);color:var(--dim);font-family:inherit;font-size:10px;padding:3px 8px;border-radius:3px;cursor:pointer;flex-shrink:0}
.ping-btn:hover{border-color:var(--cyan);color:var(--cyan)}

/* Main layout */
.main{flex:1;display:flex;flex-direction:column;padding:16px 20px;gap:16px;overflow:hidden}

/* Bot cards */
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}
.bot-card{background:var(--panel2);border:1px solid var(--border);border-radius:8px;padding:14px;transition:border-color .3s,box-shadow .3s}
.bot-card.online{border-color:var(--green-border);box-shadow:0 0 20px rgba(34,197,94,.08)}
.bot-card.offline{border-color:var(--red-border)}
.bot-card-top{display:flex;align-items:center;gap:10px;margin-bottom:12px}
.bot-avatar{width:36px;height:36px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0}
.bot-card.online .bot-avatar{background:var(--green-bg)}
.bot-card.offline .bot-avatar{background:var(--red-bg)}
.bot-name{font-weight:700;font-size:14px}
.bot-type{font-size:10px;color:var(--dim);margin-top:1px}
.bot-status{margin-left:auto;font-size:10px;font-weight:700;letter-spacing:1px;padding:2px 8px;border-radius:12px}
.bot-card.online .bot-status{color:var(--green);background:var(--green-bg);border:1px solid var(--green-border)}
.bot-card.offline .bot-status{color:var(--red);background:var(--red-bg);border:1px solid var(--red-border)}
.bot-stats{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:10px}
.stat-box{background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:6px 8px;text-align:center}
.stat-label{font-size:9px;color:var(--dim);letter-spacing:.5px;margin-bottom:2px}
.stat-val{font-size:14px;font-weight:700;color:var(--cyan)}
.bot-coords{background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:6px 10px;margin-bottom:10px;display:flex;align-items:center;gap:6px;font-size:10px}
.coords-label{color:var(--dim)}
.coords-xyz{color:var(--teal);font-weight:700;flex:1}
.coords-ts{color:var(--dim);font-size:9px}
.refresh-btn{background:none;border:none;color:var(--dim);cursor:pointer;font-size:12px;padding:0;line-height:1}
.refresh-btn:hover{color:var(--teal)}
.bot-loot{background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:6px 10px;margin-bottom:10px;display:flex;align-items:center;gap:10px;font-size:10px;flex-wrap:wrap}
.loot-item{display:flex;align-items:center;gap:4px}
.loot-icon{font-size:12px}
.loot-name{color:var(--dim)}
.loot-count{color:var(--orange);font-weight:700}
.scan-btn{margin-left:auto;background:none;border:1px solid var(--border2);color:var(--dim);font-family:inherit;font-size:9px;padding:2px 7px;border-radius:3px;cursor:pointer}
.scan-btn:hover{border-color:var(--orange);color:var(--orange)}
.bot-actions{display:flex;gap:6px}
.act-btn{flex:1;border:none;border-radius:4px;padding:5px 0;font-family:inherit;font-size:11px;font-weight:700;cursor:pointer;transition:opacity .15s}
.act-btn:disabled{opacity:.25;cursor:not-allowed}
.btn-start{background:var(--green-bg);color:var(--green);border:1px solid var(--green-border)}
.btn-start:hover:not(:disabled){background:#0d3320}
.btn-stop{background:var(--red-bg);color:var(--red);border:1px solid var(--red-border)}
.btn-stop:hover:not(:disabled){background:#3d0f0f}
.btn-cmd{background:var(--cyan-bg);color:var(--cyan);border:1px solid #1e4a7a;flex:0.6}
.btn-cmd:hover{background:#0f2340}
.btn-map{background:#1a0a2e;color:var(--purple);border:1px solid #4c1d95;flex:0.6}
.btn-map:hover{background:#220d3a}

/* Console section */
.console-section{flex:1;display:grid;grid-template-columns:1fr 1fr;gap:12px;min-height:0;height:340px}
.console-card{background:var(--panel2);border:1px solid var(--border);border-radius:8px;display:flex;flex-direction:column;overflow:hidden}
.console-head{padding:8px 12px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:6px;flex-shrink:0}
.console-name{color:var(--cyan);font-weight:700;font-size:12px;flex:1}
.console-count{color:var(--yellow);font-size:10px;margin-right:4px}
.filter-btn{background:none;border:1px solid var(--border);color:var(--dim);font-family:inherit;font-size:9px;padding:1px 6px;border-radius:3px;cursor:pointer}
.filter-btn.active{border-color:var(--cyan);color:var(--cyan);background:rgba(56,189,248,.08)}
.clr-btn{background:none;border:none;color:var(--dim);font-family:inherit;font-size:10px;cursor:pointer;margin-left:auto}
.clr-btn:hover{color:var(--red)}
.log-area{flex:1;overflow-y:auto;padding:4px 10px}
.log-area::-webkit-scrollbar{width:3px}
.log-area::-webkit-scrollbar-thumb{background:var(--border2);border-radius:2px}
.log-entry{display:flex;gap:5px;padding:1px 0;border-bottom:1px solid rgba(31,41,55,.5);line-height:1.7;font-size:11px}
.log-ts{color:var(--dim);flex-shrink:0;width:65px;font-size:10px}
.log-tag{font-size:9px;font-weight:700;letter-spacing:.5px;flex-shrink:0;width:46px;text-align:right;padding-right:4px}
.log-msg{flex:1;word-break:break-word}
.t-info .log-tag{color:var(--blue)} .t-info .log-msg{color:#cbd5e1}
.t-error .log-tag,.t-error .log-msg{color:var(--red)}
.t-kick .log-tag,.t-kick .log-msg{color:var(--orange)}
.t-disconnect .log-tag,.t-disconnect .log-msg{color:var(--orange);opacity:.8}
.t-reconnect .log-tag,.t-reconnect .log-msg{color:var(--yellow)}
.t-kill .log-tag,.t-kill .log-msg{color:var(--purple)}
.t-food .log-tag,.t-food .log-msg{color:#86efac}
.t-chat .log-tag,.t-chat .log-msg{color:var(--cyan)}
.t-inv .log-tag,.t-inv .log-msg{color:var(--teal)}
.t-error{background:rgba(239,68,68,.04)}
.t-kick{background:rgba(251,146,60,.04)}
.t-kill{background:rgba(167,139,250,.04)}
.cmd-bar{display:flex;border-top:1px solid var(--border);flex-shrink:0}
.cmd-field{flex:1;background:#060810;border:none;color:var(--text);font-family:inherit;font-size:11px;padding:7px 10px;outline:none}
.cmd-field::placeholder{color:var(--dim)}
.cmd-go{background:var(--green-bg);border:none;border-left:1px solid var(--border);color:var(--green);font-family:inherit;font-size:11px;padding:7px 12px;cursor:pointer}
.cmd-go:hover{background:#0d3320}

/* Modal */
.overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:100;align-items:center;justify-content:center}
.overlay.show{display:flex}
.modal{background:var(--panel2);border:1px solid var(--border2);border-radius:10px;display:flex;flex-direction:column;overflow:hidden}
.modal-header{padding:12px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center}
.modal-title{font-weight:700;color:var(--cyan);flex:1}
.modal-x{background:none;border:none;color:var(--dim);cursor:pointer;font-size:18px;line-height:1}
.modal-x:hover{color:var(--red)}
#cmd-overlay .modal{width:660px;max-width:95vw;height:70vh}
.modal-log{flex:1;overflow-y:auto;padding:8px 14px}
.modal-log::-webkit-scrollbar{width:3px}
.modal-log::-webkit-scrollbar-thumb{background:var(--border2)}
.modal-cmd{display:flex;border-top:1px solid var(--border)}
.modal-field{flex:1;background:#060810;border:none;color:var(--text);font-family:inherit;font-size:12px;padding:10px 14px;outline:none}
.modal-send{background:var(--green-bg);border:none;border-left:1px solid var(--border);color:var(--green);font-family:inherit;padding:10px 16px;cursor:pointer;font-size:12px}
#map-overlay .modal{width:380px;max-width:95vw}
.map-body{padding:16px;display:flex;flex-direction:column;align-items:center;gap:10px}
#map-img{width:256px;height:256px;background:var(--bg);border:2px solid var(--border);border-radius:4px;display:flex;align-items:center;justify-content:center;color:var(--dim);font-size:11px;text-align:center;image-rendering:pixelated}
#map-img img{width:100%;height:100%;image-rendering:pixelated}
.map-hint{font-size:10px;color:var(--dim);text-align:center}
.map-input-row{display:flex;gap:6px;width:100%}
#map-answer{flex:1;background:var(--bg);border:1px solid var(--border2);color:var(--text);font-family:inherit;font-size:14px;padding:8px 10px;border-radius:4px;outline:none;text-align:center;letter-spacing:3px}
#map-answer:focus{border-color:var(--yellow)}
#map-submit{background:#2d1f00;border:1px solid var(--yellow);color:var(--yellow);font-family:inherit;font-size:12px;font-weight:700;padding:8px 16px;border-radius:4px;cursor:pointer}
.map-refresh{background:none;border:1px solid var(--border);color:var(--dim);font-family:inherit;font-size:10px;padding:4px 12px;border-radius:3px;cursor:pointer;width:100%}
.map-refresh:hover{border-color:var(--cyan);color:var(--cyan)}
.map-status{font-size:11px;min-height:16px}
.map-status.ok{color:var(--green)}.map-status.err{color:var(--red)}
</style>
</head>
<body>

<div class="header">
  <div class="logo">MC<b>Bot</b></div>
  <div class="uptime">UP <span id="uptime">00:00:00</span></div>
  <div class="conn-wrap">
    <button class="reconnect-btn" onclick="startPoll()">Reconnect</button>
    <div class="conn-dot" id="conn-dot"></div>
    <span class="conn-text" id="conn-text">Connecting...</span>
  </div>
</div>

<div class="server-bar">
  <div class="srv-favicon" id="srv-fav">🌐</div>
  <div class="srv-info">
    <div class="srv-motd" id="srv-motd">Pinging server...</div>
    <div class="srv-meta">
      <span>IP <b>${HOST}:${MC_PORT}</b></span>
      <span class="online-count" id="srv-players">--/--</span>
      <span id="srv-ver">--</span>
    </div>
  </div>
  <button class="ping-btn" onclick="pingServer()">Ping</button>
</div>

<div class="main">
  <div class="cards" id="cards"></div>
  <div class="console-section" id="consoles"></div>
</div>

<!-- CMD Modal -->
<div class="overlay" id="cmd-overlay" onclick="if(event.target===this)closeOverlay('cmd-overlay')">
  <div class="modal">
    <div class="modal-header">
      <span class="modal-title" id="cmd-title"></span>
      <button class="modal-x" onclick="closeOverlay('cmd-overlay')">✕</button>
    </div>
    <div class="modal-log" id="cmd-log"></div>
    <div class="modal-cmd">
      <input class="modal-field" id="cmd-field" placeholder="Type command..." onkeydown="if(event.key==='Enter')sendModalCmd()">
      <button class="modal-send" onclick="sendModalCmd()">SEND</button>
    </div>
  </div>
</div>

<!-- Map Modal -->
<div class="overlay" id="map-overlay" onclick="if(event.target===this)closeOverlay('map-overlay')">
  <div class="modal">
    <div class="modal-header">
      <span class="modal-title" id="map-title">Map Captcha</span>
      <button class="modal-x" onclick="closeOverlay('map-overlay')">✕</button>
    </div>
    <div class="map-body">
      <div id="map-img">No map data.<br>Bot must hold a map item.</div>
      <div class="map-hint">Read the captcha from the map and type it below.</div>
      <div class="map-input-row">
        <input id="map-answer" placeholder="Answer..." onkeydown="if(event.key==='Enter')submitMap()">
        <button id="map-submit" onclick="submitMap()">SEND</button>
      </div>
      <button class="map-refresh" onclick="fetchMap()">Refresh Map</button>
      <div class="map-status" id="map-status"></div>
    </div>
  </div>
</div>

<script>
const logs = {}, status = {}, stats = {}, coords = {};
let lastId = 0, init = false, startTime = Date.now();
let activeCmd = null, activeMap = null, pollTimer = null;
const filters = {}, autoScroll = {};
const TAGS = {info:'INFO',error:'ERR',kick:'KICK',disconnect:'DISC',reconnect:'RCON',kill:'KILL',food:'FOOD',chat:'CHAT',inv:'INV'};

function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmt(ts){ return new Date(ts).toTimeString().slice(0,8); }
function ago(ts){ if(!ts)return''; const s=Math.floor((Date.now()-ts)/1000); return s<60?s+'s':s<3600?Math.floor(s/60)+'m':Math.floor(s/3600)+'h'; }

setInterval(()=>{
  const s=Math.floor((Date.now()-startTime)/1000);
  document.getElementById('uptime').textContent=[Math.floor(s/3600),Math.floor((s%3600)/60),s%60].map(n=>String(n).padStart(2,'0')).join(':');
},1000);

function renderCard(name){
  let el=document.getElementById('bc-'+name);
  if(!el){ el=document.createElement('div'); el.id='bc-'+name; document.getElementById('cards').appendChild(el); }
  const s=status[name]||{}, st=stats[name]||{}, cr=coords[name];
  const inv=st.inventory||{}, ch=st.chests||{};
  const tear=(inv.ghast_tear||0)+(ch.ghast_tear||0);
  const powder=(inv.gunpowder||0)+(ch.gunpowder||0);
  el.className='bot-card '+(s.online?'online':'offline');
  el.innerHTML=
    '<div class="bot-card-top">'+
      '<div class="bot-avatar">'+(s.online?'🟢':'🔴')+'</div>'+
      '<div><div class="bot-name">'+esc(name)+'</div><div class="bot-type">'+esc(s.type||'Bot')+'</div></div>'+
      '<div class="bot-status">'+(s.online?'ONLINE':'OFFLINE')+'</div>'+
    '</div>'+
    '<div class="bot-stats">'+
      '<div class="stat-box"><div class="stat-label">KILLS</div><div class="stat-val">'+(st.ghastKills||0)+'</div></div>'+
      '<div class="stat-box"><div class="stat-label">FOOD</div><div class="stat-val">'+(st.foodAte||0)+'</div></div>'+
      '<div class="stat-box"><div class="stat-label">STATUS</div><div class="stat-val" style="font-size:10px;color:'+(s.online?'var(--green)':'var(--red)')+'"> '+(s.online?'UP':'DOWN')+'</div></div>'+
    '</div>'+
    '<div class="bot-coords">'+
      '<span class="coords-label">📍</span>'+
      '<span class="coords-xyz">'+(cr?'X:'+cr.x+' Y:'+cr.y+' Z:'+cr.z:'unknown')+'</span>'+
      (cr?'<span class="coords-ts">'+ago(cr.ts)+'</span>':'')+
      '<button class="refresh-btn" data-action="coords" data-bot="'+esc(name)+'">↻</button>'+
    '</div>'+
    '<div class="bot-loot">'+
      '<div class="loot-item"><span class="loot-icon">💀</span><span class="loot-name">Tear</span><span class="loot-count">'+tear+'</span></div>'+
      '<div class="loot-item"><span class="loot-icon">💥</span><span class="loot-name">Powder</span><span class="loot-count">'+powder+'</span></div>'+
      '<button class="scan-btn" data-action="chestscan" data-bot="'+esc(name)+'">SCAN</button>'+
    '</div>'+
    '<div class="bot-actions">'+
      '<button class="act-btn btn-start" data-action="start" data-bot="'+esc(name)+'" '+(s.running?'disabled':'')+'>▶ START</button>'+
      '<button class="act-btn btn-stop" data-action="stop" data-bot="'+esc(name)+'" '+(!s.running?'disabled':'')+'>■ STOP</button>'+
      '<button class="act-btn btn-cmd" data-action="opencmd" data-bot="'+esc(name)+'">⌨</button>'+
      '<button class="act-btn btn-map" data-action="openmap" data-bot="'+esc(name)+'">🗺</button>'+
    '</div>';
}

function initConsoles(bots){
  const el=document.getElementById('consoles'); el.innerHTML='';
  for(const name of bots){
    logs[name]=[]; filters[name]='all'; autoScroll[name]=true;
    const pane=document.createElement('div'); pane.className='console-card'; pane.id='cc-'+name;
    pane.innerHTML=
      '<div class="console-head">'+
        '<span class="console-name">'+esc(name)+'</span>'+
        '<span class="console-count" id="cnt-'+name+'">0</span>'+
        '<button class="filter-btn active" data-pane="'+name+'" data-filter="all">ALL</button>'+
        '<button class="filter-btn" data-pane="'+name+'" data-filter="error">ERR</button>'+
        '<button class="filter-btn" data-pane="'+name+'" data-filter="kill">KILL</button>'+
        '<button class="filter-btn" data-pane="'+name+'" data-filter="chat">CHAT</button>'+
        '<button class="filter-btn" data-pane="'+name+'" data-filter="inv">INV</button>'+
        '<button class="clr-btn" data-action="clear" data-pane="'+name+'">CLR</button>'+
      '</div>'+
      '<div class="log-area" id="la-'+name+'"></div>'+
      '<div class="cmd-bar">'+
        '<input class="cmd-field" id="cf-'+name+'" data-bot="'+name+'" placeholder="/cmd for '+esc(name)+'...">'+
        '<button class="cmd-go" data-action="sendcmd" data-bot="'+name+'">▶</button>'+
      '</div>';
    el.appendChild(pane);
    document.getElementById('la-'+name).addEventListener('scroll',function(){
      autoScroll[name]=this.scrollTop+this.clientHeight>=this.scrollHeight-20;
    });
  }
}

function makeEntry(e){
  const t=e.type||'info';
  const d=document.createElement('div');
  d.className='log-entry t-'+t; d.dataset.type=t;
  d.innerHTML='<span class="log-ts">'+fmt(e.ts)+'</span><span class="log-tag">'+(TAGS[t]||t.toUpperCase().slice(0,5))+'</span><span class="log-msg">'+esc(e.message)+'</span>';
  return d;
}

function pushLog(e){
  const b=e.username; if(!logs[b])return;
  logs[b].push(e);
  const f=filters[b]||'all';
  if(f==='all'||f===e.type){
    const la=document.getElementById('la-'+b);
    if(la){ la.appendChild(makeEntry(e)); if(autoScroll[b])la.scrollTop=la.scrollHeight; }
    if(activeCmd===b){ const cl=document.getElementById('cmd-log'); if(cl){ cl.appendChild(makeEntry(e)); cl.scrollTop=cl.scrollHeight; } }
  }
  const c=document.getElementById('cnt-'+b); if(c)c.textContent=logs[b].length;
}

function rebuildLog(bot){
  const la=document.getElementById('la-'+bot); if(!la)return;
  la.innerHTML='';
  const f=filters[bot]||'all';
  (f==='all'?logs[bot]:logs[bot].filter(x=>x.type===f)).forEach(e=>la.appendChild(makeEntry(e)));
  la.scrollTop=la.scrollHeight;
}

// Delegated events
document.addEventListener('click',async function(e){
  const el=e.target.closest('[data-action]'); if(!el)return;
  const a=el.dataset.action, b=el.dataset.bot, p=el.dataset.pane;
  if(a==='start'||a==='stop'){
    const d=await fetch('/bot/'+encodeURIComponent(b)+'/'+a,{method:'POST'}).then(r=>r.json());
    if(!d.ok)alert(d.reason||'error');
  } else if(a==='coords'){ fetch('/bot/'+encodeURIComponent(b)+'/coords',{method:'POST'}); }
  else if(a==='chestscan'){ fetch('/bot/'+encodeURIComponent(b)+'/chestscan',{method:'POST'}); }
  else if(a==='opencmd'){ openCmd(b); }
  else if(a==='openmap'){ openMap(b); }
  else if(a==='sendcmd'){ doSendCmd(b); }
  else if(a==='clear'){ logs[p]=[]; rebuildLog(p); }
  else if(el.classList.contains('filter-btn')&&el.dataset.pane){
    document.querySelectorAll('#cc-'+p+' .filter-btn').forEach(x=>x.classList.remove('active'));
    el.classList.add('active'); filters[p]=el.dataset.filter; rebuildLog(p);
  }
});
document.addEventListener('keydown',function(e){
  if(e.key!=='Enter')return;
  const el=e.target.closest('.cmd-field[data-bot]'); if(el)doSendCmd(el.dataset.bot);
});

async function doSendCmd(name){
  const inp=document.getElementById('cf-'+name); if(!inp||!inp.value.trim())return;
  const cmd=inp.value.trim(); inp.value='';
  const d=await fetch('/bot/'+encodeURIComponent(name)+'/cmd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cmd})}).then(r=>r.json());
  if(!d.ok)pushLog({username:name,type:'error',message:'CMD failed: '+(d.reason||'?'),ts:Date.now()});
}

function openCmd(name){
  activeCmd=name;
  document.getElementById('cmd-title').textContent='⌨ '+name;
  const cl=document.getElementById('cmd-log'); cl.innerHTML='';
  (logs[name]||[]).forEach(e=>cl.appendChild(makeEntry(e))); cl.scrollTop=cl.scrollHeight;
  document.getElementById('cmd-overlay').classList.add('show');
  setTimeout(()=>document.getElementById('cmd-field').focus(),50);
}
async function sendModalCmd(){
  if(!activeCmd)return;
  const inp=document.getElementById('cmd-field'); if(!inp.value.trim())return;
  const cmd=inp.value.trim(); inp.value='';
  await fetch('/bot/'+encodeURIComponent(activeCmd)+'/cmd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cmd})});
}

function openMap(name){
  activeMap=name;
  document.getElementById('map-title').textContent='🗺 Captcha — '+name;
  document.getElementById('map-answer').value='';
  document.getElementById('map-status').textContent='';
  document.getElementById('map-overlay').classList.add('show');
  fetchMap();
}
async function fetchMap(){
  if(!activeMap)return;
  const box=document.getElementById('map-img'); box.textContent='Loading...';
  try{
    const d=await fetch('/bot/'+encodeURIComponent(activeMap)+'/map').then(r=>r.json());
    if(!d.ok){ box.textContent=d.reason||'No map data. Bot must hold a map item.'; return; }
    box.innerHTML=''; const img=document.createElement('img'); img.src=d.png;
    img.style.cssText='width:100%;height:100%;image-rendering:pixelated'; box.appendChild(img);
    document.getElementById('map-answer').focus();
  }catch(_){ box.textContent='Error fetching map.'; }
}
async function submitMap(){
  const ans=document.getElementById('map-answer').value.trim();
  const st=document.getElementById('map-status'); if(!ans||!activeMap)return;
  const d=await fetch('/bot/'+encodeURIComponent(activeMap)+'/cmd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cmd:ans})}).then(r=>r.json());
  if(d.ok){ st.textContent='✓ Sent!'; st.className='map-status ok'; document.getElementById('map-answer').value=''; setTimeout(()=>closeOverlay('map-overlay'),1500); }
  else{ st.textContent='✗ '+(d.reason||'failed'); st.className='map-status err'; }
}

function closeOverlay(id){ document.getElementById(id).classList.remove('show'); if(id==='cmd-overlay')activeCmd=null; if(id==='map-overlay')activeMap=null; }

async function pingServer(){
  document.getElementById('srv-motd').textContent='Pinging...';
  try{
    const d=await fetch('/serverinfo').then(r=>r.json());
    if(d&&d.motd!==undefined){
      document.getElementById('srv-motd').textContent=d.motd.replace(/§[0-9a-fk-or]/gi,'')||'Unknown';
      document.getElementById('srv-players').textContent=(d.onlinePlayers||0)+'/'+(d.maxPlayers||0)+' online';
      document.getElementById('srv-ver').textContent=d.version||'';
      const fav=document.getElementById('srv-fav');
      if(d.favicon&&d.favicon.startsWith('data:image')){ fav.innerHTML='<img src="'+d.favicon+'">'; }
    }
  }catch(_){ document.getElementById('srv-motd').textContent='Ping failed'; }
}

async function poll(){
  const dot=document.getElementById('conn-dot'), txt=document.getElementById('conn-text');
  try{
    const d=await fetch('/poll?since='+lastId).then(r=>r.json());
    lastId=d.lastId;
    dot.className='conn-dot live'; txt.textContent='LIVE';
    if(!init){
      init=true;
      const {status:s,stats:st,coords:cr,bots:b} = d.state;
      const names=Object.keys(s);
      initConsoles(names);
      for(const n of names){
        status[n]=s[n]; stats[n]=st[n]||{}; coords[n]=cr[n]||null;
        if(b)status[n].type=b[n]; renderCard(n);
      }
    }
    for(const ev of d.events){
      if(ev.event==='log') pushLog(ev.data);
      else if(ev.event==='status'){ if(status[ev.data.username])status[ev.data.username].online=ev.data.online; renderCard(ev.data.username); }
      else if(ev.event==='stats'){ stats[ev.data.username]=ev.data.stats; renderCard(ev.data.username); }
      else if(ev.event==='coords'){ coords[ev.data.username]=ev.data.coords; renderCard(ev.data.username); }
      else if(ev.event==='chestScan'){ if(stats[ev.data.username])stats[ev.data.username].chests=ev.data.chests; renderCard(ev.data.username); }
      else if(ev.event==='control'){ if(status[ev.data.username])status[ev.data.username].running=(ev.data.action==='started'); renderCard(ev.data.username); }
    }
  }catch(_){
    dot.className='conn-dot dead'; txt.textContent='Disconnected';
    init=false; lastId=0;
  }
  pollTimer=setTimeout(poll,2000);
}

function startPoll(){ if(pollTimer)clearTimeout(pollTimer); init=false; lastId=0; poll(); }

startPoll();
pingServer();
setInterval(pingServer,5*60*1000);
</script>
</body>
</html>`);
});


// ─── Start server FIRST, then bots ────────────────────────────────────────────
app.listen(PORT_WEB, '0.0.0.0', () => {
  console.log('[Dashboard] http://0.0.0.0:' + PORT_WEB);

  // SSE keepalive ping
  setInterval(() => {
    sseClients.forEach(res => res.write(': ping\n\n'));
  }, 15000);

  // Fetch server info in background — don't block startup
  setTimeout(() => {
    fetchServerInfo().then(info => {
      serverInfo = info;
      if (info) {
        broadcast('serverInfo', info);
        console.log('[Server] ' + info.motd + ' | ' + info.onlinePlayers + '/' + info.maxPlayers);
      } else {
        console.log('[Server] ping failed or timed out');
      }
    }).catch(() => {});
  }, 3000);

  // Start bots after port is registered — store controllers for start/stop
  setTimeout(() => {
    botStatus[BOT1].running = true;
    console.log('[Launcher] Starting AFK bot...');
    controllers[BOT1] = require('./afk-bot');
  }, 2000);

  setTimeout(() => {
    botStatus[BOT2].running = true;
    console.log('[Launcher] Starting Kill bot...');
    controllers[BOT2] = require('./kill-bot');
  }, 22000);
});
