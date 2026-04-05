require('dotenv').config();
const express = require('express');

const SERVER_START = Date.now();
const app = express();
const PORT_WEB = process.env.PORT || 3000;
app.use(express.json());

const utils = require('./utils');
const { botEvents, botRegistry, botMaps, fetchServerInfo, scanInventoryAndChests, emit } = utils;

const MAX_LOGS = 300;
const logBuffer = [];

const BOT1 = process.env.BOT1_NAME || 'KillBot';
const BOT2 = process.env.BOT2_NAME || 'AfkBot';

const botConfigs = {};
const botStatus  = {};
const stats      = {};
const coords     = {};
const controllers = {};
const botServers = {};
const containerCache = {};
let serverInfo = null;

function typeLabel(t) {
  if (t === 'kill') return 'Kill Bot';
  if (t === 'afk')  return 'AFK Bot';
  return t || 'Bot';
}

function initBotState(name, type, tag) {
  botConfigs[name] = { name, type, tag: tag || '', proxy: null };
  botStatus[name]  = { online: false, type: typeLabel(type), running: false };
  stats[name]      = { ghastKills: 0, foodAte: 0, inventory: {}, chests: {} };
  coords[name]     = null;
  botServers[name] = { host: utils.HOST, port: utils.MC_PORT };
  containerCache[name] = { items: {}, ts: 0 };
}

initBotState(BOT1, 'kill');
initBotState(BOT2, 'afk');

// ─── Events ───────────────────────────────────────────────────────────────────
botEvents.on('log', (entry) => {
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOGS) logBuffer.shift();
  broadcast('log', entry);
});
botEvents.on('status', ({ username, online }) => {
  if (botStatus[username]) {
    botStatus[username].online = online;
    if (online) botStatus[username].onlineSince = Date.now();
    else botStatus[username].onlineSince = null;
  }
  broadcast('status', { username, online, onlineSince: botStatus[username]?.onlineSince || null });
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
  // Replace (not accumulate) to prevent item count duplication
  if (containerCache[username]) containerCache[username] = { items: chests, ts: Date.now() };
  broadcast('stats', { username, stats: stats[username] });
  broadcast('containerUpdate', { username, data: containerCache[username] });
});
botEvents.on('mapUpdate', ({ username, png, ts }) => { broadcast('mapUpdate', { username, png, ts }); });
botEvents.on('coords', ({ username, coords: c }) => {
  coords[username] = { ...c, ts: Date.now() };
  broadcast('coords', { username, coords: coords[username] });
});

// ─── SSE ──────────────────────────────────────────────────────────────────────
const sseClients = new Set();
function broadcast(event, data) {
  sseClients.forEach(res => res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'));
}

app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write('event: init\ndata: ' + JSON.stringify({ logs: logBuffer, status: botStatus, stats, coords, serverInfo, maps: botMaps, serverStart: SERVER_START, botConfigs, botServers, host: utils.HOST, port: utils.MC_PORT }) + '\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ─── Bot launcher ─────────────────────────────────────────────────────────────
function launchBot(name) {
  const cfg = botConfigs[name];
  if (!cfg) return;
  const srv = botServers[name] || { host: utils.HOST, port: utils.MC_PORT };
  const opts = { proxy: cfg.proxy, host: srv.host, port: srv.port };
  let ctrl;
  if (cfg.type === 'kill') ctrl = require('./kill-bot').launch(name, opts);
  else ctrl = require('./afk-bot').launch(name, opts);
  controllers[name] = ctrl;
  return ctrl;
}

// ─── API ──────────────────────────────────────────────────────────────────────
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

app.post('/bot/add', (req, res) => {
  const { name, type, tag, host, port } = req.body;
  if (!name || !name.trim()) return res.json({ ok: false, reason: 'name required' });
  const n = name.trim();
  if (botStatus[n]) return res.json({ ok: false, reason: 'bot already exists' });
  const t = ['kill','afk'].includes(type) ? type : 'custom';
  initBotState(n, t, tag || '');
  if (host) botServers[n].host = host;
  if (port) botServers[n].port = parseInt(port);
  botStatus[n].running = true;
  launchBot(n);
  broadcast('botAdded', { name: n, status: botStatus[n], config: botConfigs[n], server: botServers[n] });
  res.json({ ok: true });
});

app.post('/bot/:name/remove', (req, res) => {
  const name = req.params.name;
  if (!botStatus[name]) return res.json({ ok: false, reason: 'unknown bot' });
  if (controllers[name]) { try { controllers[name].stop(); } catch(_){} delete controllers[name]; }
  delete botStatus[name]; delete stats[name]; delete coords[name]; delete botConfigs[name];
  delete botServers[name]; delete containerCache[name];
  broadcast('botRemoved', { name });
  res.json({ ok: true });
});

app.post('/bot/:name/rename', (req, res) => {
  const oldName = req.params.name;
  const { newName } = req.body;
  if (!newName || !newName.trim()) return res.json({ ok: false, reason: 'name required' });
  const nn = newName.trim();
  if (!botStatus[oldName]) return res.json({ ok: false, reason: 'unknown bot' });
  if (botStatus[nn] && nn !== oldName) return res.json({ ok: false, reason: 'name already taken' });
  if (controllers[oldName]) { try { controllers[oldName].stop(); } catch(_){} delete controllers[oldName]; }
  botStatus[nn] = { ...botStatus[oldName], running: false, online: false };
  stats[nn] = { ...stats[oldName] };
  coords[nn] = coords[oldName];
  botConfigs[nn] = { ...botConfigs[oldName], name: nn };
  botServers[nn] = { ...(botServers[oldName] || { host: utils.HOST, port: utils.MC_PORT }) };
  containerCache[nn] = { ...(containerCache[oldName] || { items: {}, ts: 0 }) };
  if (nn !== oldName) {
    delete botStatus[oldName]; delete stats[oldName]; delete coords[oldName];
    delete botConfigs[oldName]; delete botServers[oldName]; delete containerCache[oldName];
  }
  botStatus[nn].running = true;
  launchBot(nn);
  broadcast('botRenamed', { oldName, newName: nn, status: botStatus[nn], config: botConfigs[nn], server: botServers[nn] });
  res.json({ ok: true });
});

app.post('/bot/:name/proxy', (req, res) => {
  const name = req.params.name;
  if (!botConfigs[name]) return res.json({ ok: false, reason: 'unknown bot' });
  const { host, port, type, username, password } = req.body;
  botConfigs[name].proxy = host ? { host, port: parseInt(port)||1080, type: parseInt(type)||5, username, password } : null;
  broadcast('proxyUpdated', { name, proxy: botConfigs[name].proxy });
  res.json({ ok: true, proxy: botConfigs[name].proxy });
});

app.post('/bot/:name/server', (req, res) => {
  const name = req.params.name;
  if (!botConfigs[name]) return res.json({ ok: false, reason: 'unknown bot' });
  const { host, port } = req.body;
  if (host) botServers[name].host = host;
  if (port) botServers[name].port = parseInt(port);
  broadcast('botServerUpdated', { name, server: botServers[name] });
  res.json({ ok: true, server: botServers[name] });
});

app.get('/config/server', (req, res) => res.json({ host: utils.HOST, port: utils.MC_PORT }));
app.post('/config/server', (req, res) => {
  const { host, port } = req.body;
  utils.setServer(host || utils.HOST, port ? parseInt(port) : utils.MC_PORT);
  broadcast('serverConfig', { host: utils.HOST, port: utils.MC_PORT });
  res.json({ ok: true, host: utils.HOST, port: utils.MC_PORT });
});

app.post('/bot/:name/cmd', (req, res) => {
  const { name } = req.params, { cmd } = req.body;
  if (!cmd) return res.json({ ok: false, reason: 'no command' });
  const bot = botRegistry[name];
  if (!bot) return res.json({ ok: false, reason: 'bot not connected' });
  try { bot.chat(cmd); emit(name, 'chat', '[CMD] ' + cmd); res.json({ ok: true }); }
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
  emit(name, 'info', 'Manual container scan triggered...');
  // Reset cache before scan — prevents item count duplication on repeated scans
  containerCache[name] = { items: {}, ts: 0 };
  scanInventoryAndChests(bot, name).catch(() => {});
  res.json({ ok: true });
});

app.get('/bot/:name/containers', (req, res) => {
  res.json({ ok: true, data: containerCache[req.params.name] || { items: {}, ts: 0 } });
});

app.get('/bot/:name/map', (req, res) => {
  const map = botMaps[req.params.name];
  if (!map) return res.json({ ok: false, reason: 'no map data' });
  res.json({ ok: true, ...map });
});

app.get('/serverinfo', async (req, res) => {
  try {
    const host = req.query.host || utils.HOST;
    const port = req.query.port ? parseInt(req.query.port) : utils.MC_PORT;
    const info = await fetchServerInfo(host, port);
    if (!req.query.host) { serverInfo = info; if (info) broadcast('serverInfo', info); }
    res.json(info || { error: 'ping failed' });
  } catch(_) { res.json({ error: 'ping error' }); }
});

const eventQueue = []; let eventId = 0;
botEvents.on('log', (entry) => { eventQueue.push({ id: ++eventId, event: 'log', data: entry }); if (eventQueue.length > 500) eventQueue.shift(); });

app.get('/poll', (req, res) => {
  const since = parseInt(req.query.since) || 0;
  res.json({ lastId: eventId, events: eventQueue.filter(e => e.id > since), state: { status: botStatus, stats, coords, serverInfo, serverStart: SERVER_START, host: utils.HOST, port: utils.MC_PORT, botConfigs, botServers } });
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
:root{
  --fd:'Rajdhani','Segoe UI','Ubuntu',Arial,sans-serif;
  --fm:'JetBrains Mono','Fira Code','Consolas','Courier New',monospace;
  --bg:#050210;--panel:rgba(15,7,42,0.92);--glass:rgba(139,92,246,0.07);
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
body{background:var(--bg);color:var(--text);font-family:var(--fm);font-size:13px;min-height:100vh;display:flex;flex-direction:column;overflow-x:hidden}
#bg-canvas{position:fixed;inset:0;z-index:0;pointer-events:none;opacity:.55}
.grid-overlay{position:fixed;inset:0;z-index:0;pointer-events:none;background-image:linear-gradient(rgba(139,92,246,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(139,92,246,.04) 1px,transparent 1px);background-size:44px 44px}
.blob{position:fixed;border-radius:50%;filter:blur(90px);pointer-events:none;z-index:0;animation:blobMove 22s ease-in-out infinite}
.blob1{width:600px;height:600px;background:radial-gradient(circle,rgba(112,40,220,.25),transparent 70%);top:-200px;left:-200px}
.blob2{width:500px;height:500px;background:radial-gradient(circle,rgba(60,20,160,.2),transparent 70%);bottom:-150px;right:-150px;animation-delay:-7s}
.blob3{width:400px;height:400px;background:radial-gradient(circle,rgba(180,60,255,.15),transparent 70%);top:40%;left:40%;animation-delay:-14s}
@keyframes blobMove{0%,100%{transform:translate(0,0) scale(1)}33%{transform:translate(30px,-40px) scale(1.05)}66%{transform:translate(-20px,25px) scale(.95)}}
.content{position:relative;z-index:1;display:flex;flex-direction:column;min-height:100vh}
/* Header */
.hdr{background:rgba(10,5,30,0.95);border-bottom:1px solid var(--border);padding:10px 22px;display:flex;align-items:center;gap:14px;position:sticky;top:0;z-index:50;backdrop-filter:blur(20px)}
.logo{font-family:var(--fd);font-size:22px;font-weight:700;letter-spacing:4px;background:linear-gradient(135deg,var(--v3),var(--v),var(--vneon));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;filter:drop-shadow(0 0 12px rgba(139,92,246,.6))}
.logo span{-webkit-text-fill-color:rgba(255,255,255,.5)}
.uptime-pill{background:var(--glass);border:1px solid var(--border);border-radius:20px;padding:3px 12px;font-size:11px;color:var(--dim2);display:flex;align-items:center;gap:6px}
.uptime-pill .dot{width:6px;height:6px;border-radius:50%;background:var(--v);box-shadow:0 0 8px var(--v);animation:pulse 2s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
#uptime{color:var(--v2);font-weight:600}
.hdr-right{margin-left:auto;display:flex;align-items:center;gap:8px}
.conn-pill{display:flex;align-items:center;gap:6px;background:var(--glass);border:1px solid var(--border);border-radius:20px;padding:3px 12px;font-size:11px}
.conn-dot{width:7px;height:7px;border-radius:50%;background:var(--yellow);transition:all .4s}
.conn-dot.live{background:var(--green);box-shadow:0 0 10px var(--green)}
.conn-dot.dead{background:var(--red)}
.icon-btn{background:var(--glass);border:1px solid var(--border);color:var(--dim2);border-radius:8px;padding:6px 10px;cursor:pointer;font-size:14px;transition:all .2s;font-family:inherit}
.icon-btn:hover{border-color:var(--v);color:var(--v2);box-shadow:var(--glow)}
/* Server bar */
.srv-bar{background:rgba(12,6,32,0.9);border-bottom:1px solid var(--border);padding:8px 22px;display:flex;align-items:center;gap:12px;backdrop-filter:blur(10px)}
.srv-favicon{width:34px;height:34px;border-radius:6px;background:var(--glass);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:16px;overflow:hidden;flex-shrink:0;image-rendering:pixelated}
.srv-favicon img{width:100%;height:100%;image-rendering:pixelated}
.srv-motd{font-size:12px;color:var(--v2);margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:var(--fd);font-weight:600;letter-spacing:.5px}
.srv-meta{display:flex;gap:14px;font-size:10px;color:var(--dim)}
.srv-online{color:var(--green);font-weight:700}
.srv-addr{color:var(--v3);cursor:pointer;text-decoration:underline dotted}
.srv-addr:hover{color:var(--v2)}
.ping-btn{background:var(--glass);border:1px solid var(--border);color:var(--dim);font-family:inherit;font-size:10px;padding:3px 10px;border-radius:6px;cursor:pointer;transition:all .2s;flex-shrink:0}
.ping-btn:hover{border-color:var(--v);color:var(--v2)}
/* Main */
.main{flex:1;padding:16px 20px;display:flex;flex-direction:column;gap:16px}
/* Cards with arrow scroll */
.cards-outer{position:relative;display:flex;align-items:center;gap:6px}
.scroll-arrow{background:rgba(139,92,246,.15);border:1px solid var(--border);color:var(--v2);border-radius:8px;padding:8px 10px;cursor:pointer;font-size:16px;line-height:1;flex-shrink:0;transition:all .2s;user-select:none}
.scroll-arrow:hover{background:rgba(139,92,246,.3);border-color:var(--v)}
.cards-wrap{display:flex;flex-wrap:nowrap;gap:14px;overflow-x:auto;scroll-behavior:smooth;padding-bottom:4px;flex:1;align-items:flex-start}
.cards-wrap::-webkit-scrollbar{height:3px}
.cards-wrap::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}
/* Bot card */
.bot-card{background:var(--panel);border:1px solid var(--border);border-radius:var(--r);padding:14px;width:272px;flex-shrink:0;transition:border-color .35s,box-shadow .35s;position:relative;overflow:hidden;animation:cardIn .4s ease both;cursor:pointer}
@keyframes cardIn{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}
.bot-card::before{content:'';position:absolute;inset:0;background:linear-gradient(135deg,rgba(139,92,246,.06),transparent 60%);pointer-events:none}
.bot-card.online{border-color:rgba(52,211,153,.45);box-shadow:0 0 20px rgba(52,211,153,.08)}
.bot-card.offline{border-color:rgba(248,113,113,.3)}
.card-top{display:flex;align-items:flex-start;gap:10px;margin-bottom:10px}
.bot-skin{width:42px;height:42px;border-radius:7px;border:2px solid var(--border);overflow:hidden;flex-shrink:0;background:var(--glass)}
.bot-skin img{width:100%;height:100%}
.card-info{flex:1;min-width:0}
.bot-name-row{display:flex;align-items:center;gap:4px;margin-bottom:2px}
.bot-name{font-family:var(--fd);font-weight:700;font-size:15px;letter-spacing:.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:120px}
.bot-tag{font-size:9px;padding:1px 6px;border-radius:7px;background:rgba(139,92,246,.15);border:1px solid var(--border);color:var(--v3);letter-spacing:.5px;white-space:nowrap;max-width:65px;overflow:hidden;text-overflow:ellipsis;flex-shrink:0}
.rename-btn{background:none;border:none;color:var(--dim);cursor:pointer;font-size:11px;padding:2px 3px;border-radius:3px;transition:color .2s;line-height:1;flex-shrink:0}
.rename-btn:hover{color:var(--v2)}
.bot-type-badge{display:inline-flex;align-items:center;gap:4px;font-size:9px;font-family:var(--fd);font-weight:600;letter-spacing:1.5px;padding:2px 7px;border-radius:9px}
.type-kill{background:rgba(248,113,113,.12);color:var(--red);border:1px solid rgba(248,113,113,.3)}
.type-afk{background:rgba(96,165,250,.12);color:var(--cyan);border:1px solid rgba(96,165,250,.3)}
.type-custom{background:rgba(251,191,36,.1);color:var(--yellow);border:1px solid rgba(251,191,36,.3)}
.status-badge{margin-left:auto;font-size:9px;font-family:var(--fd);font-weight:700;letter-spacing:2px;padding:2px 9px;border-radius:10px;flex-shrink:0}
.status-badge.online{color:var(--green);background:var(--green-bg);border:1px solid var(--green-bd);animation:sGlow 2s ease-in-out infinite}
.status-badge.offline{color:var(--red);background:var(--red-bg);border:1px solid var(--red-bd)}
@keyframes sGlow{0%,100%{box-shadow:0 0 6px rgba(52,211,153,.4)}50%{box-shadow:0 0 14px rgba(52,211,153,.7)}}
.stats-row{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-bottom:8px}
.stat-box{background:rgba(0,0,0,.3);border:1px solid var(--border);border-radius:6px;padding:5px 8px;text-align:center}
.stat-label{font-size:8px;color:var(--dim);letter-spacing:1px;font-family:var(--fd);font-weight:600;margin-bottom:2px}
.stat-val{font-size:14px;font-weight:700;color:var(--v2)}
.coords-row{background:rgba(0,0,0,.22);border:1px solid var(--border);border-radius:6px;padding:5px 8px;margin-bottom:7px;display:flex;align-items:center;gap:5px;font-size:10px}
.coords-xyz{color:var(--teal);font-weight:600;flex:1;font-size:10px}
.coords-ts{color:var(--dim);font-size:9px}
.coords-refresh{background:none;border:none;color:var(--dim);cursor:pointer;font-size:12px;padding:0;transition:color .2s;line-height:1}
.coords-refresh:hover{color:var(--teal)}
/* Inventory row */
.inv-row{background:rgba(0,0,0,.22);border:1px solid var(--border);border-radius:6px;padding:5px 8px;margin-bottom:8px;display:flex;align-items:center;gap:5px;font-size:10px}
.inv-summary{color:var(--dim2);flex:1;font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.inv-open-btn{background:rgba(139,92,246,.12);border:1px solid var(--border);color:var(--v2);font-family:inherit;font-size:9px;padding:2px 7px;border-radius:4px;cursor:pointer;transition:all .2s;flex-shrink:0}
.inv-open-btn:hover{border-color:var(--v);background:rgba(139,92,246,.25)}
.scan-btn{background:none;border:1px solid var(--border);color:var(--dim);font-family:inherit;font-size:9px;padding:2px 7px;border-radius:4px;cursor:pointer;transition:all .2s;flex-shrink:0}
.scan-btn:hover{border-color:var(--orange);color:var(--orange)}
/* Proxy */
.proxy-row{display:flex;align-items:center;gap:5px;margin-bottom:8px;font-size:10px}
.proxy-badge{display:flex;align-items:center;gap:3px;padding:2px 7px;border-radius:4px;font-size:9px;font-family:var(--fd);font-weight:600;letter-spacing:.5px}
.proxy-badge.active{background:rgba(251,191,36,.1);color:var(--yellow);border:1px solid rgba(251,191,36,.3)}
.proxy-badge.inactive{background:var(--glass);color:var(--dim);border:1px solid var(--border)}
.proxy-set-btn{margin-left:auto;background:none;border:1px solid var(--border);color:var(--dim);font-family:inherit;font-size:9px;padding:2px 7px;border-radius:4px;cursor:pointer;transition:all .2s}
.proxy-set-btn:hover{border-color:var(--yellow);color:var(--yellow)}
/* Action buttons */
.actions{display:flex;gap:4px}
.act-btn{flex:1;min-width:0;border-radius:6px;padding:6px 3px;font-family:var(--fd);font-size:11px;font-weight:700;letter-spacing:.5px;cursor:pointer;transition:all .2s;border:1px solid;text-align:center}
.act-btn:disabled{opacity:.25;cursor:not-allowed}
.act-btn:not(:disabled):hover{transform:translateY(-1px)}
.btn-start{background:var(--green-bg);color:var(--green);border-color:var(--green-bd)}
.btn-start:not(:disabled):hover{box-shadow:0 0 14px rgba(52,211,153,.35)}
.btn-stop{background:var(--red-bg);color:var(--red);border-color:var(--red-bd)}
.btn-stop:not(:disabled):hover{box-shadow:0 0 14px rgba(248,113,113,.35)}
.btn-ico{flex:0 0 30px;background:var(--glass);color:var(--v2);border-color:var(--border)}
.btn-ico:hover{border-color:var(--v);box-shadow:var(--glow)}
.btn-remove{flex:0 0 26px;background:var(--glass);color:var(--dim);border-color:var(--border);font-size:10px}
.btn-remove:hover{border-color:var(--red-bd);color:var(--red)}
/* Add card */
.add-card{background:var(--glass);border:1px dashed var(--border);border-radius:var(--r);padding:16px;width:150px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;cursor:pointer;transition:all .3s;min-height:180px;flex-shrink:0}
.add-card:hover{border-color:var(--v);background:rgba(139,92,246,.08);box-shadow:var(--glow)}
.add-icon{font-size:30px;opacity:.4}
.add-label{font-family:var(--fd);font-size:13px;font-weight:600;color:var(--dim);letter-spacing:1px}
/* Unified log panel */
.log-panel{background:var(--panel);border:1px solid var(--border);border-radius:var(--r);display:flex;flex-direction:column;overflow:hidden;height:310px}
.log-head{padding:6px 10px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:5px;flex-shrink:0;background:rgba(0,0,0,.2);flex-wrap:nowrap;overflow:hidden}
.log-title{font-family:var(--fd);color:var(--v2);font-weight:700;font-size:12px;letter-spacing:.5px;flex-shrink:0;margin-right:4px}
.bot-tabs{display:flex;gap:3px;overflow-x:auto;flex:1;min-width:0}
.bot-tabs::-webkit-scrollbar{display:none}
.bot-tab{background:none;border:1px solid var(--border);color:var(--dim);font-family:var(--fd);font-size:9px;font-weight:600;letter-spacing:.3px;padding:2px 8px;border-radius:4px;cursor:pointer;transition:all .2s;white-space:nowrap;flex-shrink:0}
.bot-tab.active{border-color:var(--v);color:var(--v2);background:rgba(139,92,246,.15)}
.type-filters{display:flex;gap:3px;flex-shrink:0}
.filter-btn{background:none;border:1px solid var(--border);color:var(--dim);font-family:var(--fd);font-size:9px;font-weight:600;letter-spacing:.5px;padding:1px 6px;border-radius:4px;cursor:pointer;transition:all .2s;flex-shrink:0}
.filter-btn.active{border-color:var(--v);color:var(--v2);background:rgba(139,92,246,.12)}
.clr-btn{background:none;border:none;color:var(--dim);font-family:inherit;font-size:10px;cursor:pointer;transition:color .2s;padding:0 3px;flex-shrink:0}
.clr-btn:hover{color:var(--red)}
.log-area{flex:1;overflow-y:auto;padding:2px 8px}
.log-area::-webkit-scrollbar{width:3px}
.log-area::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}
.log-entry{display:flex;gap:4px;padding:1.5px 0;border-bottom:1px solid rgba(112,70,220,.07);line-height:1.6;font-size:10.5px}
.log-ts{color:var(--dim);flex-shrink:0;width:60px;font-size:9px;opacity:.7}
.log-bot{font-size:8.5px;color:var(--v3);flex-shrink:0;width:52px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--fd)}
.log-tag{font-size:8.5px;font-weight:700;letter-spacing:.5px;flex-shrink:0;width:38px;text-align:right;padding-right:3px;font-family:var(--fd)}
.log-msg{flex:1;word-break:break-word}
.t-info .log-tag{color:var(--cyan)}.t-info .log-msg{color:#c8d8f0}
.t-error .log-tag,.t-error .log-msg{color:var(--red)}
.t-kick .log-tag,.t-kick .log-msg{color:var(--orange)}
.t-disconnect .log-tag,.t-disconnect .log-msg{color:var(--orange);opacity:.8}
.t-reconnect .log-tag,.t-reconnect .log-msg{color:var(--yellow)}
.t-kill .log-tag,.t-kill .log-msg{color:var(--pink)}
.t-food .log-tag,.t-food .log-msg{color:var(--green)}
.t-chat .log-tag,.t-chat .log-msg{color:var(--v2)}
.t-inv .log-tag,.t-inv .log-msg{color:var(--teal)}
.t-error{background:rgba(248,113,113,.04)}.t-kick{background:rgba(251,146,60,.04)}.t-kill{background:rgba(244,114,182,.04)}
.log-cmd-bar{display:flex;border-top:1px solid var(--border);flex-shrink:0}
.cmd-field{flex:1;background:rgba(0,0,0,.4);border:none;color:var(--text);font-family:var(--fm);font-size:11px;padding:7px 10px;outline:none}
.cmd-field::placeholder{color:var(--dim)}
.cmd-go{background:var(--green-bg);border:none;border-left:1px solid var(--border);color:var(--green);font-family:var(--fd);font-weight:600;font-size:11px;padding:7px 14px;cursor:pointer;transition:background .2s}
.cmd-go:hover{background:rgba(6,60,38,.9)}
/* Modals */
.overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:100;align-items:center;justify-content:center;backdrop-filter:blur(6px)}
.overlay.show{display:flex;animation:fadeIn .15s ease}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
.modal{background:linear-gradient(160deg,rgba(18,8,50,.98),rgba(10,5,30,.98));border:1px solid var(--border2);border-radius:14px;display:flex;flex-direction:column;overflow:hidden;box-shadow:var(--glow2),0 20px 60px rgba(0,0,0,.7);animation:modalIn .2s ease}
@keyframes modalIn{from{opacity:0;transform:translateY(18px) scale(.97)}to{opacity:1;transform:translateY(0) scale(1)}}
.modal-hdr{padding:13px 17px;border-bottom:1px solid var(--border);display:flex;align-items:center;background:rgba(0,0,0,.2)}
.modal-title{font-family:var(--fd);font-weight:700;font-size:15px;color:var(--v2);flex:1;letter-spacing:.5px}
.modal-x{background:none;border:none;color:var(--dim);cursor:pointer;font-size:17px;line-height:1;transition:color .2s;padding:2px 5px}
.modal-x:hover{color:var(--red)}
/* Detail modal */
#detail-overlay .modal{width:710px;max-width:97vw;height:80vh}
.detail-body{flex:1;display:flex;overflow:hidden}
.detail-left{width:210px;flex-shrink:0;border-right:1px solid var(--border);padding:12px;display:flex;flex-direction:column;gap:9px;overflow-y:auto}
.detail-right{flex:1;display:flex;flex-direction:column;overflow:hidden}
.detail-srv-row{display:flex;align-items:center;gap:8px}
.detail-fav{width:38px;height:38px;border-radius:7px;border:1px solid var(--border);background:var(--glass);display:flex;align-items:center;justify-content:center;font-size:18px;overflow:hidden;flex-shrink:0;image-rendering:pixelated}
.detail-fav img{width:100%;height:100%;image-rendering:pixelated}
.detail-srv-motd{font-family:var(--fd);font-weight:600;font-size:11px;color:var(--v2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.detail-srv-addr{font-size:10px;color:var(--teal)}
.detail-stat-grid{display:grid;grid-template-columns:1fr 1fr;gap:5px}
.detail-stat{background:rgba(0,0,0,.3);border:1px solid var(--border);border-radius:6px;padding:5px 7px;text-align:center}
.detail-stat-l{font-size:8px;color:var(--dim);font-family:var(--fd);font-weight:600;letter-spacing:1px;margin-bottom:2px}
.detail-stat-v{font-size:13px;font-weight:700;color:var(--v2)}
.detail-sec{font-family:var(--fd);font-size:9px;font-weight:700;letter-spacing:1.5px;color:var(--dim);margin-top:4px;border-top:1px solid var(--border);padding-top:5px}
.detail-log-head{padding:5px 10px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:4px;background:rgba(0,0,0,.15);flex-shrink:0}
.detail-log{flex:1;overflow-y:auto;padding:2px 10px}
.detail-log::-webkit-scrollbar{width:3px}
.detail-log::-webkit-scrollbar-thumb{background:var(--border)}
.detail-cmd{display:flex;border-top:1px solid var(--border);flex-shrink:0}
.detail-field{flex:1;background:rgba(0,0,0,.5);border:none;color:var(--text);font-family:var(--fm);font-size:12px;padding:9px 12px;outline:none}
.detail-send{background:var(--green-bg);border:none;border-left:1px solid var(--border);color:var(--green);font-family:var(--fd);font-weight:700;padding:9px 16px;cursor:pointer;font-size:12px;letter-spacing:.5px}
/* Inventory modal */
#inv-overlay .modal{width:450px;max-width:95vw}
.inv-body{padding:14px;display:flex;flex-direction:column;gap:10px;max-height:68vh;overflow-y:auto}
.inv-sec-title{font-family:var(--fd);font-size:10px;font-weight:700;letter-spacing:1.5px;color:var(--dim2);border-bottom:1px solid var(--border);padding-bottom:4px}
.inv-grid{display:flex;flex-wrap:wrap;gap:5px;margin-top:5px}
.inv-chip{background:rgba(0,0,0,.32);border:1px solid var(--border);border-radius:5px;padding:3px 9px;font-size:10px;display:flex;align-items:center;gap:5px}
.inv-chip-name{color:var(--dim2)}
.inv-chip-count{color:var(--orange);font-weight:700}
.inv-empty{color:var(--dim);font-size:10px;font-style:italic}
/* Map modal */
#map-overlay .modal{width:380px;max-width:95vw}
.map-body{padding:16px;display:flex;flex-direction:column;align-items:center;gap:10px}
#map-img{width:256px;height:256px;background:rgba(0,0,0,.4);border:2px solid var(--border2);border-radius:6px;display:flex;align-items:center;justify-content:center;color:var(--dim);font-size:11px;text-align:center;image-rendering:pixelated}
#map-img img{width:100%;height:100%;image-rendering:pixelated}
.map-hint{font-size:10px;color:var(--dim);text-align:center}
.map-input-row{display:flex;gap:6px;width:100%}
#map-answer{flex:1;background:rgba(0,0,0,.4);border:1px solid var(--border2);color:var(--text);font-family:var(--fm);font-size:14px;padding:9px;border-radius:7px;outline:none;text-align:center;letter-spacing:3px;transition:border-color .2s}
#map-answer:focus{border-color:var(--v)}
#map-submit{background:rgba(139,92,246,.2);border:1px solid var(--v);color:var(--v2);font-family:var(--fd);font-size:13px;font-weight:700;padding:9px 16px;border-radius:7px;cursor:pointer}
.map-refresh{background:var(--glass);border:1px solid var(--border);color:var(--dim);font-family:inherit;font-size:10px;padding:5px 14px;border-radius:6px;cursor:pointer;width:100%;transition:all .2s}
.map-refresh:hover{border-color:var(--v);color:var(--v2)}
.map-status{font-size:11px;min-height:15px;font-family:var(--fd);font-weight:600}
.map-status.ok{color:var(--green)}.map-status.err{color:var(--red)}
/* Shared modal body */
.modal-body{padding:16px;display:flex;flex-direction:column;gap:11px}
.field-group{display:flex;flex-direction:column;gap:5px}
.field-label{font-family:var(--fd);font-size:11px;font-weight:600;letter-spacing:1px;color:var(--dim2)}
.field-input{background:rgba(0,0,0,.4);border:1px solid var(--border);color:var(--text);font-family:var(--fm);font-size:12px;padding:9px 11px;border-radius:7px;outline:none;transition:border-color .2s;width:100%}
.field-input:focus{border-color:var(--v);box-shadow:0 0 0 2px rgba(139,92,246,.12)}
.field-select{background:rgba(5,2,20,.9);border:1px solid var(--border);color:var(--text);font-family:var(--fd);font-size:13px;font-weight:600;padding:9px 11px;border-radius:7px;outline:none;cursor:pointer;width:100%}
.field-select:focus{border-color:var(--v)}
.field-row{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.type-toggle{display:grid;grid-template-columns:1fr 1fr 1fr;gap:5px}
.type-opt{background:var(--glass);border:1px solid var(--border);border-radius:7px;padding:8px 4px;text-align:center;cursor:pointer;transition:all .2s;font-family:var(--fd);font-weight:600;font-size:11px;letter-spacing:.5px;color:var(--dim)}
.type-opt.selected.kill{background:rgba(248,113,113,.12);border-color:rgba(248,113,113,.4);color:var(--red)}
.type-opt.selected.afk{background:rgba(56,189,248,.12);border-color:rgba(56,189,248,.4);color:var(--cyan)}
.type-opt.selected.custom{background:rgba(251,191,36,.1);border-color:rgba(251,191,36,.4);color:var(--yellow)}
.modal-btn{background:linear-gradient(135deg,var(--vneon),var(--v));border:none;color:#fff;font-family:var(--fd);font-size:14px;font-weight:700;padding:10px;border-radius:8px;cursor:pointer;letter-spacing:1px;transition:all .2s;box-shadow:0 4px 18px rgba(139,92,246,.4)}
.modal-btn:hover{box-shadow:0 6px 26px rgba(139,92,246,.6);transform:translateY(-1px)}
.modal-btn-sec{background:var(--glass);border:1px solid var(--border);color:var(--dim2);font-family:var(--fd);font-size:13px;font-weight:600;padding:9px;border-radius:8px;cursor:pointer;transition:all .2s}
.modal-btn-sec:hover{border-color:var(--v);color:var(--v2)}
.btn-row{display:flex;gap:8px}
.btn-row .modal-btn{flex:1}
.btn-row .modal-btn-sec{flex:0 0 auto}
.srv-note{font-size:10px;color:var(--dim);text-align:center;line-height:1.5}
.proxy-clear-btn{background:none;border:1px solid var(--red-bd);color:var(--red);font-family:inherit;font-size:11px;padding:5px 12px;border-radius:6px;cursor:pointer;transition:all .2s}
.proxy-clear-btn:hover{background:var(--red-bg)}
#add-overlay .modal{width:400px;max-width:95vw}
#srv-overlay .modal,#proxy-overlay .modal,#bsrv-overlay .modal{width:390px;max-width:95vw}
#rename-overlay .modal{width:350px;max-width:95vw}
::-webkit-scrollbar{width:4px;height:4px}
::-webkit-scrollbar-thumb{background:rgba(139,92,246,.35);border-radius:4px}
::-webkit-scrollbar-track{background:transparent}
</style>
</head>
<body>
<canvas id="bg-canvas"></canvas>
<div class="grid-overlay"></div>
<div class="blob blob1"></div><div class="blob blob2"></div><div class="blob blob3"></div>
<div class="content">

<div class="hdr">
  <div class="logo">NEXUS<span>BOT</span></div>
  <div class="uptime-pill"><div class="dot"></div>UP <span id="uptime">00:00:00</span></div>
  <div class="hdr-right">
    <div class="conn-pill"><div class="conn-dot" id="conn-dot"></div><span id="conn-text" style="font-size:10px;color:var(--dim2)">Connecting</span></div>
    <button class="icon-btn" onclick="startPoll()" title="Reconnect">&#8635;</button>
    <button class="icon-btn" onclick="openOverlay('srv-overlay')" title="Server Settings">&#9881;</button>
  </div>
</div>

<div class="srv-bar">
  <div class="srv-favicon" id="srv-fav">&#127760;</div>
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
  <div class="cards-outer">
    <button class="scroll-arrow" onclick="scrollCards(-1)">&#8592;</button>
    <div class="cards-wrap" id="cards"></div>
    <button class="scroll-arrow" onclick="scrollCards(1)">&#8594;</button>
  </div>
  <div class="log-panel">
    <div class="log-head">
      <span class="log-title">LOG</span>
      <div class="bot-tabs" id="bot-tabs"></div>
      <div class="type-filters">
        <button class="filter-btn active" data-lf="all">ALL</button>
        <button class="filter-btn" data-lf="error">ERR</button>
        <button class="filter-btn" data-lf="kill">KILL</button>
        <button class="filter-btn" data-lf="chat">CHAT</button>
        <button class="filter-btn" data-lf="inv">INV</button>
      </div>
      <button class="clr-btn" onclick="clearMainLog()">CLR</button>
    </div>
    <div class="log-area" id="main-log"></div>
    <div class="log-cmd-bar">
      <input class="cmd-field" id="main-cmd" placeholder="Select a bot tab, then type command...">
      <button class="cmd-go" onclick="sendMainCmd()">&#9654;</button>
    </div>
  </div>
</div>
</div>

<!-- Detail Modal -->
<div class="overlay" id="detail-overlay" onclick="if(event.target===this)closeOverlay('detail-overlay')">
  <div class="modal">
    <div class="modal-hdr"><span class="modal-title" id="detail-title">Bot Details</span><button class="modal-x" onclick="closeOverlay('detail-overlay')">&#10005;</button></div>
    <div class="detail-body">
      <div class="detail-left" id="detail-left"></div>
      <div class="detail-right">
        <div class="detail-log-head">
          <span style="font-family:var(--fd);font-size:11px;font-weight:700;color:var(--v2);margin-right:4px">CONSOLE</span>
          <div class="type-filters" id="detail-type-filters">
            <button class="filter-btn active" data-df="all">ALL</button>
            <button class="filter-btn" data-df="error">ERR</button>
            <button class="filter-btn" data-df="kill">KILL</button>
            <button class="filter-btn" data-df="chat">CHAT</button>
            <button class="filter-btn" data-df="inv">INV</button>
          </div>
          <button class="clr-btn" onclick="document.getElementById('detail-log').innerHTML=''">CLR</button>
        </div>
        <div class="detail-log" id="detail-log"></div>
        <div class="detail-cmd">
          <input class="detail-field" id="detail-cmd-field" placeholder="Type command..." onkeydown="if(event.key==='Enter')sendDetailCmd()">
          <button class="detail-send" onclick="sendDetailCmd()">SEND</button>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- Inventory Modal -->
<div class="overlay" id="inv-overlay" onclick="if(event.target===this)closeOverlay('inv-overlay')">
  <div class="modal">
    <div class="modal-hdr"><span class="modal-title" id="inv-title">Inventory</span><button class="modal-x" onclick="closeOverlay('inv-overlay')">&#10005;</button></div>
    <div class="inv-body" id="inv-body"></div>
  </div>
</div>

<!-- Map Modal -->
<div class="overlay" id="map-overlay" onclick="if(event.target===this)closeOverlay('map-overlay')">
  <div class="modal">
    <div class="modal-hdr"><span class="modal-title" id="map-title">Map Captcha</span><button class="modal-x" onclick="closeOverlay('map-overlay')">&#10005;</button></div>
    <div class="map-body">
      <div id="map-img">No map data.<br>Bot must hold a map item.</div>
      <div class="map-hint">Read the captcha from the map and enter below</div>
      <div class="map-input-row">
        <input id="map-answer" placeholder="Answer..." onkeydown="if(event.key==='Enter')submitMap()">
        <button id="map-submit" onclick="submitMap()">SEND</button>
      </div>
      <button class="map-refresh" onclick="fetchMap()">&#8635; Refresh</button>
      <div class="map-status" id="map-status"></div>
    </div>
  </div>
</div>

<!-- Add Bot -->
<div class="overlay" id="add-overlay" onclick="if(event.target===this)closeOverlay('add-overlay')">
  <div class="modal">
    <div class="modal-hdr"><span class="modal-title">+ Add New Bot</span><button class="modal-x" onclick="closeOverlay('add-overlay')">&#10005;</button></div>
    <div class="modal-body">
      <div class="field-group"><div class="field-label">USERNAME</div><input class="field-input" id="add-name" placeholder="e.g. MyBot123" maxlength="16"></div>
      <div class="field-group"><div class="field-label">TAG (optional)</div><input class="field-input" id="add-tag" placeholder="e.g. main, backup, raid..." maxlength="16"></div>
      <div class="field-group">
        <div class="field-label">BOT TYPE</div>
        <div class="type-toggle">
          <div class="type-opt kill selected" id="add-type-kill" onclick="selectAddType('kill')">&#9876; KILL</div>
          <div class="type-opt afk" id="add-type-afk" onclick="selectAddType('afk')">&#128164; AFK</div>
          <div class="type-opt custom" id="add-type-custom" onclick="selectAddType('custom')">&#9881; CUSTOM</div>
        </div>
      </div>
      <div class="field-group">
        <div class="field-label">SERVER (leave blank to use global)</div>
        <div class="field-row">
          <input class="field-input" id="add-host" placeholder="play.example.net">
          <input class="field-input" id="add-port" placeholder="25565" type="number">
        </div>
      </div>
      <div class="btn-row"><button class="modal-btn" onclick="doAddBot()">LAUNCH BOT</button><button class="modal-btn-sec" onclick="closeOverlay('add-overlay')">Cancel</button></div>
    </div>
  </div>
</div>

<!-- Global Server -->
<div class="overlay" id="srv-overlay" onclick="if(event.target===this)closeOverlay('srv-overlay')">
  <div class="modal">
    <div class="modal-hdr"><span class="modal-title">&#9881; Global Server Config</span><button class="modal-x" onclick="closeOverlay('srv-overlay')">&#10005;</button></div>
    <div class="modal-body">
      <div class="field-group"><div class="field-label">HOST</div><input class="field-input" id="srv-host-input" placeholder="play.example.net"></div>
      <div class="field-group"><div class="field-label">PORT</div><input class="field-input" id="srv-port-input" placeholder="25565" type="number"></div>
      <div class="srv-note">Default for all bots. Each bot can override via &#127760; button on its card.</div>
      <div class="btn-row"><button class="modal-btn" onclick="saveServerConfig()">SAVE</button><button class="modal-btn-sec" onclick="closeOverlay('srv-overlay')">Cancel</button></div>
    </div>
  </div>
</div>

<!-- Proxy -->
<div class="overlay" id="proxy-overlay" onclick="if(event.target===this)closeOverlay('proxy-overlay')">
  <div class="modal">
    <div class="modal-hdr"><span class="modal-title" id="proxy-title">Proxy Config</span><button class="modal-x" onclick="closeOverlay('proxy-overlay')">&#10005;</button></div>
    <div class="modal-body">
      <div class="field-group"><div class="field-label">SOCKS HOST</div><input class="field-input" id="proxy-host" placeholder="127.0.0.1"></div>
      <div class="field-row">
        <div class="field-group"><div class="field-label">PORT</div><input class="field-input" id="proxy-port" placeholder="1080" type="number"></div>
        <div class="field-group"><div class="field-label">TYPE</div><select class="field-select" id="proxy-type"><option value="5">SOCKS5</option><option value="4">SOCKS4</option></select></div>
      </div>
      <div class="field-group"><div class="field-label">USERNAME (optional)</div><input class="field-input" id="proxy-user" placeholder="leave blank if none"></div>
      <div class="field-group"><div class="field-label">PASSWORD (optional)</div><input class="field-input" id="proxy-pass" type="password" placeholder="leave blank if none"></div>
      <div class="btn-row"><button class="modal-btn" onclick="saveProxy()">APPLY</button><button class="modal-btn-sec proxy-clear-btn" onclick="clearProxy()">Clear</button></div>
    </div>
  </div>
</div>

<!-- Rename -->
<div class="overlay" id="rename-overlay" onclick="if(event.target===this)closeOverlay('rename-overlay')">
  <div class="modal">
    <div class="modal-hdr"><span class="modal-title">&#9998; Rename Bot</span><button class="modal-x" onclick="closeOverlay('rename-overlay')">&#10005;</button></div>
    <div class="modal-body">
      <div class="field-group"><div class="field-label">NEW USERNAME</div><input class="field-input" id="rename-input" placeholder="New username..." maxlength="16" onkeydown="if(event.key==='Enter')doRename()"></div>
      <div class="srv-note">&#9888; Bot will disconnect and reconnect with new name.</div>
      <div class="btn-row"><button class="modal-btn" onclick="doRename()">RENAME &amp; RECONNECT</button><button class="modal-btn-sec" onclick="closeOverlay('rename-overlay')">Cancel</button></div>
    </div>
  </div>
</div>

<!-- Per-bot server -->
<div class="overlay" id="bsrv-overlay" onclick="if(event.target===this)closeOverlay('bsrv-overlay')">
  <div class="modal">
    <div class="modal-hdr"><span class="modal-title" id="bsrv-title">Bot Server</span><button class="modal-x" onclick="closeOverlay('bsrv-overlay')">&#10005;</button></div>
    <div class="modal-body">
      <div class="field-group"><div class="field-label">HOST</div><input class="field-input" id="bsrv-host" placeholder="play.example.net"></div>
      <div class="field-group"><div class="field-label">PORT</div><input class="field-input" id="bsrv-port" placeholder="25565" type="number"></div>
      <div class="srv-note">Takes effect on next start/restart.</div>
      <div class="btn-row"><button class="modal-btn" onclick="saveBotServer()">SAVE</button><button class="modal-btn-sec" onclick="closeOverlay('bsrv-overlay')">Cancel</button></div>
    </div>
  </div>
</div>

<script>
var MAXD=200;
var TAGS={info:'INFO',error:'ERR',kick:'KICK',disconnect:'DISC',reconnect:'RCON',kill:'KILL',food:'FOOD',chat:'CHAT',inv:'INV'};
var status={},stats={},coords={},botCfg={},botSrv={},containers={},logs={};
var botServerInfo={};  // per-bot server ping cache
var allLogs=[];
var lastId=0,init=false,serverStart=null,pollTimer=null;
var mainBotFilter='all',mainTypeFilter='all';
var detailBot=null,detailTypeFilter='all';
var activeMap=null,activeProxy=null,activeRename=null,activeBotSrv=null,activeInv=null;
var addType='kill';
var serverInfo=null;

function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function fmt(ts){return new Date(ts).toTimeString().slice(0,8);}
function ago(ts){if(!ts)return'';var s=Math.floor((Date.now()-ts)/1000);return s<60?s+'s':s<3600?Math.floor(s/60)+'m':Math.floor(s/3600)+'h';}

setInterval(function(){
  if(!serverStart)return;
  var s=Math.floor((Date.now()-serverStart)/1000);
  document.getElementById('uptime').textContent=[Math.floor(s/3600),Math.floor((s%3600)/60),s%60].map(function(n){return String(n).padStart(2,'0');}).join(':');
},1000);

function nameColor(name){var h=0;for(var i=0;i<name.length;i++)h=(Math.imul(31,h)+name.charCodeAt(i))|0;var hue=Math.abs(h)%360;return'hsl('+hue+',60%,55%)';}
function skinSvg(name){var c=nameColor(name),l=name.slice(0,2).toUpperCase();return'data:image/svg+xml,'+encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='40' height='40' viewBox='0 0 40 40'><rect width='40' height='40' rx='6' fill='"+c+"' opacity='.85'/><text x='50%' y='54%' dominant-baseline='middle' text-anchor='middle' fill='white' font-family='monospace' font-weight='bold' font-size='14'>"+l+"</text></svg>");}

function scrollCards(dir){document.getElementById('cards').scrollLeft+=dir*300;}

// ── Render card ──────────────────────────────────────────────────────────
function renderCard(name){
  var el=document.getElementById('bc-'+name);
  if(!el){
    el=document.createElement('div');el.id='bc-'+name;
    var ac=document.getElementById('add-card-btn');
    if(ac)document.getElementById('cards').insertBefore(el,ac);
    else document.getElementById('cards').appendChild(el);
    el.addEventListener('click',function(e){if(!e.target.closest('[data-action]'))openDetail(name);});
  }
  var s=status[name]||{},st=stats[name]||{},cr=coords[name],cfg=botCfg[name]||{},srv=botSrv[name]||{};
  var isOnline=!!s.online,isRunning=!!s.running;
  var t=cfg.type||'custom';
  var typeCls=t==='kill'?'type-kill':t==='afk'?'type-afk':'type-custom';
  var typeText=t==='kill'?'&#9876; KILL':t==='afk'?'&#128164; AFK':'&#9881; '+(t.toUpperCase().slice(0,8));
  var inv=st.inventory||{},invKeys=Object.keys(inv);
  var invSummary=invKeys.length?invKeys.map(function(k){return inv[k]+'x '+k.replace(/_/g,' ');}).join(', '):'empty';
  var proxy=cfg.proxy;
  el.className='bot-card '+(isOnline?'online':'offline');
  el.innerHTML=
    '<div class="card-top">'+
      '<div class="bot-skin"><img src="'+skinSvg(name)+'"></div>'+
      '<div class="card-info">'+
        '<div class="bot-name-row">'+
          '<div class="bot-name" title="'+esc(name)+'">'+esc(name)+'</div>'+
          (cfg.tag?'<span class="bot-tag">'+esc(cfg.tag)+'</span>':'')+
          '<button class="rename-btn" data-action="openrename" data-bot="'+esc(name)+'">&#9998;</button>'+
        '</div>'+
        '<div class="bot-type-badge '+typeCls+'">'+typeText+'</div>'+
      '</div>'+
      '<div class="status-badge '+(isOnline?'online':'offline')+'">'+(isOnline?'LIVE':'OFF')+'</div>'+
    '</div>'+
    '<div class="stats-row">'+
      '<div class="stat-box"><div class="stat-label">KILLS</div><div class="stat-val">'+(st.ghastKills||0)+'</div></div>'+
      '<div class="stat-box"><div class="stat-label">FOOD</div><div class="stat-val">'+(st.foodAte||0)+'</div></div>'+
    '</div>'+
    '<div class="coords-row">'+
      '<span style="font-size:11px">&#128205;</span>'+
      '<span class="coords-xyz">'+(cr?'X:'+cr.x+' Y:'+cr.y+' Z:'+cr.z:'unknown')+'</span>'+
      (cr?'<span class="coords-ts">'+ago(cr.ts)+'</span>':'')+
      '<button class="coords-refresh" data-action="coords" data-bot="'+esc(name)+'">&#8635;</button>'+
    '</div>'+
    '<div class="inv-row">'+
      '<span style="font-size:11px">&#127974;</span>'+
      '<span class="inv-summary">'+esc(invSummary)+'</span>'+
      '<button class="inv-open-btn" data-action="openinv" data-bot="'+esc(name)+'">INV</button>'+
      '<button class="scan-btn" data-action="chestscan" data-bot="'+esc(name)+'">SCAN</button>'+
    '</div>'+
    '<div class="proxy-row">'+
      '<div class="proxy-badge '+(proxy?'active':'inactive')+'">'+(proxy?'&#127760; '+esc(proxy.host)+':'+proxy.port:'&#128275; DIRECT')+'</div>'+
      '<button class="proxy-set-btn" data-action="openproxy" data-bot="'+esc(name)+'">PROXY</button>'+
    '</div>'+
    '<div class="actions">'+
      '<button class="act-btn btn-start" data-action="start" data-bot="'+esc(name)+'" '+(isRunning?'disabled':'')+'>&#9654; START</button>'+
      '<button class="act-btn btn-stop" data-action="stop" data-bot="'+esc(name)+'" '+(!isRunning?'disabled':'')+'>&#9632; STOP</button>'+
      '<button class="act-btn btn-ico" data-action="openmap" data-bot="'+esc(name)+'" title="Map">&#128506;</button>'+
      '<button class="act-btn btn-ico" data-action="openbsrv" data-bot="'+esc(name)+'" title="Server IP">&#127760;</button>'+
      '<button class="act-btn btn-remove" data-action="remove" data-bot="'+esc(name)+'" title="Remove">&#10005;</button>'+
    '</div>';
}

// ── Unified log panel ─────────────────────────────────────────────────────
function updateBotTabs(){
  var t=document.getElementById('bot-tabs');
  t.innerHTML='<button class="bot-tab'+(mainBotFilter==='all'?' active':'')+'" data-tab="all">ALL</button>';
  Object.keys(status).forEach(function(n){
    t.innerHTML+='<button class="bot-tab'+(mainBotFilter===n?' active':'')+'" data-tab="'+esc(n)+'">'+esc(n)+'</button>';
  });
}
// Bot tab click via delegation (safe for any bot name)
document.getElementById('bot-tabs').addEventListener('click',function(ev){
  var btn=ev.target.closest('[data-tab]');if(!btn)return;
  setMainBotFilter(btn.dataset.tab);
});
function setMainBotFilter(n){
  mainBotFilter=n;updateBotTabs();rebuildMainLog();
  document.getElementById('main-cmd').placeholder=n==='all'?'Select a bot tab first...':'/cmd \u2192 '+n+'...';
}

// Wire up type filter buttons
document.addEventListener('click',function(ev){
  var lf=ev.target.closest('[data-lf]');
  if(lf){mainTypeFilter=lf.dataset.lf;document.querySelectorAll('[data-lf]').forEach(function(b){b.classList.toggle('active',b.dataset.lf===mainTypeFilter);});rebuildMainLog();}
  var df=ev.target.closest('[data-df]');
  if(df){detailTypeFilter=df.dataset.df;document.querySelectorAll('[data-df]').forEach(function(b){b.classList.toggle('active',b.dataset.df===detailTypeFilter);});rebuildDetailLog();}
});

function makeEntry(e,showBot){
  var t=e.type||'info';
  var d=document.createElement('div');d.className='log-entry t-'+t;d.dataset.type=t;d.dataset.bot=e.username||'';
  d.innerHTML='<span class="log-ts">'+fmt(e.ts)+'</span>'+
    (showBot?'<span class="log-bot">'+esc((e.username||'').slice(0,8))+'</span>':'')+
    '<span class="log-tag">'+(TAGS[t]||t.slice(0,5).toUpperCase())+'</span>'+
    '<span class="log-msg">'+esc(e.message)+'</span>';
  return d;
}
function matchesMain(e){return(mainBotFilter==='all'||e.username===mainBotFilter)&&(mainTypeFilter==='all'||e.type===mainTypeFilter);}
function matchesDetail(e){return e.username===detailBot&&(detailTypeFilter==='all'||e.type===detailTypeFilter);}

function pushMainLog(e){
  allLogs.push(e);if(allLogs.length>2000)allLogs.shift();
  if(e.username){if(!logs[e.username])logs[e.username]=[];logs[e.username].push(e);if(logs[e.username].length>500)logs[e.username].shift();}
  if(!matchesMain(e))return;
  var la=document.getElementById('main-log');
  var atBottom=la.scrollTop+la.clientHeight>=la.scrollHeight-20;
  la.appendChild(makeEntry(e,true));
  while(la.children.length>MAXD)la.removeChild(la.firstChild);
  if(atBottom)la.scrollTop=la.scrollHeight;
}
function rebuildMainLog(){
  var la=document.getElementById('main-log');la.innerHTML='';
  allLogs.filter(matchesMain).slice(-MAXD).forEach(function(e){la.appendChild(makeEntry(e,true));});
  la.scrollTop=la.scrollHeight;
}
function clearMainLog(){allLogs=[];document.getElementById('main-log').innerHTML='';}

function pushDetailLog(e){
  if(!detailBot||!matchesDetail(e))return;
  var dl=document.getElementById('detail-log');
  var atBottom=dl.scrollTop+dl.clientHeight>=dl.scrollHeight-20;
  dl.appendChild(makeEntry(e,false));
  while(dl.children.length>MAXD)dl.removeChild(dl.firstChild);
  if(atBottom)dl.scrollTop=dl.scrollHeight;
}
function rebuildDetailLog(){
  var dl=document.getElementById('detail-log');if(!dl||!detailBot)return;dl.innerHTML='';
  allLogs.filter(matchesDetail).slice(-MAXD).forEach(function(e){dl.appendChild(makeEntry(e,false));});
  dl.scrollTop=dl.scrollHeight;
}

function sendMainCmd(){
  if(mainBotFilter==='all'){alert('Select a specific bot tab first.');return;}
  var inp=document.getElementById('main-cmd');if(!inp.value.trim())return;
  var cmd=inp.value.trim();inp.value='';
  fetch('/bot/'+encodeURIComponent(mainBotFilter)+'/cmd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cmd:cmd})});
}
document.getElementById('main-cmd').addEventListener('keydown',function(e){if(e.key==='Enter')sendMainCmd();});

// ── Detail modal ─────────────────────────────────────────────────────────
function openDetail(name){
  detailBot=name;detailTypeFilter='all';
  document.querySelectorAll('[data-df]').forEach(function(b){b.classList.toggle('active',b.dataset.df==='all');});
  document.getElementById('detail-title').textContent='Bot: '+name;
  renderDetailLeft(name);rebuildDetailLog();
  openOverlay('detail-overlay');
  setTimeout(function(){document.getElementById('detail-cmd-field').focus();},60);
}
function renderDetailLeft(name){
  var s=status[name]||{},st=stats[name]||{},cr=coords[name],cfg=botCfg[name]||{},srv=botSrv[name]||{};
  var si=botServerInfo[name]||serverInfo||{},proxy=cfg.proxy;
  var inv=st.inventory||{};
  // Per-bot online duration
  var onlineStr='--';
  if(s.online&&s.onlineSince){var sec=Math.floor((Date.now()-s.onlineSince)/1000);onlineStr=sec<60?sec+'s':sec<3600?Math.floor(sec/60)+'m '+sec%60+'s':Math.floor(sec/3600)+'h '+Math.floor((sec%3600)/60)+'m';}
  var el=document.getElementById('detail-left');
  el.innerHTML=
    '<div class="detail-srv-row">'+
      '<div class="detail-fav">'+(si.favicon?'<img src="'+si.favicon+'">':'&#127760;')+'</div>'+
      '<div style="flex:1;min-width:0">'+
        '<div class="detail-srv-motd">'+esc((si.motd||'').replace(/\u00a7[0-9a-fk-or]/gi,'')||srv.host||'?')+'</div>'+
        '<div class="detail-srv-addr">'+esc(srv.host||'?')+':'+(srv.port||25565)+'</div>'+
      '</div>'+
      '<button style="background:none;border:1px solid var(--border);color:var(--dim);font-size:9px;padding:2px 6px;border-radius:4px;cursor:pointer;flex-shrink:0" id="detail-ping-btn">PING</button>'+
    '</div>'+
    '<div class="detail-stat-grid">'+
      '<div class="detail-stat"><div class="detail-stat-l">STATUS</div><div class="detail-stat-v" style="color:'+(!!s.online?'var(--green)':'var(--red)')+'">'+(!!s.online?'LIVE':'OFF')+'</div></div>'+
      '<div class="detail-stat"><div class="detail-stat-l">ONLINE FOR</div><div class="detail-stat-v" style="font-size:10px">'+onlineStr+'</div></div>'+
      '<div class="detail-stat"><div class="detail-stat-l">PLAYERS</div><div class="detail-stat-v">'+(si.onlinePlayers!=null?si.onlinePlayers+'/'+si.maxPlayers:'--')+'</div></div>'+
      '<div class="detail-stat"><div class="detail-stat-l">VERSION</div><div class="detail-stat-v" style="font-size:9px">'+esc(si.version||'--')+'</div></div>'+
    '</div>'+
    '<div class="detail-sec">COORDS</div>'+
    '<div style="font-size:10px;color:var(--teal);padding:3px 0">'+(cr?'X:'+cr.x+' Y:'+cr.y+' Z:'+cr.z:'unknown')+'</div>'+
    '<div class="detail-sec">INVENTORY</div>'+
    '<div style="font-size:10px;color:var(--dim2);padding:3px 0;line-height:1.8">'+(Object.keys(inv).length?Object.entries(inv).map(function(kv){return'<span style="color:var(--orange)">'+kv[1]+'</span> '+esc(kv[0].replace(/_/g,' '));}).join(' &bull; '):'empty')+'</div>'+
    '<div class="detail-sec">PROXY</div>'+
    '<div style="font-size:9px;color:'+(proxy?'var(--yellow)':'var(--dim)')+';padding:3px 0">'+(proxy?esc(proxy.host)+':'+proxy.port:'none')+'</div>'+
    '<div class="detail-sec">ACTIONS</div>'+
    '<div style="display:flex;flex-direction:column;gap:5px;margin-top:2px">'+
      '<button class="modal-btn-sec" style="font-size:10px;padding:5px" data-daction="rename" data-dbot="'+esc(name)+'">&#9998; Rename</button>'+
      '<button class="modal-btn-sec" style="font-size:10px;padding:5px" data-daction="proxy" data-dbot="'+esc(name)+'">&#127760; Proxy</button>'+
      '<button class="modal-btn-sec" style="font-size:10px;padding:5px" data-daction="bsrv" data-dbot="'+esc(name)+'">&#127758; Bot Server</button>'+
      '<button class="modal-btn-sec" style="font-size:10px;padding:5px;color:var(--orange)" data-daction="inv" data-dbot="'+esc(name)+'">&#127974; Inventory</button>'+
      '<button class="modal-btn-sec" style="font-size:10px;padding:5px;color:var(--red)" data-daction="remove" data-dbot="'+esc(name)+'">&#10005; Remove</button>'+
    '</div>';
  // Wire ping button
  var pb=document.getElementById('detail-ping-btn');
  if(pb)pb.onclick=function(){pingBotServer(name);};
}
async function sendDetailCmd(){
  if(!detailBot)return;
  var inp=document.getElementById('detail-cmd-field');if(!inp.value.trim())return;
  var cmd=inp.value.trim();inp.value='';
  await fetch('/bot/'+encodeURIComponent(detailBot)+'/cmd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cmd:cmd})});
}

// ── Inventory modal ───────────────────────────────────────────────────────
function openInv(name){
  activeInv=name;
  document.getElementById('inv-title').textContent='&#127974; '+name+' — Inventory & Containers';
  renderInvBody(name);openOverlay('inv-overlay');
}
function renderInvBody(name){
  var st=stats[name]||{},inv=st.inventory||{};
  var cont=containers[name]||{items:{},ts:0};
  var body=document.getElementById('inv-body');body.innerHTML='';
  // Inventory section
  var s1=document.createElement('div');s1.className='inv-sec-title';s1.textContent='HOTBAR / INVENTORY';body.appendChild(s1);
  var g1=document.createElement('div');g1.className='inv-grid';
  var invKeys=Object.keys(inv);
  if(invKeys.length)invKeys.forEach(function(k){var ch=document.createElement('div');ch.className='inv-chip';ch.innerHTML='<span class="inv-chip-name">'+esc(k.replace(/_/g,' '))+'</span><span class="inv-chip-count">x'+inv[k]+'</span>';g1.appendChild(ch);});
  else g1.innerHTML='<div class="inv-empty">No tracked items</div>';
  body.appendChild(g1);
  // Containers section
  var ts=cont.ts?(' — scanned '+ago(cont.ts)+' ago'):'';
  var s2=document.createElement('div');s2.className='inv-sec-title';s2.textContent='NEARBY CONTAINERS'+ts;body.appendChild(s2);
  var g2=document.createElement('div');g2.className='inv-grid';
  var contKeys=Object.keys(cont.items||{});
  if(contKeys.length)contKeys.forEach(function(k){var ch=document.createElement('div');ch.className='inv-chip';ch.innerHTML='<span class="inv-chip-name">'+esc(k.replace(/_/g,' '))+'</span><span class="inv-chip-count">x'+cont.items[k]+'</span>';g2.appendChild(ch);});
  else g2.innerHTML='<div class="inv-empty">No data — press SCAN on the card first</div>';
  body.appendChild(g2);
  var btn=document.createElement('button');btn.className='map-refresh';btn.style.marginTop='6px';
  btn.innerHTML='&#8635; Trigger Container Scan';
  btn.onclick=function(){containers[name]={items:{},ts:0};fetch('/bot/'+encodeURIComponent(name)+'/chestscan',{method:'POST'});setTimeout(function(){renderInvBody(name);},800);};
  body.appendChild(btn);
}

// ── Map modal ─────────────────────────────────────────────────────────────
function openMap(name){
  activeMap=name;
  document.getElementById('map-title').textContent='Map \u2014 '+name;
  document.getElementById('map-answer').value='';document.getElementById('map-status').textContent='';
  openOverlay('map-overlay');fetchMap();
}
async function fetchMap(){
  if(!activeMap)return;
  var box=document.getElementById('map-img');box.textContent='Loading...';
  try{
    var d=await fetch('/bot/'+encodeURIComponent(activeMap)+'/map').then(function(r){return r.json();});
    if(!d.ok){box.textContent=d.reason||'No map. Bot must hold map item.';return;}
    box.innerHTML='';var img=document.createElement('img');img.src=d.png;img.style.cssText='width:100%;height:100%;image-rendering:pixelated';box.appendChild(img);
    document.getElementById('map-answer').focus();
  }catch(_){box.textContent='Error.';}
}
async function submitMap(){
  var ans=document.getElementById('map-answer').value.trim(),st=document.getElementById('map-status');
  if(!ans||!activeMap)return;
  var d=await fetch('/bot/'+encodeURIComponent(activeMap)+'/cmd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cmd:ans})}).then(function(r){return r.json();});
  if(d.ok){st.textContent='Sent!';st.className='map-status ok';document.getElementById('map-answer').value='';setTimeout(function(){closeOverlay('map-overlay');},1400);}
  else{st.textContent='Failed: '+(d.reason||'?');st.className='map-status err';}
}

// ── Add bot ───────────────────────────────────────────────────────────────
function selectAddType(t){
  addType=t;
  ['kill','afk','custom'].forEach(function(x){document.getElementById('add-type-'+x).className='type-opt '+x+(t===x?' selected':'');});
}
async function doAddBot(){
  var name=document.getElementById('add-name').value.trim();
  if(!name){alert('Enter a username');return;}
  var tag=document.getElementById('add-tag').value.trim();
  var host=document.getElementById('add-host').value.trim();
  var port=document.getElementById('add-port').value.trim();
  var d=await fetch('/bot/add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name,type:addType,tag:tag,host:host||undefined,port:port||undefined})}).then(function(r){return r.json();});
  if(d.ok){closeOverlay('add-overlay');['add-name','add-tag','add-host','add-port'].forEach(function(id){document.getElementById(id).value='';});}
  else alert(d.reason||'Failed to add bot');
}

// ── Proxy ─────────────────────────────────────────────────────────────────
function openProxy(name){
  activeProxy=name;document.getElementById('proxy-title').textContent='&#127760; Proxy \u2014 '+name;
  var p=botCfg[name]&&botCfg[name].proxy;
  document.getElementById('proxy-host').value=p&&p.host||'';
  document.getElementById('proxy-port').value=p&&p.port||'1080';
  document.getElementById('proxy-type').value=p&&p.type||'5';
  document.getElementById('proxy-user').value=p&&p.username||'';
  document.getElementById('proxy-pass').value=p&&p.password||'';
  openOverlay('proxy-overlay');
}
async function saveProxy(){
  if(!activeProxy)return;
  var d=await fetch('/bot/'+encodeURIComponent(activeProxy)+'/proxy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({host:document.getElementById('proxy-host').value.trim(),port:document.getElementById('proxy-port').value,type:document.getElementById('proxy-type').value,username:document.getElementById('proxy-user').value,password:document.getElementById('proxy-pass').value})}).then(function(r){return r.json();});
  if(d.ok){if(botCfg[activeProxy])botCfg[activeProxy].proxy=d.proxy;renderCard(activeProxy);closeOverlay('proxy-overlay');}
  else alert(d.reason||'Failed');
}
async function clearProxy(){
  if(!activeProxy)return;
  var d=await fetch('/bot/'+encodeURIComponent(activeProxy)+'/proxy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({host:''})}).then(function(r){return r.json();});
  if(d.ok){if(botCfg[activeProxy])botCfg[activeProxy].proxy=null;renderCard(activeProxy);closeOverlay('proxy-overlay');}
}

// ── Per-bot server ────────────────────────────────────────────────────────
function openBotServer(name){
  activeBotSrv=name;document.getElementById('bsrv-title').textContent='&#127760; Server \u2014 '+name;
  var srv=botSrv[name]||{};
  document.getElementById('bsrv-host').value=srv.host||'';
  document.getElementById('bsrv-port').value=srv.port||'25565';
  openOverlay('bsrv-overlay');
}
async function saveBotServer(){
  if(!activeBotSrv)return;
  var d=await fetch('/bot/'+encodeURIComponent(activeBotSrv)+'/server',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({host:document.getElementById('bsrv-host').value.trim(),port:document.getElementById('bsrv-port').value})}).then(function(r){return r.json();});
  if(d.ok){botSrv[activeBotSrv]=d.server;closeOverlay('bsrv-overlay');}
  else alert('Failed');
}

// ── Rename ────────────────────────────────────────────────────────────────
function openRename(name){
  activeRename=name;document.getElementById('rename-input').value=name;
  openOverlay('rename-overlay');
  setTimeout(function(){var i=document.getElementById('rename-input');i.focus();i.select();},60);
}
async function doRename(){
  if(!activeRename)return;
  var nn=document.getElementById('rename-input').value.trim();if(!nn)return;
  var oldName=activeRename;
  var d=await fetch('/bot/'+encodeURIComponent(oldName)+'/rename',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({newName:nn})}).then(function(r){return r.json();});
  if(d.ok){
    // Migrate logs immediately so they aren't lost when botRenamed event fires
    if(logs[oldName]&&!logs[nn]){logs[nn]=logs[oldName];}
    activeRename=null;
    closeOverlay('rename-overlay');
  }else alert(d.reason||'Failed');
}

// ── Remove ────────────────────────────────────────────────────────────────
async function doRemove(name){
  var d=await fetch('/bot/'+encodeURIComponent(name)+'/remove',{method:'POST'}).then(function(r){return r.json();});
  if(!d.ok)alert(d.reason||'Failed');
}

// ── Global server ─────────────────────────────────────────────────────────
async function saveServerConfig(){
  var host=document.getElementById('srv-host-input').value.trim(),port=document.getElementById('srv-port-input').value.trim();
  if(!host&&!port)return;
  var d=await fetch('/config/server',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({host:host||undefined,port:port||undefined})}).then(function(r){return r.json();});
  if(d.ok){updateSrvAddr(d.host,d.port);closeOverlay('srv-overlay');}else alert('Failed');
}
function updateSrvAddr(h,p){document.getElementById('srv-addr').textContent=(h||'?')+':'+(p||'?');}

async function pingBotServer(name){
  var srv=botSrv[name]||{};if(!srv.host)return;
  var pb=document.getElementById('detail-ping-btn');if(pb)pb.textContent='...';
  try{
    var d=await fetch('/serverinfo?host='+encodeURIComponent(srv.host)+'&port='+(srv.port||25565)).then(function(r){return r.json();});
    if(d&&!d.error){botServerInfo[name]=d;if(detailBot===name)renderDetailLeft(name);}
    else if(pb)pb.textContent='FAIL';
  }catch(_){if(pb)pb.textContent='ERR';}
}

// Delegated handler for detail-left action buttons (safe for any bot name)
document.addEventListener('click',function(ev){
  var el=ev.target.closest('[data-daction]');if(!el)return;
  var a=el.dataset.daction,n=el.dataset.dbot;
  if(a==='rename'){closeOverlay('detail-overlay');openRename(n);}
  else if(a==='proxy'){closeOverlay('detail-overlay');openProxy(n);}
  else if(a==='bsrv'){closeOverlay('detail-overlay');openBotServer(n);}
  else if(a==='inv'){openInv(n);}
  else if(a==='remove'){if(confirm('Remove '+n+'?')){doRemove(n);closeOverlay('detail-overlay');}}
});
  document.getElementById('srv-motd').textContent='Pinging...';
  try{
    var d=await fetch('/serverinfo').then(function(r){return r.json();});
    if(d&&d.motd!==undefined){
      document.getElementById('srv-motd').textContent=d.motd.replace(/\u00a7[0-9a-fk-or]/gi,'')||'(no motd)';
      document.getElementById('srv-players').textContent=(d.onlinePlayers||0)+'/'+(d.maxPlayers||0)+' online';
      document.getElementById('srv-ver').textContent=d.version||'';
      if(d.favicon&&d.favicon.startsWith('data:image'))document.getElementById('srv-fav').innerHTML='<img src="'+d.favicon+'">';
    }
  }catch(_){document.getElementById('srv-motd').textContent='Ping failed';}
}

// ── Overlay helpers ───────────────────────────────────────────────────────
function openOverlay(id){document.getElementById(id).classList.add('show');}
function closeOverlay(id){
  document.getElementById(id).classList.remove('show');
  if(id==='detail-overlay')detailBot=null;
  if(id==='map-overlay')activeMap=null;
  if(id==='proxy-overlay')activeProxy=null;
  if(id==='rename-overlay')activeRename=null;
  if(id==='bsrv-overlay')activeBotSrv=null;
  if(id==='inv-overlay')activeInv=null;
}

// ── Delegated card button events ──────────────────────────────────────────
document.addEventListener('click',async function(ev){
  var el=ev.target.closest('[data-action]');if(!el)return;
  var a=el.dataset.action,b=el.dataset.bot;
  if(a==='start'||a==='stop'){
    if(status[b])status[b].running=(a==='start');renderCard(b);
    var d=await fetch('/bot/'+encodeURIComponent(b)+'/'+a,{method:'POST'}).then(function(r){return r.json();});
    if(!d.ok){alert(d.reason||'error');if(status[b])status[b].running=(a==='stop');renderCard(b);}
  }else if(a==='coords'){fetch('/bot/'+encodeURIComponent(b)+'/coords',{method:'POST'});}
  else if(a==='chestscan'){containers[b]={items:{},ts:0};fetch('/bot/'+encodeURIComponent(b)+'/chestscan',{method:'POST'});}
  else if(a==='openinv'){openInv(b);}
  else if(a==='openmap'){openMap(b);}
  else if(a==='openproxy'){openProxy(b);}
  else if(a==='openrename'){openRename(b);}
  else if(a==='openbsrv'){openBotServer(b);}
  else if(a==='remove'){if(confirm('Remove bot '+b+'?'))doRemove(b);}
});

// ── Polling ───────────────────────────────────────────────────────────────
async function poll(){
  var dot=document.getElementById('conn-dot'),txt=document.getElementById('conn-text');
  try{
    var d=await fetch('/poll?since='+lastId).then(function(r){return r.json();});
    lastId=d.lastId;dot.className='conn-dot live';txt.textContent='LIVE';
    if(!init){
      init=true;serverStart=d.state.serverStart;
      var s=d.state.status,st=d.state.stats,cr=d.state.coords,bc=d.state.botConfigs,bs=d.state.botServers||{};
      if(d.state.host)document.getElementById('srv-host-input').value=d.state.host;
      if(d.state.port)document.getElementById('srv-port-input').value=d.state.port;
      updateSrvAddr(d.state.host,d.state.port);
      var names=Object.keys(s);
      names.forEach(function(n){
        status[n]=s[n]||{};stats[n]=st[n]||{};coords[n]=cr[n]||null;
        if(bc&&bc[n])botCfg[n]=bc[n];
        if(bs&&bs[n])botSrv[n]=bs[n];
        containers[n]={items:{},ts:0};
        if(!logs[n])logs[n]=[];
        renderCard(n);
      });
      if(!document.getElementById('add-card-btn')){
        var ac=document.createElement('div');ac.id='add-card-btn';ac.className='add-card';
        ac.onclick=function(){openOverlay('add-overlay');};
        ac.innerHTML='<div class="add-icon">&#65291;</div><div class="add-label">ADD BOT</div>';
        document.getElementById('cards').appendChild(ac);
      }
      updateBotTabs();
    }
    d.events.forEach(function(ev){
      var e=ev.event,dat=ev.data;
      if(e==='log'){
        if(!logs[dat.username])logs[dat.username]=[];
        logs[dat.username].push(dat);
        pushMainLog(dat);
        pushDetailLog(dat);
      }else if(e==='status'){
        if(status[dat.username]){
          status[dat.username].online=dat.online;
          if(dat.online)status[dat.username].onlineSince=dat.onlineSince||Date.now();
          else status[dat.username].onlineSince=null;
        }
        renderCard(dat.username);
        if(detailBot===dat.username)renderDetailLeft(dat.username);
      }else if(e==='stats'){
        if(stats[dat.username])stats[dat.username]=Object.assign({},stats[dat.username],dat.stats);
        renderCard(dat.username);
        if(detailBot===dat.username)renderDetailLeft(dat.username);
        if(activeInv===dat.username)renderInvBody(dat.username);
      }else if(e==='coords'){
        coords[dat.username]=dat.coords;renderCard(dat.username);
        if(detailBot===dat.username)renderDetailLeft(dat.username);
      }else if(e==='containerUpdate'){
        // Replace entirely — prevents item count duplication on repeated scans
        containers[dat.username]=dat.data;
        if(activeInv===dat.username)renderInvBody(dat.username);
      }else if(e==='control'){
        if(status[dat.username])status[dat.username].running=dat.running!=null?dat.running:(dat.action==='started');
        renderCard(dat.username);
      }else if(e==='serverInfo'){
        serverInfo=dat;
        if(dat.motd)document.getElementById('srv-motd').textContent=dat.motd.replace(/\u00a7[0-9a-fk-or]/gi,'')||'(no motd)';
        if(dat.onlinePlayers!=null)document.getElementById('srv-players').textContent=dat.onlinePlayers+'/'+dat.maxPlayers+' online';
        if(dat.version)document.getElementById('srv-ver').textContent=dat.version;
        if(dat.favicon&&dat.favicon.startsWith('data:image'))document.getElementById('srv-fav').innerHTML='<img src="'+dat.favicon+'">';
        if(detailBot)renderDetailLeft(detailBot);
      }else if(e==='serverConfig'){updateSrvAddr(dat.host,dat.port);}
      else if(e==='botServerUpdated'){botSrv[dat.name]=dat.server;}
      else if(e==='botAdded'){
        status[dat.name]=dat.status;stats[dat.name]={ghastKills:0,foodAte:0,inventory:{},chests:{}};
        coords[dat.name]=null;containers[dat.name]={items:{},ts:0};logs[dat.name]=[];
        if(dat.config)botCfg[dat.name]=dat.config;
        if(dat.server)botSrv[dat.name]=dat.server;
        renderCard(dat.name);updateBotTabs();
      }else if(e==='botRemoved'){
        delete status[dat.name];delete stats[dat.name];delete coords[dat.name];
        delete botCfg[dat.name];delete botSrv[dat.name];delete containers[dat.name];delete logs[dat.name];
        var c=document.getElementById('bc-'+dat.name);if(c)c.remove();
        updateBotTabs();
        if(detailBot===dat.name)closeOverlay('detail-overlay');
        if(activeInv===dat.name)closeOverlay('inv-overlay');
      }else if(e==='botRenamed'){
        var oN=dat.oldName,nN=dat.newName;
        // Migrate allLogs username references live
        allLogs.forEach(function(entry){if(entry.username===oN)entry.username=nN;});
        // Migrate per-bot logs
        if(logs[oN]){logs[nN]=logs[oN];delete logs[oN];}
        delete status[oN];delete stats[oN];delete coords[oN];delete botCfg[oN];delete botSrv[oN];delete containers[oN];
        var oc=document.getElementById('bc-'+oN);if(oc)oc.remove();
        status[nN]=dat.status;
        if(!stats[nN])stats[nN]={ghastKills:0,foodAte:0,inventory:{},chests:{}};
        if(!coords[nN])coords[nN]=null;
        if(!containers[nN])containers[nN]={items:{},ts:0};
        if(dat.config)botCfg[nN]=dat.config;
        if(dat.server)botSrv[nN]=dat.server;
        // Keep watching the renamed bot in log if we were watching old name
        if(mainBotFilter===oN){mainBotFilter=nN;}
        renderCard(nN);updateBotTabs();rebuildMainLog();
        if(detailBot===oN){detailBot=nN;document.getElementById('detail-title').textContent='Bot: '+nN;renderDetailLeft(nN);}
      }else if(e==='proxyUpdated'){
        if(botCfg[dat.name])botCfg[dat.name].proxy=dat.proxy;renderCard(dat.name);
        if(detailBot===dat.name)renderDetailLeft(dat.name);
      }
    });
  }catch(_){
    dot.className='conn-dot dead';txt.textContent='Offline';init=false;lastId=0;
  }
  pollTimer=setTimeout(poll,2000);
}
function startPoll(){if(pollTimer)clearTimeout(pollTimer);init=false;lastId=0;poll();}

// ── Particles ─────────────────────────────────────────────────────────────
(function(){
  var cv=document.getElementById('bg-canvas'),ctx=cv.getContext('2d'),W,H,pts=[];
  function resize(){W=cv.width=innerWidth;H=cv.height=innerHeight;}
  resize();window.addEventListener('resize',resize);
  function mkPt(){return{x:Math.random()*W,y:Math.random()*H,vx:(Math.random()-.5)*.3,vy:(Math.random()-.5)*.3,r:Math.random()*1.8+.4,a:Math.random()};}
  for(var i=0;i<70;i++)pts.push(mkPt());
  function draw(){
    ctx.clearRect(0,0,W,H);
    for(var i=0;i<pts.length;i++){
      var p=pts[i];p.x+=p.vx;p.y+=p.vy;
      if(p.x<0||p.x>W)p.vx*=-1;if(p.y<0||p.y>H)p.vy*=-1;
      ctx.beginPath();ctx.arc(p.x,p.y,p.r,0,Math.PI*2);ctx.fillStyle='rgba(139,92,246,'+p.a*.6+')';ctx.fill();
    }
    for(var i=0;i<pts.length;i++)for(var j=i+1;j<pts.length;j++){
      var dx=pts[i].x-pts[j].x,dy=pts[i].y-pts[j].y,dist=Math.sqrt(dx*dx+dy*dy);
      if(dist<120){ctx.beginPath();ctx.moveTo(pts[i].x,pts[i].y);ctx.lineTo(pts[j].x,pts[j].y);ctx.strokeStyle='rgba(139,92,246,'+(0.12*(1-dist/120))+')';ctx.lineWidth=.5;ctx.stroke();}
    }
    requestAnimationFrame(draw);
  }
  draw();
})();

startPoll();pingServer();setInterval(pingServer,5*60*1000);
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
  setTimeout(() => { botStatus[BOT1].running = true; console.log('[Launcher] Starting Kill bot: ' + BOT1); launchBot(BOT1); }, 2000);
  setTimeout(() => { botStatus[BOT2].running = true; console.log('[Launcher] Starting AFK bot: ' + BOT2); launchBot(BOT2); }, 22000);
});
