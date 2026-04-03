// afk-bot.js — Anti-AFK bot (no chest scanner)
require('dotenv').config();
const mineflayer = require('mineflayer');
const { HOST, MC_PORT, sleep, emit, botRegistry,
  setupAutoLogin, setupAutoEat, setupInventoryScan,
  setupCoordsTracker, startBotLifecycle, setupMapListener } = require('./utils');

const USERNAME = process.env.BOT1_NAME || 'AfkBot';

const MOVES = [['forward',800],['back',800],['left',600],['right',600]];

async function runAntiAfk(bot) {
  while (true) {
    const [dir, dur] = MOVES[Math.floor(Math.random() * MOVES.length)];
    bot.setControlState(dir, true);
    if (Math.random() < 0.5) {
      await sleep(Math.random() * 300 + 100);
      bot.setControlState('jump', true);
      await sleep(200);
      bot.setControlState('jump', false);
    }
    if (Math.random() < 0.3) {
      await sleep(Math.random() * 200 + 100);
      bot.setControlState('sneak', true);
      await sleep(300);
      bot.setControlState('sneak', false);
    }
    await sleep(dur);
    bot.setControlState(dir, false);
    await sleep(Math.random() * 500 + 200);
  }
}

function createBot() {
  const bot = mineflayer.createBot({
    host: HOST, port: MC_PORT, username: USERNAME,
    version: false, auth: 'offline', checkTimeoutInterval: 30000,
  });
  setupAutoLogin(bot, USERNAME);
  setupAutoEat(bot, USERNAME);
  setupInventoryScan(bot, USERNAME);   // inventory only, no chests
  setupCoordsTracker(bot, USERNAME);
  setupMapListener(bot, USERNAME);
  let loggedIn = false;

  bot.on('message', (jsonMsg) => {
    const msg = jsonMsg.toString().toLowerCase();
    if (!loggedIn && (msg.includes('logged in') || msg.includes('welcome') ||
        msg.includes('authenticated') || msg.includes('successfully'))) {
      loggedIn = true;
      emit(USERNAME, 'info', 'Login confirmed — starting anti-AFK in 5s...');
      setTimeout(() => runAntiAfk(bot), 5000);
    }
  });

  bot.once('spawn', () => {
    emit(USERNAME, 'info', 'Spawned — waiting for login before moving...');
    botRegistry[USERNAME] = bot;
    // Fallback: move after 20s regardless
    setTimeout(() => {
      if (!loggedIn) {
        loggedIn = true;
        emit(USERNAME, 'info', 'Login fallback — starting anti-AFK...');
        runAntiAfk(bot);
      }
    }, 20000);
  });
  bot.on('chat', (sender, msg) => emit(USERNAME, 'chat', `<${sender}> ${msg}`));
  return bot;
}

// Export lifecycle controller so index.js can stop/start it
const controller = startBotLifecycle(createBot, USERNAME, 30000);
module.exports = controller;
