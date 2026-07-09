// Enable/disable "start grok-remote when the user logs in".
//
// macOS: user LaunchAgent that runs node --import tsx server.ts
// Linux: systemd --user unit (best-effort)
//
// Does NOT require pm2. If pm2-based startup was installed by the installer,
// status() reports that separately as method "pm2".

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const LABEL = 'com.siir.grok-remote';
const PLIST_NAME = `${LABEL}.plist`;
const SYSTEMD_UNIT = 'grok-remote.service';

export type BootMethod = 'launchd' | 'systemd' | 'pm2' | 'none';

export interface BootStartStatus {
  supported: boolean;
  enabled: boolean;
  method: BootMethod;
  path: string | null;
  detail: string;
  /** Absolute install dir the unit would run from. */
  installDir: string;
  nodePath: string;
}

function installDirFromHere(): string {
  // lib/boot-autostart.ts → project root
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..');
}

function launchAgentsDir(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents');
}

function plistPath(): string {
  return path.join(launchAgentsDir(), PLIST_NAME);
}

function systemdUserDir(): string {
  return path.join(os.homedir(), '.config', 'systemd', 'user');
}

function unitPath(): string {
  return path.join(systemdUserDir(), SYSTEMD_UNIT);
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildPlist(opts: {
  nodePath: string;
  installDir: string;
  port: string;
  host: string;
}): string {
  const serverTs = path.join(opts.installDir, 'server.ts');
  const logOut = path.join(opts.installDir, 'logs', 'grok-remote.launchd.out.log');
  const logErr = path.join(opts.installDir, 'logs', 'grok-remote.launchd.err.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(opts.nodePath)}</string>
    <string>--import</string>
    <string>tsx</string>
    <string>${escapeXml(serverTs)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(opts.installDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key>
    <string>${escapeXml(opts.port)}</string>
    <key>HOST</key>
    <string>${escapeXml(opts.host)}</string>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>PATH</key>
    <string>${escapeXml(process.env['PATH'] || '/usr/local/bin:/usr/bin:/bin')}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(logOut)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logErr)}</string>
</dict>
</plist>
`;
}

function buildSystemdUnit(opts: {
  nodePath: string;
  installDir: string;
  port: string;
  host: string;
}): string {
  const serverTs = path.join(opts.installDir, 'server.ts');
  return `[Unit]
Description=grok-remote control plane
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${opts.installDir}
ExecStart=${opts.nodePath} --import tsx ${serverTs}
Restart=on-failure
RestartSec=3
Environment=PORT=${opts.port}
Environment=HOST=${opts.host}
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
`;
}

function pm2StartupPresent(): boolean {
  if (process.platform === 'darwin') {
    try {
      const dir = launchAgentsDir();
      if (!fs.existsSync(dir)) return false;
      return fs.readdirSync(dir).some((f) => f.includes('pm2') && f.endsWith('.plist'));
    } catch { return false; }
  }
  // Linux: look for pm2 systemd unit (best-effort)
  try {
    const r = spawnSync('systemctl', ['--user', 'is-enabled', 'pm2-root'], { encoding: 'utf8' });
    if (r.status === 0) return true;
  } catch { /* ignore */ }
  return false;
}

export function bootStartStatus(opts: {
  installDir?: string;
  nodePath?: string;
} = {}): BootStartStatus {
  const installDir = opts.installDir || installDirFromHere();
  const nodePath = opts.nodePath || process.execPath;

  if (process.platform === 'darwin') {
    const p = plistPath();
    const enabled = fs.existsSync(p);
    let detail = enabled
      ? `LaunchAgent installed at ${p}`
      : 'LaunchAgent not installed (server will not start at login)';
    if (pm2StartupPresent()) {
      detail += enabled
        ? '; pm2 launch agent also present'
        : '; pm2 launch agent present (may start via pm2 resurrect if dump exists)';
    }
    return {
      supported: true,
      enabled,
      method: enabled ? 'launchd' : (pm2StartupPresent() ? 'pm2' : 'none'),
      path: enabled ? p : (pm2StartupPresent() ? launchAgentsDir() : null),
      detail,
      installDir,
      nodePath,
    };
  }

  if (process.platform === 'linux') {
    const p = unitPath();
    let enabled = false;
    try {
      const r = spawnSync('systemctl', ['--user', 'is-enabled', SYSTEMD_UNIT], { encoding: 'utf8' });
      enabled = r.status === 0 && String(r.stdout || '').trim() === 'enabled';
    } catch { enabled = fs.existsSync(p); }
    return {
      supported: true,
      enabled,
      method: enabled ? 'systemd' : 'none',
      path: fs.existsSync(p) ? p : null,
      detail: enabled
        ? `systemd user unit enabled (${SYSTEMD_UNIT})`
        : 'systemd user unit not enabled',
      installDir,
      nodePath,
    };
  }

  return {
    supported: false,
    enabled: false,
    method: 'none',
    path: null,
    detail: `boot auto-start not supported on platform ${process.platform}`,
    installDir,
    nodePath,
  };
}

export function enableBootStart(opts: {
  installDir?: string;
  nodePath?: string;
  port?: string;
  host?: string;
} = {}): BootStartStatus {
  const installDir = opts.installDir || installDirFromHere();
  const nodePath = opts.nodePath || process.execPath;
  const port = opts.port || process.env['PORT'] || '7910';
  const host = opts.host || process.env['HOST'] || '0.0.0.0';

  fs.mkdirSync(path.join(installDir, 'logs'), { recursive: true });

  if (process.platform === 'darwin') {
    const dir = launchAgentsDir();
    fs.mkdirSync(dir, { recursive: true });
    const p = plistPath();
    // Unload first if present so reload picks up new paths.
    try {
      spawnSync('launchctl', ['bootout', `gui/${process.getuid?.() ?? 501}/${LABEL}`], {
        encoding: 'utf8',
        timeout: 5000,
      });
    } catch { /* ignore */ }
    try {
      spawnSync('launchctl', ['unload', p], { encoding: 'utf8', timeout: 5000 });
    } catch { /* ignore */ }

    fs.writeFileSync(p, buildPlist({ nodePath, installDir, port, host }), 'utf8');

    const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
    const boot = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, p], {
      encoding: 'utf8',
      timeout: 8000,
    });
    // Older macOS: load
    if (boot.status !== 0) {
      spawnSync('launchctl', ['load', '-w', p], { encoding: 'utf8', timeout: 8000 });
    }
    // Do NOT kickstart -k while this process may already be serving PORT —
    // that would race EADDRINUSE. RunAtLoad starts us on next login.

    return bootStartStatus({ installDir, nodePath });
  }

  if (process.platform === 'linux') {
    const dir = systemdUserDir();
    fs.mkdirSync(dir, { recursive: true });
    const p = unitPath();
    fs.writeFileSync(p, buildSystemdUnit({ nodePath, installDir, port, host }), 'utf8');
    spawnSync('systemctl', ['--user', 'daemon-reload'], { encoding: 'utf8', timeout: 8000 });
    spawnSync('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT], {
      encoding: 'utf8',
      timeout: 8000,
    });
    // Linger so user services run at boot without login (best-effort; may need loginctl).
    try {
      spawnSync('loginctl', ['enable-linger', os.userInfo().username], {
        encoding: 'utf8',
        timeout: 5000,
      });
    } catch { /* ignore */ }
    return bootStartStatus({ installDir, nodePath });
  }

  return bootStartStatus({ installDir, nodePath });
}

export function disableBootStart(opts: {
  installDir?: string;
  nodePath?: string;
} = {}): BootStartStatus {
  const installDir = opts.installDir || installDirFromHere();
  const nodePath = opts.nodePath || process.execPath;

  if (process.platform === 'darwin') {
    const p = plistPath();
    const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
    try {
      spawnSync('launchctl', ['bootout', `gui/${uid}/${LABEL}`], {
        encoding: 'utf8',
        timeout: 5000,
      });
    } catch { /* ignore */ }
    try {
      spawnSync('launchctl', ['unload', '-w', p], { encoding: 'utf8', timeout: 5000 });
    } catch { /* ignore */ }
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ }
    return bootStartStatus({ installDir, nodePath });
  }

  if (process.platform === 'linux') {
    spawnSync('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT], {
      encoding: 'utf8',
      timeout: 8000,
    });
    const p = unitPath();
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ }
    spawnSync('systemctl', ['--user', 'daemon-reload'], { encoding: 'utf8', timeout: 5000 });
    return bootStartStatus({ installDir, nodePath });
  }

  return bootStartStatus({ installDir, nodePath });
}

export function setBootStart(enabled: boolean): BootStartStatus {
  return enabled ? enableBootStart() : disableBootStart();
}
