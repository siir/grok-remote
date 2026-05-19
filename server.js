#!/usr/bin/env node
// grok-remote server
//
// Serves the built Vite dashboard plus the /api surface. Designed to sit on
// your tailnet so you can reach it from any device you own. The
// remote-agent endpoints live below.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import os from 'node:os';

import { AgentManager } from './lib/agent-manager.js';
import { load as loadSettings, save as saveSettings } from './lib/settings.js';
import { readAll as readHistory } from './lib/history.js';
import { writeHeaders as sseHeaders, writeEvent as sseWrite, writePing as ssePing } from './lib/sse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const PORT = parseInt(process.env.PORT || '7910', 10);
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
};

const manager = new AgentManager();

function safeJoin(base, rel) {
  const target = path.resolve(base, '.' + rel);
  if (!target.startsWith(base)) return null;
  return target;
}

function tailscaleIdentity() {
  const r = spawnSync('tailscale', ['status', '--json'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  try {
    const j = JSON.parse(r.stdout);
    const self = j.Self || {};
    return {
      backend: j.BackendState,
      dns: (self.DNSName || '').replace(/\.$/, ''),
      ip:  (self.TailscaleIPs && self.TailscaleIPs[0]) || '',
      hostname: self.HostName || os.hostname(),
    };
  } catch { return null; }
}

function serveStatic(req, res) {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  let rel = url === '/' ? '/index.html' : url;
  let target = safeJoin(DIST, rel);
  if (!target || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    target = path.join(DIST, 'index.html');
  }
  if (!fs.existsSync(target)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('grok-remote: dist/ not built yet. Run `npm run build` (or `npm run install:setup`).\n');
    return;
  }
  const ext = path.extname(target).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(target).pipe(res);
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req, limitBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (c) => {
      total += c.length;
      if (total > limitBytes) {
        req.destroy();
        reject(new Error('payload too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.length) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (err) { reject(new Error(`invalid json: ${err.message}`)); }
    });
    req.on('error', reject);
  });
}

function matchAgentRoute(url) {
  // Returns { id, suffix } or null
  const m = url.match(/^\/api\/agents\/([^\/]+)(\/[^?]*)?$/);
  if (!m) return null;
  return { id: m[1], suffix: m[2] || '' };
}

async function handleApi(req, res, url, method) {
  if (url === '/api/hello' && method === 'GET') {
    const ts = tailscaleIdentity();
    return sendJson(res, 200, {
      ok: true,
      app: 'grok-remote',
      version: '0.1.0',
      message: 'remote up. agent endpoints land here soon.',
      now: new Date().toISOString(),
      uptime_seconds: Math.floor(process.uptime()),
      node: process.version,
      platform: process.platform,
      hostname: os.hostname(),
      tailscale: ts,
    });
  }

  if (url === '/api/health' && method === 'GET') {
    return sendJson(res, 200, { ok: true, uptime_seconds: Math.floor(process.uptime()) });
  }

  if (url === '/api/settings' && method === 'GET') {
    return sendJson(res, 200, loadSettings());
  }

  if (url === '/api/settings' && method === 'PATCH') {
    try {
      const body = await readJsonBody(req);
      const merged = saveSettings(body || {});
      return sendJson(res, 200, merged);
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
  }

  if (url === '/api/agents' && method === 'GET') {
    return sendJson(res, 200, manager.list());
  }

  if (url === '/api/agents' && method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const rec = await manager.spawn(body || {});
      return sendJson(res, 201, rec);
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
  }

  const route = matchAgentRoute(url);
  if (route) {
    const { id, suffix } = route;
    const rec = manager.get(id);
    if (!rec) return sendJson(res, 404, { ok: false, error: 'agent not found' });

    if (suffix === '' && method === 'GET') {
      return sendJson(res, 200, rec);
    }
    if (suffix === '' && method === 'DELETE') {
      const ok = await manager.kill(id);
      return sendJson(res, ok ? 200 : 404, { ok });
    }
    if (suffix === '/prompt' && method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const text = body?.text;
        if (typeof text !== 'string' || !text.length) {
          return sendJson(res, 400, { ok: false, error: 'text required' });
        }
        await manager.prompt(id, text);
        return sendJson(res, 202, { ok: true, accepted: true });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }
    }
    if (suffix === '/cancel' && method === 'POST') {
      await manager.cancel(id);
      return sendJson(res, 202, { ok: true, accepted: true });
    }
    if (suffix === '/history' && method === 'GET') {
      const body = readHistory(id);
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
      res.end(body);
      return;
    }
    if (suffix === '/stream' && method === 'GET') {
      return handleStream(req, res, id);
    }
    return sendJson(res, 404, { ok: false, error: 'not found' });
  }

  return sendJson(res, 404, { ok: false, error: 'not found' });
}

function handleStream(req, res, id) {
  const ring = manager.ring(id);
  if (!ring) return sendJson(res, 404, { ok: false, error: 'agent not found' });

  sseHeaders(res);
  const lastId = req.headers['last-event-id'];
  for (const ev of ring.since(lastId)) {
    sseWrite(res, ev);
  }

  const unsub = manager.subscribe(id, (ev) => sseWrite(res, ev));
  const heartbeat = setInterval(() => ssePing(res), 15000);

  const cleanup = () => {
    clearInterval(heartbeat);
    try { unsub(); } catch { /* ignore */ }
    if (!res.writableEnded) try { res.end(); } catch { /* ignore */ }
  };

  req.on('close', cleanup);
  req.on('error', cleanup);
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || '').split('?')[0];
  if (url.startsWith('/api/')) {
    try {
      await handleApi(req, res, url, req.method || 'GET');
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: err.message });
    }
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  const ts = tailscaleIdentity();
  const where = ts?.dns ? `http://${ts.dns}:${PORT}` : `http://${HOST}:${PORT}`;
  console.log(`[grok-remote] listening on ${HOST}:${PORT}`);
  console.log(`[grok-remote] tailnet url: ${where}`);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[grok-remote] shutdown on ${signal}`);
  try { await manager.shutdownAll(); } catch { /* ignore */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref?.();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
