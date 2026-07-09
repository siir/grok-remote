import test from 'node:test';
import assert from 'node:assert/strict';

import { bootStartStatus } from '../lib/boot-autostart.js';

test('bootStartStatus returns a structured status without throwing', () => {
  const s = bootStartStatus();
  assert.equal(typeof s.supported, 'boolean');
  assert.equal(typeof s.enabled, 'boolean');
  assert.ok(['launchd', 'systemd', 'pm2', 'none'].includes(s.method));
  assert.equal(typeof s.detail, 'string');
  assert.equal(typeof s.installDir, 'string');
  assert.ok(s.installDir.length > 0);
  assert.equal(typeof s.nodePath, 'string');
});
