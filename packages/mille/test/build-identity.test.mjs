import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { buildIdentity, version } from '../dist/index.js';

// This asserted a hardcoded '0.3.0' until 0.3.1 shipped and turned `main` red:
// Release Please bumps `package.json`, and nothing bumped the literal.
//
// Comparing against `package.json` here would be worse than useless — that is
// the same file `readPackageVersion()` itself reads (`src/native.ts:131`), so
// the assertion could never fail. Cross-file version agreement is checked once,
// repo-wide, by `scripts/check-release-versions.mjs`.
//
// What survives is the part only this test can see: that the loader resolved a
// real `package.json` at all, rather than falling into its `catch` and
// reporting 'unknown' from a path that quietly stopped resolving.
test('buildIdentity reports the exact public package and native load', () => {
  const identity = buildIdentity();

  assert.notEqual(identity.packageVersion, 'unknown');
  assert.match(identity.packageVersion, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
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
