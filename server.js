// ESP32 monitor server: HTTP + WebSocket + SQLite
// Run: npm install && DEVICE_TOKEN=imong-sekreto node server.js

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const DEVICE_TOKEN = process.env.DEVICE_TOKEN || 'change-me-secret';

// ---------- Database ----------
const db = new Database(path.join(__dirname, 'data.db'));
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
let lastMuted = false; // latest mute state from ESP32 / dashboard

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

// ---------- HTTP ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/readings') {
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit')) || 50, 1), 500);
    return sendJson(res, 200, selectRecent.all(limit));
  }

  // Mute / unmute from the dashboard
  if (url.pathname === '/api/mute' && req.method === 'POST') {
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
      console.log(`[mute] ${mute ? 'muted' : 'unmuted'} from dashboard`);
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
// /live   -> dashboard viewers
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
    return liveWss.handleUpgrade(req, socket, head, (ws) => liveWss.emit('connection', ws, req));
  }

  socket.destroy();
});

// When a dashboard connects, send the current mute state right away
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

process.on('SIGINT', () => {
  clearInterval(heartbeat);
  db.close();
  process.exit(0);
});
