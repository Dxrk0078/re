// afk-bot.js — Pure AFK bot, factory export
require('dotenv').config();
const mineflayer = require('mineflayer');
const utils = require('./utils');
const { sleep, emit, botRegistry, setupAutoLogin, setupAutoEat, setupInventoryScan, setupCoordsTracker, startBotLifecycle, setupMapListener } = utils;

function createBot(username, options = {}) {
  const { proxy } = options;
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
  setupInventoryScan(bot, username);
  setupCoordsTracker(bot, username);
  setupMapListener(bot, username);
  bot.once('spawn', () => { botRegistry[username] = bot; emit(username, 'info', 'Spawned — AFK mode active.'); });
  bot.on('chat', (sender, msg) => emit(username, 'chat', `<${sender}> ${msg}`));
  return bot;
}

function launch(username, options = {}) {
  return startBotLifecycle(() => createBot(username, options), username, 30000);
}

module.exports = { launch, createBot };
