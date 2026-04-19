// Phase 9 — DecorationStore + DecorationVersion counter tests.
//
// 9.1: store behavior (version start, setForProvider, getMerged,
//      removeProvider, bump + listener fanout).
// 9.2+: integration with FileExplorer lands in later commits.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DecorationStore, FileExplorer } from '../dist/index.js';

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'mille-dec-'));
}

/**
 * Minimal DecorationProvider that lets a test fire `onDidChange`
 * manually and returns pre-seeded decorations from `provide()`.
 */
function makeProvider(id, entries = new Map()) {
  const listeners = new Set();
  return {
    id,
    entries,
    fire(ids) {
      for (const l of listeners) l(ids);
    },
    onDidChange(listener) {
      listeners.add(listener);
      return {
        dispose: () => {
          listeners.delete(listener);
        },
      };
    },
    provide(entry) {
      return entries.get(entry.id) ?? null;
    },
  };
}

/**
 * Sleep one microtask turn. FileExplorer's provider bridge invokes
 * `provide()` via an async arrow — tests need to wait for the
 * resulting microtask chain to drain before asserting.
 */
function flush() {
  return new Promise((r) => setImmediate(r));
}

test('DecorationStore.version starts at 0', () => {
  const store = new DecorationStore();
  assert.equal(store.version, 0);
});

test('setForProvider returns true on change, false on no-op clear', () => {
  const store = new DecorationStore();
  // Inserting a new decoration is a change.
  assert.equal(store.setForProvider('git', 1, { badge: 'M' }), true);
  // Clearing an already-absent slot is a no-op.
  assert.equal(store.setForProvider('git', 2, null), false);
  // Clearing a present slot is a change.
  assert.equal(store.setForProvider('git', 1, null), true);
});

test('setForProvider replacing an existing entry still reports a change', () => {
  const store = new DecorationStore();
  store.setForProvider('git', 1, { badge: 'M' });
  // Replacement — callers should treat this as a change, even though
  // the presence didn't flip, because the decoration shape may differ.
  assert.equal(store.setForProvider('git', 1, { badge: 'U' }), true);
});

test('getMerged returns all providers for an id', () => {
  const store = new DecorationStore();
  assert.deepEqual(store.getMerged(1), []);
  store.setForProvider('git', 1, { badge: 'M', color: 'yellow' });
  store.setForProvider('lint', 1, { badge: '!', color: 'red' });
  const merged = store.getMerged(1);
  assert.equal(merged.length, 2);
  // Order isn't contractually sorted, but both entries must be present.
  const badges = merged.map((d) => d.badge).sort();
  assert.deepEqual(badges, ['!', 'M']);
});

test('removeProvider clears all its decorations and reports affected ids', () => {
  const store = new DecorationStore();
  store.setForProvider('git', 1, { badge: 'M' });
  store.setForProvider('git', 2, { badge: 'A' });
  store.setForProvider('lint', 1, { badge: '!' });
  store.setForProvider('lint', 3, { badge: '?' });

  const affected = store.removeProvider('git').sort((a, b) => a - b);
  assert.deepEqual(affected, [1, 2]);

  // id=1 still has the lint decoration; id=2 now has none; id=3 unchanged.
  assert.equal(store.getMerged(1).length, 1);
  assert.equal(store.getMerged(1)[0].badge, '!');
  assert.deepEqual(store.getMerged(2), []);
  assert.equal(store.getMerged(3).length, 1);
});

test('bump increments version and fires listeners with changedIds', () => {
  const store = new DecorationStore();
  const received = [];
  const sub = store.onChange((ids) => {
    received.push([...ids]);
  });

  store.setForProvider('git', 1, { badge: 'M' });
  store.setForProvider('git', 2, { badge: 'A' });
  store.bump([1, 2]);

  assert.equal(store.version, 1);
  assert.equal(received.length, 1);
  assert.deepEqual(received[0], [1, 2]);

  sub.dispose();
  store.bump([3]);
  // After dispose, no further delivery.
  assert.equal(received.length, 1);
  // But version still bumped.
  assert.equal(store.version, 2);
});

test('bump with empty changedIds is a no-op', () => {
  const store = new DecorationStore();
  let fired = 0;
  store.onChange(() => {
    fired++;
  });
  store.bump([]);
  assert.equal(store.version, 0);
  assert.equal(fired, 0);
});

test('multiple listeners all receive bump notifications', () => {
  const store = new DecorationStore();
  const seenA = [];
  const seenB = [];
  store.onChange((ids) => seenA.push([...ids]));
  store.onChange((ids) => seenB.push([...ids]));
  store.bump([42]);
  assert.deepEqual(seenA, [[42]]);
  assert.deepEqual(seenB, [[42]]);
});

// ─── 9.2 — registerDecorationProvider integration ─────────────────────
//
// These tests drive the provider bridge end-to-end but assert against
// the decoration-version channel only. The MirrorSnapshot.getDecorations
// wiring lands in 9.4; until then, the surface observable to callers is
// `getDecorationVersion()`.

test('registerDecorationProvider: provider onDidChange bumps decorationVersion', async () => {
  const dir = tempRoot();
  try {
    const fx = new FileExplorer({ roots: [dir] });
    const p = makeProvider('git', new Map([[42, { badge: 'M', color: 'yellow' }]]));
    const sub = fx.registerDecorationProvider(p);

    const v0 = fx.getDecorationVersion();
    p.fire([42]);
    await flush();
    assert.equal(fx.getDecorationVersion(), v0 + 1);

    sub.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('registerDecorationProvider: disposing bumps decorationVersion once', async () => {
  const dir = tempRoot();
  try {
    const fx = new FileExplorer({ roots: [dir] });
    const p = makeProvider('git', new Map([[7, { badge: 'M' }]]));
    const sub = fx.registerDecorationProvider(p);
    p.fire([7]);
    await flush();

    const vBefore = fx.getDecorationVersion();
    sub.dispose();
    assert.equal(fx.getDecorationVersion(), vBefore + 1);

    // Double-dispose is idempotent — no further version bump.
    sub.dispose();
    assert.equal(fx.getDecorationVersion(), vBefore + 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('registerDecorationProvider: disposing with no entries does not bump', async () => {
  const dir = tempRoot();
  try {
    const fx = new FileExplorer({ roots: [dir] });
    const p = makeProvider('git', new Map());
    const sub = fx.registerDecorationProvider(p);
    const vBefore = fx.getDecorationVersion();
    // Never fired → nothing in store → disposal shouldn't bump.
    sub.dispose();
    assert.equal(fx.getDecorationVersion(), vBefore);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('registerDecorationProvider: provider errors during provide() are swallowed', async () => {
  const dir = tempRoot();
  try {
    const fx = new FileExplorer({ roots: [dir] });
    const bad = {
      id: 'bad',
      onDidChange(listener) {
        this._l = listener;
        return { dispose: () => {} };
      },
      provide() {
        throw new Error('boom');
      },
    };
    const sub = fx.registerDecorationProvider(bad);
    const v0 = fx.getDecorationVersion();
    // Firing the change drives provide(); the throw must not escape.
    bad._l([1]);
    await flush();
    // No change landed — version stays put.
    assert.equal(fx.getDecorationVersion(), v0);
    sub.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('registerDecorationProvider: provide returning null clears the slot', async () => {
  const dir = tempRoot();
  try {
    const fx = new FileExplorer({ roots: [dir] });
    const entries = new Map([[1, { badge: 'M' }]]);
    const p = makeProvider('git', entries);
    const sub = fx.registerDecorationProvider(p);

    p.fire([1]);
    await flush();
    const vAfterSet = fx.getDecorationVersion();

    // Next fire returns null — slot should clear (still a change).
    entries.delete(1);
    p.fire([1]);
    await flush();
    assert.equal(fx.getDecorationVersion(), vAfterSet + 1);

    // Firing again with nothing stored is a no-op.
    p.fire([1]);
    await flush();
    assert.equal(fx.getDecorationVersion(), vAfterSet + 1);

    sub.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
