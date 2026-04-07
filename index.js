// ─── Global crash handler — logs real error before Railway kills the process ──
process.on('uncaughtException',  (err) => { console.error('[CRASH] uncaughtException:', err.stack || err); process.exit(1); });
process.on('unhandledRejection', (err) => { console.error('[CRASH] unhandledRejection:', err?.stack || err); process.exit(1); });

require('dotenv').config();
const express = require('express');
const crypto  = require('crypto');

const SERVER_START = Date.now();
const app = express();
const PORT_WEB = process.env.PORT || 3000;

// ─── Trust Railway / Railway.app reverse proxy ──────────────────────────────
app.set('trust proxy', true); // fix: multi-hop platforms need 'true' not 1
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

// ─── IP Whitelist ─────────────────────────────────────────────────────────────
const whitelist = new Set();
const blacklist  = new Set();
// Auto-add localhost
whitelist.add('127.0.0.1');
whitelist.add('::1');
whitelist.add('::ffff:127.0.0.1');

function getClientIP(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) { const first = fwd.split(',')[0].trim(); if (first) return first; }
  return req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || '0.0.0.0';
}

function isBlacklisted(req) {
  const ip  = getClientIP(req);
  const raw = ip.replace(/^::ffff:/, '');
  return blacklist.has(ip) || blacklist.has(raw);
}

function isSessionWhitelisted(ip) {
  const raw = ip.replace(/^::ffff:/, '');
  for (const k of [ip, raw]) {
    const exp = sessionWhitelist.get(k);
    if (exp != null) { if (Date.now() < exp) return true; sessionWhitelist.delete(k); }
  }
  return false;
}

function isWhitelisted(req) {
  const ip = getClientIP(req);
  if (whitelist.has(ip)) return true;
  const raw = ip.replace(/^::ffff:/, '');
  if (whitelist.has(raw)) return true;
  return isSessionWhitelisted(ip);
}

// ─── Session Keys ─────────────────────────────────────────────────────────────
const sessionKeys      = new Map();
const sessionWhitelist = new Map();

function parseDuration(str) {
  if (!str) return null;
  const m = String(str).match(/^(\d+)(s|m|h|d)$/i);
  if (!m) return null;
  return parseInt(m[1]) * { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2].toLowerCase()];
}

function formatDuration(ms) {
  if (ms < 60000)   return Math.round(ms / 1000) + 's';
  if (ms < 3600000) return Math.round(ms / 60000) + 'm';
  return Math.round(ms / 3600000) + 'h';
}

function parseProxy(str) {
  if (!str) return null;
  str = str.trim();
  try {
    if (/^(socks[45]?|http):\/\//i.test(str)) {
      const u = new URL(str);
      return { type: /^http/i.test(u.protocol) ? 'http' : (/socks4/i.test(u.protocol) ? 4 : 5),
               host: u.hostname, port: parseInt(u.port) || 1080,
               username: u.username || undefined, password: u.password || undefined };
    }
    const p = str.split(':');
    if (p.length >= 2) return { type: 5, host: p[0], port: parseInt(p[1]) || 1080, username: p[2], password: p[3] };
  } catch(_) {}
  return null;
}

function createSessionKey(durationMs, label = '') {
  const key = crypto.randomBytes(12).toString('hex');
  sessionKeys.set(key, { expiresAt: Date.now() + durationMs, label, used: false });
  setTimeout(() => sessionKeys.delete(key), durationMs + 5000);
  return key;
}

function redeemSessionKey(key, ip) {
  const sess = sessionKeys.get(key);
  if (!sess) return { ok: false, reason: 'Invalid or expired key' };
  if (Date.now() > sess.expiresAt) { sessionKeys.delete(key); return { ok: false, reason: 'Key expired' }; }
  if (sess.used) return { ok: false, reason: 'Key already used' };
  sess.used = true;
  const remaining = sess.expiresAt - Date.now();
  sessionWhitelist.set(ip, Date.now() + remaining);
  const raw = ip.replace(/^::ffff:/, '');
  if (raw !== ip) sessionWhitelist.set(raw, Date.now() + remaining);
  setTimeout(() => { sessionWhitelist.delete(ip); sessionWhitelist.delete(raw); }, remaining + 1000);
  return { ok: true, remaining };
}

// ─── VIP Session ──────────────────────────────────────────────────────────────
const vipSession = { active: false, bots: [], count: 0, expiresAt: null, proxies: [], timer: null };

function stopVipSession() {
  if (vipSession.timer) clearTimeout(vipSession.timer);
  vipSession.bots.forEach(b => { try { b.destroy(); } catch(_){} });
  vipSession.bots = []; vipSession.active = false; vipSession.count = 0;
  vipSession.expiresAt = null; vipSession.timer = null; vipSession.proxies = [];
  console.log('[VIP] Session stopped');
}

// ─── Discord Bot ──────────────────────────────────────────────────────────────
let discordClient = null;
const DISCORD_TOKEN      = process.env.DISCORD_TOKEN      || '';
const DISCORD_GUILD_ID   = process.env.DISCORD_GUILD_ID   || '';
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || '';

if (DISCORD_TOKEN) {
  try {
    const {
      Client, GatewayIntentBits, EmbedBuilder,
      ActionRowBuilder, ButtonBuilder, ButtonStyle,
      SlashCommandBuilder, REST, Routes,
      Events, InteractionType,
    } = require('discord.js');

    discordClient = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    const PURPLE = 0x8b5cf6;
    const GREEN  = 0x34d399;
    const RED    = 0xf87171;
    const YELLOW = 0xfbbf24;

    const mkEmbed = (title, desc, color = PURPLE) =>
      new EmbedBuilder().setTitle(title).setDescription(desc).setColor(color)
        .setFooter({ text: 'MC-BOTS • DXRK @2026' }).setTimestamp();

    // ── Helper: paginated bot list buttons ──────────────────────────────────
    const PAGE_SIZE = 5;
    function getBotNames() { return Object.keys(botStatus); }
    function botListRow(page) {
      const names = getBotNames();
      const start = page * PAGE_SIZE;
      const slice = names.slice(start, start + PAGE_SIZE);
      const row = new ActionRowBuilder();
      slice.forEach(n => {
        const short = n.slice(0, 10);
        const online = botStatus[n]?.online;
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`bot_sel:${n}`)
            .setLabel(`${online ? '🟢' : '🔴'} ${short}`)
            .setStyle(ButtonStyle.Secondary)
        );
      });
      if (start + PAGE_SIZE < names.length) {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`bot_page:${page + 1}`)
            .setLabel('Next ▶')
            .setStyle(ButtonStyle.Primary)
        );
      }
      if (page > 0) {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`bot_page:${page - 1}`)
            .setLabel('◀ Prev')
            .setStyle(ButtonStyle.Primary)
        );
      }
      return row;
    }

    function botActionRow(name) {
      const s = botStatus[name] || {};
      return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`bot_start:${name}`).setLabel('▶ Start').setStyle(ButtonStyle.Success).setDisabled(!!s.running),
        new ButtonBuilder().setCustomId(`bot_stop:${name}`).setLabel('■ Stop').setStyle(ButtonStyle.Danger).setDisabled(!s.running),
        new ButtonBuilder().setCustomId(`bot_inv:${name}`).setLabel('🎒 Inv').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`bot_coords:${name}`).setLabel('📍 Coords').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`bot_back`).setLabel('◀ Back').setStyle(ButtonStyle.Primary),
      );
    }

    function botEmbed(name) {
      const s  = botStatus[name] || {};
      const st = stats[name] || {};
      const cr = coords[name];
      const inv = st.inventory || {};
      const invStr = Object.keys(inv).length
        ? Object.entries(inv).map(([k,v]) => `**${v}x** ${k.replace(/_/g,' ')}`).join('\n')
        : 'empty';
      const onlineFor = s.online && s.onlineSince
        ? (() => { const sec = Math.floor((Date.now()-s.onlineSince)/1000); return sec<60?sec+'s':sec<3600?Math.floor(sec/60)+'m':Math.floor(sec/3600)+'h '+Math.floor((sec%3600)/60)+'m'; })()
        : '--';
      return mkEmbed(
        `${s.online ? '🟢' : '🔴'} ${name}`,
        [
          `**Status:** ${s.online ? `ONLINE (${onlineFor})` : 'OFFLINE'}`,
          `**Running:** ${s.running ? 'Yes' : 'No'}`,
          `**Type:** ${s.type || 'Bot'}${(botConfigs[name] && botConfigs[name].tag) ? ' ['+botConfigs[name].tag+']' : ''}`,
          `**Kills:** ${st.ghastKills || 0} | **Food:** ${st.foodAte || 0}`,
          cr ? `**Coords:** X:${cr.x} Y:${cr.y} Z:${cr.z}` : '**Coords:** unknown',
          `\n**Inventory:**\n${invStr}`,
        ].join('\n'),
        s.online ? GREEN : RED,
      );
    }

    // ── Slash commands register ──────────────────────────────────────────────
    const slashCmds = [
      new SlashCommandBuilder().setName('bots').setDescription('Show bot list and controls'),
      new SlashCommandBuilder().setName('status').setDescription('Quick status of all bots'),
      new SlashCommandBuilder().setName('uptime').setDescription('Server uptime'),
      new SlashCommandBuilder()
        .setName('whitelist')
        .setDescription('Manage dashboard whitelist')
        .addSubcommand(s => s.setName('add').setDescription('Add IP').addStringOption(o => o.setName('ip').setDescription('IP address').setRequired(true)))
        .addSubcommand(s => s.setName('remove').setDescription('Remove IP').addStringOption(o => o.setName('ip').setDescription('IP address').setRequired(true)))
        .addSubcommand(s => s.setName('list').setDescription('List whitelisted IPs'))
        .addSubcommand(s => s.setName('clear').setDescription('Clear all IPs')),
      new SlashCommandBuilder()
        .setName('blacklist')
        .setDescription('Manage dashboard blacklist')
        .addSubcommand(s => s.setName('add').setDescription('Block IP').addStringOption(o => o.setName('ip').setDescription('IP address').setRequired(true)))
        .addSubcommand(s => s.setName('remove').setDescription('Unblock IP').addStringOption(o => o.setName('ip').setDescription('IP address').setRequired(true)))
        .addSubcommand(s => s.setName('list').setDescription('List blocked IPs')),
      new SlashCommandBuilder()
        .setName('bot')
        .setDescription('Control a specific bot')
        .addStringOption(o => o.setName('name').setDescription('Bot name').setRequired(true).setAutocomplete(true))
        .addStringOption(o => o.setName('action').setDescription('Action').setRequired(true)
          .addChoices(
            { name: '▶ Start', value: 'start' },
            { name: '■ Stop',  value: 'stop'  },
            { name: '📍 Coords', value: 'coords' },
            { name: '🎒 Inventory', value: 'inv' },
          )),
    ].map(cmd => cmd.toJSON());

    discordClient.on(Events.ClientReady, async () => {
      console.log(`[Discord] Logged in as ${discordClient.user.tag}`);
      try {
        const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
        if (DISCORD_GUILD_ID) {
          await rest.put(Routes.applicationGuildCommands(discordClient.user.id, DISCORD_GUILD_ID), { body: slashCmds });
        } else {
          await rest.put(Routes.applicationCommands(discordClient.user.id), { body: slashCmds });
        }
        console.log('[Discord] Slash commands registered');
      } catch(e) { console.error('[Discord] Slash register failed:', e.message); }
    });

    // ── Autocomplete ──────────────────────────────────────────────────────────
    discordClient.on(Events.InteractionCreate, async interaction => {
      if (interaction.type === InteractionType.ApplicationCommandAutocomplete) {
        const focused = interaction.options.getFocused();
        const choices = Object.keys(botStatus)
          .filter(n => n.toLowerCase().includes(focused.toLowerCase()))
          .slice(0, 25)
          .map(n => ({ name: `${botStatus[n]?.online ? '🟢' : '🔴'} ${n}`, value: n }));
        return interaction.respond(choices).catch(() => {});
      }

      // ── Slash command handling ─────────────────────────────────────────────
      if (interaction.isChatInputCommand()) {
        const name = interaction.commandName;

        if (name === 'bots') {
          const names = getBotNames();
          if (!names.length) return interaction.reply({ content: 'No bots configured.', ephemeral: true });
          const embed = mkEmbed('🤖 Bot Panel', 'Select a bot to view controls:');
          return interaction.reply({ embeds: [embed], components: [botListRow(0)], ephemeral: true });
        }

        if (name === 'status') {
          const desc = getBotNames().map(n => {
            const s = botStatus[n] || {};
            const dur = s.online && s.onlineSince ? (() => { const sec=Math.floor((Date.now()-s.onlineSince)/1000); return sec<60?sec+'s':sec<3600?Math.floor(sec/60)+'m':Math.floor(sec/3600)+'h'; })() : null;
            return `${s.online ? '🟢' : '🔴'} **${n}** — ${s.online ? `ONLINE${dur ? ' ('+dur+')' : ''}` : 'OFFLINE'} | ${s.running ? 'running' : 'stopped'}`;
          }).join('\n') || 'No bots';
          return interaction.reply({ embeds: [mkEmbed('⚡ Bot Status', desc)] });
        }

        if (name === 'uptime') {
          const sec = Math.floor((Date.now() - SERVER_START) / 1000);
          const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60), s2 = sec%60;
          return interaction.reply({ embeds: [mkEmbed('⏱ Uptime', `\`${h}h ${m}m ${s2}s\``, PURPLE)] });
        }

        if (name === 'whitelist') {
          const sub = interaction.options.getSubcommand();
          const ip  = interaction.options.getString('ip');
          if (sub === 'add') { whitelist.add(ip); return interaction.reply({ embeds: [mkEmbed('✅ Whitelisted', `\`${ip}\` added.`, GREEN)] }); }
          if (sub === 'remove') { whitelist.delete(ip); return interaction.reply({ embeds: [mkEmbed('🔴 Removed', `\`${ip}\` removed.`, RED)] }); }
          if (sub === 'list') { return interaction.reply({ embeds: [mkEmbed('📋 Whitelist', `\`\`\`\n${[...whitelist].join('\n') || 'None'}\n\`\`\``)] }); }
          if (sub === 'clear') { whitelist.clear(); whitelist.add('127.0.0.1'); whitelist.add('::1'); return interaction.reply({ embeds: [mkEmbed('🗑️ Cleared', 'Whitelist cleared.', YELLOW)] }); }
        }

        if (name === 'blacklist') {
          const sub = interaction.options.getSubcommand();
          const ip  = interaction.options.getString('ip');
          if (sub === 'add') { blacklist.add(ip); whitelist.delete(ip); return interaction.reply({ embeds: [mkEmbed('🚫 Blacklisted', `\`${ip}\` blocked.`, RED)] }); }
          if (sub === 'remove') { blacklist.delete(ip); return interaction.reply({ embeds: [mkEmbed('✅ Unblocked', `\`${ip}\` unblocked.`, GREEN)] }); }
          if (sub === 'list') { return interaction.reply({ embeds: [mkEmbed('🚫 Blacklist', `\`\`\`\n${[...blacklist].join('\n') || 'None'}\n\`\`\``)] }); }
        }

        if (name === 'bot') {
          const bName  = interaction.options.getString('name');
          const action = interaction.options.getString('action');
          if (!botStatus[bName]) return interaction.reply({ content: `Bot \`${bName}\` not found.`, ephemeral: true });
          if (action === 'start') {
            if (!botStatus[bName].running || !controllers[bName]) { botStatus[bName].running = true; launchBot(bName); broadcast('control', { username: bName, action: 'started', running: true }); }
            return interaction.reply({ embeds: [botEmbed(bName)], components: [botActionRow(bName)], ephemeral: true });
          }
          if (action === 'stop') {
            botStatus[bName].running = false; botStatus[bName].online = false;
            if (controllers[bName]) { try { controllers[bName].stop(); } catch(_){} delete controllers[bName]; }
            broadcast('control', { username: bName, action: 'stopped', running: false });
            broadcast('status',  { username: bName, online: false });
            return interaction.reply({ embeds: [botEmbed(bName)], components: [botActionRow(bName)], ephemeral: true });
          }
          if (action === 'inv') {
            const inv = stats[bName]?.inventory || {};
            const invStr = Object.keys(inv).length ? Object.entries(inv).map(([k,v]) => `**${v}x** ${k.replace(/_/g,' ')}`).join('\n') : 'No tracked items';
            return interaction.reply({ embeds: [mkEmbed(`🎒 ${bName} Inventory`, invStr)], ephemeral: true });
          }
          if (action === 'coords') {
            const bot = botRegistry[bName];
            if (bot?.entity) { const p = bot.entity.position; coords[bName] = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), ts: Date.now() }; broadcast('coords', { username: bName, coords: coords[bName] }); }
            const cr = coords[bName];
            return interaction.reply({ embeds: [mkEmbed(`📍 ${bName} Coords`, cr ? `X:${cr.x} Y:${cr.y} Z:${cr.z}` : 'Unknown')], ephemeral: true });
          }
        }
      }

      // ── Button handling ───────────────────────────────────────────────────
      if (interaction.isButton()) {
        const [type, ...rest] = interaction.customId.split(':');
        const val = rest.join(':');

        if (type === 'bot_page') {
          const page = parseInt(val) || 0;
          return interaction.update({ components: [botListRow(page)] });
        }
        if (type === 'bot_sel') {
          return interaction.update({ embeds: [botEmbed(val)], components: [botActionRow(val)] });
        }
        if (type === 'bot_back') {
          return interaction.update({ embeds: [mkEmbed('🤖 Bot Panel', 'Select a bot:')], components: [botListRow(0)] });
        }
        if (type === 'bot_start') {
          if (!botStatus[val].running || !controllers[val]) { botStatus[val].running = true; launchBot(val); broadcast('control', { username: val, action: 'started', running: true }); }
          return interaction.update({ embeds: [botEmbed(val)], components: [botActionRow(val)] });
        }
        if (type === 'bot_stop') {
          botStatus[val].running = false; botStatus[val].online = false;
          if (controllers[val]) { try { controllers[val].stop(); } catch(_){} delete controllers[val]; }
          broadcast('control', { username: val, action: 'stopped', running: false });
          broadcast('status', { username: val, online: false });
          return interaction.update({ embeds: [botEmbed(val)], components: [botActionRow(val)] });
        }
        if (type === 'bot_inv') {
          const inv = stats[val]?.inventory || {};
          const invStr = Object.keys(inv).length ? Object.entries(inv).map(([k,v]) => `**${v}x** ${k.replace(/_/g,' ')}`).join('\n') : 'No tracked items';
          return interaction.reply({ embeds: [mkEmbed(`🎒 ${val} Inventory`, invStr)], ephemeral: true });
        }
        if (type === 'bot_coords') {
          const bot2 = botRegistry[val];
          if (bot2?.entity) { const p = bot2.entity.position; coords[val] = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), ts: Date.now() }; broadcast('coords', { username: val, coords: coords[val] }); }
          const cr2 = coords[val];
          return interaction.reply({ embeds: [mkEmbed(`📍 ${val} Coords`, cr2 ? `X:${cr2.x} Y:${cr2.y} Z:${cr2.z}` : 'Unknown')], ephemeral: true });
        }
      }
    });

    // ── Legacy ! prefix commands (kept for compatibility) ─────────────────
    discordClient.on('messageCreate', async (msg) => {
      if (msg.author.bot) return;
      if (!msg.content.startsWith('!')) return;
      if (DISCORD_GUILD_ID && msg.guild?.id !== DISCORD_GUILD_ID) return;
      const args = msg.content.slice(1).trim().split(/\s+/);
      const cmd = args[0]?.toLowerCase();
      const reply = (embed) => msg.reply({ embeds: [embed] });
      if (cmd === 'help') {
        await reply(mkEmbed('🤖 MC-BOTS Commands', [
          '**Slash Commands**',
          '`/bots` `/status` `/bot` `/whitelist` `/blacklist` `/uptime`',
          '',
          '**🔑 Session Keys**',
          '`!key <duration>` — One-time timed dashboard link',
          '_e.g. `!key 30s`  `!key 30m`  `!key 1h`_',
          '',
          '**🤖 VIP Bot Swarm** _(connect-only, ultra-light)_',
          '`!vip <count> <duration> [proxy1 proxy2 ...]`',
          '_e.g. `!vip 10 30m 1.2.3.4:1080`_',
          '`!vipstop` — Stop VIP session early',
          '`!vpncheck <proxy ...>` — Test proxy/VPN connectivity',
        ].join('\n')));

      // !key
      } else if (cmd === 'key') {
        const ms = parseDuration(args[1]);
        if (!ms) return reply(mkEmbed('❌ Bad Duration', 'Usage: `!key <time>`  e.g. `!key 30s` `!key 30m` `!key 1h`', RED));
        if (ms > 86400000) return reply(mkEmbed('❌ Too Long', 'Max is **24h**.', RED));
        const key  = createSessionKey(ms, `by ${msg.author.tag}`);
        const base = (process.env.PUBLIC_URL || `http://localhost:${PORT_WEB}`).replace(/\/$/,'');
        const url  = `${base}/auth?key=${key}`;
        await reply(mkEmbed('🔑 Session Key Created', [
          `**Duration:** ${formatDuration(ms)}`,
          `**Expires:** <t:${Math.floor((Date.now() + ms) / 1000)}:R>`,
          '',
          '**One-time link — share with the person who needs access:**',
          `\`\`\`${url}\`\`\``,
          '_Single-use. Grants their IP full dashboard access for the duration._',
        ].join('\n'), GREEN));

      // !vip
      } else if (cmd === 'vip') {
        if (vipSession.active) return reply(mkEmbed('⚠️ Already Active',
          `Running **${vipSession.bots.length}** VIP bots. Use \`!vipstop\` first.`, YELLOW));
        const count = parseInt(args[1]);
        const ms    = parseDuration(args[2]);
        if (!count || count < 1 || !ms) return reply(mkEmbed('❌ Usage',
          '`!vip <count> <duration> [proxy1 proxy2 ...]`', RED));
        if (count > 200) return reply(mkEmbed('❌ Too Many', 'Max **200** VIP bots.', RED));
        const proxies = args.slice(3).filter(Boolean).map(parseProxy).filter(Boolean);
        await reply(mkEmbed('⏳ Launching…',
          `Starting **${count}** ultra-light bots${proxies.length ? ` via **${proxies.length}** proxy/VPN` : ' (direct)'}…`, YELLOW));
        try {
          const vipBot = require('./vip-bot');
          vipSession.active = true; vipSession.count = count;
          vipSession.proxies = proxies; vipSession.expiresAt = Date.now() + ms;
          const launched = await vipBot.launchSwarm({
            count, proxies, host: utils.HOST, port: utils.MC_PORT,
            password: process.env.PASSWORD || 'botx123x',
            onDead: (u) => { const i = vipSession.bots.findIndex(b => b.username === u); if (i !== -1) vipSession.bots.splice(i, 1); },
          });
          vipSession.bots  = launched;
          vipSession.timer = setTimeout(() => {
            stopVipSession();
            if (DISCORD_CHANNEL_ID && discordClient) {
              discordClient.channels.fetch(DISCORD_CHANNEL_ID)
                .then(ch => ch.send({ embeds: [mkEmbed('⏰ VIP Expired', 'All VIP bots disconnected.', YELLOW)] })).catch(()=>{});
            }
          }, ms);
          const proxyLines = proxies.length
            ? proxies.map((p, i) => `\`${p.host}:${p.port}\` → **${launched.filter(b => b.proxyIndex === i).length}** bots`).join('\n')
            : '_Direct (no proxy)_';
          await msg.reply({ embeds: [mkEmbed('✅ VIP Swarm Active', [
            `**Connected:** ${launched.length}/${count}`,
            `**Duration:** ${formatDuration(ms)} (ends <t:${Math.floor(vipSession.expiresAt / 1000)}:R>)`,
            proxies.length ? `\n**Proxy Distribution:**\n${proxyLines}` : '',
            '\nUse `!vipstop` to end early.',
          ].join('\n'), GREEN)] });
        } catch(e) {
          vipSession.active = false;
          await msg.reply({ embeds: [mkEmbed('❌ Launch Failed', String(e.message), RED)] });
        }

      // !vipstop
      } else if (cmd === 'vipstop') {
        if (!vipSession.active) return reply(mkEmbed('ℹ️ No Session', 'No VIP bot session is running.', YELLOW));
        const n = vipSession.bots.length; stopVipSession();
        await reply(mkEmbed('🛑 VIP Stopped', `Disconnected **${n}** bots.`, RED));

      // !vpncheck
      } else if (cmd === 'vpncheck') {
        const rawList = args.slice(1).filter(Boolean);
        if (!rawList.length) return reply(mkEmbed('❌ Usage',
          '`!vpncheck <proxy1> [proxy2 ...]`\nFormats: `host:port`  `socks5://user:pass@host:port`  `http://host:port`', RED));
        await reply(mkEmbed('🔍 Testing…', `Checking **${rawList.length}** proxy/VPN${rawList.length > 1 ? 's' : ''}…`, YELLOW));
        const vipBot = require('./vip-bot');
        const results = await Promise.all(rawList.map(async raw => {
          const proxy = parseProxy(raw);
          if (!proxy) return `❓ \`${raw}\` — unrecognised format`;
          const res = await vipBot.checkProxy(proxy);
          const label = proxy.type === 'http' ? 'HTTP' : 'SOCKS5';
          return res.ok ? `✅ \`${proxy.host}:${proxy.port}\` (${label}) — **online** ${res.latency}ms`
                        : `❌ \`${proxy.host}:${proxy.port}\` (${label}) — ${res.err}`;
        }));
        await msg.reply({ embeds: [mkEmbed('📡 Proxy Results', results.join('\n'), PURPLE)] });
      }
    });

    discordClient.login(DISCORD_TOKEN).catch(e => console.error('[Discord] Login failed:', e.message));
  } catch (e) {
    console.warn('[Discord] discord.js not installed, skipping:', e.message);
  }
}

// ─── Bot state ────────────────────────────────────────────────────────────────
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
  // Also push non-log events to poll queue for polling clients
  if (event !== 'log') {
    eventQueue.push({ id: ++eventId, event, data });
    if (eventQueue.length > 500) eventQueue.shift();
  }
}

// ─── Session Key Redemption ───────────────────────────────────────────────────
app.get('/auth', (req, res) => {
  const key = req.query.key;
  const ip  = getClientIP(req);
  if (!key) return res.redirect('/dash');
  const result = redeemSessionKey(key, ip);
  if (!result.ok) {
    return res.send(`<html><body style="background:#050210;color:#e8deff;font-family:monospace;padding:40px;text-align:center">
      <h2 style="color:#f87171">⛔ Access Denied</h2><p style="font-size:18px;color:#c4b5fd">${result.reason}</p>
      <p style="color:#7a6699;font-size:13px">Contact the admin on Discord for a new key.</p></body></html>`);
  }
  console.log(`[Session] Key redeemed by ${ip} — ${formatDuration(result.remaining)} access granted`);
  return res.send(`<html><head><meta http-equiv="refresh" content="1;url=/dash"></head>
    <body style="background:#050210;color:#e8deff;font-family:monospace;padding:40px;text-align:center">
      <h2 style="color:#34d399">✅ Access Granted</h2>
      <p style="font-size:18px;color:#c4b5fd">Session active for <strong>${formatDuration(result.remaining)}</strong></p>
      <p style="color:#7a6699;font-size:13px">Redirecting to dashboard…</p></body></html>`);
});

// SSE — only whitelisted IPs can subscribe
app.get('/events', (req, res) => {
  if (!isWhitelisted(req)) return res.status(403).json({ error: 'forbidden' });
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write('event: init\ndata: ' + JSON.stringify({ logs: logBuffer, status: botStatus, stats, coords, serverInfo, maps: botMaps, serverStart: SERVER_START, botConfigs, botServers, host: utils.HOST, port: utils.MC_PORT }) + '\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ─── Health endpoint ──────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  const uptime = Math.floor((Date.now() - SERVER_START) / 1000);
  const botList = Object.entries(botStatus).map(([name, s]) => ({ name, online: s.online, running: s.running }));
  res.json({
    status: 'ok',
    uptime_seconds: uptime,
    uptime_human: [Math.floor(uptime/3600), Math.floor((uptime%3600)/60), uptime%60].map(n=>String(n).padStart(2,'0')).join(':'),
    bots: botList,
    server: { host: utils.HOST, port: utils.MC_PORT },
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    name: 'MC-BOTS by DXRK'
  });
});

// ─── Auth check ───────────────────────────────────────────────────────────────
// ─── Auto-whitelist helper: show current IP so you can add it from Discord ────
app.get('/myip', (req, res) => {
  const ip = getClientIP(req);
  res.send(`<html><body style="background:#050210;color:#e8deff;font-family:monospace;padding:40px;text-align:center">
    <h2 style="color:#8b5cf6">Your IP Address</h2>
    <p style="font-size:24px;margin:20px 0;color:#c4b5fd">${ip}</p>
    <p style="color:#7a6699;font-size:13px">Use <code>/whitelist add ${ip}</code> in Discord to gain access</p>
  </body></html>`);
});

app.get('/api/whoami', (req, res) => {
  const ip = getClientIP(req);
  const authed = isWhitelisted(req);
  res.json({ ip, authed, mode: authed ? 'owner' : 'visitor' });
});

// ─── Whitelist API (requires already being whitelisted) ───────────────────────
app.get('/api/whitelist', (req, res) => {
  if (!isWhitelisted(req)) return res.status(403).json({ error: 'forbidden' });
  res.json({ ips: [...whitelist] });
});
app.post('/api/whitelist/add', (req, res) => {
  if (!isWhitelisted(req)) return res.status(403).json({ error: 'forbidden' });
  const { ip } = req.body;
  if (!ip) return res.status(400).json({ error: 'ip required' });
  whitelist.add(ip);
  res.json({ ok: true, ip });
});
app.post('/api/whitelist/remove', (req, res) => {
  if (!isWhitelisted(req)) return res.status(403).json({ error: 'forbidden' });
  const { ip } = req.body;
  whitelist.delete(ip);
  res.json({ ok: true, ip });
});

// ─── Blacklist API ────────────────────────────────────────────────────────────
app.get('/api/blacklist', (req, res) => {
  if (!isWhitelisted(req)) return res.status(403).json({ error: 'forbidden' });
  res.json({ ips: [...blacklist] });
});
app.post('/api/blacklist/add', (req, res) => {
  if (!isWhitelisted(req)) return res.status(403).json({ error: 'forbidden' });
  const { ip } = req.body;
  if (!ip) return res.status(400).json({ error: 'ip required' });
  blacklist.add(ip);
  whitelist.delete(ip); // remove from whitelist if present
  broadcast('blacklistUpdate', { action: 'add', ip });
  res.json({ ok: true, ip });
});
app.post('/api/blacklist/remove', (req, res) => {
  if (!isWhitelisted(req)) return res.status(403).json({ error: 'forbidden' });
  const { ip } = req.body;
  if (!ip) return res.status(400).json({ error: 'ip required' });
  blacklist.delete(ip);
  broadcast('blacklistUpdate', { action: 'remove', ip });
  res.json({ ok: true, ip });
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

// ─── Protected API middleware ─────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!isWhitelisted(req)) return res.status(403).json({ ok: false, reason: 'Not whitelisted. Contact admin via Discord.' });
  next();
}

// ─── API (protected) ──────────────────────────────────────────────────────────
app.post('/bot/:name/start', requireAuth, (req, res) => {
  const name = req.params.name;
  if (!botStatus[name]) return res.json({ ok: false, reason: 'unknown bot' });
  // If running and controller exists, just confirm
  if (botStatus[name].running && controllers[name]) {
    broadcast('control', { username: name, action: 'started', running: true });
    return res.json({ ok: true, note: 'already running' });
  }
  botStatus[name].running = true;
  launchBot(name);
  broadcast('control', { username: name, action: 'started', running: true });
  res.json({ ok: true });
});

app.post('/bot/:name/stop', requireAuth, (req, res) => {
  const name = req.params.name;
  if (!botStatus[name]) return res.json({ ok: false, reason: 'unknown bot' });
  botStatus[name].running = false;
  botStatus[name].online  = false;
  if (controllers[name]) { try { controllers[name].stop(); } catch(_){} delete controllers[name]; }
  broadcast('control', { username: name, action: 'stopped', running: false });
  broadcast('status',  { username: name, online: false });
  res.json({ ok: true });
});

app.post('/bot/add', requireAuth, (req, res) => {
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

app.post('/bot/:name/remove', requireAuth, (req, res) => {
  const name = req.params.name;
  if (!botStatus[name]) return res.json({ ok: false, reason: 'unknown bot' });
  if (controllers[name]) { try { controllers[name].stop(); } catch(_){} delete controllers[name]; }
  delete botStatus[name]; delete stats[name]; delete coords[name]; delete botConfigs[name];
  delete botServers[name]; delete containerCache[name];
  broadcast('botRemoved', { name });
  res.json({ ok: true });
});

app.post('/bot/:name/rename', requireAuth, (req, res) => {
  const oldName = req.params.name;
  const { newName } = req.body;
  if (!newName || !newName.trim()) return res.json({ ok: false, reason: 'name required' });
  const nn = newName.trim();
  if (!botStatus[oldName]) return res.json({ ok: false, reason: 'unknown bot' });
  if (botStatus[nn] && nn !== oldName) return res.json({ ok: false, reason: 'name already taken' });
  if (controllers[oldName]) { try { controllers[oldName].stop(); } catch(_){} delete controllers[oldName]; }
  const newTag  = req.body.tag  !== undefined ? req.body.tag  : botConfigs[oldName].tag;
  const newType = req.body.type !== undefined ? req.body.type : botConfigs[oldName].type;
  botStatus[nn] = { ...botStatus[oldName], running: false, online: false };
  stats[nn] = { ...stats[oldName] };
  coords[nn] = coords[oldName];
  botConfigs[nn] = { ...botConfigs[oldName], name: nn, tag: newTag, type: newType };
  botStatus[nn].type = typeLabel(newType);
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

app.post('/bot/:name/proxy', requireAuth, (req, res) => {
  const name = req.params.name;
  if (!botConfigs[name]) return res.json({ ok: false, reason: 'unknown bot' });
  const { host, port, type, username, password } = req.body;
  botConfigs[name].proxy = host ? { host, port: parseInt(port)||1080, type: parseInt(type)||5, username, password } : null;
  broadcast('proxyUpdated', { name, proxy: botConfigs[name].proxy });
  res.json({ ok: true, proxy: botConfigs[name].proxy });
});

app.post('/bot/:name/server', requireAuth, (req, res) => {
  const name = req.params.name;
  if (!botConfigs[name]) return res.json({ ok: false, reason: 'unknown bot' });
  const { host, port } = req.body;
  if (host) botServers[name].host = host;
  if (port) botServers[name].port = parseInt(port);
  broadcast('botServerUpdated', { name, server: botServers[name] });
  res.json({ ok: true, server: botServers[name] });
});

app.get('/config/server', requireAuth, (req, res) => res.json({ host: utils.HOST, port: utils.MC_PORT }));
app.post('/config/server', requireAuth, (req, res) => {
  const { host, port } = req.body;
  utils.setServer(host || utils.HOST, port ? parseInt(port) : utils.MC_PORT);
  broadcast('serverConfig', { host: utils.HOST, port: utils.MC_PORT });
  res.json({ ok: true, host: utils.HOST, port: utils.MC_PORT });
});

app.post('/bot/:name/cmd', requireAuth, (req, res) => {
  const { name } = req.params, { cmd } = req.body;
  if (!cmd) return res.json({ ok: false, reason: 'no command' });
  const bot = botRegistry[name];
  if (!bot) return res.json({ ok: false, reason: 'bot not connected' });
  try { bot.chat(cmd); emit(name, 'chat', '[CMD] ' + cmd); res.json({ ok: true }); }
  catch (e) { res.json({ ok: false, reason: e.message }); }
});

app.post('/bot/:name/coords', requireAuth, (req, res) => {
  const name = req.params.name, bot = botRegistry[name];
  if (!bot || !bot.entity) return res.json({ ok: false, reason: 'bot not connected' });
  try {
    const pos = bot.entity.position;
    const c = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z), ts: Date.now() };
    coords[name] = c; broadcast('coords', { username: name, coords: c }); res.json({ ok: true, coords: c });
  } catch (e) { res.json({ ok: false, reason: e.message }); }
});

app.post('/bot/:name/chestscan', requireAuth, (req, res) => {
  const name = req.params.name, bot = botRegistry[name];
  if (!bot) return res.json({ ok: false, reason: 'bot not connected' });
  emit(name, 'info', 'Manual container scan triggered...');
  containerCache[name] = { items: {}, ts: 0 };
  scanInventoryAndChests(bot, name).catch(() => {});
  res.json({ ok: true });
});

app.get('/bot/:name/containers', requireAuth, (req, res) => {
  res.json({ ok: true, data: containerCache[req.params.name] || { items: {}, ts: 0 } });
});

app.get('/bot/:name/map', requireAuth, (req, res) => {
  const map = botMaps[req.params.name];
  if (!map) return res.json({ ok: false, reason: 'no map data' });
  res.json({ ok: true, ...map });
});

app.get('/serverinfo', requireAuth, async (req, res) => {
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
  // Visitors get limited state (no sensitive data)
  const authed = isWhitelisted(req);
  const since = parseInt(req.query.since) || 0;
  const safeStatus = {};
  for (const [k,v] of Object.entries(botStatus)) {
    safeStatus[k] = { online: v.online, type: v.type, running: authed ? v.running : false };
  }
  const state = {
    status: safeStatus,
    stats: authed ? stats : {},
    coords: authed ? coords : {},
    serverInfo: authed ? serverInfo : (serverInfo ? { motd: serverInfo.motd, onlinePlayers: serverInfo.onlinePlayers, maxPlayers: serverInfo.maxPlayers, version: serverInfo.version } : null),
    serverStart: SERVER_START,
    host: authed ? utils.HOST : '██████████',
    port: authed ? utils.MC_PORT : '█████',
    botConfigs: authed ? botConfigs : {},
    botServers: authed ? botServers : {}
  };
  res.json({ lastId: eventId, events: authed ? eventQueue.filter(e => e.id > since) : [], state });
});

// ─── Dashboard ────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.redirect('/dash'));
app.get('/dash', (req, res) => {
  if (isBlacklisted(req)) return res.send(BLACKLISTED_HTML());
  res.send(HTML());
});

function BLACKLISTED_HTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Access Denied</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#050210;color:#e8deff;font-family:'JetBrains Mono',monospace;min-height:100vh;display:flex;align-items:center;justify-content:center;overflow:hidden}
body::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse at center,rgba(220,38,38,.18) 0%,transparent 70%);pointer-events:none}
.wrap{text-align:center;padding:40px;max-width:480px;position:relative;z-index:1}
.icon{font-size:90px;margin-bottom:28px;filter:drop-shadow(0 0 30px rgba(248,113,113,.6));animation:pulse 2.5s ease-in-out infinite}
@keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(.94)}}
h1{font-size:26px;font-weight:700;color:#f87171;letter-spacing:4px;margin-bottom:14px;text-shadow:0 0 24px rgba(248,113,113,.7)}
p{color:#6b7280;font-size:12px;letter-spacing:.5px;line-height:1.9}
.code{font-size:10px;color:#2d1a3a;margin-top:24px;letter-spacing:2px;border-top:1px solid rgba(248,113,113,.1);padding-top:16px}
</style></head>
<body><div class="wrap">
  <div class="icon">🚫</div>
  <h1>YOU ARE BLACKLISTED</h1>
  <p>Your access to this control panel has been permanently revoked by the administrator.<br><br>If you believe this is an error, contact the admin via Discord.</p>
  <div class="code">ERROR 403 · ACCESS DENIED · MC-BOTS NEXUS · DXRK @2026</div>
</div></body></html>`;
}

function HTML() { return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MC-BOTS | DXRK</title>
<link rel="icon" type="image/png" href="https://img.icons8.com/?size=50&id=44335&format=png">
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
.hdr{background:rgba(10,5,30,0.97);border-bottom:1px solid var(--border);padding:10px 22px;display:flex;align-items:center;gap:14px;position:sticky;top:0;z-index:50;backdrop-filter:blur(20px)}
.logo-wrap{display:flex;align-items:center;gap:10px}
.logo-icon{width:32px;height:32px;border-radius:8px;overflow:hidden;filter:drop-shadow(0 0 10px rgba(139,92,246,.9)) drop-shadow(0 0 20px rgba(139,92,246,.5));animation:iconGlow 3s ease-in-out infinite}
.logo-icon img{width:100%;height:100%}
@keyframes iconGlow{0%,100%{filter:drop-shadow(0 0 10px rgba(139,92,246,.9)) drop-shadow(0 0 20px rgba(139,92,246,.5))}50%{filter:drop-shadow(0 0 18px rgba(167,139,250,1)) drop-shadow(0 0 35px rgba(139,92,246,.8))}}
.logo{font-family:var(--fd);font-size:22px;font-weight:700;letter-spacing:4px;background:linear-gradient(135deg,#fff,var(--v3),var(--v),var(--vneon));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;filter:drop-shadow(0 0 16px rgba(139,92,246,.9));animation:logoGlow 3s ease-in-out infinite}
@keyframes logoGlow{0%,100%{filter:drop-shadow(0 0 12px rgba(139,92,246,.7))}50%{filter:drop-shadow(0 0 26px rgba(167,139,250,1)) drop-shadow(0 0 40px rgba(139,92,246,.6))}}
.logo-sub{font-family:var(--fd);font-size:9px;letter-spacing:3px;color:var(--dim);margin-top:-4px;font-weight:600}
.dxrk-badge{font-family:var(--fd);font-size:10px;font-weight:700;letter-spacing:2px;padding:3px 10px;border-radius:20px;background:linear-gradient(135deg,rgba(124,58,237,.25),rgba(139,92,246,.1));border:1px solid rgba(139,92,246,.4);color:var(--v3);filter:drop-shadow(0 0 8px rgba(139,92,246,.6));animation:dxrkGlow 2.5s ease-in-out infinite;cursor:default;user-select:none}
@keyframes dxrkGlow{0%,100%{box-shadow:0 0 8px rgba(139,92,246,.4),0 0 16px rgba(139,92,246,.15);color:var(--v3)}50%{box-shadow:0 0 16px rgba(167,139,250,.7),0 0 30px rgba(139,92,246,.35);color:#fff;border-color:rgba(167,139,250,.7)}}
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
/* Visitor banner */
.visitor-bar{background:linear-gradient(135deg,rgba(251,191,36,.08),rgba(251,191,36,.04));border-bottom:1px solid rgba(251,191,36,.3);padding:8px 22px;display:flex;align-items:center;gap:10px;font-family:var(--fd);font-size:12px;color:var(--yellow);letter-spacing:.5px}
.visitor-bar .v-icon{font-size:16px}
.visitor-bar .v-link{color:var(--v2);text-decoration:underline dotted;cursor:pointer;margin-left:auto;font-size:11px}
/* Fake overlay */
.fake-wrap{position:relative;display:inline-block}
.fake-mask{position:absolute;inset:0;background:linear-gradient(90deg,rgba(5,2,16,.9),rgba(15,7,42,.95));border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:10px;color:var(--dim);font-family:var(--fd);letter-spacing:1px;z-index:5;backdrop-filter:blur(6px)}
.redact{filter:blur(6px);user-select:none;pointer-events:none;opacity:.4}
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
.inv-row{background:rgba(0,0,0,.22);border:1px solid var(--border);border-radius:6px;padding:5px 8px;margin-bottom:8px;display:flex;align-items:center;gap:5px;font-size:10px}
.inv-summary{color:var(--dim2);flex:1;font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.inv-open-btn{background:rgba(139,92,246,.12);border:1px solid var(--border);color:var(--v2);font-family:inherit;font-size:9px;padding:2px 7px;border-radius:4px;cursor:pointer;transition:all .2s;flex-shrink:0}
.inv-open-btn:hover{border-color:var(--v);background:rgba(139,92,246,.25)}
.scan-btn{background:none;border:1px solid var(--border);color:var(--dim);font-family:inherit;font-size:9px;padding:2px 7px;border-radius:4px;cursor:pointer;transition:all .2s;flex-shrink:0}
.scan-btn:hover{border-color:var(--orange);color:var(--orange)}
.proxy-row{display:flex;align-items:center;gap:5px;margin-bottom:8px;font-size:10px}
.proxy-badge{display:flex;align-items:center;gap:3px;padding:2px 7px;border-radius:4px;font-size:9px;font-family:var(--fd);font-weight:600;letter-spacing:.5px}
.proxy-badge.active{background:rgba(251,191,36,.1);color:var(--yellow);border:1px solid rgba(251,191,36,.3)}
.proxy-badge.inactive{background:var(--glass);color:var(--dim);border:1px solid var(--border)}
.proxy-set-btn{margin-left:auto;background:none;border:1px solid var(--border);color:var(--dim);font-family:inherit;font-size:9px;padding:2px 7px;border-radius:4px;cursor:pointer;transition:all .2s}
.proxy-set-btn:hover{border-color:var(--yellow);color:var(--yellow)}
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
.add-card{background:var(--glass);border:1px dashed var(--border);border-radius:var(--r);padding:16px;width:150px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;cursor:pointer;transition:all .3s;min-height:180px;flex-shrink:0}
.add-card:hover{border-color:var(--v);background:rgba(139,92,246,.08);box-shadow:var(--glow)}
.add-icon{font-size:30px;opacity:.4}
.add-label{font-family:var(--fd);font-size:13px;font-weight:600;color:var(--dim);letter-spacing:1px}
.log-panel{background:var(--panel);border:1px solid var(--border);border-radius:var(--r);display:flex;flex-direction:column;overflow:hidden;height:310px}
.log-head{padding:6px 10px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:5px;flex-shrink:0;background:rgba(0,0,0,.2);flex-wrap:nowrap;overflow:hidden}
.log-title{font-family:var(--fd);color:var(--v2);font-weight:700;font-size:12px;letter-spacing:.5px;flex-shrink:0;margin-right:4px}
.bot-drop-btn{background:rgba(139,92,246,.1);border:1px solid var(--border);color:var(--v2);font-family:var(--fd);font-size:10px;font-weight:700;letter-spacing:.5px;padding:3px 10px;border-radius:5px;cursor:pointer;display:flex;align-items:center;gap:6px;transition:all .2s;white-space:nowrap}
.bot-drop-btn:hover{border-color:var(--v);background:rgba(139,92,246,.2)}
.bot-drop-arrow{transition:transform .2s;font-size:10px}
.bot-drop-arrow.open{transform:rotate(180deg)}
.bot-drop-menu{display:none;position:absolute;top:calc(100% + 4px);left:0;background:rgba(15,7,42,.98);border:1px solid var(--border);border-radius:8px;min-width:150px;z-index:200;box-shadow:0 8px 32px rgba(0,0,0,.6),var(--glow);overflow:hidden;animation:dropIn .15s ease}
@keyframes dropIn{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:translateY(0)}}
.bot-drop-menu.show{display:block}
.bot-drop-item{padding:7px 12px;font-family:var(--fd);font-size:11px;font-weight:600;color:var(--dim2);cursor:pointer;transition:all .15s;display:flex;align-items:center;gap:6px}
.bot-drop-item:hover{background:rgba(139,92,246,.12);color:var(--v2)}
.bot-drop-item.active{color:var(--v2);background:rgba(139,92,246,.15)}
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
.log-cmd-bar{display:flex;border-top:1px solid var(--border);flex-shrink:0;position:relative}
.cmd-suggestions{display:none;position:absolute;bottom:100%;left:0;right:60px;background:rgba(15,7,42,.98);border:1px solid var(--border);border-bottom:none;border-radius:8px 8px 0 0;z-index:50;max-height:200px;overflow-y:auto}
.cmd-suggestions.show{display:block}
.cmd-sug-item{padding:6px 10px;font-family:var(--fm);font-size:11px;color:var(--dim2);cursor:pointer;display:flex;align-items:center;gap:8px;transition:background .1s}
.cmd-sug-item:hover,.cmd-sug-item.focused{background:rgba(139,92,246,.15);color:var(--v2)}
.cmd-sug-cmd{color:var(--v2);font-weight:600;flex-shrink:0}
.cmd-sug-desc{color:var(--dim);font-size:10px}
.cmd-field{flex:1;background:rgba(0,0,0,.4);border:none;color:var(--text);font-family:var(--fm);font-size:11px;padding:7px 10px;outline:none}
.cmd-field::placeholder{color:var(--dim)}
.cmd-go{background:var(--green-bg);border:none;border-left:1px solid var(--border);color:var(--green);font-family:var(--fd);font-weight:600;font-size:11px;padding:7px 14px;cursor:pointer;transition:background .2s}
.cmd-go:hover{background:rgba(6,60,38,.9)}
/* Modals */
.overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:100;align-items:center;justify-content:center;backdrop-filter:blur(6px)}
#rename-overlay,#proxy-overlay,#bsrv-overlay,#inv-overlay{z-index:200}
.overlay.show{display:flex;animation:fadeIn .15s ease}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
.modal{background:linear-gradient(160deg,rgba(18,8,50,.98),rgba(10,5,30,.98));border:1px solid var(--border2);border-radius:14px;display:flex;flex-direction:column;overflow:hidden;box-shadow:var(--glow2),0 20px 60px rgba(0,0,0,.7);animation:modalIn .2s ease}
@keyframes modalIn{from{opacity:0;transform:translateY(18px) scale(.97)}to{opacity:1;transform:translateY(0) scale(1)}}
.modal-hdr{padding:13px 17px;border-bottom:1px solid var(--border);display:flex;align-items:center;background:rgba(0,0,0,.2)}
.modal-title{font-family:var(--fd);font-weight:700;font-size:15px;color:var(--v2);flex:1;letter-spacing:.5px}
.modal-x{background:none;border:none;color:var(--dim);cursor:pointer;font-size:17px;line-height:1;transition:color .2s;padding:2px 5px}
.modal-x:hover{color:var(--red)}
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
#inv-overlay .modal{width:450px;max-width:95vw}
#rename-overlay,#proxy-overlay,#bsrv-overlay{z-index:200}
.inv-body{padding:14px;display:flex;flex-direction:column;gap:10px;max-height:68vh;overflow-y:auto}
.inv-sec-title{font-family:var(--fd);font-size:10px;font-weight:700;letter-spacing:1.5px;color:var(--dim2);border-bottom:1px solid var(--border);padding-bottom:4px}
.inv-grid{display:flex;flex-wrap:wrap;gap:5px;margin-top:5px}
.inv-chip{background:rgba(0,0,0,.32);border:1px solid var(--border);border-radius:5px;padding:3px 9px;font-size:10px;display:flex;align-items:center;gap:5px}
.inv-chip-name{color:var(--dim2)}.inv-chip-count{color:var(--orange);font-weight:700}
.inv-empty{color:var(--dim);font-size:10px;font-style:italic}
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
/* Footer */
.footer{text-align:center;padding:14px;font-family:var(--fd);font-size:10px;color:var(--dim);letter-spacing:2px;border-top:1px solid var(--border);background:rgba(5,2,16,.8)}
.footer .copy{color:var(--v3);filter:drop-shadow(0 0 6px rgba(139,92,246,.5));font-weight:700}
.footer .dxrk-f{background:linear-gradient(135deg,var(--v3),var(--v));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;font-size:12px;letter-spacing:3px}
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
  <div class="logo-wrap">
    <div class="logo-icon"><img src="https://img.icons8.com/?size=50&id=44335&format=png" alt="MC"></div>
    <div>
      <div class="logo">MC-BOTS</div>
      <div class="logo-sub">NEXUS CONTROL PANEL</div>
    </div>
  </div>
  <div class="dxrk-badge">⬡ DXRK</div>
  <div class="uptime-pill"><div class="dot"></div>UP <span id="uptime">00:00:00</span></div>
  <div class="hdr-right">
    <div class="conn-pill"><div class="conn-dot" id="conn-dot"></div><span id="conn-text" style="font-size:10px;color:var(--dim2)">Connecting</span></div>
    <button class="icon-btn" onclick="startPoll()" title="Reconnect">&#8635;</button>
    <button class="icon-btn visitor-only-hide" onclick="openOverlay('srv-overlay')" title="Server Settings">&#9881;</button>
  </div>
</div>

<div class="visitor-bar" id="visitor-bar" style="display:none">
  <span class="v-icon">👁</span>
  <span>You are in <strong>VISITOR MODE</strong> — View only. To gain full access, contact the admin via Discord and request your IP to be whitelisted.</span>
  <span class="v-link" id="your-ip-lbl"></span>
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
  <button class="ping-btn owner-only" onclick="pingServer()">PING</button>
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
      <div style="position:relative;flex-shrink:0">
        <button class="bot-drop-btn" id="bot-drop-btn" onclick="toggleBotDrop()">
          <span id="bot-drop-label">ALL BOTS</span>
          <span class="bot-drop-arrow" id="bot-drop-arrow">▾</span>
        </button>
        <div class="bot-drop-menu" id="bot-drop-menu">
          <div class="bot-drop-item active" data-tab="all">ALL BOTS</div>
        </div>
      </div>
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
    <div class="log-cmd-bar" style="position:relative">
      <div class="cmd-suggestions" id="cmd-suggestions"></div>
      <input class="cmd-field owner-only-input" id="main-cmd" placeholder="Select a bot, then type /cmd or !cmd..." autocomplete="off" oninput="showCmdSuggestions(this.value)" onkeydown="handleCmdKey(event)">
      <button class="cmd-go owner-only" onclick="sendMainCmd()">&#9654;</button>
    </div>
  </div>
</div>

<div class="footer">
  <span class="copy">© </span><span class="dxrk-f">DXRK</span> <span class="copy">@2026</span> &nbsp;·&nbsp; MC-BOTS &nbsp;·&nbsp; All Rights Reserved
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
        <div class="detail-cmd" style="position:relative">
          <div class="cmd-suggestions" id="detail-suggestions" style="left:0;right:60px"></div>
          <input class="detail-field owner-only-input" id="detail-cmd-field" placeholder="Type /cmd or !cmd..." oninput="showDetailSugs(this.value)" onkeydown="handleDetailKey(event)" autocomplete="off">
          <button class="detail-send owner-only" onclick="sendDetailCmd()">SEND</button>
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
      <div class="btn-row"><button class="modal-btn" onclick="doAddBot()">LAUNCH BOTS</button><button class="modal-btn-sec" onclick="closeOverlay('add-overlay')">Cancel</button></div>
    </div>
  </div>
</div>

<!-- Global Server -->
<div class="overlay" id="srv-overlay" onclick="if(event.target===this)closeOverlay('srv-overlay')">
  <div class="modal" style="width:480px;max-width:97vw">
    <div class="modal-hdr"><span class="modal-title">&#9881; Settings</span><button class="modal-x" onclick="closeOverlay('srv-overlay')">&#10005;</button></div>
    <div class="modal-body">
      <div class="field-group"><div class="field-label">SERVER HOST</div><input class="field-input" id="srv-host-input" placeholder="play.example.net"></div>
      <div class="field-group"><div class="field-label">PORT</div><input class="field-input" id="srv-port-input" placeholder="25565" type="number"></div>
      <div class="srv-note">Default for all bots. Each bot can override its own server.</div>
      <div class="btn-row"><button class="modal-btn" onclick="saveServerConfig()">SAVE</button><button class="modal-btn-sec" onclick="closeOverlay('srv-overlay')">Cancel</button></div>
      <div style="border-top:1px solid var(--border);margin-top:14px;padding-top:14px">
        <div class="field-label" style="margin-bottom:8px">WHITELIST</div>
        <div style="display:flex;gap:6px;margin-bottom:8px">
          <input class="field-input" id="wl-ip-input" placeholder="IP address to add..." style="flex:1">
          <button class="modal-btn" style="flex:0 0 auto;padding:8px 14px;font-size:12px" onclick="wlAdd()">ADD</button>
        </div>
        <div id="wl-list" style="font-size:11px;max-height:100px;overflow-y:auto"></div>
      </div>
      <div style="border-top:1px solid var(--border);margin-top:14px;padding-top:14px">
        <div class="field-label" style="margin-bottom:8px">BLACKLIST</div>
        <div style="display:flex;gap:6px;margin-bottom:8px">
          <input class="field-input" id="bl-ip-input" placeholder="IP address to block..." style="flex:1">
          <button class="modal-btn" style="flex:0 0 auto;padding:8px 14px;font-size:12px;background:var(--red-bg);border-color:var(--red-bd);color:var(--red)" onclick="blAdd()">BLOCK</button>
        </div>
        <div id="bl-list" style="font-size:11px;max-height:100px;overflow-y:auto"></div>
      </div>
      <div class="srv-note" style="margin-top:10px">&#128712; Your IP: <span id="my-ip-display" style="color:var(--v3)">loading...</span></div>
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
    <div class="modal-hdr"><span class="modal-title">&#9998; Edit Bot</span><button class="modal-x" onclick="closeOverlay('rename-overlay')">&#10005;</button></div>
    <div class="modal-body">
      <div class="field-group"><div class="field-label">USERNAME</div><input class="field-input" id="rename-input" placeholder="New username..." maxlength="16" onkeydown="if(event.key==='Enter')doRename()"></div>
      <div class="field-group">
        <div class="field-label">TAG / LABEL</div>
        <input class="field-input" id="rename-tag-input" placeholder="e.g. main, backup, ghast farm..." maxlength="20">
      </div>
      <div class="field-group">
        <div class="field-label">BOT TYPE</div>
        <div class="type-toggle" id="rename-type-toggle">
          <div class="type-opt kill" id="rt-kill" onclick="selectRenameType('kill')">&#9876; KILL</div>
          <div class="type-opt afk" id="rt-afk" onclick="selectRenameType('afk')">&#128164; AFK</div>
          <div class="type-opt custom" id="rt-custom" onclick="selectRenameType('custom')">&#9881; CUSTOM</div>
        </div>
      </div>
      <div class="srv-note">&#9888; Rename will disconnect and reconnect the bot.</div>
      <div class="btn-row"><button class="modal-btn" onclick="doRename()">SAVE &amp; RECONNECT</button><button class="modal-btn-sec" onclick="closeOverlay('rename-overlay')">Cancel</button></div>
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
var botServerInfo={};
var allLogs=[];
var lastId=0,init=false,serverStart=null,pollTimer=null;
var mainBotFilter='all',mainTypeFilter='all';
var detailBot=null,detailTypeFilter='all';
var activeMap=null,activeProxy=null,activeRename=null,activeBotSrv=null,activeInv=null;
var addType='kill';
var serverInfo=null;
var IS_OWNER = false;   // set after /api/whoami

// ── Auth check ──────────────────────────────────────────────────────────────
(async function checkAuth(){
  try{
    var d=await fetch('/api/whoami').then(r=>r.json());
    IS_OWNER=d.authed;
    if(!IS_OWNER){
      document.getElementById('visitor-bar').style.display='flex';
      document.getElementById('your-ip-lbl').textContent='Your IP: '+d.ip;
      // Disable all owner-only controls
      document.querySelectorAll('.owner-only').forEach(el=>{el.disabled=true;el.style.opacity='.3';el.style.cursor='not-allowed';});
      document.querySelectorAll('.owner-only-input').forEach(el=>{el.disabled=true;el.placeholder='[Visitor — Read Only]';});
      // Hide add card for visitors
      var ac=document.getElementById('add-card-btn');if(ac)ac.style.display='none';
      // Redact server address
      document.getElementById('srv-addr').classList.add('redact');
      document.getElementById('srv-addr').title='';
      document.getElementById('srv-addr').style.cursor='default';
      document.getElementById('srv-addr').onclick=null;
      // Replace with fake addr
      document.getElementById('srv-addr').textContent='██████:█████';
      document.getElementById('srv-players').textContent='?/?';
    }
  }catch(_){}
})();

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
  var invSummary=IS_OWNER?(invKeys.length?invKeys.map(function(k){return inv[k]+'x '+k.replace(/_/g,' ');}).join(', '):'empty'):'[visitor mode]';
  var proxy=cfg.proxy;
  var proxyDisplay=IS_OWNER?(proxy?'&#127760; '+esc(proxy.host)+':'+proxy.port:'&#128275; DIRECT'):'&#128275; DIRECT';
  var coordsDisplay=IS_OWNER?(cr?'X:'+cr.x+' Y:'+cr.y+' Z:'+cr.z:'unknown'):'[redacted]';
  el.className='bot-card '+(isOnline?'online':'offline');
  el.innerHTML=
    '<div class="card-top">'+
      '<div class="bot-skin"><img src="'+skinSvg(name)+'"></div>'+
      '<div class="card-info">'+
        '<div class="bot-name-row">'+
          '<div class="bot-name" title="'+esc(name)+'">'+esc(name)+'</div>'+
          (cfg.tag?'<span class="bot-tag">'+esc(cfg.tag)+'</span>':'')+
          (IS_OWNER?'<button class="rename-btn" data-action="openrename" data-bot="'+esc(name)+'">&#9998;</button>':'')+
        '</div>'+
        '<div class="bot-type-badge '+typeCls+'">'+typeText+'</div>'+
      '</div>'+
      '<div class="status-badge '+(isOnline?'online':'offline')+'">'+(isOnline?'LIVE':'OFF')+'</div>'+
    '</div>'+
    '<div class="stats-row">'+
      '<div class="stat-box"><div class="stat-label">KILLS</div><div class="stat-val">'+(IS_OWNER?(st.ghastKills||0):'?')+'</div></div>'+
      '<div class="stat-box"><div class="stat-label">FOOD</div><div class="stat-val">'+(IS_OWNER?(st.foodAte||0):'?')+'</div></div>'+
    '</div>'+
    '<div class="coords-row">'+
      '<span style="font-size:11px">&#128205;</span>'+
      '<span class="coords-xyz">'+(IS_OWNER?coordsDisplay:'<span class="redact">X:1234 Y:64 Z:5678</span>')+'</span>'+
      (IS_OWNER&&cr?'<span class="coords-ts">'+ago(cr.ts)+'</span>':'')+
      (IS_OWNER?'<button class="coords-refresh" data-action="coords" data-bot="'+esc(name)+'">&#8635;</button>':'')+
    '</div>'+
    '<div class="inv-row">'+
      '<span style="font-size:11px">&#127974;</span>'+
      '<span class="inv-summary">'+(IS_OWNER?esc(invSummary):'<span class="redact">64x diamond_sword, 32x cooked_beef</span>')+'</span>'+
      (IS_OWNER?'<button class="inv-open-btn" data-action="openinv" data-bot="'+esc(name)+'">INV</button>':'')+
      (IS_OWNER?'<button class="scan-btn" data-action="chestscan" data-bot="'+esc(name)+'">SCAN</button>':'')+
    '</div>'+
    '<div class="proxy-row">'+
      '<div class="proxy-badge '+(IS_OWNER&&proxy?'active':'inactive')+'">'+(IS_OWNER?proxyDisplay:'&#128275; DIRECT')+'</div>'+
      (IS_OWNER?'<button class="proxy-set-btn" data-action="openproxy" data-bot="'+esc(name)+'">PROXY</button>':'')+
    '</div>'+
    '<div class="actions">'+
      (IS_OWNER?
        '<button class="act-btn btn-start" data-action="start" data-bot="'+esc(name)+'" '+(isRunning?'disabled':'')+'>&#9654; START</button>'+
        '<button class="act-btn btn-stop" data-action="stop" data-bot="'+esc(name)+'" '+(!isRunning?'disabled':'')+'>&#9632; STOP</button>'+
        '<button class="act-btn btn-ico" data-action="openmap" data-bot="'+esc(name)+'" title="Map">&#128506;</button>'+
        '<button class="act-btn btn-ico" data-action="openbsrv" data-bot="'+esc(name)+'" title="Server IP">&#127760;</button>'+
        '<button class="act-btn btn-remove" data-action="remove" data-bot="'+esc(name)+'" title="Remove">&#10005;</button>'
        :
        '<div style="width:100%;text-align:center;font-size:10px;color:var(--dim);font-family:var(--fd);letter-spacing:1px;padding:6px">👁 VISITOR — READ ONLY</div>'
      )+
    '</div>';
}

function updateBotTabs(){
  var menu=document.getElementById('bot-drop-menu');
  menu.innerHTML='<div class="bot-drop-item'+(mainBotFilter==='all'?' active':'')+'" data-tab="all">📋 ALL BOTS</div>';
  Object.keys(status).forEach(function(n){
    var s=status[n]||{};
    menu.innerHTML+='<div class="bot-drop-item'+(mainBotFilter===n?' active':'')+'" data-tab="'+esc(n)+'">'+
      (s.online?'<span style="color:var(--green)">●</span>':'<span style="color:var(--red)">●</span>')+
      ' '+esc(n.slice(0,14))+'</div>';
  });
  // Re-attach listeners
  menu.querySelectorAll('[data-tab]').forEach(function(el){
    el.addEventListener('click',function(){setMainBotFilter(el.dataset.tab);toggleBotDrop(true);});
  });
}
function toggleBotDrop(forceClose){
  var menu=document.getElementById('bot-drop-menu');
  var arrow=document.getElementById('bot-drop-arrow');
  if(forceClose||menu.classList.contains('show')){
    menu.classList.remove('show');arrow.classList.remove('open');
  }else{
    menu.classList.add('show');arrow.classList.add('open');
  }
}
// Close dropdown on outside click
document.addEventListener('click',function(ev){
  if(!ev.target.closest('#bot-drop-btn')&&!ev.target.closest('#bot-drop-menu'))
    toggleBotDrop(true);
});
function setMainBotFilter(n){
  mainBotFilter=n;updateBotTabs();rebuildMainLog();
  var lbl=document.getElementById('bot-drop-label');
  if(lbl)lbl.textContent=n==='all'?'ALL BOTS':n.slice(0,14);
  document.getElementById('main-cmd').placeholder=n==='all'?'Select a bot first...':'/cmd \u2192 '+n+'...';
}

document.addEventListener('click',function(ev){
  var lf=ev.target.closest('[data-lf]');
  if(lf){mainTypeFilter=lf.dataset.lf;document.querySelectorAll('[data-lf]').forEach(function(b){b.classList.toggle('active',b.dataset.lf===mainTypeFilter);});rebuildMainLog();}
  var df=ev.target.closest('[data-df]');
  if(df){detailTypeFilter=df.dataset.df;document.querySelectorAll('[data-df]').forEach(function(b){b.classList.toggle('active',b.dataset.df===detailTypeFilter);});rebuildDetailLog();}
});

// Parse Minecraft JSON kick messages into colored readable text
function parseMCMsg(raw) {
  if (!raw) return '';
  var s = String(raw);
  // Try to find JSON object in the string
  var m = s.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      var obj = JSON.parse(m[0]);
      var result = extractMCObj(obj);
      if (result) return result;
    } catch(_) {}
  }
  // Strip § color codes
  return esc(s.replace(/\u00a7[0-9a-fk-or]/gi,''));
}

function extractMCObj(obj) {
  if (!obj) return '';
  // Handle NBT-style compound: {type:"compound", value:{...}}
  if (obj.type === 'compound' && obj.value) return extractMCObj(obj.value);
  // Handle extra list
  if (obj.extra && obj.extra.type === 'list' && obj.extra.value && obj.extra.value.value) {
    var items = obj.extra.value.value;
    if (!Array.isArray(items)) items = [items];
    var parts = obj.text && obj.text.value ? esc(obj.text.value) : '';
    items.forEach(function(item) {
      if (!item) return;
      var color = (item.color && item.color.value) || '';
      var bold  = (item.bold  && item.bold.value)  || false;
      var text  = (item.text  && item.text.value)  || (item[''] && item[''].value) || '';
      if (!text) return;
      var style = '';
      if (color) style += 'color:' + mcColor(color) + ';';
      if (bold)  style += 'font-weight:bold;';
      parts += '<span style="' + style + '">' + esc(text) + '</span>';
    });
    return parts || null;
  }
  // Handle simple JSON text {text:"...", extra:[...]}
  if (typeof obj.text === 'string' || (obj.text && obj.text.value)) {
    var t2 = typeof obj.text === 'string' ? obj.text : obj.text.value || '';
    var parts2 = t2 ? esc(t2) : '';
    var extra = obj.extra || [];
    if (!Array.isArray(extra)) extra = [extra];
    extra.forEach(function(e2) {
      if (!e2) return;
      var c2 = e2.color || '', b2 = e2.bold || false, tx = e2.text || '';
      if (!tx) return;
      var st2 = c2 ? 'color:'+mcColor(c2)+';' : '';
      if (b2) st2 += 'font-weight:bold;';
      parts2 += '<span style="'+st2+'">'+esc(tx)+'</span>';
    });
    return parts2 || null;
  }
  return null;
}

function mcColor(c) {
  var map = {black:'#111',dark_blue:'#0066cc',dark_green:'#006600',dark_aqua:'#009999',dark_red:'#cc0000',dark_purple:'#990099',gold:'#ffaa00',gray:'#aaaaaa',dark_gray:'#666666',blue:'#5555ff',green:'#55ff55',aqua:'#55ffff',red:'#ff5555',light_purple:'#ff55ff',yellow:'#ffff55',white:'#ffffff'};
  if (c && c.startsWith('#')) return c;
  return map[c] || c || '';
}

function makeEntry(e,showBot){
  var t=e.type||'info';
  var d=document.createElement('div');d.className='log-entry t-'+t;d.dataset.type=t;d.dataset.bot=e.username||'';
  var msgHtml;
  if ((t==='kick'||t==='disconnect') && e.message && e.message.length>40) {
    msgHtml='<span class="log-msg">'+parseMCMsg(e.message)+'</span>';
  } else {
    msgHtml='<span class="log-msg">'+esc(String(e.message||'').replace(/\u00a7[0-9a-fk-or]/gi,''))+'</span>';
  }
  d.innerHTML='<span class="log-ts">'+fmt(e.ts)+'</span>'+
    (showBot?'<span class="log-bot">'+esc((e.username||'').slice(0,8))+'</span>':'')+
    '<span class="log-tag">'+(TAGS[t]||t.slice(0,5).toUpperCase())+'</span>'+
    msgHtml;
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

var MC_COMMANDS = [
  {cmd:'/login',desc:'Login with password'},
  {cmd:'/register',desc:'Register account'},
  {cmd:'/tp',desc:'Teleport'},
  {cmd:'/gamemode',desc:'Set gamemode'},
  {cmd:'/give',desc:'Give items'},
  {cmd:'/kill',desc:'Kill entity'},
  {cmd:'/time',desc:'Set time'},
  {cmd:'/weather',desc:'Set weather'},
  {cmd:'/server',desc:'Switch server'},
  {cmd:'/msg',desc:'Send private message'},
  {cmd:'/home',desc:'Go to home'},
  {cmd:'/spawn',desc:'Go to spawn'},
  {cmd:'/warp',desc:'Warp to location'},
  {cmd:'/back',desc:'Go back'},
  {cmd:'/kit',desc:'Get a kit'},
  {cmd:'/tpa',desc:'Request teleport'},
  {cmd:'!help',desc:'Bot help command'},
  {cmd:'!status',desc:'Bot status'},
];
var sugFocused = -1;

function showCmdSuggestions(val){
  var box=document.getElementById('cmd-suggestions');
  if(!val||(!val.startsWith('/')&&!val.startsWith('!'))){box.classList.remove('show');return;}
  var matches=MC_COMMANDS.filter(function(x){return x.cmd.startsWith(val);});
  if(!matches.length){box.classList.remove('show');return;}
  sugFocused=-1;
  box.innerHTML=matches.map(function(x,i){
    return '<div class="cmd-sug-item" data-i="'+i+'" data-cmd="'+esc(x.cmd)+'" onclick="pickSug(\''+esc(x.cmd)+'\')">'+
      '<span class="cmd-sug-cmd">'+esc(x.cmd)+'</span>'+
      '<span class="cmd-sug-desc">'+esc(x.desc)+'</span></div>';
  }).join('');
  box.classList.add('show');
}

function pickSug(cmd){
  var inp=document.getElementById('main-cmd');
  inp.value=cmd+' ';inp.focus();
  document.getElementById('cmd-suggestions').classList.remove('show');
  sugFocused=-1;
}

function handleCmdKey(ev){
  var box=document.getElementById('cmd-suggestions');
  var items=box.querySelectorAll('.cmd-sug-item');
  if(ev.key==='ArrowDown'){ev.preventDefault();sugFocused=Math.min(sugFocused+1,items.length-1);items.forEach(function(el,i){el.classList.toggle('focused',i===sugFocused);});}
  else if(ev.key==='ArrowUp'){ev.preventDefault();sugFocused=Math.max(sugFocused-1,0);items.forEach(function(el,i){el.classList.toggle('focused',i===sugFocused);});}
  else if(ev.key==='Tab'&&box.classList.contains('show')){ev.preventDefault();var focused=sugFocused>=0?items[sugFocused]:items[0];if(focused)pickSug(focused.dataset.cmd);}
  else if(ev.key==='Escape'){box.classList.remove('show');sugFocused=-1;}
  else if(ev.key==='Enter'){
    if(box.classList.contains('show')&&sugFocused>=0&&items[sugFocused]){ev.preventDefault();pickSug(items[sugFocused].dataset.cmd);return;}
    box.classList.remove('show');sendMainCmd();
  }
}

function sendMainCmd(){
  if(!IS_OWNER){return;}
  if(mainBotFilter==='all'){alert('Select a specific bot first.');return;}
  var inp=document.getElementById('main-cmd');if(!inp.value.trim())return;
  var cmd=inp.value.trim();inp.value='';
  document.getElementById('cmd-suggestions').classList.remove('show');
  fetch('/bot/'+encodeURIComponent(mainBotFilter)+'/cmd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cmd:cmd})});
}
document.getElementById('main-cmd').addEventListener('keydown',function(e){
  // handled by handleCmdKey
});

function openDetail(name){
  detailBot=name;detailTypeFilter='all';
  document.querySelectorAll('[data-df]').forEach(function(b){b.classList.toggle('active',b.dataset.df==='all');});
  document.getElementById('detail-title').textContent='Bot: '+name;
  renderDetailLeft(name);rebuildDetailLog();
  openOverlay('detail-overlay');
  if(IS_OWNER)setTimeout(function(){document.getElementById('detail-cmd-field').focus();},60);
}
function renderDetailLeft(name){
  var s=status[name]||{},st=stats[name]||{},cr=coords[name],cfg=botCfg[name]||{},srv=botSrv[name]||{};
  var si=botServerInfo[name]||serverInfo||{},proxy=cfg.proxy;
  var inv=st.inventory||{};
  var onlineStr='--';
  if(s.online&&s.onlineSince){var sec=Math.floor((Date.now()-s.onlineSince)/1000);onlineStr=sec<60?sec+'s':sec<3600?Math.floor(sec/60)+'m '+sec%60+'s':Math.floor(sec/3600)+'h '+Math.floor((sec%3600)/60)+'m';}
  var el=document.getElementById('detail-left');
  var srvAddrDisplay=IS_OWNER?(esc(srv.host||'?')+':'+(srv.port||25565)):'<span class="redact">████████:█████</span>';
  var srvMotdDisplay=IS_OWNER?(esc((si.motd||'').replace(/\u00a7[0-9a-fk-or]/gi,'')||srv.host||'?')):'[REDACTED]';
  el.innerHTML=
    '<div class="detail-srv-row">'+
      '<div class="detail-fav">'+(si.favicon?'<img src="'+si.favicon+'">':'&#127760;')+'</div>'+
      '<div style="flex:1;min-width:0">'+
        '<div class="detail-srv-motd">'+srvMotdDisplay+'</div>'+
        '<div class="detail-srv-addr">'+srvAddrDisplay+'</div>'+
      '</div>'+
      (IS_OWNER?'<button style="background:none;border:1px solid var(--border);color:var(--dim);font-size:9px;padding:2px 6px;border-radius:4px;cursor:pointer;flex-shrink:0" id="detail-ping-btn">PING</button>':'')+
    '</div>'+
    '<div class="detail-stat-grid">'+
      '<div class="detail-stat"><div class="detail-stat-l">STATUS</div><div class="detail-stat-v" style="color:'+(!!s.online?'var(--green)':'var(--red)')+'\">'+(!!s.online?'LIVE':'OFF')+'</div></div>'+
      '<div class="detail-stat"><div class="detail-stat-l">ONLINE FOR</div><div class="detail-stat-v" style="font-size:10px">'+onlineStr+'</div></div>'+
      '<div class="detail-stat"><div class="detail-stat-l">PLAYERS</div><div class="detail-stat-v">'+(si.onlinePlayers!=null?si.onlinePlayers+'/'+si.maxPlayers:'--')+'</div></div>'+
      '<div class="detail-stat"><div class="detail-stat-l">VERSION</div><div class="detail-stat-v" style="font-size:9px">'+esc(si.version||'--')+'</div></div>'+
    '</div>'+
    '<div class="detail-sec">COORDS</div>'+
    '<div style="font-size:10px;color:var(--teal);padding:3px 0">'+(IS_OWNER?(cr?'X:'+cr.x+' Y:'+cr.y+' Z:'+cr.z:'unknown'):'<span class="redact">X:0 Y:64 Z:0</span>')+'</div>'+
    '<div class="detail-sec">INVENTORY</div>'+
    '<div style="font-size:10px;color:var(--dim2);padding:3px 0;line-height:1.8">'+(IS_OWNER?(Object.keys(inv).length?Object.entries(inv).map(function(kv){return'<span style="color:var(--orange)">'+kv[1]+'</span> '+esc(kv[0].replace(/_/g,' '));}).join(' &bull; '):'empty'):'<span class="redact">64x diamond 32x emerald</span>')+'</div>'+
    '<div class="detail-sec">PROXY</div>'+
    '<div style="font-size:9px;color:'+(IS_OWNER&&proxy?'var(--yellow)':'var(--dim)')+';padding:3px 0">'+(IS_OWNER?(proxy?esc(proxy.host)+':'+proxy.port:'none'):'hidden')+'</div>'+
    (IS_OWNER?
    '<div class="detail-sec">ACTIONS</div>'+
    '<div style="display:flex;flex-direction:column;gap:5px;margin-top:2px">'+
      '<button class="modal-btn-sec" style="font-size:10px;padding:5px" data-daction="rename" data-dbot="'+esc(name)+'">&#9998; Rename</button>'+
      '<button class="modal-btn-sec" style="font-size:10px;padding:5px" data-daction="proxy" data-dbot="'+esc(name)+'">&#127760; Proxy</button>'+
      '<button class="modal-btn-sec" style="font-size:10px;padding:5px" data-daction="bsrv" data-dbot="'+esc(name)+'">&#127758; Bot Server</button>'+
      '<button class="modal-btn-sec" style="font-size:10px;padding:5px;color:var(--orange)" data-daction="inv" data-dbot="'+esc(name)+'">&#127974; Inventory</button>'+
      '<button class="modal-btn-sec" style="font-size:10px;padding:5px;color:var(--red)" data-daction="remove" data-dbot="'+esc(name)+'">&#10005; Remove</button>'+
    '</div>'
    :'<div style="text-align:center;font-size:10px;color:var(--dim);margin-top:10px;padding:8px;border:1px dashed var(--border);border-radius:6px">👁 Visitor mode — actions hidden</div>');
  if(IS_OWNER){var pb=document.getElementById('detail-ping-btn');if(pb)pb.onclick=function(){pingBotServer(name);};}
}
var detailSugFocused=-1;
function showDetailSugs(val){
  var box=document.getElementById('detail-suggestions');
  if(!val||(!val.startsWith('/')&&!val.startsWith('!'))){box.classList.remove('show');return;}
  var matches=MC_COMMANDS.filter(function(x){return x.cmd.startsWith(val);});
  if(!matches.length){box.classList.remove('show');return;}
  detailSugFocused=-1;
  box.innerHTML=matches.map(function(x,i){
    return '<div class="cmd-sug-item" data-i="'+i+'" data-cmd="'+esc(x.cmd)+'" onclick="pickDetailSug(\''+esc(x.cmd)+'\')">'+
      '<span class="cmd-sug-cmd">'+esc(x.cmd)+'</span><span class="cmd-sug-desc">'+esc(x.desc)+'</span></div>';
  }).join('');
  box.classList.add('show');
}
function pickDetailSug(cmd){
  var inp=document.getElementById('detail-cmd-field');inp.value=cmd+' ';inp.focus();
  document.getElementById('detail-suggestions').classList.remove('show');detailSugFocused=-1;
}
function handleDetailKey(ev){
  var box=document.getElementById('detail-suggestions');
  var items=box.querySelectorAll('.cmd-sug-item');
  if(ev.key==='ArrowDown'){ev.preventDefault();detailSugFocused=Math.min(detailSugFocused+1,items.length-1);items.forEach(function(el,i){el.classList.toggle('focused',i===detailSugFocused);});}
  else if(ev.key==='ArrowUp'){ev.preventDefault();detailSugFocused=Math.max(detailSugFocused-1,0);items.forEach(function(el,i){el.classList.toggle('focused',i===detailSugFocused);});}
  else if(ev.key==='Tab'&&box.classList.contains('show')){ev.preventDefault();var f=detailSugFocused>=0?items[detailSugFocused]:items[0];if(f)pickDetailSug(f.dataset.cmd);}
  else if(ev.key==='Escape'){box.classList.remove('show');detailSugFocused=-1;}
  else if(ev.key==='Enter'){
    if(box.classList.contains('show')&&detailSugFocused>=0&&items[detailSugFocused]){ev.preventDefault();pickDetailSug(items[detailSugFocused].dataset.cmd);return;}
    box.classList.remove('show');sendDetailCmd();
  }
}

async function sendDetailCmd(){
  if(!IS_OWNER||!detailBot)return;
  var inp=document.getElementById('detail-cmd-field');if(!inp.value.trim())return;
  var cmd=inp.value.trim();inp.value='';
  document.getElementById('detail-suggestions').classList.remove('show');
  await fetch('/bot/'+encodeURIComponent(detailBot)+'/cmd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cmd:cmd})});
}

function openInv(name){
  if(!IS_OWNER)return;
  activeInv=name;
  document.getElementById('inv-title').textContent='&#127974; '+name+' \u2014 Inventory & Containers';
  renderInvBody(name);openOverlay('inv-overlay');
}
function renderInvBody(name){
  var st=stats[name]||{},inv=st.inventory||{};
  var cont=containers[name]||{items:{},ts:0};
  var body=document.getElementById('inv-body');body.innerHTML='';
  var s1=document.createElement('div');s1.className='inv-sec-title';s1.textContent='HOTBAR / INVENTORY';body.appendChild(s1);
  var g1=document.createElement('div');g1.className='inv-grid';
  var invKeys=Object.keys(inv);
  if(invKeys.length)invKeys.forEach(function(k){var ch=document.createElement('div');ch.className='inv-chip';ch.innerHTML='<span class="inv-chip-name">'+esc(k.replace(/_/g,' '))+'</span><span class="inv-chip-count">x'+inv[k]+'</span>';g1.appendChild(ch);});
  else g1.innerHTML='<div class="inv-empty">No tracked items</div>';
  body.appendChild(g1);
  var ts=cont.ts?(' \u2014 scanned '+ago(cont.ts)+' ago'):'';
  var s2=document.createElement('div');s2.className='inv-sec-title';s2.textContent='NEARBY CONTAINERS'+ts;body.appendChild(s2);
  var g2=document.createElement('div');g2.className='inv-grid';
  var contKeys=Object.keys(cont.items||{});
  if(contKeys.length)contKeys.forEach(function(k){var ch=document.createElement('div');ch.className='inv-chip';ch.innerHTML='<span class="inv-chip-name">'+esc(k.replace(/_/g,' '))+'</span><span class="inv-chip-count">x'+cont.items[k]+'</span>';g2.appendChild(ch);});
  else g2.innerHTML='<div class="inv-empty">No data \u2014 press SCAN on the card first</div>';
  body.appendChild(g2);
  var btn=document.createElement('button');btn.className='map-refresh';btn.style.marginTop='6px';
  btn.innerHTML='&#8635; Trigger Container Scan';
  btn.onclick=function(){containers[name]={items:{},ts:0};fetch('/bot/'+encodeURIComponent(name)+'/chestscan',{method:'POST'});setTimeout(function(){renderInvBody(name);},800);};
  body.appendChild(btn);
}

function openMap(name){
  if(!IS_OWNER)return;
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

function selectAddType(t){
  addType=t;
  ['kill','afk','custom'].forEach(function(x){
    var el=document.getElementById('add-type-'+x);
    el.className='type-opt '+x+(t===x?' selected':'');
  });
}

async function doAddBot(){
  if(!IS_OWNER)return;
  var n=document.getElementById('add-name').value.trim();
  var tag=document.getElementById('add-tag').value.trim();
  var host=document.getElementById('add-host').value.trim();
  var port=document.getElementById('add-port').value.trim();
  if(!n){alert('Name required');return;}
  var d=await fetch('/bot/add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:n,type:addType,tag,host:host||undefined,port:port||undefined})}).then(r=>r.json());
  if(d.ok){closeOverlay('add-overlay');document.getElementById('add-name').value='';document.getElementById('add-tag').value='';}
  else alert(d.reason||'Failed');
}

function openProxy(name){
  if(!IS_OWNER)return;
  activeProxy=name;document.getElementById('proxy-title').textContent='Proxy \u2014 '+name;
  var p=botCfg[name]&&botCfg[name].proxy;
  document.getElementById('proxy-host').value=p?p.host:'';
  document.getElementById('proxy-port').value=p?p.port:'';
  document.getElementById('proxy-type').value=p?String(p.type||5):'5';
  document.getElementById('proxy-user').value=p&&p.username?p.username:'';
  document.getElementById('proxy-pass').value=p&&p.password?p.password:'';
  openOverlay('proxy-overlay');
}
async function saveProxy(){
  if(!IS_OWNER||!activeProxy)return;
  var host=document.getElementById('proxy-host').value.trim();
  var port=document.getElementById('proxy-port').value.trim();
  var type=document.getElementById('proxy-type').value;
  var user=document.getElementById('proxy-user').value.trim();
  var pass=document.getElementById('proxy-pass').value.trim();
  var d=await fetch('/bot/'+encodeURIComponent(activeProxy)+'/proxy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({host:host||null,port:port||null,type,username:user||null,password:pass||null})}).then(r=>r.json());
  if(d.ok)closeOverlay('proxy-overlay');else alert('Failed');
}
async function clearProxy(){
  if(!IS_OWNER||!activeProxy)return;
  await fetch('/bot/'+encodeURIComponent(activeProxy)+'/proxy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({host:null})});
  closeOverlay('proxy-overlay');
}

function openBotServer(name){
  if(!IS_OWNER)return;
  activeBotSrv=name;document.getElementById('bsrv-title').textContent='Bot Server \u2014 '+name;
  var s=botSrv[name]||{};
  document.getElementById('bsrv-host').value=s.host||'';
  document.getElementById('bsrv-port').value=s.port||'';
  openOverlay('bsrv-overlay');
}
async function saveBotServer(){
  if(!IS_OWNER||!activeBotSrv)return;
  var host=document.getElementById('bsrv-host').value.trim();
  var port=document.getElementById('bsrv-port').value.trim();
  var d=await fetch('/bot/'+encodeURIComponent(activeBotSrv)+'/server',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({host:host||undefined,port:port||undefined})}).then(r=>r.json());
  if(d.ok)closeOverlay('bsrv-overlay');else alert('Failed');
}

var renameType='kill';
function selectRenameType(t){
  renameType=t;
  ['kill','afk','custom'].forEach(function(x){
    var el=document.getElementById('rt-'+x);
    el.className='type-opt '+x+(t===x?' selected':'');
  });
}
function openRename(name){
  if(!IS_OWNER)return;
  activeRename=name;
  document.getElementById('rename-input').value=name;
  var cfg=botCfg[name]||{};
  document.getElementById('rename-tag-input').value=cfg.tag||'';
  var t=cfg.type||'kill';
  renameType=t;
  selectRenameType(t);
  openOverlay('rename-overlay');
  setTimeout(function(){var i=document.getElementById('rename-input');i.focus();i.select();},60);
}
async function doRename(){
  if(!IS_OWNER||!activeRename)return;
  var nn=document.getElementById('rename-input').value.trim();if(!nn)return;
  var tag=document.getElementById('rename-tag-input').value.trim();
  var oldName=activeRename;
  var d=await fetch('/bot/'+encodeURIComponent(oldName)+'/rename',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({newName:nn,tag,type:renameType})}).then(function(r){return r.json();});
  if(d.ok){if(logs[oldName]&&!logs[nn]){logs[nn]=logs[oldName];}activeRename=null;closeOverlay('rename-overlay');}
  else alert(d.reason||'Failed');
}

async function doRemove(name){
  if(!IS_OWNER)return;
  var d=await fetch('/bot/'+encodeURIComponent(name)+'/remove',{method:'POST'}).then(function(r){return r.json();});
  if(!d.ok)alert(d.reason||'Failed');
}

async function saveServerConfig(){
  if(!IS_OWNER)return;
  var host=document.getElementById('srv-host-input').value.trim(),port=document.getElementById('srv-port-input').value.trim();
  if(!host&&!port)return;
  var d=await fetch('/config/server',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({host:host||undefined,port:port||undefined})}).then(function(r){return r.json();});
  if(d.ok){updateSrvAddr(d.host,d.port);closeOverlay('srv-overlay');}else alert('Failed');
}

async function loadWlBl(){
  var wl=await fetch('/api/whitelist').then(function(r){return r.json();}).catch(function(){return{ips:[]};});
  var bl=await fetch('/api/blacklist').then(function(r){return r.json();}).catch(function(){return{ips:[]};});
  var myip=await fetch('/api/whoami').then(function(r){return r.json();}).catch(function(){return{ip:'unknown'};});
  var mid=document.getElementById('my-ip-display');
  if(mid)mid.textContent=myip.ip||'unknown';
  renderWlList(wl.ips||[]);
  renderBlList(bl.ips||[]);
}
function renderWlList(ips){
  var el=document.getElementById('wl-list');if(!el)return;
  el.innerHTML=ips.length?ips.map(function(ip){
    return '<div style="display:flex;align-items:center;gap:6px;padding:3px 0;border-bottom:1px solid var(--border)">'
      +'<span style="flex:1;color:var(--v3)">'+esc(ip)+'</span>'
      +'<button onclick="wlRemove(\''+esc(ip)+'\')" style="background:none;border:1px solid var(--red-bd);color:var(--red);font-family:inherit;font-size:9px;padding:1px 6px;border-radius:3px;cursor:pointer">×</button>'
      +'</div>';
  }).join(''):'<div style="color:var(--dim);font-size:10px">No IPs whitelisted</div>';
}
function renderBlList(ips){
  var el=document.getElementById('bl-list');if(!el)return;
  el.innerHTML=ips.length?ips.map(function(ip){
    return '<div style="display:flex;align-items:center;gap:6px;padding:3px 0;border-bottom:1px solid var(--border)">'
      +'<span style="flex:1;color:var(--red)">🚫 '+esc(ip)+'</span>'
      +'<button onclick="blRemove(\''+esc(ip)+'\')" style="background:none;border:1px solid var(--green-bd);color:var(--green);font-family:inherit;font-size:9px;padding:1px 6px;border-radius:3px;cursor:pointer">✓</button>'
      +'</div>';
  }).join(''):'<div style="color:var(--dim);font-size:10px">No IPs blacklisted</div>';
}
async function wlAdd(){
  var ip=document.getElementById('wl-ip-input').value.trim();if(!ip)return;
  await fetch('/api/whitelist/add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ip})});
  document.getElementById('wl-ip-input').value='';loadWlBl();
}
async function wlRemove(ip){
  await fetch('/api/whitelist/remove',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ip})});
  loadWlBl();
}
async function blAdd(){
  var ip=document.getElementById('bl-ip-input').value.trim();if(!ip)return;
  await fetch('/api/blacklist/add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ip})});
  document.getElementById('bl-ip-input').value='';loadWlBl();
}
async function blRemove(ip){
  await fetch('/api/blacklist/remove',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ip})});
  loadWlBl();
}
function updateSrvAddr(h,p){
  if(IS_OWNER)document.getElementById('srv-addr').textContent=(h||'?')+':'+(p||'?');
}

async function pingBotServer(name){
  if(!IS_OWNER)return;
  var srv=botSrv[name]||{};if(!srv.host)return;
  var pb=document.getElementById('detail-ping-btn');if(pb)pb.textContent='...';
  try{
    var d=await fetch('/serverinfo?host='+encodeURIComponent(srv.host)+'&port='+(srv.port||25565)).then(function(r){return r.json();});
    if(d&&!d.error){botServerInfo[name]=d;if(detailBot===name)renderDetailLeft(name);}
    else if(pb)pb.textContent='FAIL';
  }catch(_){if(pb)pb.textContent='ERR';}
}

document.addEventListener('click',function(ev){
  var el=ev.target.closest('[data-daction]');if(!el)return;
  var a=el.dataset.daction,n=el.dataset.dbot;
  if(!IS_OWNER)return;
  // Keep detail modal open, stack sub-modals on top
  if(a==='rename'){openRename(n);}
  else if(a==='proxy'){openProxy(n);}
  else if(a==='bsrv'){openBotServer(n);}
  else if(a==='inv'){openInv(n);}
  else if(a==='remove'){if(confirm('Remove '+n+'?')){doRemove(n);closeOverlay('detail-overlay');}}
});

async function pingServer(){
  if(!IS_OWNER)return;
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

function openOverlay(id){
  if(!IS_OWNER&&['add-overlay','srv-overlay','proxy-overlay','rename-overlay','bsrv-overlay'].includes(id))return;
  document.getElementById(id).classList.add('show');
  if(id==='srv-overlay'&&IS_OWNER)loadWlBl();
}
function closeOverlay(id){
  document.getElementById(id).classList.remove('show');
  if(id==='detail-overlay')detailBot=null;
  if(id==='map-overlay')activeMap=null;
  if(id==='proxy-overlay')activeProxy=null;
  if(id==='rename-overlay')activeRename=null;
  if(id==='bsrv-overlay')activeBotSrv=null;
  if(id==='inv-overlay')activeInv=null;
}

document.addEventListener('click',async function(ev){
  var el=ev.target.closest('[data-action]');if(!el)return;
  var a=el.dataset.action,b=el.dataset.bot;
  if(!IS_OWNER)return;
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

async function poll(){
  var dot=document.getElementById('conn-dot'),txt=document.getElementById('conn-text');
  try{
    var d=await fetch('/poll?since='+lastId).then(function(r){return r.json();});
    lastId=d.lastId;dot.className='conn-dot live';txt.textContent='LIVE';
    if(!init){
      init=true;serverStart=d.state.serverStart;
      var s=d.state.status,st=d.state.stats||{},cr=d.state.coords||{},bc=d.state.botConfigs||{},bs=d.state.botServers||{};
      if(IS_OWNER){
        if(d.state.host)document.getElementById('srv-host-input').value=d.state.host;
        if(d.state.port)document.getElementById('srv-port-input').value=d.state.port;
        updateSrvAddr(d.state.host,d.state.port);
      }
      var names=Object.keys(s);
      names.forEach(function(n){
        status[n]=s[n]||{};stats[n]=st[n]||{};coords[n]=cr[n]||null;
        if(bc&&bc[n])botCfg[n]=bc[n];
        if(bs&&bs[n])botSrv[n]=bs[n];
        containers[n]={items:{},ts:0};
        if(!logs[n])logs[n]=[];
        renderCard(n);
      });
      if(IS_OWNER&&!document.getElementById('add-card-btn')){
        var ac=document.createElement('div');ac.id='add-card-btn';ac.className='add-card';
        ac.onclick=function(){openOverlay('add-overlay');};
        ac.innerHTML='<div class="add-icon">&#65291;</div><div class="add-label">ADD BOTS</div>';
        document.getElementById('cards').appendChild(ac);
      }
      updateBotTabs();
    }
    d.events.forEach(function(ev){
      var e=ev.event,dat=ev.data;
      if(e==='log'){
        if(!logs[dat.username])logs[dat.username]=[];
        logs[dat.username].push(dat);
        pushMainLog(dat);pushDetailLog(dat);
      }else if(e==='status'){
        if(status[dat.username]){status[dat.username].online=dat.online;if(dat.online)status[dat.username].onlineSince=dat.onlineSince||Date.now();else status[dat.username].onlineSince=null;}
        renderCard(dat.username);if(detailBot===dat.username)renderDetailLeft(dat.username);
      }else if(e==='stats'){
        if(stats[dat.username])stats[dat.username]=Object.assign({},stats[dat.username],dat.stats);
        renderCard(dat.username);if(detailBot===dat.username)renderDetailLeft(dat.username);if(activeInv===dat.username)renderInvBody(dat.username);
      }else if(e==='coords'){
        coords[dat.username]=dat.coords;renderCard(dat.username);if(detailBot===dat.username)renderDetailLeft(dat.username);
      }else if(e==='containerUpdate'){
        containers[dat.username]=dat.data;if(activeInv===dat.username)renderInvBody(dat.username);
      }else if(e==='control'){
        if(status[dat.username])status[dat.username].running=dat.running!=null?dat.running:(dat.action==='started');renderCard(dat.username);
      }else if(e==='serverInfo'){
        serverInfo=dat;
        if(IS_OWNER){
          if(dat.motd)document.getElementById('srv-motd').textContent=dat.motd.replace(/\u00a7[0-9a-fk-or]/gi,'')||'(no motd)';
          if(dat.onlinePlayers!=null)document.getElementById('srv-players').textContent=dat.onlinePlayers+'/'+dat.maxPlayers+' online';
          if(dat.version)document.getElementById('srv-ver').textContent=dat.version;
          if(dat.favicon&&dat.favicon.startsWith('data:image'))document.getElementById('srv-fav').innerHTML='<img src="'+dat.favicon+'">';
        }
        if(detailBot)renderDetailLeft(detailBot);
      }else if(e==='serverConfig'){if(IS_OWNER)updateSrvAddr(dat.host,dat.port);}
      else if(e==='botServerUpdated'){botSrv[dat.name]=dat.server;}
      else if(e==='botAdded'){
        status[dat.name]=dat.status;stats[dat.name]={ghastKills:0,foodAte:0,inventory:{},chests:{}};
        coords[dat.name]=null;containers[dat.name]={items:{},ts:0};logs[dat.name]=[];
        if(dat.config)botCfg[dat.name]=dat.config;if(dat.server)botSrv[dat.name]=dat.server;
        renderCard(dat.name);updateBotTabs();
      }else if(e==='botRemoved'){
        delete status[dat.name];delete stats[dat.name];delete coords[dat.name];
        delete botCfg[dat.name];delete botSrv[dat.name];delete containers[dat.name];delete logs[dat.name];
        var c=document.getElementById('bc-'+dat.name);if(c)c.remove();
        updateBotTabs();
        if(detailBot===dat.name)closeOverlay('detail-overlay');if(activeInv===dat.name)closeOverlay('inv-overlay');
      }else if(e==='botRenamed'){
        var oN=dat.oldName,nN=dat.newName;
        allLogs.forEach(function(entry){if(entry.username===oN)entry.username=nN;});
        if(logs[oN]){logs[nN]=logs[oN];delete logs[oN];}
        delete status[oN];delete stats[oN];delete coords[oN];delete botCfg[oN];delete botSrv[oN];delete containers[oN];
        var oc=document.getElementById('bc-'+oN);if(oc)oc.remove();
        status[nN]=dat.status;
        if(!stats[nN])stats[nN]={ghastKills:0,foodAte:0,inventory:{},chests:{}};
        if(!coords[nN])coords[nN]=null;if(!containers[nN])containers[nN]={items:{},ts:0};
        if(dat.config)botCfg[nN]=dat.config;if(dat.server)botSrv[nN]=dat.server;
        if(mainBotFilter===oN){mainBotFilter=nN;}
        renderCard(nN);updateBotTabs();rebuildMainLog();
        if(detailBot===oN){detailBot=nN;document.getElementById('detail-title').textContent='Bot: '+nN;renderDetailLeft(nN);}
      }else if(e==='proxyUpdated'){
        if(botCfg[dat.name])botCfg[dat.name].proxy=dat.proxy;renderCard(dat.name);if(detailBot===dat.name)renderDetailLeft(dat.name);
      }else if(e==='blacklistUpdate'){
        // Refresh lists if settings modal is open
        var srvOv=document.getElementById('srv-overlay');
        if(srvOv&&srvOv.classList.contains('show'))loadWlBl();
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

startPoll();
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
  setTimeout(() => { botStatus[BOT1].running = true; console.log('[Launcher] Starting Kill bots: ' + BOT1); launchBot(BOT1); }, 2000);
  setTimeout(() => { botStatus[BOT2].running = true; console.log('[Launcher] Starting AFK bots: ' + BOT2); launchBot(BOT2); }, 22000);
});
