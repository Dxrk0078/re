// kill-bot.js — Ghast kill-aura + chest scanner, factory export
require('dotenv').config();
const mineflayer = require('mineflayer');
const utils = require('./utils');
const { sleep, emit, botRegistry, botEvents, setupAutoLogin, setupAutoEat, setupChestScanner, setupCoordsTracker, startBotLifecycle, setupMapListener } = utils;

const ATTACK_RANGE = 4.5;
const HIT_COOLDOWN = 1600;
const TARGET = 'ghast';

function dist(bot, e) {
  const b = bot.entity.position, p = e.position;
  return Math.sqrt((b.x-p.x)**2+(b.y-p.y)**2+(b.z-p.z)**2);
}

function createBot(username, options = {}) {
  const { proxy } = options;
  let lastHit = 0, ghastKills = 0;

  const botOpts = {
    host: utils.HOST, port: utils.MC_PORT, username,
    version: false, auth: 'offline', checkTimeoutInterval: 30000,
  };
  if (proxy && proxy.host) {
    try {
      const { SocksClient } = require('socks');
      botOpts.connect = (client) => {
        SocksClient.createConnection({
          proxy: { host: proxy.host, port: proxy.port||1080, type: proxy.type||5, userId: proxy.username, password: proxy.password },
          command: 'connect',
          destination: { host: utils.HOST, port: utils.MC_PORT },
        }, (err, info) => {
          if (err) { client.emit('error', err); return; }
          client.setSocket(info.socket); client.emit('connect');
        });
      };
    } catch (e) { emit(username, 'error', 'socks package not installed — proxy disabled'); }
  }

  const bot = mineflayer.createBot(botOpts);
  setupAutoLogin(bot, username);
  setupAutoEat(bot, username);
  setupChestScanner(bot, username);
  setupCoordsTracker(bot, username);
  setupMapListener(bot, username);

  async function killAuraLoop() {
    while (true) {
      await sleep(300);
      let nearest = null, minD = Infinity;
      for (const e of Object.values(bot.entities)) {
        if (e.type !== 'mob' || e.name?.toLowerCase() !== TARGET || !e.isValid) continue;
        const d = dist(bot, e);
        if (d < minD && d <= ATTACK_RANGE) { minD = d; nearest = e; }
      }
      if (!nearest) continue;
      const now = Date.now();
      if (now - lastHit < HIT_COOLDOWN) continue;
      await bot.lookAt(nearest.position.offset(0, nearest.height/2, 0), false);
      bot.attack(nearest);
      lastHit = now;
      emit(username, 'kill', `Hit ghast (id=${nearest.id}) at ${dist(bot,nearest).toFixed(2)}m`);
    }
  }

  bot.once('spawn', () => { emit(username, 'info', 'Starting ghast kill-aura...'); setTimeout(() => killAuraLoop(), 4500); });
  bot.on('entityDead', (e) => {
    if (e.name?.toLowerCase() === TARGET) {
      ghastKills++;
      emit(username, 'kill', `Ghast killed (id=${e.id}) — total: ${ghastKills}`);
      botEvents.emit('ghastKill', { username, total: ghastKills });
    }
  });
  bot.on('chat', (sender, msg) => emit(username, 'chat', `<${sender}> ${msg}`));
  return bot;
}

function launch(username, options = {}) {
  return startBotLifecycle(() => createBot(username, options), username, 30000);
}

module.exports = { launch, createBot };
