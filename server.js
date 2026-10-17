// ESP32 monitor server: HTTP + WebSocket + SQLite
// Run: npm install && DEVICE_TOKEN=imong-sekreto node server.js

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const DEVICE_TOKEN = process.env.DEVICE_TOKEN || 'change-me-secret';

// Dashboard login (set DASH_PASS to turn it on; strongly recommended when hosted online)
const DASH_USER = process.env.DASH_USER || 'admin';
const DASH_PASS = process.env.DASH_PASS || '';
const SESSION_SECRET = process.env.SESSION_SECRET ||
  crypto.createHash('sha256').update(DEVICE_TOKEN + '|' + DASH_PASS).digest('hex');
const COOKIE_NAME = 'farm_session';

// Database location (on Render with a Disk: DB_PATH=/var/data/data.db) and how long to keep readings
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS) || 30;

if (!DASH_PASS) console.warn('[security] DASH_PASS is not set: the dashboard is open to anyone who has the link');
if (DEVICE_TOKEN === 'change-me-secret') console.warn('[security] DEVICE_TOKEN is the default value, set your own secret');

// ---------- Database ----------
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS readings (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id     TEXT    NOT NULL,
    temperature   REAL,
    humidity      REAL,
    soil_moisture INTEGER,
    alarm         INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_readings_device_time
    ON readings (device_id, created_at DESC);
`);

const insertReading = db.prepare(`
  INSERT INTO readings (device_id, temperature, humidity, soil_moisture, alarm)
  VALUES (@device_id, @temperature, @humidity, @soil_moisture, @alarm)
`);
const selectRecent = db.prepare(`
  SELECT * FROM readings ORDER BY id DESC LIMIT ?
`);
const pruneOld = db.prepare(`DELETE FROM readings WHERE created_at < datetime('now', ?)`);
function prune() {
  try { pruneOld.run(`-${RETENTION_DAYS} days`); } catch (e) { console.error('[prune]', e.message); }
}
prune();
const pruneTimer = setInterval(prune, 6 * 60 * 60 * 1000);

// ---------- Validation ----------
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function validate(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const deviceId = typeof msg.device_id === 'string' ? msg.device_id.slice(0, 32) : '';
  if (!deviceId) return null;
  if (!isNum(msg.temperature) || msg.temperature < -40 || msg.temperature > 80) return null;
  if (!isNum(msg.humidity) || msg.humidity < 0 || msg.humidity > 100) return null;
  if (!isNum(msg.soil_moisture) || msg.soil_moisture < 0 || msg.soil_moisture > 100) return null;
  return {
    device_id: deviceId,
    temperature: msg.temperature,
    humidity: msg.humidity,
    soil_moisture: Math.round(msg.soil_moisture),
    alarm: msg.alarm ? 1 : 0,
  };
}

// ---------- Helpers ----------
let lastMuted = false; // pinakabag-ong mute state gikan sa ESP32 / dashboard

function broadcastLive(obj) {
  const payload = JSON.stringify(obj);
  for (const client of liveWss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// ---------- Dashboard auth ----------
const safeEqual = (a, b) => {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
};
const sessionValue = () => crypto.createHmac('sha256', SESSION_SECRET).update('dashboard-session').digest('hex');

function getCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return '';
}
const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const hasSession = (req) => safeEqual(getCookie(req, COOKIE_NAME), sessionValue());

// Simple brute-force guard: 10 wrong logins per 10 minutes per IP
const failedLogins = new Map();
const isLocked = (ip) => { const f = failedLogins.get(ip); return !!f && f.count >= 10 && Date.now() - f.first < 600000; };
function noteFail(ip) {
  const f = failedLogins.get(ip), now = Date.now();
  if (!f || now - f.first >= 600000) failedLogins.set(ip, { count: 1, first: now });
  else f.count++;
}

// Returns true when the request may continue. Otherwise it has already answered.
function requireDashAuth(req, res) {
  if (!DASH_PASS) return true;
  if (hasSession(req)) return true;

  const ip = clientIp(req);
  if (isLocked(ip)) {
    res.writeHead(429, { 'Content-Type': 'text/plain' });
    res.end('Too many attempts. Try again later.');
    return false;
  }
  const h = req.headers.authorization || '';
  if (h.startsWith('Basic ')) {
    const decoded = Buffer.from(h.slice(6), 'base64').toString();
    const i = decoded.indexOf(':');
    const user = i < 0 ? decoded : decoded.slice(0, i);
    const pass = i < 0 ? '' : decoded.slice(i + 1);
    if (safeEqual(user, DASH_USER) && safeEqual(pass, DASH_PASS)) {
      const secure = req.headers['x-forwarded-proto'] === 'https';
      res.setHeader('Set-Cookie',
        `${COOKIE_NAME}=${sessionValue()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure ? '; Secure' : ''}`);
      failedLogins.delete(ip);
      return true;
    }
    noteFail(ip);
  }
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Smart Farm Monitor", charset="UTF-8"', 'Content-Type': 'text/plain' });
  res.end('Login required');
  return false;
}

// ---------- HTTP ----------
const PWA_FILES = {
  '/manifest.webmanifest':          ['manifest.webmanifest', 'application/manifest+json', 'no-cache'],
  '/sw.js':                         ['sw.js', 'application/javascript; charset=utf-8', 'no-cache'],
  '/icons/icon-192.png':            ['icons/icon-192.png', 'image/png', 'public, max-age=86400'],
  '/icons/icon-512.png':            ['icons/icon-512.png', 'image/png', 'public, max-age=86400'],
  '/icons/icon-maskable-512.png':   ['icons/icon-maskable-512.png', 'image/png', 'public, max-age=86400'],
  '/icons/apple-touch-icon.png':    ['icons/apple-touch-icon.png', 'image/png', 'public, max-age=86400'],
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Health check for the hosting platform (no login, no data)
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }

  // App-install files (contain nothing private), served without login so the phone can install the app
  const pwa = PWA_FILES[url.pathname];
  if (pwa) {
    return fs.readFile(path.join(__dirname, 'public', pwa[0]), (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': pwa[1], 'Cache-Control': pwa[2] });
      res.end(data);
    });
  }

  if (!requireDashAuth(req, res)) return;

  if (url.pathname === '/api/readings') {
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit')) || 50, 1), 500);
    return sendJson(res, 200, selectRecent.all(limit));
  }

  // Mute / unmute gikan sa dashboard
  if (url.pathname === '/api/mute' && req.method === 'POST') {
    // Block requests coming from other websites
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) {
      return sendJson(res, 403, { ok: false, error: 'forbidden origin' });
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024) req.destroy();
    });
    req.on('end', () => {
      let mute = true;
      try {
        const j = JSON.parse(body || '{}');
        if (j.mute === false) mute = false;
      } catch {}

      let sent = 0;
      for (const d of deviceWss.clients) {
        if (d.readyState === WebSocket.OPEN) {
          d.send(JSON.stringify({ type: mute ? 'mute' : 'unmute' }));
          sent++;
        }
      }
      if (!sent) return sendJson(res, 503, { ok: false, error: 'device offline' });

      lastMuted = mute;
      broadcastLive({ type: 'mute_state', muted: mute });
      console.log(`[mute] ${mute ? 'muted' : 'unmuted'} gikan sa dashboard`);
      sendJson(res, 200, { ok: true, muted: mute });
    });
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    const file = path.join(__dirname, 'public', 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(500);
        return res.end('Dashboard file missing');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// ---------- WebSocket ----------
// /device -> ESP32 (needs ?token=...)
// /live   -> dashboard viewers (read-only)
const deviceWss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
const liveWss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/device') {
    if (url.searchParams.get('token') !== DEVICE_TOKEN) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    return deviceWss.handleUpgrade(req, socket, head, (ws) => deviceWss.emit('connection', ws, req));
  }

  if (url.pathname === '/live') {
    if (DASH_PASS && !hasSession(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    return liveWss.handleUpgrade(req, socket, head, (ws) => liveWss.emit('connection', ws, req));
  }

  socket.destroy();
});

// Kung mo-connect ang dashboard, ihatag dayon ang kasamtangang mute state
liveWss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'mute_state', muted: lastMuted }));
});

deviceWss.on('connection', (ws) => {
  console.log('[device] connected');

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return ws.send(JSON.stringify({ type: 'error', message: 'invalid JSON' }));
    }

    const reading = validate(msg);
    if (!reading) {
      return ws.send(JSON.stringify({ type: 'error', message: 'invalid reading' }));
    }

    const muted = !!msg.muted;
    lastMuted = muted;

    const info = insertReading.run(reading);
    ws.send(JSON.stringify({ type: 'ack', id: Number(info.lastInsertRowid) }));

    broadcastLive({ type: 'reading', ...reading, muted, created_at: new Date().toISOString() });
    console.log(`[reading] ${reading.device_id} ${reading.temperature}C ${reading.humidity}% soil ${reading.soil_moisture}% alarm=${reading.alarm} muted=${muted ? 1 : 0}`);
  });

  ws.on('close', () => console.log('[device] disconnected'));
  ws.on('error', (e) => console.error('[device] error', e.message));
});

// Drop dead connections
const heartbeat = setInterval(() => {
  for (const wss of [deviceWss, liveWss]) {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }
}, 30000);
for (const wss of [deviceWss, liveWss]) {
  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
  });
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
  console.log(`ESP32 connects to ws://<IP-SA-KOMPYUTER>:${PORT}/device?token=${DEVICE_TOKEN}`);
});

function shutdown() {
  clearInterval(heartbeat);
  clearInterval(pruneTimer);
  db.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);   // Render stops the app with SIGTERM
