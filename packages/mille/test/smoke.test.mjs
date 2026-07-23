// Phase 5.12 smoke tests — verify the first .node build loads from Node
// and the publicly-exported methods are callable end-to-end.
//
// Scope limited by Phase 5: store starts empty until the Phase 6 walker
// auto-populates it, so tests that require pre-existing entries (create
// under a parent, readFile by id, mutations) are deferred.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Loaded per host triple. Extend when more prebuilts land.
const candidates = [
  '../mille.darwin-arm64.node',
  '../mille.darwin-x64.node',
  '../mille.linux-x64-gnu.node',
  '../mille.linux-arm64-gnu.node',
];

let native = null;
for (const rel of candidates) {
  try {
    native = require(rel);
    break;
  } catch (err) {
    if (err && err.code !== 'MODULE_NOT_FOUND') throw err;
  }
}
assert.ok(native, `no built .node found — ran pnpm run build:napi? (tried ${candidates.join(', ')})`);

const { FileExplorer, buildInfo, version } = native;

function mkTmp() {
  return mkdtempSync(join(tmpdir(), 'mille-smoke-'));
}

test('version() returns a non-empty string', () => {
  const v = version();
  assert.equal(typeof v, 'string');
  assert.ok(v.length > 0, `version should be non-empty, got ${JSON.stringify(v)}`);
});

test('buildInfo() identifies the native artifact profile and target', () => {
  const info = buildInfo();
  const rustArch = process.arch === 'arm64' ? 'aarch64' : process.arch;
  assert.equal(info.crateVersion, version());
  assert.match(info.profile, /^(debug|release)$/);
  assert.equal(typeof info.target, 'string');
  assert.ok(info.target.includes(rustArch));
});

test('FileExplorer constructor rejects empty roots', () => {
  assert.throws(() => new FileExplorer({ roots: [] }));
});

test('FileExplorer constructor rejects relative roots', () => {
  assert.throws(() => new FileExplorer({ roots: ['relative/path'] }));
});

test('FileExplorer constructs with a valid absolute root', () => {
  const dir = mkTmp();
  try {
    const fx = new FileExplorer({ roots: [dir] });
    assert.equal(typeof fx.capabilities, 'number');
    assert.equal(typeof fx.getTreeVersion(), 'number');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getSnapshot() returns a MirrorSnapshot with treeVersion + roots()', () => {
  const dir = mkTmp();
  try {
    const fx = new FileExplorer({ roots: [dir] });
    const snap = fx.getSnapshot();
    assert.equal(typeof snap.treeVersion, 'number');
    assert.equal(typeof snap.decorationVersion, 'number');
    const roots = snap.roots();
    assert.ok(Array.isArray(roots));
    // Phase 5 does not auto-populate — roots() is empty until Phase 6.
    // Just verify the accessor returns an array without throwing.
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MirrorSnapshot.getById returns null for unknown id', () => {
  const dir = mkTmp();
  try {
    const fx = new FileExplorer({ roots: [dir] });
    const snap = fx.getSnapshot();
    assert.equal(snap.getById(99999), null);
    assert.equal(snap.hasChildren(99999), false);
    assert.equal(snap.directChildCount(99999), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('visibleRows/visibleRowCount work on an empty snapshot', () => {
  const dir = mkTmp();
  try {
    const fx = new FileExplorer({ roots: [dir] });
    const snap = fx.getSnapshot();
    const rows = snap.visibleRows({ expanded: [], offset: 0, limit: 100 });
    assert.ok(Array.isArray(rows));
    assert.equal(rows.length, 0);
    const count = snap.visibleRowCount([]);
    assert.equal(typeof count.known, 'number');
    assert.ok(Array.isArray(count.pendingExpansions));
    assert.equal(snap.visibleRowIndex(99999, []), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('emitReadyForTests + onReady fire end-to-end through the TSFN', async () => {
  const dir = mkTmp();
  try {
    const fx = new FileExplorer({ roots: [dir] });
    let fired = 0;
    const subId = fx.onReady(() => { fired += 1; });
    fx.emitReadyForTests();
    // TSFN dispatch is async. Give the libuv queue a couple of ticks.
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(fired, 1, 'ready listener should have fired exactly once');
    // off() expects a number — subscription ids are bigints at the API layer.
    const removed = fx.off(Number(subId));
    assert.equal(removed, true);
    // Double-off is idempotent.
    assert.equal(fx.off(Number(subId)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('off() on an unknown subscription is idempotent', () => {
  const dir = mkTmp();
  try {
    const fx = new FileExplorer({ roots: [dir] });
    assert.equal(fx.off(12345), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
