// setup routes. Wraps `grok setup` so the dashboard can run the managed-
// deployment installer from a browser. See docs/setup.md.
//
// Registered routes:
//   POST /api/system/setup    -> runs `grok setup`, returns exit/stdout/stderr
//                                + the post-run `grok inspect --json` output
//                                so the UI can show what changed.

import { send } from '../helpers.js';
import {
  runGrok,
  runGrokJson,
  GrokCliError,
  errorToResponse,
} from '../../grok-cli.js';

export function register(add) {
  add('POST', '/api/system/setup', runHandler);
}

// `grok setup` can take a while when it actually downloads a bundle (network
// + verification). We bound it at 90s to keep the HTTP request from hanging
// forever, but accept that on slower links it may still cut off.
const SETUP_TIMEOUT_MS = 90_000;
const SETUP_MAX_BYTES  = 2 * 1024 * 1024;

// Heuristic: grok 0.1.212+ refuses `grok setup` with exit 1 and the message
// "GROK_DEPLOYMENT_KEY is not set." when the host has no managed deployment
// configured. For individual users this is the expected state, not a real
// failure, so we surface it as a distinct "kind" the UI can present as info.
function classifySetupOutput({ code, stdout, stderr }) {
  const blob = `${stderr || ''}\n${stdout || ''}`;
  if (code !== 0 && /GROK_DEPLOYMENT_KEY is not set/i.test(blob)) {
    return 'no-deployment-key';
  }
  if (code === 0) return 'ok';
  return 'error';
}

// Pull the first non-empty line out of stderr (fallback: stdout) so the UI
// can show the real cause in the result header instead of the generic
// "grok exited with code N".
function firstMeaningfulLine(text) {
  if (!text) return '';
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line) return line;
  }
  return '';
}

async function runHandler(req, res) {
  let result = null;
  let setupError = null;

  // We want to surface the exit code AND the output, even on non-zero
  // exits, so the user can read the failure in the dashboard. runGrok
  // rejects on non-zero, so unpack the GrokCliError when that happens.
  try {
    result = await runGrok(['setup'], {
      timeoutMs: SETUP_TIMEOUT_MS,
      maxBytes:  SETUP_MAX_BYTES,
    });
  } catch (err) {
    if (err instanceof GrokCliError) {
      setupError = err;
      result = {
        stdout: err.stdout || '',
        stderr: err.stderr || '',
        code:   err.code   ?? null,
      };
    } else {
      return send(res, 500, errorToResponse(err));
    }
  }

  const kind = classifySetupOutput({
    code:   result.code,
    stdout: result.stdout,
    stderr: result.stderr,
  });

  // For the no-deployment-key case we still ran successfully from the
  // dashboard's point of view: the user just doesn't have a managed bundle
  // bound. Treat it as a soft outcome, not a failure.
  const ok = kind === 'ok' || kind === 'no-deployment-key';

  // Best-effort: run `grok inspect --json` after setup so the page can show
  // what changed. If inspect doesn't exist (older CLI) or fails, we still
  // return the setup result.
  let inspect = null;
  let inspectError = null;
  try {
    inspect = await runGrokJson(['inspect', '--json'], {
      timeoutMs: 15_000,
      maxBytes:  1 * 1024 * 1024,
    });
  } catch (err) {
    inspectError = err?.message || String(err);
  }

  const firstLine =
    firstMeaningfulLine(result.stderr) ||
    firstMeaningfulLine(result.stdout) ||
    (setupError ? setupError.message : '');

  send(res, 200, {
    ok,
    kind,
    exitCode: result.code ?? 0,
    stdout:   result.stdout || '',
    stderr:   result.stderr || '',
    summary:  firstLine,
    inspect,
    inspectError,
    error:    setupError ? setupError.message : null,
  });
}
