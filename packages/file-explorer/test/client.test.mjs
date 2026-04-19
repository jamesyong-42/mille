// Phase 6 commit 6.7 — integration tests for the typed FileExplorer
// wrapper in src/client.ts.
//
// Exercises the wrapper end-to-end against the live .node binding:
//   - construction routes ExplorerOptions through to the native
//   - capabilities bitmask surfaces
//   - getSnapshot() returns a MirrorSnapshot with tree/decoration versions
//   - visibleRows + visibleRowCount return sensible empty results
//   - on('ready') subscribes through the correct native channel and
//     disposes cleanly
//   - dispose() resolves without throwing
//
// Tests that depend on walker-populated entries (create under a real
// parent_id, readFile round-trip) are explicitly skipped pending
// Phase 7, where the walker integration lands.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileExplorer, MirrorSnapshot } from '../dist/index.js';

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'mille-client-'));
}

test('FileExplorer constructor accepts an absolute root path', () => {
  const dir = tempRoot();
  try {
    const fx = new FileExplorer({ roots: [dir] });
    assert.equal(typeof fx.capabilities, 'number');
    assert.equal(typeof fx.getTreeVersion(), 'number');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FileExplorer constructor accepts a Uri-shaped root', () => {
  const dir = tempRoot();
  try {
    const fx = new FileExplorer({ roots: [{ scheme: 'file', path: dir }] });
    assert.equal(typeof fx.capabilities, 'number');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FileExplorer constructor forwards followSymlinks booleans + smart', () => {
  const dir = tempRoot();
  try {
    // All three variants should construct without throwing.
    for (const v of [true, false, 'smart']) {
      const fx = new FileExplorer({ roots: [dir], followSymlinks: v });
      assert.equal(typeof fx.capabilities, 'number');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getSnapshot returns MirrorSnapshot with tree/decoration versions', () => {
  const dir = tempRoot();
  try {
    const fx = new FileExplorer({ roots: [dir] });
    const snap = fx.getSnapshot();
    assert.ok(snap instanceof MirrorSnapshot);
    assert.equal(typeof snap.treeVersion, 'number');
    assert.equal(typeof snap.decorationVersion, 'number');
    assert.ok(Array.isArray(snap.roots()));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MirrorSnapshot.getById / hasChildren / directChildCount for unknown id', () => {
  const dir = tempRoot();
  try {
    const fx = new FileExplorer({ roots: [dir] });
    const snap = fx.getSnapshot();
    assert.equal(snap.getById(99999), null);
    assert.equal(snap.hasChildren(99999), false);
    assert.equal(snap.directChildCount(99999), null);
    // Decorations land in Phase 9 — wrapper returns an empty array.
    assert.deepEqual(snap.getDecorations(99999), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('visibleRows + visibleRowCount return empty on a pristine tree', () => {
  const dir = tempRoot();
  try {
    const fx = new FileExplorer({ roots: [dir] });
    const snap = fx.getSnapshot();
    const rows = snap.visibleRows({ expanded: new Set(), offset: 0, limit: 100 });
    assert.ok(Array.isArray(rows));
    assert.equal(rows.length, 0);
    const count = snap.visibleRowCount(new Set());
    assert.equal(count.known, 0);
    assert.ok(count.pendingExpansions instanceof Set);
    assert.equal(count.pendingExpansions.size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('visibleRowsBulk decodes the bincode payload (empty case)', () => {
  const dir = tempRoot();
  try {
    const fx = new FileExplorer({ roots: [dir] });
    const snap = fx.getSnapshot();
    const rows = snap.visibleRowsBulk({ expanded: new Set(), offset: 0, limit: 100 });
    assert.ok(Array.isArray(rows));
    assert.equal(rows.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('on("ready") fires via emitReadyForTests and disposes cleanly', async () => {
  const dir = tempRoot();
  try {
    const fx = new FileExplorer({ roots: [dir] });
    let fired = 0;
    const sub = fx.on('ready', () => {
      fired += 1;
    });
    // Reach through the private handle — `emitReadyForTests` is a
    // cfg(test-hooks)-like escape hatch on the native, not public TS.
    fx['nativeFx'].emitReadyForTests();
    // TSFN dispatch is async — give libuv a couple of ticks.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(fired, 1);
    sub.dispose();
    // Double-dispose is idempotent on our wrapper.
    sub.dispose();
    // After dispose, another emit should not fire.
    fx['nativeFx'].emitReadyForTests();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(fired, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('on() rejects unknown event names', () => {
  const dir = tempRoot();
  try {
    const fx = new FileExplorer({ roots: [dir] });
    assert.throws(() => fx.on('bogus', () => {}), /unknown event channel/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dispose() resolves without throwing', async () => {
  const dir = tempRoot();
  try {
    const fx = new FileExplorer({ roots: [dir] });
    await fx.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Deferred to Phase 7 (walker-populated entries) ───────────────────
// create/rename/move/delete/readFile/readText/writeFile/readFileStream
// all require an existing entry with a known id. The walker isn't yet
// wired to auto-scan on construction; when that lands we'll swap the
// skip flag off and add round-trip assertions.

test('create + readFile round-trip', { skip: 'Phase 7 — walker populates entries' }, () => {});
test('rename round-trip', { skip: 'Phase 7 — walker populates entries' }, () => {});
test('readFileStream async iteration round-trip', { skip: 'Phase 7 — walker populates entries' }, () => {});
