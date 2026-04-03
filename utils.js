// utils.js — shared helpers + event bus for dashboard
require('dotenv').config();
const { EventEmitter } = require('events');

const HOST     = process.env.HOST     || 'localhost';
const MC_PORT  = parseInt(process.env.MC_PORT) || 25565;
const PASSWORD = process.env.PASSWORD || 'botx123x';

// ─── Global event bus ─────────────────────────────────────────────────────────
const botEvents = new EventEmitter();
botEvents.setMaxListeners(50);

// ─── Bot instance registry ────────────────────────────────────────────────────
// Each entry: { bot, dead, stopped }
const botRegistry = {};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function parseReason(reason) {
  if (!reason) return 'unknown';
  if (typeof reason === 'object') {
    return reason.text || reason.translate || JSON.stringify(reason);
  }
  try {
    const parsed = JSON.parse(reason);
    return parsed.text || parsed.translate || reason;
  } catch (_) { return String(reason); }
}

function emit(username, type, message) {
  const entry = { username, type, message, ts: Date.now() };
  botEvents.emit('log', entry);
  const prefix = `[${username}]`;
  if (type === 'error')     console.error(`${prefix} ERROR: ${message}`);
  else if (type === 'kick') console.warn(`${prefix}  KICK: ${message}`);
  else                      console.log(`${prefix} ${message}`);
}

// ─── Auto login ───────────────────────────────────────────────────────────────
function setupAutoLogin(bot, username) {
  bot.once('spawn', async () => {
    botEvents.emit('status', { username, online: true });
    emit(username, 'info', 'Spawned — sending /login instantly...');
    // Fire immediately with zero delay — PrimE auth window is very tight
    bot.chat(`/login ${PASSWORD}`);
    bot.chat(`/register ${PASSWORD} ${PASSWORD}`);
    bot.chat(`/login ${PASSWORD}`);
    // Keep retrying every 500ms for 3s in case first ones are ignored
    for (let i = 1; i <= 6; i++) {
      await sleep(500);
      bot.chat(`/login ${PASSWORD}`);
    }
  });

  bot.on('message', async (jsonMsg) => {
    const msg = jsonMsg.toString().toLowerCase();
    if (msg.includes('please login') || msg.includes('use /login') ||
        msg.includes('not logged') || msg.includes('login first')) {
      await sleep(300);
      bot.chat(`/login ${PASSWORD}`);
    }
    if (msg.includes('please register') || msg.includes('use /register') ||
        msg.includes('not registered')) {
      await sleep(300);
      bot.chat(`/register ${PASSWORD} ${PASSWORD}`);
      await sleep(500);
      bot.chat(`/login ${PASSWORD}`);
    }
  });
}

// ─── Auto eat ─────────────────────────────────────────────────────────────────
const FOOD_PRIORITY = [
  'golden_carrot','cooked_beef','cooked_porkchop','cooked_chicken',
  'cooked_mutton','cooked_salmon','cooked_cod','bread',
  'carrot','baked_potato','potato','apple',
];

function setupAutoEat(bot, username) {
  bot.once('spawn', () => {
    setInterval(async () => {
      try {
        if (bot.food > 14) return;
        let foodItem = null;
        for (const name of FOOD_PRIORITY) {
          const item = bot.inventory.items().find(i => i.name === name);
          if (item) { foodItem = item; break; }
        }
        if (!foodItem) return;
        await bot.equip(foodItem, 'hand');
        await bot.consume();
        emit(username, 'food', `Ate ${foodItem.name} (hunger ${bot.food}/20)`);
        botEvents.emit('ate', { username, item: foodItem.name });
      } catch (_) {}
    }, 2000);
  });
}

// ─── Inventory scan (no chest opening) ───────────────────────────────────────
const TRACKED_ITEMS = ['ghast_tear', 'gunpowder', 'golden_carrot',
  'cooked_beef', 'cooked_porkchop', 'cooked_chicken',
  'cooked_mutton', 'cooked_salmon', 'cooked_cod',
  'bread', 'carrot', 'baked_potato', 'potato', 'apple'];

function setupInventoryScan(bot, username) {
  bot.once('spawn', () => {
    setTimeout(() => scanInventory(bot, username), 30000);
    setInterval(() => scanInventory(bot, username), 60 * 60 * 1000);
  });
}

function scanInventory(bot, username) {
  try {
    const counts = {};
    for (const item of bot.inventory.items()) {
      if (TRACKED_ITEMS.includes(item.name))
        counts[item.name] = (counts[item.name] || 0) + item.count;
    }
    emit(username, 'inv', `Inventory: ${JSON.stringify(counts)}`);
    botEvents.emit('inventory', { username, counts });
  } catch (_) {}
}

// ─── Chest scanner (kill-bot only, no movement) ───────────────────────────────
function setupChestScanner(bot, username) {
  bot.once('spawn', () => {
    setTimeout(() => scanInventoryAndChests(bot, username), 35000);
    setInterval(() => scanInventoryAndChests(bot, username), 60 * 60 * 1000);
  });
}

async function scanInventoryAndChests(bot, username) {
  try {
    // Inventory first
    const invCounts = {};
    for (const item of bot.inventory.items()) {
      if (TRACKED_ITEMS.includes(item.name))
        invCounts[item.name] = (invCounts[item.name] || 0) + item.count;
    }
    botEvents.emit('inventory', { username, counts: invCounts });

    // Nearby chests — no movement
    const chestBlocks = bot.findBlocks({
      matching: (block) => block && ['chest','trapped_chest','barrel'].includes(block.name),
      maxDistance: 16,
      count: 5,
    });

    const chestTotals = {};
    let opened = 0;
    for (const pos of chestBlocks) {
      try {
        const block = bot.blockAt(pos);
        if (!block) continue;
        const chest = await bot.openContainer(block);
        opened++;
        for (const item of chest.containerItems()) {
          if (TRACKED_ITEMS.includes(item.name))
            chestTotals[item.name] = (chestTotals[item.name] || 0) + item.count;
        }
        chest.close();
        await sleep(300);
      } catch (_) {}
    }

    const summary = Object.entries(chestTotals).map(([k,v]) => `${k}:${v}`).join(', ') || 'none';
    emit(username, 'inv', `Chest scan (${opened} chests): ${summary}`);
    botEvents.emit('chestScan', { username, chests: chestTotals, count: opened });
  } catch (e) {
    emit(username, 'error', `Chest scan error: ${e.message}`);
  }
}

// ─── Coords tracker ───────────────────────────────────────────────────────────
function setupCoordsTracker(bot, username) {
  bot.once('spawn', () => {
    const send = () => {
      try {
        const p = bot.entity.position;
        botEvents.emit('coords', { username, coords: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }, ts: Date.now() });
      } catch (_) {}
    };
    setTimeout(send, 5000);
    setInterval(send, 60 * 60 * 1000);
  });
}

// ─── Server ping ──────────────────────────────────────────────────────────────
async function fetchServerInfo() {
  return new Promise((resolve) => {
    // Hard timeout — never block longer than 5s
    const timer = setTimeout(() => resolve(null), 5000);
    try {
      const mc = require('minecraft-protocol');
      mc.ping({ host: HOST, port: MC_PORT, closeTimeout: 4000 }, (err, result) => {
        clearTimeout(timer);
        if (err) { resolve(null); return; }
        try {
          resolve({
            motd: result.description
              ? (typeof result.description === 'string' ? result.description
                : result.description.text || JSON.stringify(result.description))
              : '',
            onlinePlayers: result.players?.online ?? 0,
            maxPlayers: result.players?.max ?? 0,
            version: result.version?.name || '?',
            favicon: result.favicon || null,
          });
        } catch(_) { resolve(null); }
      });
    } catch (_) { clearTimeout(timer); resolve(null); }
  });
}

// ─── Core bot lifecycle (start / stop / reconnect) ────────────────────────────
// createFn: () => mineflayer bot
// Returns a controller: { stop() }
function startBotLifecycle(createFn, username, delayMs = 30000) {
  let stopped = false;
  let currentBot = null;

  function spawnBot() {
    if (stopped) return;
    let bot;
    try { bot = createFn(); } catch(e) {
      emit(username, 'error', `Create failed: ${e.message}`);
      if (!stopped) setTimeout(spawnBot, delayMs);
      return;
    }
    currentBot = bot;
    botRegistry[username] = bot;

    let dead = false;
    const die = (reason) => {
      if (dead) return;
      dead = true;
      currentBot = null;
      delete botRegistry[username];
      if (stopped) {
        emit(username, 'info', 'Bot stopped.');
        botEvents.emit('status', { username, online: false });
        return;
      }
      emit(username, 'disconnect', reason || 'disconnected');
      botEvents.emit('status', { username, online: false });
      setTimeout(() => {
        if (stopped) return;
        emit(username, 'reconnect', `Reconnecting in ${delayMs/1000}s...`);
        spawnBot();
      }, delayMs);
    };

    bot.on('message', (jsonMsg) => {
      const msg = jsonMsg.toString().toLowerCase();
      if (msg.includes('hub') || msg.includes('lobby') || msg.includes('choose a server') || msg.includes('select server')) {
        emit(username, 'info', 'Hub detected — sending /server anarchy');
        bot.chat('/server anarchy');
      }
    });

    bot.on('end',    (r)   => die(parseReason(r) || 'connection ended'));
    bot.on('kicked', (r)   => { const m = parseReason(r); emit(username, 'kick', m); die('kicked: '+m); });
    bot.on('error',  (err) => {
      const m = err ? (err.code && err.message ? `${err.code}: ${err.message}` : err.message || String(err)) : 'unknown';
      emit(username, 'error', m);
      die(m);
    });
  }

  spawnBot();

  return {
    stop() {
      stopped = true;
      if (currentBot) {
        try { currentBot.quit('Stopped from dashboard'); } catch(_) {}
        currentBot = null;
        delete botRegistry[username];
      }
    },
    start() {
      if (!stopped) return; // already running
      stopped = false;
      spawnBot();
    }
  };
}

module.exports = {
  HOST, MC_PORT, PASSWORD, sleep,
  botEvents, botRegistry, emit, parseReason,
  setupAutoLogin, setupAutoEat,
  setupInventoryScan, setupChestScanner, scanInventoryAndChests,
  setupCoordsTracker, fetchServerInfo,
  startBotLifecycle,
};

// ─── Map data reader ──────────────────────────────────────────────────────────
// Mineflayer color palette (128 base colors × 4 shading = 512 entries)
// We only need indices 0-255 that appear in map data
const MAP_COLORS = (() => {
  const base = [
    [0,0,0],[127,178,56],[247,233,163],[199,199,199],[255,0,0],[160,160,255],
    [167,167,167],[0,124,0],[255,255,255],[164,168,184],[151,109,77],[112,112,112],
    [64,64,255],[143,119,72],[255,252,245],[216,127,51],[178,76,216],[102,153,216],
    [229,229,51],[127,204,25],[242,127,165],[76,76,76],[153,153,153],[76,127,153],
    [127,63,178],[51,76,178],[102,76,51],[102,127,51],[153,51,51],[25,25,25],
    [250,238,77],[92,219,213],[74,128,255],[0,217,58],[129,86,49],[112,2,0],
    [209,177,161],[159,82,36],[149,87,108],[112,108,138],[186,133,36],[103,117,53],
    [160,77,78],[57,41,35],[135,107,98],[87,92,92],[122,73,88],[76,62,92],
    [76,50,35],[76,82,42],[142,60,46],[37,22,16],[189,48,49],[148,63,97],
    [92,25,29],[22,126,134],[58,142,140],[86,44,62],[20,180,133],
  ];
  const shades = [0.71, 0.86, 1.0, 0.53];
  const palette = [];
  for (let i = 0; i < 64; i++) {
    const [r,g,b] = base[i] || [0,0,0];
    for (const s of shades) {
      palette.push([Math.floor(r*s), Math.floor(g*s), Math.floor(b*s)]);
    }
  }
  return palette;
})();

function mapDataToPng(mapData) {
  // mapData is 128*128 = 16384 bytes of color indices
  // Return base64 PNG via raw pixel buffer
  const width = 128, height = 128;
  // PNG structure: signature + IHDR + IDAT + IEND
  const { createCanvas } = (() => {
    try { return require('canvas'); } catch(_) { return null; }
  })() || {};

  if (createCanvas) {
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    const imgData = ctx.createImageData(width, height);
    for (let i = 0; i < mapData.length; i++) {
      const ci = mapData[i] & 0xFF;
      const [r,g,b] = MAP_COLORS[ci] || [0,0,0];
      imgData.data[i*4]   = r;
      imgData.data[i*4+1] = g;
      imgData.data[i*4+2] = b;
      imgData.data[i*4+3] = ci === 0 ? 0 : 255;
    }
    ctx.putImageData(imgData, 0, 0);
    return canvas.toDataURL('image/png');
  }

  // Fallback: build raw PNG manually without canvas
  function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function deflateRaw(data) {
    // zlib with no compression (stored)
    const out = [];
    const BSIZE = 65535;
    let pos = 0;
    while (pos < data.length) {
      const chunk = data.slice(pos, pos + BSIZE);
      const last = pos + chunk.length >= data.length ? 1 : 0;
      out.push(last, chunk.length & 0xFF, (chunk.length >> 8) & 0xFF,
               (~chunk.length) & 0xFF, ((~chunk.length) >> 8) & 0xFF);
      for (const b of chunk) out.push(b);
      pos += chunk.length;
    }
    // zlib header + adler32
    const adler = (() => {
      let s1=1, s2=0;
      for (const b of data) { s1=(s1+b)%65521; s2=(s2+s1)%65521; }
      return (s2<<16)|s1;
    })();
    return [0x78,0x01,...out,
      (adler>>24)&0xFF,(adler>>16)&0xFF,(adler>>8)&0xFF,adler&0xFF];
  }

  // Build raw image data (filter byte 0 + RGB per row)
  const raw = [];
  for (let y = 0; y < height; y++) {
    raw.push(0); // filter none
    for (let x = 0; x < width; x++) {
      const ci = mapData[y*width+x] & 0xFF;
      const [r,g,b] = MAP_COLORS[ci] || [0,0,0];
      raw.push(r,g,b);
    }
  }

  function chunk(type, data) {
    const t = Buffer.from(type);
    const d = Buffer.from(data);
    const len = Buffer.alloc(4); len.writeUInt32BE(d.length);
    const crcBuf = Buffer.concat([t, d]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc32(crcBuf));
    return Buffer.concat([len, t, d, c]);
  }

  const sig = Buffer.from([137,80,78,71,13,10,26,10]);
  const ihdr = Buffer.from([0,0,0,128,0,0,0,128,8,2,0,0,0]); // 128x128 RGB
  const idat = deflateRaw(raw);
  const png = Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', []),
  ]);
  return 'data:image/png;base64,' + png.toString('base64');
}

// Store latest map per bot
const botMaps = {};

function setupMapListener(bot, username) {
  bot.on('map', (map) => {
    try {
      if (!map.data || map.data.length < 128*128) return;
      const png = mapDataToPng(Array.from(map.data));
      botMaps[username] = { png, ts: Date.now(), id: map.id };
      botEvents.emit('mapUpdate', { username, png, ts: Date.now() });
    } catch(e) { /* ignore */ }
  });
}

module.exports.setupMapListener = setupMapListener;
module.exports.botMaps = botMaps;
