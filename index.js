require('dotenv').config();
const express = require('express');

// ─── Persistent server uptime (survives client refresh) ───────────────────────
const SERVER_START = Date.now();

const app = express();
const PORT_WEB = process.env.PORT || 3000;
app.use(express.json());

// ─── Utils + events ───────────────────────────────────────────────────────────
const utils = require('./utils');
const { botEvents, botRegistry, botMaps, fetchServerInfo, scanInventoryAndChests, emit } = utils;

// ─── State ────────────────────────────────────────────────────────────────────
const MAX_LOGS = 300;
const logBuffer = [];

// Default bots: BOT1 = Kill, BOT2 = AFK (user's intent)
const BOT1 = process.env.BOT1_NAME || 'KillBot';
const BOT2 = process.env.BOT2_NAME || 'AfkBot';

const botConfigs = {};
const botStatus  = {};
const stats      = {};
const coords     = {};
const controllers = {};
let serverInfo = null;

function initBotState(name, type) {
  botConfigs[name] = { name, type, proxy: null };
  botStatus[name]  = { online: false, type: type === 'kill' ? 'Kill Bot' : 'AFK Bot', running: false };
  stats[name]      = { ghastKills: 0, foodAte: 0, inventory: {}, chests: {} };
  coords[name]     = null;
}

initBotState(BOT1, 'kill');
initBotState(BOT2, 'afk');

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
botEvents.on('chestScan', ({ username, chests }) => {
  if (stats[username]) stats[username].chests = chests;
  broadcast('stats', { username, stats: stats[username] });
});
botEvents.on('mapUpdate', ({ username, png, ts }) => { broadcast('mapUpdate', { username, png, ts }); });
botEvents.on('coords', ({ username, coords: c }) => {
  coords[username] = { ...c, ts: Date.now() };
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
  res.write(`event: init\ndata: ${JSON.stringify({ logs: logBuffer, status: botStatus, stats, coords, serverInfo, maps: botMaps, serverStart: SERVER_START, botConfigs, host: utils.HOST, port: utils.MC_PORT })}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ─── Bot launcher ─────────────────────────────────────────────────────────────
function launchBot(name) {
  const cfg = botConfigs[name];
  if (!cfg) return;
  const opts = { proxy: cfg.proxy };
  let ctrl;
  if (cfg.type === 'kill') ctrl = require('./kill-bot').launch(name, opts);
  else ctrl = require('./afk-bot').launch(name, opts);
  controllers[name] = ctrl;
  return ctrl;
}

// ─── API: Start / Stop ────────────────────────────────────────────────────────
app.post('/bot/:name/start', (req, res) => {
  const name = req.params.name;
  if (!botStatus[name]) return res.json({ ok: false, reason: 'unknown bot' });
  if (botStatus[name].running) return res.json({ ok: false, reason: 'already running' });
  botStatus[name].running = true;
  launchBot(name);
  broadcast('control', { username: name, action: 'started', running: true });
  res.json({ ok: true });
});

app.post('/bot/:name/stop', (req, res) => {
  const name = req.params.name;
  if (!botStatus[name]) return res.json({ ok: false, reason: 'unknown bot' });
  botStatus[name].running = false;
  botStatus[name].online  = false;
  if (controllers[name]) { try { controllers[name].stop(); } catch(_){} delete controllers[name]; }
  broadcast('control', { username: name, action: 'stopped', running: false });
  broadcast('status',  { username: name, online: false });
  res.json({ ok: true });
});

// ─── API: Add Bot ─────────────────────────────────────────────────────────────
app.post('/bot/add', (req, res) => {
  const { name, type } = req.body;
  if (!name || !name.trim()) return res.json({ ok: false, reason: 'name required' });
  const n = name.trim();
  if (botStatus[n]) return res.json({ ok: false, reason: 'bot already exists' });
  const t = type === 'kill' ? 'kill' : 'afk';
  initBotState(n, t);
  botStatus[n].running = true;
  launchBot(n);
  broadcast('botAdded', { name: n, status: botStatus[n], config: botConfigs[n] });
  res.json({ ok: true });
});

// ─── API: Remove Bot ──────────────────────────────────────────────────────────
app.post('/bot/:name/remove', (req, res) => {
  const name = req.params.name;
  if (!botStatus[name]) return res.json({ ok: false, reason: 'unknown bot' });
  if (controllers[name]) { try { controllers[name].stop(); } catch(_){} delete controllers[name]; }
  delete botStatus[name]; delete stats[name]; delete coords[name]; delete botConfigs[name];
  broadcast('botRemoved', { name });
  res.json({ ok: true });
});

// ─── API: Rename Bot ──────────────────────────────────────────────────────────
app.post('/bot/:name/rename', (req, res) => {
  const oldName = req.params.name;
  const { newName } = req.body;
  if (!newName || !newName.trim()) return res.json({ ok: false, reason: 'name required' });
  const nn = newName.trim();
  if (!botStatus[oldName]) return res.json({ ok: false, reason: 'unknown bot' });
  if (botStatus[nn]) return res.json({ ok: false, reason: 'name already taken' });
  if (controllers[oldName]) { try { controllers[oldName].stop(); } catch(_){} delete controllers[oldName]; }
  botStatus[nn] = { ...botStatus[oldName], running: false, online: false };
  stats[nn] = { ...stats[oldName] };
  coords[nn] = coords[oldName];
  botConfigs[nn] = { ...botConfigs[oldName], name: nn };
  delete botStatus[oldName]; delete stats[oldName]; delete coords[oldName]; delete botConfigs[oldName];
  botStatus[nn].running = true;
  launchBot(nn);
  broadcast('botRenamed', { oldName, newName: nn, status: botStatus[nn], config: botConfigs[nn] });
  res.json({ ok: true });
});

// ─── API: Set Proxy ───────────────────────────────────────────────────────────
app.post('/bot/:name/proxy', (req, res) => {
  const name = req.params.name;
  if (!botConfigs[name]) return res.json({ ok: false, reason: 'unknown bot' });
  const { host, port, type, username, password } = req.body;
  botConfigs[name].proxy = host ? { host, port: parseInt(port)||1080, type: parseInt(type)||5, username, password } : null;
  broadcast('proxyUpdated', { name, proxy: botConfigs[name].proxy });
  res.json({ ok: true, proxy: botConfigs[name].proxy });
});

// ─── API: Server Config ───────────────────────────────────────────────────────
app.get('/config/server', (req, res) => res.json({ host: utils.HOST, port: utils.MC_PORT }));
app.post('/config/server', (req, res) => {
  const { host, port } = req.body;
  utils.setServer(host || utils.HOST, port ? parseInt(port) : utils.MC_PORT);
  broadcast('serverConfig', { host: utils.HOST, port: utils.MC_PORT });
  res.json({ ok: true, host: utils.HOST, port: utils.MC_PORT });
});

// ─── API: Send command ────────────────────────────────────────────────────────
app.post('/bot/:name/cmd', (req, res) => {
  const { name } = req.params, { cmd } = req.body;
  if (!cmd) return res.json({ ok: false, reason: 'no command' });
  const bot = botRegistry[name];
  if (!bot) return res.json({ ok: false, reason: 'bot not connected' });
  try { bot.chat(cmd); emit(name, 'chat', `[CMD] ${cmd}`); res.json({ ok: true }); }
  catch (e) { res.json({ ok: false, reason: e.message }); }
});

app.post('/bot/:name/coords', (req, res) => {
  const name = req.params.name, bot = botRegistry[name];
  if (!bot || !bot.entity) return res.json({ ok: false, reason: 'bot not connected' });
  try {
    const pos = bot.entity.position;
    const c = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z), ts: Date.now() };
    coords[name] = c; broadcast('coords', { username: name, coords: c }); res.json({ ok: true, coords: c });
  } catch (e) { res.json({ ok: false, reason: e.message }); }
});

app.post('/bot/:name/chestscan', (req, res) => {
  const name = req.params.name, bot = botRegistry[name];
  if (!bot) return res.json({ ok: false, reason: 'bot not connected' });
  emit(name, 'info', 'Manual chest scan triggered...');
  scanInventoryAndChests(bot, name).catch(() => {});
  res.json({ ok: true });
});

app.get('/bot/:name/map', (req, res) => {
  const map = botMaps[req.params.name];
  if (!map) return res.json({ ok: false, reason: 'no map data — bot must hold a map item' });
  res.json({ ok: true, ...map });
});

app.get('/serverinfo', async (req, res) => {
  try { serverInfo = await fetchServerInfo(); if (serverInfo) broadcast('serverInfo', serverInfo); res.json(serverInfo || { error: 'ping failed' }); }
  catch(_) { res.json({ error: 'ping error' }); }
});

// ─── Polling ──────────────────────────────────────────────────────────────────
const eventQueue = []; let eventId = 0;
botEvents.on('log', (entry) => { eventQueue.push({ id: ++eventId, event: 'log', data: entry }); if (eventQueue.length > 500) eventQueue.shift(); });

app.get('/poll', (req, res) => {
  const since = parseInt(req.query.since) || 0;
  res.json({ lastId: eventId, events: eventQueue.filter(e => e.id > since), state: { status: botStatus, stats, coords, serverInfo, serverStart: SERVER_START, host: utils.HOST, port: utils.MC_PORT, botConfigs } });
});

// ─── Dashboard ────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.redirect('/dash'));
app.get('/dash', (req, res) => res.send(HTML()));

function HTML() { return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NEXUS Bot Control</title>
<style>
  /* Self-hosted font fallbacks — no external CDN needed */
  :root {
    --font-display: 'Rajdhani', 'Segoe UI', 'Ubuntu', Arial, sans-serif;
    --font-mono: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', 'Courier New', monospace;
  }
</style>
<style>
:root{
  --bg:#050210;--bg1:#0a0520;--bg2:#0f0730;
  --panel:rgba(15,7,42,0.92);--panel2:rgba(22,10,55,0.85);--glass:rgba(139,92,246,0.07);
  --border:rgba(112,70,220,0.28);--border2:rgba(160,100,255,0.55);
  --text:#e8deff;--dim:#7a6699;--dim2:#b09dd4;
  --v:#8b5cf6;--v2:#a78bfa;--v3:#c4b5fd;--vneon:#7c3aed;
  --green:#34d399;--green-bg:rgba(6,40,28,0.85);--green-bd:rgba(52,211,153,0.35);
  --red:#f87171;--red-bg:rgba(45,8,8,0.85);--red-bd:rgba(248,113,113,0.35);
  --yellow:#fbbf24;--cyan:#38bdf8;--orange:#fb923c;--teal:#2dd4bf;--pink:#f472b6;
  --glow:0 0 20px rgba(139,92,246,0.35);--glow2:0 0 40px rgba(139,92,246,0.55);
  --r:10px;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{background:var(--bg);color:var(--text);font-family:var(--font-mono);font-size:13px;min-height:100vh;display:flex;flex-direction:column;overflow-x:hidden;position:relative}

/* ── BG effects ── */
#bg-canvas{position:fixed;inset:0;z-index:0;pointer-events:none;opacity:.55}
.grid-overlay{position:fixed;inset:0;z-index:0;pointer-events:none;background-image:linear-gradient(rgba(139,92,246,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(139,92,246,.04) 1px,transparent 1px);background-size:44px 44px}
.blob{position:fixed;border-radius:50%;filter:blur(90px);pointer-events:none;z-index:0;animation:blobMove 22s ease-in-out infinite}
.blob1{width:600px;height:600px;background:radial-gradient(circle,rgba(112,40,220,.25),transparent 70%);top:-200px;left:-200px;animation-delay:0s}
.blob2{width:500px;height:500px;background:radial-gradient(circle,rgba(60,20,160,.2),transparent 70%);bottom:-150px;right:-150px;animation-delay:-7s}
.blob3{width:400px;height:400px;background:radial-gradient(circle,rgba(180,60,255,.15),transparent 70%);top:40%;left:40%;animation-delay:-14s}
@keyframes blobMove{0%,100%{transform:translate(0,0) scale(1)}33%{transform:translate(30px,-40px) scale(1.05)}66%{transform:translate(-20px,25px) scale(.95)}}

/* ── Layout ── */
.content{position:relative;z-index:1;display:flex;flex-direction:column;min-height:100vh}

/* ── Header ── */
.hdr{background:rgba(10,5,30,0.95);border-bottom:1px solid var(--border);padding:10px 22px;display:flex;align-items:center;gap:14px;position:sticky;top:0;z-index:50;backdrop-filter:blur(20px)}
.logo{font-family:var(--font-display);font-size:22px;font-weight:700;letter-spacing:4px;background:linear-gradient(135deg,var(--v3),var(--v),var(--vneon));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;filter:drop-shadow(0 0 12px rgba(139,92,246,.6))}
.logo span{-webkit-text-fill-color:rgba(255,255,255,.5)}
.uptime-pill{background:var(--glass);border:1px solid var(--border);border-radius:20px;padding:3px 12px;font-size:11px;color:var(--dim2);display:flex;align-items:center;gap:6px}
.uptime-pill .dot{width:6px;height:6px;border-radius:50%;background:var(--v);box-shadow:0 0 8px var(--v);animation:uptimePulse 2s ease-in-out infinite}
@keyframes uptimePulse{0%,100%{opacity:1;box-shadow:0 0 8px var(--v)}50%{opacity:.5;box-shadow:0 0 4px var(--v)}}
#uptime{color:var(--v2);font-weight:600}
.hdr-right{margin-left:auto;display:flex;align-items:center;gap:8px}
.conn-pill{display:flex;align-items:center;gap:6px;background:var(--glass);border:1px solid var(--border);border-radius:20px;padding:3px 12px;font-size:11px}
.conn-dot{width:7px;height:7px;border-radius:50%;background:var(--yellow);transition:all .4s}
.conn-dot.live{background:var(--green);box-shadow:0 0 10px var(--green)}
.conn-dot.dead{background:var(--red)}
.icon-btn{background:var(--glass);border:1px solid var(--border);color:var(--dim2);border-radius:8px;padding:6px 10px;cursor:pointer;font-size:14px;transition:all .2s;font-family:inherit}
.icon-btn:hover{border-color:var(--v);color:var(--v2);box-shadow:var(--glow)}

/* ── Server bar ── */
.srv-bar{background:rgba(12,6,32,0.9);border-bottom:1px solid var(--border);padding:8px 22px;display:flex;align-items:center;gap:12px;backdrop-filter:blur(10px)}
.srv-favicon{width:34px;height:34px;border-radius:6px;background:var(--glass);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:16px;overflow:hidden;flex-shrink:0;image-rendering:pixelated}
.srv-favicon img{width:100%;height:100%;image-rendering:pixelated}
.srv-motd{font-size:12px;color:var(--v2);margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:var(--font-display);font-weight:600;letter-spacing:.5px}
.srv-meta{display:flex;gap:14px;font-size:10px;color:var(--dim)}
.srv-meta b{color:var(--dim2)}
.srv-online{color:var(--green);font-weight:700}
.srv-addr{color:var(--v3);cursor:pointer;text-decoration:underline dotted}
.srv-addr:hover{color:var(--v2)}
.ping-btn{background:var(--glass);border:1px solid var(--border);color:var(--dim);font-family:inherit;font-size:10px;padding:3px 10px;border-radius:6px;cursor:pointer;transition:all .2s;flex-shrink:0}
.ping-btn:hover{border-color:var(--v);color:var(--v2)}

/* ── Main ── */
.main{flex:1;padding:16px 20px;display:flex;flex-direction:column;gap:16px}

/* ── Cards area ── */
.cards-wrap{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-start}
.bot-card{background:var(--panel);border:1px solid var(--border);border-radius:var(--r);padding:16px;width:280px;flex-shrink:0;transition:border-color .35s,box-shadow .35s;position:relative;overflow:hidden;animation:cardIn .4s ease both}
@keyframes cardIn{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
.bot-card::before{content:'';position:absolute;inset:0;background:linear-gradient(135deg,rgba(139,92,246,.06),transparent 60%);pointer-events:none;border-radius:var(--r)}
.bot-card.online{border-color:rgba(52,211,153,.45);box-shadow:0 0 24px rgba(52,211,153,.1),inset 0 0 30px rgba(52,211,153,.04)}
.bot-card.offline{border-color:rgba(248,113,113,.3);box-shadow:0 0 16px rgba(248,113,113,.06)}

/* Card top */
.card-top{display:flex;align-items:flex-start;gap:10px;margin-bottom:12px}
.bot-skin{width:44px;height:44px;border-radius:8px;border:2px solid var(--border);overflow:hidden;flex-shrink:0;background:var(--glass);image-rendering:pixelated;position:relative}
.bot-skin img{width:100%;height:100%;image-rendering:pixelated}
.bot-skin-placeholder{width:44px;height:44px;display:flex;align-items:center;justify-content:center;font-size:22px}
.card-info{flex:1;min-width:0}
.bot-name-row{display:flex;align-items:center;gap:5px}
.bot-name{font-family:var(--font-display);font-weight:700;font-size:16px;letter-spacing:.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px}
.rename-btn{background:none;border:none;color:var(--dim);cursor:pointer;font-size:11px;padding:2px 4px;border-radius:4px;transition:color .2s;line-height:1;flex-shrink:0}
.rename-btn:hover{color:var(--v2)}
.bot-type-badge{display:inline-flex;align-items:center;gap:4px;font-size:9px;font-family:var(--font-display);font-weight:600;letter-spacing:1.5px;padding:2px 8px;border-radius:10px;margin-top:3px}
.type-kill{background:rgba(248,113,113,.12);color:var(--red);border:1px solid rgba(248,113,113,.3)}
.type-afk{background:rgba(96,165,250,.12);color:var(--cyan);border:1px solid rgba(96,165,250,.3)}
.status-badge{margin-left:auto;font-size:9px;font-family:var(--font-display);font-weight:700;letter-spacing:2px;padding:3px 10px;border-radius:12px;flex-shrink:0}
.status-badge.online{color:var(--green);background:var(--green-bg);border:1px solid var(--green-bd);animation:statusGlow 2s ease-in-out infinite}
.status-badge.offline{color:var(--red);background:var(--red-bg);border:1px solid var(--red-bd)}
@keyframes statusGlow{0%,100%{box-shadow:0 0 6px rgba(52,211,153,.4)}50%{box-shadow:0 0 14px rgba(52,211,153,.7)}}

/* Stats grid */
.stats-row{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:10px}
.stat-box{background:rgba(0,0,0,.3);border:1px solid var(--border);border-radius:7px;padding:6px 8px;text-align:center;transition:border-color .2s}
.stat-box:hover{border-color:var(--v)}
.stat-label{font-size:8px;color:var(--dim);letter-spacing:1px;font-family:var(--font-display);font-weight:600;margin-bottom:2px}
.stat-val{font-size:15px;font-weight:700;color:var(--v2)}

/* Coords */
.coords-row{background:rgba(0,0,0,.25);border:1px solid var(--border);border-radius:7px;padding:6px 10px;margin-bottom:8px;display:flex;align-items:center;gap:6px;font-size:10px}
.coords-ico{font-size:11px}
.coords-xyz{color:var(--teal);font-weight:600;flex:1;font-size:10px}
.coords-ts{color:var(--dim);font-size:9px}
.coords-refresh{background:none;border:none;color:var(--dim);cursor:pointer;font-size:13px;padding:0;transition:color .2s;line-height:1}
.coords-refresh:hover{color:var(--teal)}

/* Loot */
.loot-row{background:rgba(0,0,0,.25);border:1px solid var(--border);border-radius:7px;padding:6px 10px;margin-bottom:10px;display:flex;align-items:center;gap:10px;font-size:10px;flex-wrap:wrap}
.loot-item{display:flex;align-items:center;gap:4px}
.loot-ico{font-size:12px}
.loot-name{color:var(--dim)}
.loot-count{color:var(--orange);font-weight:700}
.scan-btn{margin-left:auto;background:none;border:1px solid var(--border);color:var(--dim);font-family:inherit;font-size:9px;padding:2px 8px;border-radius:5px;cursor:pointer;transition:all .2s;flex-shrink:0}
.scan-btn:hover{border-color:var(--orange);color:var(--orange)}

/* Proxy indicator */
.proxy-row{display:flex;align-items:center;gap:6px;margin-bottom:8px;font-size:10px}
.proxy-badge{display:flex;align-items:center;gap:4px;padding:2px 8px;border-radius:5px;font-size:9px;font-family:var(--font-display);font-weight:600;letter-spacing:.5px}
.proxy-badge.active{background:rgba(251,191,36,.1);color:var(--yellow);border:1px solid rgba(251,191,36,.3)}
.proxy-badge.inactive{background:var(--glass);color:var(--dim);border:1px solid var(--border)}
.proxy-set-btn{margin-left:auto;background:none;border:1px solid var(--border);color:var(--dim);font-family:inherit;font-size:9px;padding:2px 8px;border-radius:5px;cursor:pointer;transition:all .2s}
.proxy-set-btn:hover{border-color:var(--yellow);color:var(--yellow)}

/* Action buttons */
.actions{display:flex;gap:5px;flex-wrap:wrap}
.act-btn{flex:1;min-width:0;border-radius:7px;padding:7px 4px;font-family:var(--font-display);font-size:12px;font-weight:700;letter-spacing:.5px;cursor:pointer;transition:all .2s;border:1px solid;text-align:center;position:relative;overflow:hidden}
.act-btn:disabled{opacity:.25;cursor:not-allowed}
.act-btn:not(:disabled):hover{transform:translateY(-1px)}
.act-btn:not(:disabled):active{transform:translateY(0)}
.btn-start{background:var(--green-bg);color:var(--green);border-color:var(--green-bd)}
.btn-start:not(:disabled):hover{background:rgba(6,60,38,.9);box-shadow:0 0 16px rgba(52,211,153,.35)}
.btn-stop{background:var(--red-bg);color:var(--red);border-color:var(--red-bd)}
.btn-stop:not(:disabled):hover{background:rgba(60,10,10,.9);box-shadow:0 0 16px rgba(248,113,113,.35)}
.btn-cmd,.btn-map{flex:0 0 36px;background:var(--glass);color:var(--v2);border-color:var(--border)}
.btn-cmd:hover,.btn-map:hover{border-color:var(--v);box-shadow:var(--glow)}
.btn-remove{flex:0 0 28px;background:var(--glass);color:var(--dim);border-color:var(--border);font-size:11px}
.btn-remove:hover{border-color:var(--red-bd);color:var(--red)}

/* Add bot card */
.add-card{background:var(--glass);border:1px dashed var(--border);border-radius:var(--r);padding:16px;width:280px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;cursor:pointer;transition:all .3s;min-height:200px}
.add-card:hover{border-color:var(--v);background:rgba(139,92,246,.08);box-shadow:var(--glow)}
.add-icon{font-size:32px;opacity:.4}
.add-label{font-family:var(--font-display);font-size:14px;font-weight:600;color:var(--dim);letter-spacing:1px}

/* ── Console section ── */
.consoles{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px;height:320px}
.console-card{background:var(--panel);border:1px solid var(--border);border-radius:var(--r);display:flex;flex-direction:column;overflow:hidden}
.con-head{padding:7px 12px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:5px;flex-shrink:0;background:rgba(0,0,0,.2)}
.con-name{font-family:var(--font-display);color:var(--v2);font-weight:700;font-size:12px;flex:1;letter-spacing:.5px}
.con-count{font-size:9px;color:var(--yellow);margin-right:4px;font-family:var(--font-display);font-weight:600}
.filter-btn{background:none;border:1px solid var(--border);color:var(--dim);font-family:var(--font-display);font-size:9px;font-weight:600;letter-spacing:.5px;padding:1px 7px;border-radius:4px;cursor:pointer;transition:all .2s}
.filter-btn.active{border-color:var(--v);color:var(--v2);background:rgba(139,92,246,.12)}
.clr-btn{background:none;border:none;color:var(--dim);font-family:inherit;font-size:10px;cursor:pointer;margin-left:auto;transition:color .2s}
.clr-btn:hover{color:var(--red)}
.log-area{flex:1;overflow-y:auto;padding:3px 8px}
.log-area::-webkit-scrollbar{width:3px}
.log-area::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}
.log-entry{display:flex;gap:5px;padding:1.5px 0;border-bottom:1px solid rgba(112,70,220,.08);line-height:1.65;font-size:10.5px}
.log-ts{color:var(--dim);flex-shrink:0;width:64px;font-size:9px;opacity:.7}
.log-tag{font-size:8.5px;font-weight:700;letter-spacing:.5px;flex-shrink:0;width:44px;text-align:right;padding-right:4px;font-family:var(--font-display)}
.log-msg{flex:1;word-break:break-word}
.t-info .log-tag{color:var(--cyan)} .t-info .log-msg{color:#c8d8f0}
.t-error .log-tag,.t-error .log-msg{color:var(--red)}
.t-kick .log-tag,.t-kick .log-msg{color:var(--orange)}
.t-disconnect .log-tag,.t-disconnect .log-msg{color:var(--orange);opacity:.8}
.t-reconnect .log-tag,.t-reconnect .log-msg{color:var(--yellow)}
.t-kill .log-tag,.t-kill .log-msg{color:var(--pink)}
.t-food .log-tag,.t-food .log-msg{color:var(--green)}
.t-chat .log-tag,.t-chat .log-msg{color:var(--v2)}
.t-inv .log-tag,.t-inv .log-msg{color:var(--teal)}
.t-error{background:rgba(248,113,113,.04)}
.t-kick{background:rgba(251,146,60,.04)}
.t-kill{background:rgba(244,114,182,.04)}
.cmd-bar{display:flex;border-top:1px solid var(--border);flex-shrink:0}
.cmd-field{flex:1;background:rgba(0,0,0,.4);border:none;color:var(--text);font-family:var(--font-mono);font-size:11px;padding:7px 10px;outline:none}
.cmd-field::placeholder{color:var(--dim)}
.cmd-go{background:var(--green-bg);border:none;border-left:1px solid var(--border);color:var(--green);font-family:inherit;font-size:11px;padding:7px 14px;cursor:pointer;transition:background .2s;font-family:var(--font-display);font-weight:600}
.cmd-go:hover{background:rgba(6,60,38,.9)}

/* ── Modals ── */
.overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:100;align-items:center;justify-content:center;backdrop-filter:blur(6px)}
.overlay.show{display:flex;animation:fadeIn .15s ease}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
.modal{background:linear-gradient(160deg,rgba(18,8,50,.98),rgba(10,5,30,.98));border:1px solid var(--border2);border-radius:14px;display:flex;flex-direction:column;overflow:hidden;box-shadow:var(--glow2),0 20px 60px rgba(0,0,0,.7);animation:modalIn .2s ease}
@keyframes modalIn{from{opacity:0;transform:translateY(20px) scale(.97)}to{opacity:1;transform:translateY(0) scale(1)}}
.modal-hdr{padding:14px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;background:rgba(0,0,0,.2)}
.modal-title{font-family:var(--font-display);font-weight:700;font-size:15px;color:var(--v2);flex:1;letter-spacing:.5px}
.modal-x{background:none;border:none;color:var(--dim);cursor:pointer;font-size:18px;line-height:1;transition:color .2s;padding:2px 6px}
.modal-x:hover{color:var(--red)}

/* CMD Modal */
#cmd-overlay .modal{width:680px;max-width:96vw;height:68vh}
.modal-log{flex:1;overflow-y:auto;padding:8px 14px}
.modal-log::-webkit-scrollbar{width:3px}
.modal-log::-webkit-scrollbar-thumb{background:var(--border)}
.modal-cmd{display:flex;border-top:1px solid var(--border)}
.modal-field{flex:1;background:rgba(0,0,0,.5);border:none;color:var(--text);font-family:var(--font-mono);font-size:12px;padding:11px 14px;outline:none}
.modal-send{background:var(--green-bg);border:none;border-left:1px solid var(--border);color:var(--green);font-family:var(--font-display);font-weight:700;padding:11px 18px;cursor:pointer;font-size:13px;letter-spacing:.5px}

/* Map Modal */
#map-overlay .modal{width:390px;max-width:95vw}
.map-body{padding:16px;display:flex;flex-direction:column;align-items:center;gap:10px}
#map-img{width:260px;height:260px;background:rgba(0,0,0,.4);border:2px solid var(--border2);border-radius:6px;display:flex;align-items:center;justify-content:center;color:var(--dim);font-size:11px;text-align:center;image-rendering:pixelated}
#map-img img{width:100%;height:100%;image-rendering:pixelated}
.map-hint{font-size:10px;color:var(--dim);text-align:center}
.map-input-row{display:flex;gap:6px;width:100%}
#map-answer{flex:1;background:rgba(0,0,0,.4);border:1px solid var(--border2);color:var(--text);font-family:var(--font-mono);font-size:14px;padding:9px;border-radius:7px;outline:none;text-align:center;letter-spacing:3px;transition:border-color .2s}
#map-answer:focus{border-color:var(--v)}
#map-submit{background:rgba(139,92,246,.2);border:1px solid var(--v);color:var(--v2);font-family:var(--font-display);font-size:13px;font-weight:700;padding:9px 18px;border-radius:7px;cursor:pointer;letter-spacing:.5px}
.map-refresh{background:var(--glass);border:1px solid var(--border);color:var(--dim);font-family:inherit;font-size:10px;padding:5px 14px;border-radius:6px;cursor:pointer;width:100%;transition:all .2s}
.map-refresh:hover{border-color:var(--v);color:var(--v2)}
.map-status{font-size:11px;min-height:16px;font-family:var(--font-display);font-weight:600}
.map-status.ok{color:var(--green)}.map-status.err{color:var(--red)}

/* Add Bot Modal */
#add-overlay .modal{width:360px;max-width:95vw}
.modal-body{padding:18px;display:flex;flex-direction:column;gap:12px}
.field-group{display:flex;flex-direction:column;gap:5px}
.field-label{font-family:var(--font-display);font-size:11px;font-weight:600;letter-spacing:1px;color:var(--dim2)}
.field-input{background:rgba(0,0,0,.4);border:1px solid var(--border);color:var(--text);font-family:var(--font-mono);font-size:12px;padding:9px 12px;border-radius:7px;outline:none;transition:border-color .2s;width:100%}
.field-input:focus{border-color:var(--v);box-shadow:0 0 0 2px rgba(139,92,246,.15)}
.field-select{background:rgba(5,2,20,.9);border:1px solid var(--border);color:var(--text);font-family:var(--font-display);font-size:13px;font-weight:600;padding:9px 12px;border-radius:7px;outline:none;cursor:pointer;transition:border-color .2s;width:100%}
.field-select:focus{border-color:var(--v)}
.type-toggle{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.type-opt{background:var(--glass);border:1px solid var(--border);border-radius:7px;padding:10px;text-align:center;cursor:pointer;transition:all .2s;font-family:var(--font-display);font-weight:600;font-size:12px;letter-spacing:.5px}
.type-opt.selected.kill{background:rgba(248,113,113,.12);border-color:rgba(248,113,113,.4);color:var(--red)}
.type-opt.selected.afk{background:rgba(56,189,248,.12);border-color:rgba(56,189,248,.4);color:var(--cyan)}
.type-opt:not(.selected){color:var(--dim)}
.modal-btn{background:linear-gradient(135deg,var(--vneon),var(--v));border:none;color:white;font-family:var(--font-display);font-size:14px;font-weight:700;padding:11px;border-radius:8px;cursor:pointer;letter-spacing:1px;transition:all .2s;box-shadow:0 4px 20px rgba(139,92,246,.4)}
.modal-btn:hover{box-shadow:0 6px 28px rgba(139,92,246,.6);transform:translateY(-1px)}
.modal-btn-sec{background:var(--glass);border:1px solid var(--border);color:var(--dim2);font-family:var(--font-display);font-size:13px;font-weight:600;padding:10px;border-radius:8px;cursor:pointer;transition:all .2s}
.modal-btn-sec:hover{border-color:var(--v);color:var(--v2)}
.btn-row{display:flex;gap:8px}
.btn-row .modal-btn{flex:1}
.btn-row .modal-btn-sec{flex:0 0 auto}

/* Server config modal */
#srv-overlay .modal{width:400px;max-width:95vw}
.srv-note{font-size:10px;color:var(--dim);text-align:center;line-height:1.5}

/* Proxy modal */
#proxy-overlay .modal{width:400px;max-width:95vw}
.proxy-clear-btn{background:none;border:1px solid var(--red-bd);color:var(--red);font-family:inherit;font-size:11px;padding:5px 12px;border-radius:6px;cursor:pointer;margin-top:4px;transition:all .2s}
.proxy-clear-btn:hover{background:var(--red-bg)}

/* Rename modal */
#rename-overlay .modal{width:360px;max-width:95vw}

/* Scrollbar global */
::-webkit-scrollbar{width:4px;height:4px}
::-webkit-scrollbar-thumb{background:rgba(139,92,246,.35);border-radius:4px}
::-webkit-scrollbar-track{background:transparent}
</style>
</head>
<body>

<canvas id="bg-canvas"></canvas>
<div class="grid-overlay"></div>
<div class="blob blob1"></div>
<div class="blob blob2"></div>
<div class="blob blob3"></div>

<div class="content">

<div class="hdr">
  <div class="logo">NEXUS<span>BOT</span></div>
  <div class="uptime-pill"><div class="dot"></div>UP <span id="uptime">00:00:00</span></div>
  <div class="hdr-right">
    <div class="conn-pill"><div class="conn-dot" id="conn-dot"></div><span id="conn-text" style="font-size:10px;color:var(--dim2)">Connecting</span></div>
    <button class="icon-btn" onclick="startPoll()" title="Reconnect">⟳</button>
    <button class="icon-btn" onclick="openOverlay('srv-overlay')" title="Server Settings">⚙</button>
  </div>
</div>

<div class="srv-bar">
  <div class="srv-favicon" id="srv-fav">🌐</div>
  <div style="flex:1;min-width:0">
    <div class="srv-motd" id="srv-motd">Pinging server...</div>
    <div class="srv-meta">
      <span><span class="srv-addr" onclick="openOverlay('srv-overlay')" id="srv-addr">--:--</span></span>
      <span class="srv-online" id="srv-players">--/--</span>
      <span id="srv-ver" style="color:var(--dim)">--</span>
    </div>
  </div>
  <button class="ping-btn" onclick="pingServer()">PING</button>
</div>

<div class="main">
  <div class="cards-wrap" id="cards"></div>
  <div class="consoles" id="consoles"></div>
</div>

</div><!-- .content -->

<!-- CMD Modal -->
<div class="overlay" id="cmd-overlay" onclick="if(event.target===this)closeOverlay('cmd-overlay')">
  <div class="modal">
    <div class="modal-hdr"><span class="modal-title" id="cmd-title"></span><button class="modal-x" onclick="closeOverlay('cmd-overlay')">✕</button></div>
    <div class="modal-log" id="cmd-log"></div>
    <div class="modal-cmd">
      <input class="modal-field" id="cmd-field" placeholder="Type command and press Enter..." onkeydown="if(event.key==='Enter')sendModalCmd()">
      <button class="modal-send" onclick="sendModalCmd()">SEND</button>
    </div>
  </div>
</div>

<!-- Map Modal -->
<div class="overlay" id="map-overlay" onclick="if(event.target===this)closeOverlay('map-overlay')">
  <div class="modal">
    <div class="modal-hdr"><span class="modal-title" id="map-title">Map Captcha</span><button class="modal-x" onclick="closeOverlay('map-overlay')">✕</button></div>
    <div class="map-body">
      <div id="map-img">No map data.<br>Bot must hold a map item.</div>
      <div class="map-hint">Read the captcha from the map image and enter it below</div>
      <div class="map-input-row">
        <input id="map-answer" placeholder="Answer..." onkeydown="if(event.key==='Enter')submitMap()">
        <button id="map-submit" onclick="submitMap()">SEND</button>
      </div>
      <button class="map-refresh" onclick="fetchMap()">↻ Refresh Map</button>
      <div class="map-status" id="map-status"></div>
    </div>
  </div>
</div>

<!-- Add Bot Modal -->
<div class="overlay" id="add-overlay" onclick="if(event.target===this)closeOverlay('add-overlay')">
  <div class="modal">
    <div class="modal-hdr"><span class="modal-title">+ Add New Bot</span><button class="modal-x" onclick="closeOverlay('add-overlay')">✕</button></div>
    <div class="modal-body">
      <div class="field-group">
        <div class="field-label">USERNAME</div>
        <input class="field-input" id="add-name" placeholder="e.g. MyBot123" maxlength="16" onkeydown="if(event.key==='Enter')doAddBot()">
      </div>
      <div class="field-group">
        <div class="field-label">BOT TYPE</div>
        <div class="type-toggle">
          <div class="type-opt kill selected" id="add-type-kill" onclick="selectAddType('kill')">⚔ KILL BOT</div>
          <div class="type-opt afk" id="add-type-afk" onclick="selectAddType('afk')">💤 AFK BOT</div>
        </div>
      </div>
      <div class="btn-row" style="margin-top:4px">
        <button class="modal-btn" onclick="doAddBot()">LAUNCH BOT</button>
        <button class="modal-btn-sec" onclick="closeOverlay('add-overlay')">Cancel</button>
      </div>
    </div>
  </div>
</div>

<!-- Server Config Modal -->
<div class="overlay" id="srv-overlay" onclick="if(event.target===this)closeOverlay('srv-overlay')">
  <div class="modal">
    <div class="modal-hdr"><span class="modal-title">⚙ Server Configuration</span><button class="modal-x" onclick="closeOverlay('srv-overlay')">✕</button></div>
    <div class="modal-body">
      <div class="field-group">
        <div class="field-label">MINECRAFT SERVER HOST</div>
        <input class="field-input" id="srv-host-input" placeholder="play.example.net">
      </div>
      <div class="field-group">
        <div class="field-label">PORT</div>
        <input class="field-input" id="srv-port-input" placeholder="25565" type="number">
      </div>
      <div class="srv-note">⚠ Changing the server will affect new connections.<br>Restart bots manually to reconnect them.</div>
      <div class="btn-row">
        <button class="modal-btn" onclick="saveServerConfig()">SAVE CONFIG</button>
        <button class="modal-btn-sec" onclick="closeOverlay('srv-overlay')">Cancel</button>
      </div>
    </div>
  </div>
</div>

<!-- Proxy Modal -->
<div class="overlay" id="proxy-overlay" onclick="if(event.target===this)closeOverlay('proxy-overlay')">
  <div class="modal">
    <div class="modal-hdr"><span class="modal-title" id="proxy-title">🌐 Proxy Config</span><button class="modal-x" onclick="closeOverlay('proxy-overlay')">✕</button></div>
    <div class="modal-body">
      <div class="field-group">
        <div class="field-label">SOCKS HOST</div>
        <input class="field-input" id="proxy-host" placeholder="127.0.0.1">
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div class="field-group">
          <div class="field-label">PORT</div>
          <input class="field-input" id="proxy-port" placeholder="1080" type="number">
        </div>
        <div class="field-group">
          <div class="field-label">TYPE</div>
          <select class="field-select" id="proxy-type">
            <option value="5">SOCKS5</option>
            <option value="4">SOCKS4</option>
          </select>
        </div>
      </div>
      <div class="field-group">
        <div class="field-label">USERNAME (optional)</div>
        <input class="field-input" id="proxy-user" placeholder="leave blank if none">
      </div>
      <div class="field-group">
        <div class="field-label">PASSWORD (optional)</div>
        <input class="field-input" id="proxy-pass" type="password" placeholder="leave blank if none">
      </div>
      <div class="btn-row">
        <button class="modal-btn" onclick="saveProxy()">APPLY PROXY</button>
        <button class="modal-btn-sec proxy-clear-btn" onclick="clearProxy()">Clear</button>
      </div>
    </div>
  </div>
</div>

<!-- Rename Modal -->
<div class="overlay" id="rename-overlay" onclick="if(event.target===this)closeOverlay('rename-overlay')">
  <div class="modal">
    <div class="modal-hdr"><span class="modal-title">✎ Rename Bot</span><button class="modal-x" onclick="closeOverlay('rename-overlay')">✕</button></div>
    <div class="modal-body">
      <div class="field-group">
        <div class="field-label">NEW USERNAME</div>
        <input class="field-input" id="rename-input" placeholder="New username..." maxlength="16" onkeydown="if(event.key==='Enter')doRename()">
      </div>
      <div class="srv-note">⚠ Bot will disconnect and reconnect with the new name.</div>
      <div class="btn-row">
        <button class="modal-btn" onclick="doRename()">RENAME & RECONNECT</button>
        <button class="modal-btn-sec" onclick="closeOverlay('rename-overlay')">Cancel</button>
      </div>
    </div>
  </div>
</div>

<script>
const MAX_DISPLAY = 150;
const TAGS = {info:'INFO',error:'ERR',kick:'KICK',disconnect:'DISC',reconnect:'RCON',kill:'KILL',food:'FOOD',chat:'CHAT',inv:'INV'};

const logs={}, status={}, stats={}, coords={}, botCfg={};
let lastId=0, init=false, serverStart=null, pollTimer=null;
const filters={}, autoScroll={};
let activeCmd=null, activeMap=null, activeProxy=null, activeRename=null;
let addType='kill';

function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function fmt(ts){return new Date(ts).toTimeString().slice(0,8);}
function ago(ts){if(!ts)return'';const s=Math.floor((Date.now()-ts)/1000);return s<60?s+'s':s<3600?Math.floor(s/60)+'m':Math.floor(s/3600)+'h';}

// ── Uptime (server-based) ──────────────────────────────────────────────────
setInterval(()=>{
  if(!serverStart)return;
  const s=Math.floor((Date.now()-serverStart)/1000);
  document.getElementById('uptime').textContent=[Math.floor(s/3600),Math.floor((s%3600)/60),s%60].map(n=>String(n).padStart(2,'0')).join(':');
},1000);

// ── Skin URL ───────────────────────────────────────────────────────────────
// Generate a deterministic color from the bot name (no external dependency)
function nameColor(name){var h=0;for(var i=0;i<name.length;i++)h=(Math.imul(31,h)+name.charCodeAt(i))|0;var hue=Math.abs(h)%360;return'hsl('+hue+',60%,55%)';}
function skinSvg(name){var c=nameColor(name),l=name.slice(0,2).toUpperCase();return'data:image/svg+xml,'+encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='40' height='40' viewBox='0 0 40 40'><rect width='40' height='40' rx='6' fill='"+c+"' opacity='.85'/><text x='50%' y='54%' dominant-baseline='middle' text-anchor='middle' fill='white' font-family='monospace' font-weight='bold' font-size='14'>"+l+"</text></svg>");}
function skinUrl(name){return skinSvg(name);}
// Optional: swap above to use mc-heads when network is available:
// function skinUrl(name){return 'https://mc-heads.net/avatar/'+encodeURIComponent(name)+'/40';}

// ── Render card ────────────────────────────────────────────────────────────
function renderCard(name){
  let el=document.getElementById('bc-'+name);
  if(!el){
    el=document.createElement('div');el.id='bc-'+name;
    // Insert before add card
    const addCard=document.getElementById('add-card-btn');
    if(addCard)document.getElementById('cards').insertBefore(el,addCard);
    else document.getElementById('cards').appendChild(el);
  }
  const s=status[name]||{}, st=stats[name]||{}, cr=coords[name], cfg=botCfg[name]||{};
  const inv=st.inventory||{}, ch=st.chests||{};
  const tear=(inv.ghast_tear||0)+(ch.ghast_tear||0);
  const powder=(inv.gunpowder||0)+(ch.gunpowder||0);
  const isOnline=!!s.online, isRunning=!!s.running;
  const typeBadge=s.type==='Kill Bot'?'type-kill kill':'type-afk afk';
  const typeText=s.type==='Kill Bot'?'⚔ KILL':'💤 AFK';
  const proxy=cfg.proxy;
  el.className='bot-card '+(isOnline?'online':'offline');
  el.innerHTML=
    '<div class="card-top">'+
      '<div class="bot-skin"><img src="'+skinUrl(name)+'" alt="'+esc(name.slice(0,2).toUpperCase())+'" style="border-radius:6px"></div>'+
      '<div class="card-info">'+
        '<div class="bot-name-row">'+
          '<div class="bot-name" title="'+esc(name)+'">'+esc(name)+'</div>'+
          '<button class="rename-btn" data-action="openrename" data-bot="'+esc(name)+'" title="Rename">✎</button>'+
        '</div>'+
        '<div class="bot-type-badge '+typeBadge+'">'+typeText+'</div>'+
      '</div>'+
      '<div class="status-badge '+(isOnline?'online':'offline')+'">'+(isOnline?'LIVE':'OFF')+'</div>'+
    '</div>'+
    '<div class="stats-row">'+
      '<div class="stat-box"><div class="stat-label">KILLS</div><div class="stat-val">'+(st.ghastKills||0)+'</div></div>'+
      '<div class="stat-box"><div class="stat-label">FOOD</div><div class="stat-val">'+(st.foodAte||0)+'</div></div>'+
      '<div class="stat-box"><div class="stat-label">STATE</div><div class="stat-val" style="font-size:10px;color:'+(isOnline?'var(--green)':'var(--red)')+'">'+(isOnline?'UP':'DOWN')+'</div></div>'+
    '</div>'+
    '<div class="coords-row">'+
      '<span class="coords-ico">📍</span>'+
      '<span class="coords-xyz">'+(cr?'X:'+cr.x+' Y:'+cr.y+' Z:'+cr.z:'unknown')+'</span>'+
      (cr?'<span class="coords-ts">'+ago(cr.ts)+'</span>':'')+
      '<button class="coords-refresh" data-action="coords" data-bot="'+esc(name)+'" title="Refresh coords">↻</button>'+
    '</div>'+
    '<div class="loot-row">'+
      '<div class="loot-item"><span class="loot-ico">💀</span><span class="loot-name">Tear</span><span class="loot-count">'+tear+'</span></div>'+
      '<div class="loot-item"><span class="loot-ico">💥</span><span class="loot-name">Powder</span><span class="loot-count">'+powder+'</span></div>'+
      '<button class="scan-btn" data-action="chestscan" data-bot="'+esc(name)+'">SCAN</button>'+
    '</div>'+
    '<div class="proxy-row">'+
      '<div class="proxy-badge '+(proxy?'active':'inactive')+'">'+(proxy?'🌐 PROXY: '+proxy.host+':'+proxy.port:'🔓 NO PROXY')+'</div>'+
      '<button class="proxy-set-btn" data-action="openproxy" data-bot="'+esc(name)+'">Config</button>'+
    '</div>'+
    '<div class="actions">'+
      '<button class="act-btn btn-start" data-action="start" data-bot="'+esc(name)+'" '+(isRunning?'disabled':'')+'>▶ START</button>'+
      '<button class="act-btn btn-stop" data-action="stop" data-bot="'+esc(name)+'" '+(!isRunning?'disabled':'')+'>■ STOP</button>'+
      '<button class="act-btn btn-cmd" data-action="opencmd" data-bot="'+esc(name)+'" title="Command">⌨</button>'+
      '<button class="act-btn btn-map" data-action="openmap" data-bot="'+esc(name)+'" title="Map">🗺</button>'+
      '<button class="act-btn btn-remove" data-action="remove" data-bot="'+esc(name)+'" title="Remove bot">✕</button>'+
    '</div>';
}

// ── Init consoles ──────────────────────────────────────────────────────────
function initConsoles(bots){
  const el=document.getElementById('consoles'); el.innerHTML='';
  for(const name of bots){
    logs[name]=[]; filters[name]='all'; autoScroll[name]=true;
    const pane=document.createElement('div'); pane.className='console-card'; pane.id='cc-'+name;
    pane.innerHTML=
      '<div class="con-head">'+
        '<span class="con-name">'+esc(name)+'</span>'+
        '<span class="con-count" id="cnt-'+name+'">0</span>'+
        '<button class="filter-btn active" data-pane="'+name+'" data-filter="all">ALL</button>'+
        '<button class="filter-btn" data-pane="'+name+'" data-filter="error">ERR</button>'+
        '<button class="filter-btn" data-pane="'+name+'" data-filter="kill">KILL</button>'+
        '<button class="filter-btn" data-pane="'+name+'" data-filter="chat">CHAT</button>'+
        '<button class="filter-btn" data-pane="'+name+'" data-filter="inv">INV</button>'+
        '<button class="clr-btn" data-action="clear" data-pane="'+name+'">CLR</button>'+
      '</div>'+
      '<div class="log-area" id="la-'+name+'"></div>'+
      '<div class="cmd-bar">'+
        '<input class="cmd-field" id="cf-'+name+'" data-bot="'+name+'" placeholder="/cmd → '+esc(name)+'...">'+
        '<button class="cmd-go" data-action="sendcmd" data-bot="'+name+'">▶</button>'+
      '</div>';
    el.appendChild(pane);
    document.getElementById('la-'+name).addEventListener('scroll',function(){
      autoScroll[name]=this.scrollTop+this.clientHeight>=this.scrollHeight-20;
    });
  }
}

function addConsole(name){
  if(document.getElementById('cc-'+name))return;
  logs[name]=[]; filters[name]='all'; autoScroll[name]=true;
  const el=document.getElementById('consoles');
  const pane=document.createElement('div'); pane.className='console-card'; pane.id='cc-'+name;
  pane.innerHTML=
    '<div class="con-head">'+
      '<span class="con-name">'+esc(name)+'</span>'+
      '<span class="con-count" id="cnt-'+name+'">0</span>'+
      '<button class="filter-btn active" data-pane="'+name+'" data-filter="all">ALL</button>'+
      '<button class="filter-btn" data-pane="'+name+'" data-filter="error">ERR</button>'+
      '<button class="filter-btn" data-pane="'+name+'" data-filter="kill">KILL</button>'+
      '<button class="filter-btn" data-pane="'+name+'" data-filter="chat">CHAT</button>'+
      '<button class="filter-btn" data-pane="'+name+'" data-filter="inv">INV</button>'+
      '<button class="clr-btn" data-action="clear" data-pane="'+name+'">CLR</button>'+
    '</div>'+
    '<div class="log-area" id="la-'+name+'"></div>'+
    '<div class="cmd-bar">'+
      '<input class="cmd-field" id="cf-'+name+'" data-bot="'+name+'" placeholder="/cmd → '+esc(name)+'...">'+
      '<button class="cmd-go" data-action="sendcmd" data-bot="'+name+'">▶</button>'+
    '</div>';
  el.appendChild(pane);
  document.getElementById('la-'+name).addEventListener('scroll',function(){
    autoScroll[name]=this.scrollTop+this.clientHeight>=this.scrollHeight-20;
  });
}

function removeConsole(name){const el=document.getElementById('cc-'+name);if(el)el.remove();}

// ── Log entries ─────────────────────────────────────────────────────────────
function makeEntry(e){
  const t=e.type||'info', d=document.createElement('div');
  d.className='log-entry t-'+t; d.dataset.type=t;
  d.innerHTML='<span class="log-ts">'+fmt(e.ts)+'</span><span class="log-tag">'+(TAGS[t]||t.slice(0,5).toUpperCase())+'</span><span class="log-msg">'+esc(e.message)+'</span>';
  return d;
}

function pushLog(e){
  const b=e.username; if(!logs[b]){logs[b]=[];}
  logs[b].push(e);
  if(logs[b].length>300)logs[b].shift();
  const f=filters[b]||'all';
  if(f==='all'||f===e.type){
    const la=document.getElementById('la-'+b);
    if(la){
      la.appendChild(makeEntry(e));
      while(la.children.length>MAX_DISPLAY)la.removeChild(la.firstChild);
      if(autoScroll[b])la.scrollTop=la.scrollHeight;
    }
    if(activeCmd===b){const cl=document.getElementById('cmd-log');if(cl){cl.appendChild(makeEntry(e));cl.scrollTop=cl.scrollHeight;}}
  }
  const c=document.getElementById('cnt-'+b);if(c)c.textContent=logs[b].length;
}

function rebuildLog(bot){
  const la=document.getElementById('la-'+bot);if(!la)return;
  la.innerHTML='';
  const f=filters[bot]||'all';
  const entries=f==='all'?logs[bot]:logs[bot].filter(x=>x.type===f);
  entries.slice(-MAX_DISPLAY).forEach(e=>la.appendChild(makeEntry(e)));
  la.scrollTop=la.scrollHeight;
}

// ── Delegated events ────────────────────────────────────────────────────────
document.addEventListener('click',async function(ev){
  const el=ev.target.closest('[data-action]');if(!el)return;
  const a=el.dataset.action,b=el.dataset.bot,p=el.dataset.pane;
  if(a==='start'||a==='stop'){
    // Optimistic immediate update
    if(status[b]){status[b].running=(a==='start');renderCard(b);}
    const d=await fetch('/bot/'+encodeURIComponent(b)+'/'+a,{method:'POST'}).then(r=>r.json());
    if(!d.ok){alert(d.reason||'error');if(status[b]){status[b].running=(a==='stop');renderCard(b);}}
  }else if(a==='coords'){fetch('/bot/'+encodeURIComponent(b)+'/coords',{method:'POST'});}
  else if(a==='chestscan'){fetch('/bot/'+encodeURIComponent(b)+'/chestscan',{method:'POST'});}
  else if(a==='opencmd'){openCmd(b);}
  else if(a==='openmap'){openMap(b);}
  else if(a==='openproxy'){openProxy(b);}
  else if(a==='openrename'){openRename(b);}
  else if(a==='remove'){if(confirm('Remove bot '+b+'?'))doRemove(b);}
  else if(a==='sendcmd'){doSendCmd(b);}
  else if(a==='clear'){logs[p]=[];rebuildLog(p);}
  else if(el.classList.contains('filter-btn')&&el.dataset.pane){
    document.querySelectorAll('#cc-'+p+' .filter-btn').forEach(x=>x.classList.remove('active'));
    el.classList.add('active');filters[p]=el.dataset.filter;rebuildLog(p);
  }
});
document.addEventListener('keydown',function(ev){
  if(ev.key!=='Enter')return;
  const el=ev.target.closest('.cmd-field[data-bot]');if(el)doSendCmd(el.dataset.bot);
});

async function doSendCmd(name){
  const inp=document.getElementById('cf-'+name);if(!inp||!inp.value.trim())return;
  const cmd=inp.value.trim();inp.value='';
  const d=await fetch('/bot/'+encodeURIComponent(name)+'/cmd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cmd})}).then(r=>r.json());
  if(!d.ok)pushLog({username:name,type:'error',message:'CMD failed: '+(d.reason||'?'),ts:Date.now()});
}

// ── Modals ─────────────────────────────────────────────────────────────────
function openOverlay(id){document.getElementById(id).classList.add('show');}
function closeOverlay(id){document.getElementById(id).classList.remove('show');if(id==='cmd-overlay')activeCmd=null;if(id==='map-overlay')activeMap=null;if(id==='proxy-overlay')activeProxy=null;if(id==='rename-overlay')activeRename=null;}

function openCmd(name){
  activeCmd=name;
  document.getElementById('cmd-title').textContent='⌨ '+name;
  const cl=document.getElementById('cmd-log');cl.innerHTML='';
  (logs[name]||[]).forEach(e=>cl.appendChild(makeEntry(e)));cl.scrollTop=cl.scrollHeight;
  openOverlay('cmd-overlay');
  setTimeout(()=>document.getElementById('cmd-field').focus(),60);
}
async function sendModalCmd(){
  if(!activeCmd)return;
  const inp=document.getElementById('cmd-field');if(!inp.value.trim())return;
  const cmd=inp.value.trim();inp.value='';
  await fetch('/bot/'+encodeURIComponent(activeCmd)+'/cmd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cmd})});
}

function openMap(name){
  activeMap=name;
  document.getElementById('map-title').textContent='🗺 Map — '+name;
  document.getElementById('map-answer').value='';
  document.getElementById('map-status').textContent='';
  openOverlay('map-overlay');fetchMap();
}
async function fetchMap(){
  if(!activeMap)return;
  const box=document.getElementById('map-img');box.textContent='Loading...';
  try{
    const d=await fetch('/bot/'+encodeURIComponent(activeMap)+'/map').then(r=>r.json());
    if(!d.ok){box.textContent=d.reason||'No map. Bot must hold map item.';return;}
    box.innerHTML='';const img=document.createElement('img');img.src=d.png;
    img.style.cssText='width:100%;height:100%;image-rendering:pixelated';box.appendChild(img);
    document.getElementById('map-answer').focus();
  }catch(_){box.textContent='Error fetching map.';}
}
async function submitMap(){
  const ans=document.getElementById('map-answer').value.trim();
  const st=document.getElementById('map-status');if(!ans||!activeMap)return;
  const d=await fetch('/bot/'+encodeURIComponent(activeMap)+'/cmd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cmd:ans})}).then(r=>r.json());
  if(d.ok){st.textContent='✓ Sent!';st.className='map-status ok';document.getElementById('map-answer').value='';setTimeout(()=>closeOverlay('map-overlay'),1500);}
  else{st.textContent='✗ '+(d.reason||'failed');st.className='map-status err';}
}

// Add bot
function selectAddType(t){
  addType=t;
  document.getElementById('add-type-kill').className='type-opt kill'+(t==='kill'?' selected':'');
  document.getElementById('add-type-afk').className='type-opt afk'+(t==='afk'?' selected':'');
}
async function doAddBot(){
  const name=document.getElementById('add-name').value.trim();
  if(!name){alert('Enter a username');return;}
  const d=await fetch('/bot/add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,type:addType})}).then(r=>r.json());
  if(d.ok){closeOverlay('add-overlay');document.getElementById('add-name').value='';}
  else alert(d.reason||'Failed to add bot');
}

// Proxy
function openProxy(name){
  activeProxy=name;
  document.getElementById('proxy-title').textContent='🌐 Proxy — '+name;
  const cfg=botCfg[name]?.proxy;
  document.getElementById('proxy-host').value=cfg?.host||'';
  document.getElementById('proxy-port').value=cfg?.port||'1080';
  document.getElementById('proxy-type').value=cfg?.type||'5';
  document.getElementById('proxy-user').value=cfg?.username||'';
  document.getElementById('proxy-pass').value=cfg?.password||'';
  openOverlay('proxy-overlay');
}
async function saveProxy(){
  if(!activeProxy)return;
  const host=document.getElementById('proxy-host').value.trim();
  const d=await fetch('/bot/'+encodeURIComponent(activeProxy)+'/proxy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({host,port:document.getElementById('proxy-port').value,type:document.getElementById('proxy-type').value,username:document.getElementById('proxy-user').value,password:document.getElementById('proxy-pass').value})}).then(r=>r.json());
  if(d.ok){if(botCfg[activeProxy])botCfg[activeProxy].proxy=d.proxy;renderCard(activeProxy);closeOverlay('proxy-overlay');}
  else alert(d.reason||'Failed');
}
async function clearProxy(){
  if(!activeProxy)return;
  const d=await fetch('/bot/'+encodeURIComponent(activeProxy)+'/proxy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({host:''})}).then(r=>r.json());
  if(d.ok){if(botCfg[activeProxy])botCfg[activeProxy].proxy=null;renderCard(activeProxy);closeOverlay('proxy-overlay');}
}

// Rename
function openRename(name){
  activeRename=name;
  document.getElementById('rename-input').value=name;
  openOverlay('rename-overlay');
  setTimeout(()=>{const i=document.getElementById('rename-input');i.focus();i.select();},60);
}
async function doRename(){
  if(!activeRename)return;
  const newName=document.getElementById('rename-input').value.trim();
  if(!newName)return;
  const d=await fetch('/bot/'+encodeURIComponent(activeRename)+'/rename',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({newName})}).then(r=>r.json());
  if(d.ok)closeOverlay('rename-overlay');
  else alert(d.reason||'Failed to rename');
}

// Remove
async function doRemove(name){
  const d=await fetch('/bot/'+encodeURIComponent(name)+'/remove',{method:'POST'}).then(r=>r.json());
  if(!d.ok)alert(d.reason||'Failed');
}

// Server config
async function saveServerConfig(){
  const host=document.getElementById('srv-host-input').value.trim();
  const port=document.getElementById('srv-port-input').value.trim();
  if(!host&&!port)return;
  const d=await fetch('/config/server',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({host:host||undefined,port:port||undefined})}).then(r=>r.json());
  if(d.ok){updateSrvAddr(d.host,d.port);closeOverlay('srv-overlay');}
  else alert('Failed');
}
function updateSrvAddr(h,p){document.getElementById('srv-addr').textContent=(h||'?')+':'+(p||'?');}

// Server ping
async function pingServer(){
  document.getElementById('srv-motd').textContent='Pinging...';
  try{
    const d=await fetch('/serverinfo').then(r=>r.json());
    if(d&&d.motd!==undefined){
      document.getElementById('srv-motd').textContent=d.motd.replace(/\u00a7[0-9a-fk-or]/gi,'')||'(no motd)';
      document.getElementById('srv-players').textContent=(d.onlinePlayers||0)+'/'+(d.maxPlayers||0)+' online';
      document.getElementById('srv-ver').textContent=d.version||'';
      if(d.favicon&&d.favicon.startsWith('data:image')){document.getElementById('srv-fav').innerHTML='<img src="'+d.favicon+'">';}
    }
  }catch(_){document.getElementById('srv-motd').textContent='Ping failed';}
}

// ── Polling ─────────────────────────────────────────────────────────────────
async function poll(){
  const dot=document.getElementById('conn-dot'),txt=document.getElementById('conn-text');
  try{
    const d=await fetch('/poll?since='+lastId).then(r=>r.json());
    lastId=d.lastId;
    dot.className='conn-dot live';txt.textContent='LIVE';
    if(!init){
      init=true;
      serverStart=d.state.serverStart;
      const {status:s,stats:st,coords:cr,botConfigs:bc}=d.state;
      // Load srv config
      if(d.state.host)document.getElementById('srv-host-input').value=d.state.host;
      if(d.state.port)document.getElementById('srv-port-input').value=d.state.port;
      updateSrvAddr(d.state.host,d.state.port);
      const names=Object.keys(s);
      initConsoles(names);
      for(const n of names){
        status[n]=s[n]||{}; stats[n]=st[n]||{}; coords[n]=cr[n]||null;
        if(bc&&bc[n])botCfg[n]=bc[n];
        renderCard(n);
      }
      // Add card button
      if(!document.getElementById('add-card-btn')){
        const addEl=document.createElement('div');addEl.id='add-card-btn';addEl.className='add-card';
        addEl.onclick=()=>openOverlay('add-overlay');
        addEl.innerHTML='<div class="add-icon">＋</div><div class="add-label">ADD BOT</div>';
        document.getElementById('cards').appendChild(addEl);
      }
    }
    for(const ev of d.events){
      const {event:e,data:dat}=ev;
      if(e==='log')pushLog(dat);
      else if(e==='status'){if(status[dat.username])status[dat.username].online=dat.online;renderCard(dat.username);}
      else if(e==='stats'){if(stats[dat.username])stats[dat.username]={...stats[dat.username],...dat.stats};renderCard(dat.username);}
      else if(e==='coords'){coords[dat.username]=dat.coords;renderCard(dat.username);}
      else if(e==='chestScan'){if(stats[dat.username])stats[dat.username].chests=dat.chests;renderCard(dat.username);}
      else if(e==='control'){
        if(status[dat.username]){status[dat.username].running=dat.running!=null?dat.running:(dat.action==='started');}
        renderCard(dat.username);
      }
      else if(e==='serverInfo'){
        if(dat.motd)document.getElementById('srv-motd').textContent=dat.motd.replace(/\u00a7[0-9a-fk-or]/gi,'')||'(no motd)';
        if(dat.onlinePlayers!=null)document.getElementById('srv-players').textContent=dat.onlinePlayers+'/'+dat.maxPlayers+' online';
        if(dat.version)document.getElementById('srv-ver').textContent=dat.version;
        if(dat.favicon&&dat.favicon.startsWith('data:image'))document.getElementById('srv-fav').innerHTML='<img src="'+dat.favicon+'">';
      }
      else if(e==='serverConfig'){updateSrvAddr(dat.host,dat.port);}
      else if(e==='botAdded'){
        status[dat.name]=dat.status;stats[dat.name]={ghastKills:0,foodAte:0,inventory:{},chests:{}};
        coords[dat.name]=null;if(dat.config)botCfg[dat.name]=dat.config;
        renderCard(dat.name);addConsole(dat.name);
      }
      else if(e==='botRemoved'){
        delete status[dat.name];delete stats[dat.name];delete coords[dat.name];delete botCfg[dat.name];
        const c=document.getElementById('bc-'+dat.name);if(c)c.remove();
        removeConsole(dat.name);
      }
      else if(e==='botRenamed'){
        const {oldName,newName:nn}=dat;
        delete status[oldName];delete stats[oldName];delete coords[oldName];delete botCfg[oldName];
        const c=document.getElementById('bc-'+oldName);if(c)c.remove();
        removeConsole(oldName);
        status[nn]=dat.status;stats[nn]={ghastKills:0,foodAte:0,inventory:{},chests:{}};
        coords[nn]=null;if(dat.config)botCfg[nn]=dat.config;
        renderCard(nn);addConsole(nn);
      }
      else if(e==='proxyUpdated'){if(botCfg[dat.name])botCfg[dat.name].proxy=dat.proxy;renderCard(dat.name);}
    }
  }catch(_){
    dot.className='conn-dot dead';txt.textContent='Offline';
    init=false;lastId=0;
  }
  pollTimer=setTimeout(poll,2000);
}

function startPoll(){if(pollTimer)clearTimeout(pollTimer);init=false;lastId=0;poll();}

// ── Particle background ──────────────────────────────────────────────────────
(function(){
  const canvas=document.getElementById('bg-canvas');
  const ctx=canvas.getContext('2d');
  let W,H,pts=[];
  function resize(){W=canvas.width=innerWidth;H=canvas.height=innerHeight;}
  resize();window.addEventListener('resize',()=>{resize();});
  function mkPt(){return{x:Math.random()*W,y:Math.random()*H,vx:(Math.random()-.5)*.3,vy:(Math.random()-.5)*.3,r:Math.random()*1.8+.4,a:Math.random()};}
  for(let i=0;i<70;i++)pts.push(mkPt());
  function draw(){
    ctx.clearRect(0,0,W,H);
    for(const p of pts){
      p.x+=p.vx;p.y+=p.vy;
      if(p.x<0||p.x>W)p.vx*=-1;
      if(p.y<0||p.y>H)p.vy*=-1;
      ctx.beginPath();ctx.arc(p.x,p.y,p.r,0,Math.PI*2);
      ctx.fillStyle='rgba(139,92,246,'+p.a*.6+')';ctx.fill();
    }
    // Draw connecting lines
    for(let i=0;i<pts.length;i++){
      for(let j=i+1;j<pts.length;j++){
        const dx=pts[i].x-pts[j].x,dy=pts[i].y-pts[j].y,d=Math.sqrt(dx*dx+dy*dy);
        if(d<120){ctx.beginPath();ctx.moveTo(pts[i].x,pts[i].y);ctx.lineTo(pts[j].x,pts[j].y);ctx.strokeStyle='rgba(139,92,246,'+(0.12*(1-d/120))+')';ctx.lineWidth=.5;ctx.stroke();}
      }
    }
    requestAnimationFrame(draw);
  }
  draw();
})();

startPoll();
pingServer();
setInterval(pingServer,5*60*1000);
</script>
</body>
</html>`; }

// ─── Start server ─────────────────────────────────────────────────────────────
app.listen(PORT_WEB, '0.0.0.0', () => {
  console.log('[Dashboard] http://0.0.0.0:' + PORT_WEB);

  setInterval(() => { sseClients.forEach(res => res.write(': ping\n\n')); }, 15000);

  setTimeout(() => {
    fetchServerInfo().then(info => {
      serverInfo = info;
      if (info) { broadcast('serverInfo', info); console.log('[Server] ' + info.motd + ' | ' + info.onlinePlayers + '/' + info.maxPlayers); }
      else console.log('[Server] ping failed');
    }).catch(() => {});
  }, 3000);

  // Launch Kill Bot first (BOT1), AFK Bot second (BOT2)
  setTimeout(() => {
    botStatus[BOT1].running = true;
    console.log('[Launcher] Starting Kill bot: ' + BOT1);
    launchBot(BOT1);
  }, 2000);

  setTimeout(() => {
    botStatus[BOT2].running = true;
    console.log('[Launcher] Starting AFK bot: ' + BOT2);
    launchBot(BOT2);
  }, 22000);
});
