// Unit tests for ClientMirrorSnapshot.visibleRowCount — Phase 8 commit 8.5.
//
// Mirrors fx-core's snapshot::visible_row_count with the added
// pendingExpansions fold from MirrorWorking.pendingExpansions (the
// reducer's setExpanded-in-flight tracker). See SPEC §4.9.2 for the
// "don't trust yet" contract.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createMirror } from '../dist/mirror.js';
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

function seedDir(m, id, name, parentId, childCount) {
  m.byId.set(id, entry({ id, parentId, name, kind: 1 }));
  m.directChildCounts.set(id, childCount);
}

function seedFile(m, id, name, parentId, overrides = {}) {
  m.byId.set(id, entry({ id, parentId, name, kind: 0, ...overrides }));
  m.directChildCounts.set(id, 0);
}

test('visibleRowCount: empty mirror returns { known: 0, pending: empty }', () => {
  const snap = new ClientMirrorSnapshot(createMirror());
  const vc = snap.visibleRowCount(new Set());
  assert.equal(vc.known, 0);
  assert.equal(vc.pendingExpansions.size, 0);
});

test('visibleRowCount: single root, not expanded → known: 1', () => {
  const m = createMirror();
  seedDir(m, 1, 'root', null, 3);
  m.roots.push(1);
  const snap = new ClientMirrorSnapshot(m);
  const vc = snap.visibleRowCount(new Set());
  assert.equal(vc.known, 1);
  assert.equal(vc.pendingExpansions.size, 0);
});

test('visibleRowCount: root expanded with known children → known includes them', () => {
  const m = createMirror();
  seedDir(m, 1, 'root', null, 2);
  seedFile(m, 10, 'a.txt', 1);
  seedFile(m, 11, 'b.txt', 1);
  m.children.set(1, [10, 11]);
  m.roots.push(1);
  const snap = new ClientMirrorSnapshot(m);
  const vc = snap.visibleRowCount(new Set([1]));
  assert.equal(vc.known, 3);
  assert.equal(vc.pendingExpansions.size, 0);
});

test('visibleRowCount: expanded folder with missing children in mirror → reported as pending', () => {
  const m = createMirror();
  seedDir(m, 1, 'root', null, 1);
  seedDir(m, 2, 'lazy-dir', 1, 5);
  m.children.set(1, [2]);
  // No m.children.set(2, ...) — host hasn't delivered lazy-dir's kids.
  m.roots.push(1);
  const snap = new ClientMirrorSnapshot(m);
  const vc = snap.visibleRowCount(new Set([1, 2]));
  // root + lazy-dir visible; lazy-dir's children not counted (unknown).
  assert.equal(vc.known, 2);
  assert.equal(vc.pendingExpansions.size, 1);
  assert.ok(vc.pendingExpansions.has(2));
});

test('visibleRowCount: Project view shows ignored + hidden; OS noise optional', () => {
  const m = createMirror();
  seedDir(m, 1, 'root', null, 4);
  seedFile(m, 10, 'a.txt', 1);
  seedFile(m, 11, 'node_modules', 1, { isIgnored: true, kind: 1 });
  seedFile(m, 12, '.env', 1, { isHidden: true });
  seedFile(m, 13, '.DS_Store', 1, { isHidden: true });
  m.children.set(1, [10, 11, 12, 13]);
  m.roots.push(1);
  const snap = new ClientMirrorSnapshot(m);

  // Default Project view: root + a.txt + node_modules + .env (no .DS_Store).
  const vcDefault = snap.visibleRowCount(new Set([1]));
  assert.equal(vcDefault.known, 4);

  // includeIgnored also surfaces OS noise.
  const vcAll = snap.visibleRowCount(new Set([1]), true);
  assert.equal(vcAll.known, 5);
});

test('visibleRowCount: reducer pendingExpansions folds into return', () => {
  const m = createMirror();
  seedDir(m, 1, 'root', null, 1);
  seedDir(m, 2, 'coarse-subtree', 1, 3);
  m.children.set(1, [2]);
  m.children.set(2, []); // children-map IS populated (empty), so DFS won't flag as pending
  m.roots.push(1);
  // Reducer marked this subtree as pending (e.g. a coarseSubtrees flag
  // from a delta, or setExpanded before children arrived).
  m.pendingExpansions.add(2);

  const snap = new ClientMirrorSnapshot(m);
  const vc = snap.visibleRowCount(new Set([1, 2]));
  // root + coarse-subtree known; children-map is a known-empty array
  // so DFS itself doesn't add a pending entry, but the reducer's
  // pendingExpansions tracker still surfaces id 2.
  assert.equal(vc.known, 2);
  assert.equal(vc.pendingExpansions.size, 1);
  assert.ok(vc.pendingExpansions.has(2));
});

test('visibleRowCount: reducer pendingExpansions union with DFS-discovered pending', () => {
  const m = createMirror();
  seedDir(m, 1, 'root', null, 2);
  seedDir(m, 2, 'dfs-pending', 1, 5);
  seedDir(m, 3, 'reducer-pending', 1, 7);
  m.children.set(1, [2, 3]);
  // dfs-pending: no children entry — DFS flags it as pending.
  // reducer-pending: children entry is empty array — DFS sees it as
  // empty, but reducer.pendingExpansions has it.
  m.children.set(3, []);
  m.pendingExpansions.add(3);
  m.roots.push(1);

  const snap = new ClientMirrorSnapshot(m);
  const vc = snap.visibleRowCount(new Set([1, 2, 3]));
  assert.equal(vc.known, 3);
  assert.equal(vc.pendingExpansions.size, 2);
  assert.ok(vc.pendingExpansions.has(2));
  assert.ok(vc.pendingExpansions.has(3));
});

test('visibleRowCount: invisible-expanded parent suppresses its subtree from known', () => {
  // Mirrors the same regression guard as visibleRows: a hard-hidden
  // parent (`.git`) must not leak its descendants into the count.
  const m = createMirror();
  seedDir(m, 1, 'visible', null, 0);
  m.byId.set(2, entry({ id: 2, parentId: null, name: '.git', kind: 1, isHidden: true }));
  m.directChildCounts.set(2, 2);
  seedFile(m, 20, 'leaked-a', 2);
  seedFile(m, 21, 'leaked-b', 2);
  m.children.set(2, [20, 21]);
  m.roots.push(1, 2);
  const snap = new ClientMirrorSnapshot(m);

  const vc = snap.visibleRowCount(new Set([1, 2]));
  assert.equal(vc.known, 1);
  // Cross-check: matches visibleRows.length in the same configuration.
  const rows = snap.visibleRows({ expanded: new Set([1, 2]), offset: 0, limit: 100 });
  assert.equal(rows.length, vc.known);
});

test('visibleRowCount: known === visibleRows.length across mixed expansion', () => {
  // Integration-style consistency check on a deeper tree.
  const m = createMirror();
  seedDir(m, 1, 'root', null, 2);
  seedDir(m, 2, 'sub-a', 1, 2);
  seedFile(m, 20, 'leaf-a1', 2);
  seedFile(m, 21, 'leaf-a2', 2);
  m.children.set(2, [20, 21]);
  seedDir(m, 3, 'sub-b', 1, 1);
  seedFile(m, 30, 'leaf-b1', 3);
  m.children.set(3, [30]);
  m.children.set(1, [2, 3]);
  m.roots.push(1);
  const snap = new ClientMirrorSnapshot(m);

  const expanded = new Set([1, 2]);
  const vc = snap.visibleRowCount(expanded);
  const rows = snap.visibleRows({ expanded, offset: 0, limit: 1000 });
  assert.equal(vc.known, rows.length);
  assert.equal(vc.known, 5); // root, sub-a, leaf-a1, leaf-a2, sub-b
  assert.equal(vc.pendingExpansions.size, 0);
});
