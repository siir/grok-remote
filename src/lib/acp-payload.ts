// Pure helpers for un-narrowing ACP payloads received over SSE / history.
// Extracted from src/views/chat.ts so they can be unit-tested without DOM.

interface UnknownRecord {
  [key: string]: unknown;
}

interface MaybeUpdateWrapper {
  update?: unknown;
}

/**
 * History and SSE both may wrap the ACP `update` object inside an envelope:
 * `{ update: { ... }, _meta?: ..., sessionId?: ... }`.
 * Merge the inner update with outer envelope fields so tool status in
 * `_meta.updateParams` (and sessionId) survive into chat handlers.
 * Returns an empty object for nullish input so property access is safe.
 */
export function unwrap(payload: unknown): UnknownRecord {
  if (payload && typeof payload === 'object') {
    const outer = payload as MaybeUpdateWrapper & UnknownRecord;
    if (outer.update && typeof outer.update === 'object') {
      const inner = outer.update as UnknownRecord;
      const out: UnknownRecord = { ...inner };
      // Prefer outer _meta/sessionId (server envelope); keep inner if outer absent.
      if (outer['_meta'] !== undefined) out['_meta'] = outer['_meta'];
      else if (inner['_meta'] !== undefined) out['_meta'] = inner['_meta'];
      if (outer['sessionId'] !== undefined) out['sessionId'] = outer['sessionId'];
      else if (inner['sessionId'] !== undefined) out['sessionId'] = inner['sessionId'];
      return out;
    }
    return outer as UnknownRecord;
  }
  return {};
}

/**
 * Best-effort text extractor for ACP content blocks. Handles three shapes:
 *   - plain strings
 *   - `{ content: 'text' }`
 *   - `{ content: { text: 'text' } }`
 *   - `{ text: 'text' }`
 * Returns null when no string can be found, so callers can branch on it.
 */
export function extractText(payload: unknown): string | null {
  if (!payload) return null;
  if (typeof payload === 'string') return payload;
  if (typeof payload !== 'object') return null;
  const p = payload as {
    content?: unknown;
    text?: unknown;
  };
  if (p.content) {
    if (typeof p.content === 'string') return p.content;
    if (typeof p.content === 'object' && p.content !== null) {
      const inner = (p.content as { text?: unknown }).text;
      if (typeof inner === 'string') return inner;
    }
  }
  if (typeof p.text === 'string') return p.text;
  return null;
}
