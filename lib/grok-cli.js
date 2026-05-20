// Thin wrapper around the `grok` CLI for the system-pages routes.
//
// Every `grok <subcommand>` we want to surface in the web UI goes through
// `runGrok(args, opts)`. The wrapper:
//
// - Pipes stdout/stderr (no inherited PTY) so a misbehaving grok run can't
//   hang the http process.
// - Bounds output (`maxBytes`, default 1 MB) so a runaway command can't
//   exhaust memory.
// - Times out (`timeoutMs`, default 20 s) and kills the child on overrun.
// - When `json: true`, parses the stdout body as JSON. Many grok subcommands
//   take a `--json` flag; the caller is responsible for adding that flag.
//
// Anything that needs interactive input from the user (sudo password,
// tailscale login, oauth flow) is NOT a good fit for this wrapper and
// should stay in the installer.

import { spawn } from 'node:child_process';

const GROK_BIN = process.env.GROK_BIN || 'grok';

export class GrokCliError extends Error {
  constructor(message, { code, stdout, stderr, args } = {}) {
    super(message);
    this.name = 'GrokCliError';
    this.code = code ?? null;
    this.stdout = stdout || '';
    this.stderr = stderr || '';
    this.args = args || null;
  }
}

export function runGrok(args, opts = {}) {
  const {
    timeoutMs = 20_000,
    maxBytes  = 1_048_576,
    cwd       = undefined,
    env       = process.env,
    json      = false,
    stdin     = null,
  } = opts;

  return new Promise((resolve, reject) => {
    const child = spawn(GROK_BIN, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let killed = false;
    let outBytes = 0;
    let errBytes = 0;

    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 1500);
    }, timeoutMs);

    child.stdout.on('data', (buf) => {
      outBytes += buf.length;
      if (outBytes > maxBytes) {
        killed = true;
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        return;
      }
      stdout += buf.toString('utf8');
    });
    child.stderr.on('data', (buf) => {
      errBytes += buf.length;
      if (errBytes > maxBytes) return; // just drop excess stderr
      stderr += buf.toString('utf8');
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new GrokCliError(err.message, { args, stdout, stderr }));
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      if (killed) {
        return reject(new GrokCliError('grok call timed out or exceeded output limit', {
          code, stdout, stderr, args,
        }));
      }
      if (code !== 0) {
        return reject(new GrokCliError(`grok exited with code ${code}`, {
          code, stdout, stderr, args,
        }));
      }
      if (!json) return resolve({ stdout, stderr, code });
      // Many `--json` grok commands print exactly one JSON object/array.
      // Some print one JSON object per line (e.g. import --list --json).
      // Try the simple parse first, fall back to NDJSON.
      const trimmed = stdout.trim();
      if (!trimmed) return resolve({ json: null, stdout, stderr, code });
      try {
        return resolve({ json: JSON.parse(trimmed), stdout, stderr, code });
      } catch { /* fall through to NDJSON */ }
      const rows = [];
      for (const line of trimmed.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try { rows.push(JSON.parse(t)); } catch { /* skip malformed */ }
      }
      if (rows.length) return resolve({ json: rows, stdout, stderr, code });
      return reject(new GrokCliError('failed to parse grok output as JSON', { code, stdout, stderr, args }));
    });

    if (stdin) {
      try { child.stdin.write(stdin); } catch { /* ignore */ }
    }
    try { child.stdin.end(); } catch { /* ignore */ }
  });
}

// Convenience: surface stdout text only, throw on non-zero.
export async function runGrokText(args, opts = {}) {
  const r = await runGrok(args, { ...opts, json: false });
  return r.stdout;
}

// Convenience: parse --json output (or NDJSON) into a value.
export async function runGrokJson(args, opts = {}) {
  const r = await runGrok(args, { ...opts, json: true });
  return r.json;
}

// Errors-as-JSON helper for HTTP handlers.
export function errorToResponse(err) {
  if (err instanceof GrokCliError) {
    return {
      ok: false,
      error: err.message,
      code: err.code,
      stderr: (err.stderr || '').slice(-2000),
      stdout: (err.stdout || '').slice(-2000),
      args: err.args,
    };
  }
  return { ok: false, error: err?.message || String(err) };
}
