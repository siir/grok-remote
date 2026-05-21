export function modeFromArgs(args = []) {
  if (args.includes('--local') || args.includes('-l')) return 'local';
  if (args.includes('--tailnet')) return 'tailnet';
  return null;
}

export function bindHostForMode(mode) {
  return mode === 'local' ? '127.0.0.1' : '0.0.0.0';
}

export function pm2EnvForMode(mode, baseEnv = process.env) {
  return {
    ...baseEnv,
    GROK_REMOTE_HOST: bindHostForMode(mode),
  };
}

export function chooseModeFromInputs({ args = [], env = process.env, isTTY = false } = {}) {
  const explicit = modeFromArgs(args);
  if (explicit) return explicit;
  if (env.NO_PROMPT === '1') return 'tailnet';
  if (!isTTY) return 'tailnet';
  return null;
}

export function autoStartFromArgs(args = []) {
  if (args.includes('--no-auto-start')) return false;
  if (args.includes('--auto-start')) return true;
  return null;
}

export function chooseAutoStartFromInputs({ args = [], env = process.env, isTTY = false } = {}) {
  const explicit = autoStartFromArgs(args);
  if (explicit !== null) return explicit;
  if (env.AUTO_START === '1') return true;
  if (env.AUTO_START === '0') return false;
  if (env.NO_PROMPT === '1') return false;
  if (!isTTY) return false;
  return null;
}
