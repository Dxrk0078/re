// afk-bot.js — Pure AFK bot, no movement
require('dotenv').config();
const mineflayer = require('mineflayer');
const { HOST, MC_PORT, sleep, emit, botRegistry,
  setupAutoLogin, setupAutoEat, setupInventoryScan,
  setupCoordsTracker, startBotLifecycle, setupMapListener } = require('./utils');

const USERNAME = process.env.BOT1_NAME || 'AfkBot';

function createBot() {
  const bot = mineflayer.createBot({
    host: HOST, port: MC_PORT, username: USERNAME,
    version: false, auth: 'offline', checkTimeoutInterval: 30000,
  });

  setupAutoLogin(bot, USERNAME);
  setupAutoEat(bot, USERNAME);
  setupInventoryScan(bot, USERNAME);
  setupCoordsTracker(bot, USERNAME);
  setupMapListener(bot, USERNAME);

  bot.once('spawn', () => {
    botRegistry[USERNAME] = bot;
    emit(USERNAME, 'info', 'Spawned — staying still (pure AFK).');
  });

  bot.on('chat', (sender, msg) => emit(USERNAME, 'chat', `<${sender}> ${msg}`));

  return bot;
}

const controller = startBotLifecycle(createBot, USERNAME, 30000);
module.exports = controller;
