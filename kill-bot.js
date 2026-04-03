// kill-bot.js — Ghast kill-aura + chest scanner
require('dotenv').config();
const mineflayer = require('mineflayer');
const { HOST, MC_PORT, sleep, emit, botRegistry, botEvents,
  setupAutoLogin, setupAutoEat, setupChestScanner,
  setupCoordsTracker, startBotLifecycle, setupMapListener } = require('./utils');

const USERNAME     = process.env.BOT2_NAME || 'KillBot';
const ATTACK_RANGE = 4.5;
const HIT_COOLDOWN = 1600;
const TARGET       = 'ghast';

let lastHit   = 0;
let ghastKills = 0;

function dist(bot, e) {
  const b = bot.entity.position, p = e.position;
  return Math.sqrt((b.x-p.x)**2+(b.y-p.y)**2+(b.z-p.z)**2);
}

async function killAuraLoop(bot) {
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
    emit(USERNAME, 'kill', `Hit ghast (id=${nearest.id}) at ${dist(bot,nearest).toFixed(2)}m`);
  }
}

function createBot() {
  const bot = mineflayer.createBot({
    host: HOST, port: MC_PORT, username: USERNAME,
    version: false, auth: 'offline', checkTimeoutInterval: 30000,
  });
  setupAutoLogin(bot, USERNAME);
  setupAutoEat(bot, USERNAME);
  setupChestScanner(bot, USERNAME);   // chest scan only on kill-bot
  setupCoordsTracker(bot, USERNAME);
  setupMapListener(bot, USERNAME);
  bot.once('spawn', () => {
    emit(USERNAME, 'info', 'Starting ghast kill-aura...');
    setTimeout(() => killAuraLoop(bot), 4500);
  });
  bot.on('entityDead', (e) => {
    if (e.name?.toLowerCase() === TARGET) {
      ghastKills++;
      emit(USERNAME, 'kill', `Ghast killed (id=${e.id}) — total: ${ghastKills}`);
      botEvents.emit('ghastKill', { username: USERNAME, total: ghastKills });
    }
  });
  bot.on('chat', (sender, msg) => emit(USERNAME, 'chat', `<${sender}> ${msg}`));
  return bot;
}

const controller = startBotLifecycle(createBot, USERNAME, 30000);
module.exports = controller;
