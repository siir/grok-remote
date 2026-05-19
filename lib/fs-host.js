// Implements fs/read_text_file and fs/write_text_file.
// Scoped to the agent's working directory so a misbehaving agent can't escape.

import fs from 'node:fs/promises';
import path from 'node:path';

function withinScope(scopeDir, target) {
  if (!scopeDir) return true;
  const scope = path.resolve(scopeDir);
  const resolved = path.resolve(target);
  // Allow exact scope dir match plus any descendant.
  return resolved === scope || resolved.startsWith(scope + path.sep);
}

function rpcError(code, message) {
  const err = new Error(message);
  err.rpc = { code, message };
  return err;
}

export function createFsHost({ getCwd }) {
  function resolveAndCheck(p) {
    if (typeof p !== 'string' || !p.length) {
      throw rpcError(-32602, 'path must be a non-empty string');
    }
    const scope = getCwd();
    const abs = path.isAbsolute(p) ? p : path.resolve(scope || process.cwd(), p);
    if (!withinScope(scope, abs)) {
      throw rpcError(-32002, `path escapes agent scope: ${p}`);
    }
    return abs;
  }

  return {
    async readTextFile(params) {
      const target = resolveAndCheck(params?.path);
      const content = await fs.readFile(target, 'utf8');
      const limit = params?.limit;
      const line = params?.line;
      if (typeof line === 'number' || typeof limit === 'number') {
        const lines = content.split('\n');
        const start = Math.max(0, (line || 1) - 1);
        const end = typeof limit === 'number' ? start + limit : lines.length;
        return { content: lines.slice(start, end).join('\n') };
      }
      return { content };
    },

    async writeTextFile(params) {
      const target = resolveAndCheck(params?.path);
      const content = params?.content;
      if (typeof content !== 'string') {
        throw rpcError(-32602, 'content must be a string');
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, 'utf8');
      return {};
    },
  };
}
