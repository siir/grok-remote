#!/usr/bin/env node
// grok-remote server
//
// Serves the built Vite dashboard plus a tiny /api surface. Designed to sit
// on your tailnet so you can reach it from any device you own. The
// remote-agent endpoints land here later.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import os from 'node:os';

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

function api(req, res) {
  const url = (req.url || '').split('?')[0];

  if (url === '/api/hello') {
    const ts = tailscaleIdentity();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
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
    }, null, 2));
    return true;
  }

  if (url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, uptime_seconds: Math.floor(process.uptime()) }));
    return true;
  }

  return false;
}

const server = http.createServer((req, res) => {
  if ((req.url || '').startsWith('/api/')) {
    if (api(req, res)) return;
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
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
