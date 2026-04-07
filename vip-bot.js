// vip-bot.js — Ultra-lightweight Minecraft connection bots
// Uses minecraft-protocol directly (no mineflayer physics/chunk engine).
// RAM usage per bot: ~1-3 MB instead of ~50-100 MB with mineflayer.
// Each bot: connects → handles keepalive → auto-login → stays idle.

'use strict';

const net = require('net');

// ─── Require minecraft-protocol (bundled inside mineflayer) ──────────────────
function getMcProto() {
  try { return require('minecraft-protocol'); } catch (_) {}
  try { return require('mineflayer/node_modules/minecraft-protocol'); } catch (_) {}
  throw new Error('minecraft-protocol not found — run: npm install minecraft-protocol');
}

// ─── Proxy Checker ────────────────────────────────────────────────────────────
// Tests whether a proxy/VPN is reachable by trying to CONNECT to 1.1.1.1:80.

async function checkProxy(proxy, timeoutMs = 6000) {
  const start = Date.now();
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok, err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(ok ? { ok: true, latency: Date.now() - start } : { ok: false, err: String(err) });
    };

    const timer = setTimeout(() => finish(false, 'timeout'), timeoutMs);

    if (proxy.type === 'http') {
      // HTTP CONNECT tunnel
      const socket = net.connect(proxy.port, proxy.host, () => {
        const auth = proxy.username
          ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64')}\r\n`
          : '';
        socket.write(`CONNECT 1.1.1.1:80 HTTP/1.1\r\nHost: 1.1.1.1:80\r\n${auth}\r\n`);
        socket.once('data', (d) => {
          socket.destroy();
          finish(d.toString().includes('200'), 'HTTP CONNECT rejected');
        });
      });
      socket.once('error', (e) => finish(false, e.message));
    } else {
      // SOCKS4 / SOCKS5
      try {
        const { SocksClient } = require('socks');
        SocksClient.createConnection({
          proxy: {
            host:     proxy.host,
            port:     proxy.port,
            type:     proxy.type === 4 ? 4 : 5,
            userId:   proxy.username,
            password: proxy.password,
          },
          command:     'connect',
          destination: { host: '1.1.1.1', port: 80 },
        }, (err, info) => {
          if (err) return finish(false, err.message);
          try { info.socket.destroy(); } catch (_) {}
          finish(true, null);
        });
      } catch (e) {
        finish(false, 'socks package not installed: ' + e.message);
      }
    }
  });
}

// ─── Single Lightweight Bot ───────────────────────────────────────────────────
// Creates a raw minecraft-protocol client. No physics, no inventory tracking,
// no chunk loading. Just TCP + MC handshake + keepalive + optional /login.

function createLightBot({ username, host, port, password, proxy, onDead }) {
  const mc = getMcProto();

  const opts = {
    host,
    port,
    username,
    auth:     'offline',
    version:  false,       // auto-detect from server
    hideErrors: true,
    checkTimeoutInterval: 30000,
  };

  // Attach SOCKS proxy if provided
  if (proxy && proxy.host) {
    if (proxy.type === 'http') {
      // HTTP CONNECT proxy — tunnel the TCP socket manually
      opts.connect = (client) => {
        const socket = net.connect(proxy.port, proxy.host, () => {
          const auth = proxy.username
            ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64')}\r\n`
            : '';
          socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
          socket.once('data', (d) => {
            if (d.toString().includes('200')) {
              client.setSocket(socket);
              client.emit('connect');
            } else {
              client.emit('error', new Error('HTTP CONNECT failed'));
            }
          });
        });
        socket.once('error', (e) => client.emit('error', e));
      };
    } else {
      // SOCKS4 / SOCKS5
      opts.connect = (client) => {
        try {
          const { SocksClient } = require('socks');
          SocksClient.createConnection({
            proxy: {
              host:     proxy.host,
              port:     proxy.port,
              type:     proxy.type === 4 ? 4 : 5,
              userId:   proxy.username,
              password: proxy.password,
            },
            command:     'connect',
            destination: { host, port },
          }, (err, info) => {
            if (err) { client.emit('error', err); return; }
            client.setSocket(info.socket);
            client.emit('connect');
          });
        } catch (e) {
          client.emit('error', e);
        }
      };
    }
  }

  let alive = true;
  let client;

  try {
    client = mc.createClient(opts);
  } catch (e) {
    onDead && onDead(username);
    return { username, destroy: () => {}, alive: () => false, proxyIndex: proxy?._index ?? -1 };
  }

  // ── Keepalive: respond to server pings to avoid timeout kick ────────────
  client.on('keep_alive', (packet) => {
    if (!alive) return;
    try { client.write('keep_alive', { keepAliveId: packet.keepAliveId }); } catch (_) {}
  });

  // ── Auto-login: send /login <password> when server prompts ──────────────
  if (password) {
    let loggedIn = false;
    client.once('login', () => {
      // Send immediately on join
      setTimeout(() => {
        if (!alive || loggedIn) return;
        try { client.write('chat', { message: `/login ${password}` }); } catch (_) {}
      }, 1200);
    });
    client.on('playerChat', (p) => {
      if (loggedIn) return;
      const txt = (p.formattedMessage || p.unsignedContent || '').toLowerCase();
      if (txt.includes('login') || txt.includes('register')) {
        try { client.write('chat', { message: `/login ${password}` }); } catch (_) {}
        setTimeout(() => { try { client.write('chat', { message: `/register ${password} ${password}` }); } catch(_){} }, 400);
        setTimeout(() => { try { client.write('chat', { message: `/login ${password}` }); } catch(_){} }, 800);
        loggedIn = true;
      }
    });
    // Legacy chat packet (older server versions)
    client.on('chat', (p) => {
      if (loggedIn) return;
      let txt = '';
      try { txt = (typeof p.message === 'string' ? p.message : JSON.parse(p.message)?.text || '').toLowerCase(); } catch(_) {}
      if (txt.includes('login') || txt.includes('register')) {
        try { client.write('chat', { message: `/login ${password}` }); } catch (_) {}
        loggedIn = true;
      }
    });
  }

  const destroy = () => {
    if (!alive) return;
    alive = false;
    try { client.end('quit'); } catch (_) {}
  };

  client.on('error',      () => { alive = false; onDead && onDead(username); });
  client.on('end',        () => { alive = false; onDead && onDead(username); });
  client.on('disconnect', () => { alive = false; onDead && onDead(username); });

  return {
    username,
    destroy,
    alive:      () => alive,
    proxyIndex: proxy?._index ?? -1,
  };
}

// ─── Swarm Launcher ───────────────────────────────────────────────────────────
// Launches `count` bots, distributing them equally across proxies.
// If proxies = [A, B] and count = 10 → bots 0-4 use A, bots 5-9 use B.
// Staggers connection attempts (50 ms apart) to avoid rate-limiting.

async function launchSwarm({ count, proxies = [], host, port, password, onDead }) {
  const bots = [];
  const stagger = Math.min(80, Math.max(20, Math.floor(3000 / count))); // ms between spawns

  for (let i = 0; i < count; i++) {
    const username = `VIP_${String(i + 1).padStart(3, '0')}`;

    // Distribute proxies evenly: bot i → proxy floor(i / botsPerProxy)
    let proxy = null;
    if (proxies.length > 0) {
      const botsPerProxy = Math.ceil(count / proxies.length);
      const pIdx         = Math.min(Math.floor(i / botsPerProxy), proxies.length - 1);
      proxy              = { ...proxies[pIdx], _index: pIdx };
    }

    const bot = createLightBot({ username, host, port, password, proxy, onDead });
    bots.push(bot);

    if (i < count - 1) {
      await new Promise(r => setTimeout(r, stagger));
    }
  }

  return bots;
}

module.exports = { launchSwarm, checkProxy, createLightBot };
