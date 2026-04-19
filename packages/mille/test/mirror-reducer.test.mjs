// Unit tests for the ViewportMirror delta reducer — Phase 8 commit 8.3.
//
// Locks in the invariants called out in mirror-reducer.ts:
//   - snapshot replaces state wholesale, delta merges incrementally
//   - entries are parsed from JSON-encoded `entriesJson`
//   - removedIds drops aliased caches (children, directChildCounts,
//     pendingExpansions, volatileSubtrees)
//   - directChildCounts merge: new keys + updates to existing
//   - coarseSubtrees: drops known child list + marks pending
//   - subtreeDirty / subtreeResynced flip the volatileSubtrees flag

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createMirror } from '../dist/mirror.js';
import { applySnapshot, applyDelta } from '../dist/mirror-reducer.js';

function entry(overrides = {}) {
  return {
    id: 0,
    parentId: null,
    name: '',
    kind: 0,
    size: 0,
    mtimeMs: 0,
    ctimeMs: 0,
    symlinkTargetIsDir: null,
    pathSegments: null,
    isIgnored: false,
    isReadonly: false,
    isHidden: false,
    ...overrides,
  };
}

function emptyDelta(overrides = {}) {
  return {
    version: 0,
    changedIds: [],
    removedIds: [],
    directChildCounts: {},
    coarseSubtrees: [],
    subtreeDirty: [],
    subtreeResynced: [],
    ...overrides,
  };
}

// ─── applySnapshot ──────────────────────────────────────────────────

test('applySnapshot replaces state wholesale', () => {
  const prev = createMirror();
  // Seed stale state to prove it gets wiped.
  prev.byId.set(42, entry({ id: 42, name: 'stale' }));
  prev.directChildCounts.set(42, 7);
  prev.pendingExpansions.add(42);
  prev.volatileSubtrees.add(42);
  prev.treeVersion = 3;

  const next = applySnapshot(prev, {
    version: 10,
    roots: [1, 2],
    entriesJson: JSON.stringify([
      entry({ id: 1, name: 'a', kind: 1 }),
      entry({ id: 2, name: 'b', kind: 1 }),
    ]),
    directChildCounts: { 1: 3, 2: 0 },
    visibleCount: 2,
  });

  assert.equal(next.treeVersion, 10);
  assert.deepEqual(next.roots, [1, 2]);
  assert.equal(next.byId.size, 2);
  assert.equal(next.byId.get(1).name, 'a');
  assert.equal(next.directChildCounts.get(1), 3);
  assert.equal(next.directChildCounts.get(2), 0);
  // Stale state is gone.
  assert.equal(next.byId.has(42), false);
  assert.equal(next.directChildCounts.has(42), false);
  assert.equal(next.pendingExpansions.has(42), false);
  assert.equal(next.volatileSubtrees.has(42), false);
});

test('applySnapshot tolerates missing entriesJson', () => {
  const next = applySnapshot(createMirror(), {
    version: 1,
    roots: [],
    directChildCounts: {},
    visibleCount: 0,
  });
  assert.equal(next.treeVersion, 1);
  assert.equal(next.byId.size, 0);
});

test('applySnapshot tolerates empty-string entriesJson', () => {
  const next = applySnapshot(createMirror(), {
    version: 1,
    roots: [],
    entriesJson: '',
    directChildCounts: {},
    visibleCount: 0,
  });
  assert.equal(next.byId.size, 0);
});

// ─── applyDelta: entries ────────────────────────────────────────────

test('applyDelta adds entries from entriesJson', () => {
  const state = createMirror();
  const next = applyDelta(state, emptyDelta({
    version: 5,
    changedIds: [1, 2],
    entriesJson: JSON.stringify([
      entry({ id: 1, name: 'a' }),
      entry({ id: 2, name: 'b' }),
    ]),
  }));
  assert.equal(next.treeVersion, 5);
  assert.equal(next.byId.get(1).name, 'a');
  assert.equal(next.byId.get(2).name, 'b');
});

test('applyDelta updates existing entries (changedIds)', () => {
  const state = createMirror();
  state.byId.set(1, entry({ id: 1, name: 'old' }));
  const next = applyDelta(state, emptyDelta({
    version: 2,
    changedIds: [1],
    entriesJson: JSON.stringify([entry({ id: 1, name: 'new' })]),
  }));
  assert.equal(next.byId.get(1).name, 'new');
  // Source untouched.
  assert.equal(state.byId.get(1).name, 'old');
});

test('applyDelta removes entries and purges aliased caches', () => {
  const state = createMirror();
  state.byId.set(1, entry({ id: 1 }));
  state.children.set(1, [2, 3]);
  state.directChildCounts.set(1, 2);
  state.pendingExpansions.add(1);
  state.volatileSubtrees.add(1);

  const next = applyDelta(state, emptyDelta({
    version: 2,
    removedIds: [1],
  }));

  assert.equal(next.byId.has(1), false);
  assert.equal(next.children.has(1), false);
  assert.equal(next.directChildCounts.has(1), false);
  assert.equal(next.pendingExpansions.has(1), false);
  assert.equal(next.volatileSubtrees.has(1), false);
});

// ─── applyDelta: directChildCounts ─────────────────────────────────

test('applyDelta merges new directChildCounts keys', () => {
  const state = createMirror();
  state.directChildCounts.set(1, 5);
  const next = applyDelta(state, emptyDelta({
    version: 2,
    directChildCounts: { 2: 3 },
  }));
  assert.equal(next.directChildCounts.get(1), 5, 'existing keys preserved');
  assert.equal(next.directChildCounts.get(2), 3, 'new key added');
});

test('applyDelta overwrites directChildCounts on update', () => {
  const state = createMirror();
  state.directChildCounts.set(1, 5);
  const next = applyDelta(state, emptyDelta({
    version: 2,
    directChildCounts: { 1: 9 },
  }));
  assert.equal(next.directChildCounts.get(1), 9);
});

// ─── applyDelta: coarseSubtrees ────────────────────────────────────

test('applyDelta coarse subtree clears children + marks pending', () => {
  const state = createMirror();
  state.children.set(7, [8, 9]);
  const next = applyDelta(state, emptyDelta({
    version: 3,
    coarseSubtrees: [7],
  }));
  assert.equal(next.children.has(7), false, 'cached child list dropped');
  assert.equal(next.pendingExpansions.has(7), true, 'marked pending for re-query');
});

// ─── applyDelta: volatile flags ────────────────────────────────────

test('applyDelta subtreeDirty adds to volatileSubtrees', () => {
  const state = createMirror();
  const next = applyDelta(state, emptyDelta({
    version: 1,
    subtreeDirty: [42],
  }));
  assert.equal(next.volatileSubtrees.has(42), true);
});

test('applyDelta subtreeResynced clears from volatileSubtrees', () => {
  const state = createMirror();
  state.volatileSubtrees.add(42);
  const next = applyDelta(state, emptyDelta({
    version: 2,
    subtreeResynced: [42],
  }));
  assert.equal(next.volatileSubtrees.has(42), false);
});

test('applyDelta dirty+resynced on different roots each take effect', () => {
  const state = createMirror();
  state.volatileSubtrees.add(100);
  const next = applyDelta(state, emptyDelta({
    version: 3,
    subtreeDirty: [200],
    subtreeResynced: [100],
  }));
  assert.equal(next.volatileSubtrees.has(100), false);
  assert.equal(next.volatileSubtrees.has(200), true);
});

// ─── applyDelta: treeVersion propagation ───────────────────────────

test('applyDelta propagates treeVersion even on empty body', () => {
  const state = createMirror();
  state.treeVersion = 1;
  const next = applyDelta(state, emptyDelta({ version: 99 }));
  assert.equal(next.treeVersion, 99);
});

// ─── immutability of the source state ──────────────────────────────

test('applyDelta does not mutate the source state', () => {
  const state = createMirror();
  state.byId.set(1, entry({ id: 1, name: 'orig' }));
  state.directChildCounts.set(1, 2);
  state.volatileSubtrees.add(5);

  applyDelta(state, emptyDelta({
    version: 7,
    changedIds: [1],
    entriesJson: JSON.stringify([entry({ id: 1, name: 'changed' })]),
    removedIds: [],
    directChildCounts: { 2: 4 },
    coarseSubtrees: [5],
    subtreeDirty: [9],
    subtreeResynced: [5],
  }));

  assert.equal(state.treeVersion, 0, 'source treeVersion untouched');
  assert.equal(state.byId.get(1).name, 'orig', 'source entry untouched');
  assert.equal(state.directChildCounts.size, 1, 'source counts untouched');
  assert.equal(state.volatileSubtrees.has(5), true, 'source flags untouched');
  assert.equal(state.volatileSubtrees.has(9), false, 'source flags untouched');
});
