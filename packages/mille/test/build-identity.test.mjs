import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { buildIdentity, version } from '../dist/index.js';

test('buildIdentity reports the exact public package and native load', () => {
  const identity = buildIdentity();

  assert.equal(identity.packageVersion, '0.3.0');
  assert.equal(identity.nativeVersion, version());
  assert.match(identity.nativeProfile, /^(debug|release)$/);
  assert.equal(identity.platform, process.platform);
  assert.equal(identity.arch, process.arch);
  assert.ok(Number.isInteger(identity.protocolVersion));
  assert.ok(identity.protocolVersion > 0);
  assert.match(identity.source, /^(local|platform-package)$/);
  assert.ok(identity.resolvedPath.endsWith('.node'));
});

test('buildIdentity is frozen and identity-stable', () => {
  const first = buildIdentity();
  const second = buildIdentity();

  assert.equal(first, second);
  assert.equal(Object.isFrozen(first), true);
});
