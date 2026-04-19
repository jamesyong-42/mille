// Unit tests for mirror working-state helpers — Phase 8 commit 8.1.
//
// The working state itself is a plain object of Maps/Sets; these tests
// lock in constructor defaults and the shallow-clone contract the
// reducer relies on (mutating a cloned map MUST NOT leak back into the
// source).

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createMirror, cloneMirror } from '../dist/mirror.js';
import { ClientMirrorSnapshot } from '../dist/mirror-snapshot.js';

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

test('createMirror returns empty working state', () => {
  const m = createMirror();
  assert.equal(m.byId.size, 0);
  assert.equal(m.children.size, 0);
  assert.equal(m.directChildCounts.size, 0);
  assert.equal(m.pendingExpansions.size, 0);
  assert.deepEqual(m.roots, []);
  assert.equal(m.treeVersion, 0);
  assert.equal(m.decorationVersion, 0);
  assert.equal(m.volatileSubtrees.size, 0);
});

test('cloneMirror returns independent map references', () => {
  const src = createMirror();
  src.byId.set(1, entry({ id: 1, name: 'root', kind: 1 }));
  src.directChildCounts.set(1, 3);
  src.pendingExpansions.add(1);
  src.roots.push(1);
  src.volatileSubtrees.add(1);
  src.treeVersion = 5;
  src.decorationVersion = 2;

  const clone = cloneMirror(src);

  // Mutations to the clone must not leak back.
  clone.byId.set(2, entry({ id: 2, parentId: 1, name: 'child', kind: 0, size: 10 }));
  clone.directChildCounts.set(2, 0);
  clone.pendingExpansions.add(2);
  clone.roots.push(2);
  clone.volatileSubtrees.add(2);
  clone.treeVersion = 99;
  clone.decorationVersion = 42;

  assert.equal(src.byId.size, 1, 'byId on src untouched');
  assert.equal(src.directChildCounts.size, 1, 'directChildCounts on src untouched');
  assert.equal(src.pendingExpansions.size, 1, 'pendingExpansions on src untouched');
  assert.deepEqual(src.roots, [1], 'roots on src untouched');
  assert.equal(src.volatileSubtrees.size, 1, 'volatileSubtrees on src untouched');
  assert.equal(src.treeVersion, 5, 'treeVersion on src untouched');
  assert.equal(src.decorationVersion, 2, 'decorationVersion on src untouched');

  // Clone carries forward the initial content.
  assert.ok(clone.byId.has(1));
  assert.equal(clone.directChildCounts.get(1), 3);
  assert.ok(clone.pendingExpansions.has(1));
  assert.ok(clone.volatileSubtrees.has(1));
});

// ─── ClientMirrorSnapshot (8.2) ──────────────────────────────────────

test('ClientMirrorSnapshot exposes treeVersion + decorationVersion', () => {
  const m = createMirror();
  m.treeVersion = 7;
  m.decorationVersion = 3;
  const snap = new ClientMirrorSnapshot(m);
  assert.equal(snap.treeVersion, 7);
  assert.equal(snap.decorationVersion, 3);
});

test('ClientMirrorSnapshot is frozen', () => {
  const snap = new ClientMirrorSnapshot(createMirror());
  assert.equal(Object.isFrozen(snap), true);
});

test('ClientMirrorSnapshot.roots() returns entries in stored order', () => {
  const m = createMirror();
  m.byId.set(10, entry({ id: 10, name: 'a', kind: 1 }));
  m.byId.set(20, entry({ id: 20, name: 'b', kind: 1 }));
  m.roots.push(10, 20);
  const snap = new ClientMirrorSnapshot(m);
  const roots = snap.roots();
  assert.equal(roots.length, 2);
  assert.equal(roots[0].id, 10);
  assert.equal(roots[0].name, 'a');
  assert.equal(roots[1].id, 20);
});

test('ClientMirrorSnapshot.roots() skips ids missing from byId', () => {
  const m = createMirror();
  m.byId.set(10, entry({ id: 10, name: 'a', kind: 1 }));
  m.roots.push(10, 999);
  const snap = new ClientMirrorSnapshot(m);
  const roots = snap.roots();
  assert.equal(roots.length, 1);
  assert.equal(roots[0].id, 10);
});

test('ClientMirrorSnapshot.getById returns null for unknown ids', () => {
  const m = createMirror();
  const snap = new ClientMirrorSnapshot(m);
  assert.equal(snap.getById(42), null);
});

test('ClientMirrorSnapshot.getById translates null holes to undefined', () => {
  const m = createMirror();
  m.byId.set(1, entry({ id: 1, name: 'x', kind: 0 }));
  const snap = new ClientMirrorSnapshot(m);
  const e = snap.getById(1);
  assert.ok(e);
  assert.equal(e.id, 1);
  // Public Entry uses undefined-holes, not null.
  assert.equal(e.symlinkTargetIsDir, undefined);
  assert.equal(e.pathSegments, undefined);
});

test('ClientMirrorSnapshot.getById preserves optional fields when present', () => {
  const m = createMirror();
  m.byId.set(1, entry({
    id: 1,
    name: 'lnk',
    kind: 2,
    symlinkTargetIsDir: true,
    pathSegments: ['a', 'b', 'c'],
  }));
  const snap = new ClientMirrorSnapshot(m);
  const e = snap.getById(1);
  assert.ok(e);
  assert.equal(e.symlinkTargetIsDir, true);
  assert.deepEqual(e.pathSegments, ['a', 'b', 'c']);
});

test('ClientMirrorSnapshot.directChildCount returns null when unknown', () => {
  const m = createMirror();
  const snap = new ClientMirrorSnapshot(m);
  assert.equal(snap.directChildCount(1), null);
});

test('ClientMirrorSnapshot.directChildCount returns cached value', () => {
  const m = createMirror();
  m.directChildCounts.set(1, 4);
  m.directChildCounts.set(2, 0);
  const snap = new ClientMirrorSnapshot(m);
  assert.equal(snap.directChildCount(1), 4);
  assert.equal(snap.directChildCount(2), 0);
});

test('ClientMirrorSnapshot.hasChildren only true for >0 count', () => {
  const m = createMirror();
  m.directChildCounts.set(1, 0);
  m.directChildCounts.set(2, 3);
  const snap = new ClientMirrorSnapshot(m);
  assert.equal(snap.hasChildren(1), false);
  assert.equal(snap.hasChildren(2), true);
  assert.equal(snap.hasChildren(999), false);
});

test('ClientMirrorSnapshot.getDecorations returns empty array', () => {
  const snap = new ClientMirrorSnapshot(createMirror());
  assert.deepEqual(snap.getDecorations(1), []);
});

// visibleRows lands in 8.4 — coverage in test/visible-rows.test.mjs.
// visibleRowCount lands in 8.5 — coverage in test/visible-row-count.test.mjs.
