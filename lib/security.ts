// Wave C: access control helpers for the control-plane HTTP API.
//
// Policy (product Option B — multi-agent control plane):
//   - Loopback is trusted (agent-fleet LAUNCH_MODE=remote on same host).
//   - Non-loopback requires GROK_REMOTE_TOKEN when configured.
//   - Filesystem browse + agent cwd are jailed under $HOME (or GROK_REMOTE_JAIL).
//   - Admin routes (version update, etc.) are loopback-only unless token matches.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { IncomingMessage } from 'node:http';

export function authToken(): string {
  const t = process.env['GROK_REMOTE_TOKEN'] || process.env['GR_TOKEN'] || '';
  return t.trim();
}

/** Root for browse + cwd jail. Default $HOME. Empty string disables jail (tests only). */
export function jailRoot(): string {
  if (process.env['GROK_REMOTE_JAIL'] === '') return '';
  const j = process.env['GROK_REMOTE_JAIL'];
  if (typeof j === 'string' && j.trim()) return path.resolve(j.trim());
  return path.resolve(os.homedir());
}

export function isLoopbackAddress(addr: string | undefined | null): boolean {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/, '');
  return a === '127.0.0.1' || a === '::1' || a === 'localhost';
}

export function requestIsLoopback(req: IncomingMessage): boolean {
  const ra = req.socket && req.socket.remoteAddress;
  return isLoopbackAddress(ra);
}

/** Extract bearer / custom header token from request. */
export function requestToken(req: IncomingMessage): string | null {
  const h = req.headers;
  const custom = h['x-grok-remote-token'];
  if (typeof custom === 'string' && custom.trim()) return custom.trim();
  if (Array.isArray(custom) && custom[0]) return String(custom[0]).trim();
  const auth = h['authorization'];
  const raw = Array.isArray(auth) ? auth[0] : auth;
  if (typeof raw === 'string') {
    const m = raw.match(/^Bearer\s+(.+)$/i);
    if (m && m[1]) return m[1].trim();
    // Allow raw token in Authorization for simple curl clients.
    if (raw.trim() && !raw.includes(' ')) return raw.trim();
  }
  return null;
}

export type AuthResult =
  | { ok: true; via: 'loopback' | 'token' | 'open' }
  | { ok: false; status: number; error: string };

/**
 * Authorize an API request.
 * - Loopback always ok (fleet contract).
 * - If token configured: non-loopback must present matching token.
 * - If token unset: allow (legacy open), caller may log warn once at boot.
 */
export function authorizeRequest(req: IncomingMessage): AuthResult {
  if (requestIsLoopback(req)) return { ok: true, via: 'loopback' };
  const expected = authToken();
  if (!expected) return { ok: true, via: 'open' };
  const got = requestToken(req);
  if (got && got === expected) return { ok: true, via: 'token' };
  return {
    ok: false,
    status: 401,
    error: 'unauthorized: set Authorization: Bearer <GROK_REMOTE_TOKEN> or X-Grok-Remote-Token',
  };
}

/** Admin mutations (self-update, etc.): loopback OR valid token. */
export function authorizeAdmin(req: IncomingMessage): AuthResult {
  if (requestIsLoopback(req)) return { ok: true, via: 'loopback' };
  const expected = authToken();
  if (!expected) {
    return {
      ok: false,
      status: 403,
      error: 'admin routes require loopback or GROK_REMOTE_TOKEN on non-loopback',
    };
  }
  const got = requestToken(req);
  if (got && got === expected) return { ok: true, via: 'token' };
  return { ok: false, status: 401, error: 'unauthorized admin' };
}

/** True if `target` is equal to or inside `root` after resolve. */
export function pathInsideRoot(root: string, target: string): boolean {
  if (!root) return true;
  const r = path.resolve(root);
  const t = path.resolve(target);
  return t === r || t.startsWith(r + path.sep);
}

/**
 * Validate agent cwd: must exist, be a directory, and live under jail.
 * Returns absolute path or throws Error with message for 400 responses.
 */
export function assertCwdAllowed(
  cwd: string,
  opts: {
    jail?: string;
    existsSync?: (p: string) => boolean;
    statSync?: (p: string) => { isDirectory(): boolean };
  } = {},
): string {
  const existsSync = opts.existsSync || fs.existsSync.bind(fs);
  const statSync = opts.statSync || fs.statSync.bind(fs);
  const jail = opts.jail !== undefined ? opts.jail : jailRoot();
  const resolved = path.resolve(cwd);
  if (!existsSync(resolved)) throw new Error(`cwd does not exist: ${resolved}`);
  let st: { isDirectory(): boolean };
  try { st = statSync(resolved); } catch {
    throw new Error(`cwd not accessible: ${resolved}`);
  }
  if (!st.isDirectory()) throw new Error(`cwd is not a directory: ${resolved}`);
  if (jail && !pathInsideRoot(jail, resolved)) {
    throw new Error(`cwd outside allowed jail (${jail}): ${resolved}`);
  }
  return resolved;
}

/** Clamp browse target into jail; returns resolved path or error string. */
export function clampBrowsePath(raw: unknown, home: string = os.homedir(), jail: string = jailRoot()): { path: string; error?: string } {
  const homeAbs = path.resolve(home);
  let target: string;
  if (raw == null || raw === '') target = homeAbs;
  else {
    const s = String(raw).trim();
    if (!s || s === '~') target = homeAbs;
    else if (s.startsWith('~/') || s.startsWith('~' + path.sep)) target = path.resolve(homeAbs, s.slice(2));
    else target = path.resolve(s);
  }
  if (jail && !pathInsideRoot(jail, target)) {
    return { path: path.resolve(jail), error: `path outside allowed jail (${jail})` };
  }
  return { path: target };
}
