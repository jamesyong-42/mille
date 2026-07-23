// Unit tests for ClientMirrorSnapshot.visibleRows — Phase 8 commit 8.4.
//
// Mirrors the fx-core snapshot::visible_rows behavior tests. Key
// invariants: DFS left-to-right, sorted child order, ignored/hidden
// filtering, invisible-parent descent suppression, offset/limit
// slicing with early termination.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createMirror } from '../dist/mirror.js';
import { ClientMirrorSnapshot, createSortedChildrenLookup } from '../dist/mirror-snapshot.js';

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

test('snapshot-local child ordering is cached without mutating wire order', () => {
  const byId = new Map([
    [2, entry({ id: 2, name: 'z.ts', kind: 0 })],
    [3, entry({ id: 3, name: 'a', kind: 1 })],
    [4, entry({ id: 4, name: 'a.ts', kind: 0 })],
  ]);
  const wireOrder = [2, 4, 3];
  const lookup = createSortedChildrenLookup(byId);
  const first = lookup(1, wireOrder);
  const second = lookup(1, wireOrder);

  assert.equal(second, first, 'repeated lookups reuse the exact sorted array');
  assert.deepEqual(first, [3, 4, 2], 'directories remain first, then files by name');
  assert.deepEqual(wireOrder, [2, 4, 3], 'sorting does not mutate the mirror payload');
});

test('visibleRows: empty mirror returns empty array', () => {
  const snap = new ClientMirrorSnapshot(createMirror());
  const rows = snap.visibleRows({ expanded: new Set(), offset: 0, limit: 100 });
  assert.deepEqual([...rows], []);
});

test('visibleRows: single root, no expansion → one row', () => {
  const m = createMirror();
  seedDir(m, 1, 'root', null, 0);
  m.roots.push(1);
  const snap = new ClientMirrorSnapshot(m);
  const rows = snap.visibleRows({ expanded: new Set(), offset: 0, limit: 100 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 1);
  assert.equal(rows[0].depth, 0);
  assert.equal(rows[0].isExpanded, false);
  assert.equal(rows[0].hasChildren, false);
});

test('visibleRows: expanded root emits children in sorted order', () => {
  const m = createMirror();
  seedDir(m, 1, 'root', null, 3);
  // Insert in NON-sorted wire order: c, a, b
  seedFile(m, 10, 'c.txt', 1);
  seedFile(m, 11, 'a.txt', 1);
  seedFile(m, 12, 'b.txt', 1);
  m.children.set(1, [10, 11, 12]);
  m.roots.push(1);
  const snap = new ClientMirrorSnapshot(m);
  const rows = snap.visibleRows({ expanded: new Set([1]), offset: 0, limit: 100 });
  assert.equal(rows.length, 4);
  assert.equal(rows[0].name, 'root');
  assert.equal(rows[0].depth, 0);
  assert.equal(rows[0].isExpanded, true);
  assert.equal(rows[0].hasChildren, true);
  assert.equal(rows[1].name, 'a.txt');
  assert.equal(rows[1].depth, 1);
  assert.equal(rows[2].name, 'b.txt');
  assert.equal(rows[2].depth, 1);
  assert.equal(rows[3].name, 'c.txt');
  assert.equal(rows[3].depth, 1);
  assert.deepEqual(snap.visibleRowIds({ expanded: new Set([1]), offset: 1, limit: 2 }), [11, 12]);
  assert.equal(snap.visibleRowIndex(1, new Set([1])), 0);
  assert.equal(snap.visibleRowIndex(12, new Set([1])), 2);
  assert.equal(snap.visibleRowIndex(12, new Set()), null);
  assert.equal(snap.visibleRowIndex(999, new Set([1])), null);
});

test('visibleRows: Project view shows ignored dirs (library roots)', () => {
  const m = createMirror();
  seedDir(m, 1, 'root', null, 2);
  seedFile(m, 10, 'a.txt', 1);
  seedFile(m, 11, 'node_modules', 1, { isIgnored: true, kind: 1 });
  m.children.set(1, [10, 11]);
  m.roots.push(1);
  const snap = new ClientMirrorSnapshot(m);

  // JetBrains Project view surfaces excluded folders; UI styles them.
  const rowsDefault = snap.visibleRows({ expanded: new Set([1]), offset: 0, limit: 100 });
  assert.equal(rowsDefault.length, 3);
  // Directories first, then files.
  assert.deepEqual(
    rowsDefault.map((r) => r.name),
    ['root', 'node_modules', 'a.txt'],
  );
});

test('visibleRows: OS noise hidden; project dotfiles shown', () => {
  const m = createMirror();
  seedDir(m, 1, 'root', null, 3);
  seedFile(m, 10, '.DS_Store', 1, { isHidden: true });
  seedFile(m, 11, '.gitignore', 1, { isHidden: true });
  seedFile(m, 12, 'README.md', 1);
  m.children.set(1, [10, 11, 12]);
  m.roots.push(1);
  const snap = new ClientMirrorSnapshot(m);

  const rows = snap.visibleRows({ expanded: new Set([1]), offset: 0, limit: 100 });
  assert.deepEqual(
    rows.map((r) => r.name),
    ['root', '.gitignore', 'README.md'],
  );

  // includeIgnored reveals OS noise (.DS_Store) too.
  const rowsAll = snap.visibleRows({
    expanded: new Set([1]),
    offset: 0,
    limit: 100,
    includeIgnored: true,
  });
  assert.deepEqual(
    rowsAll.map((r) => r.name),
    ['root', '.DS_Store', '.gitignore', 'README.md'],
  );
});

test('visibleRows: offset + limit slicing', () => {
  const m = createMirror();
  seedDir(m, 1, 'root', null, 5);
  seedFile(m, 10, 'a', 1);
  seedFile(m, 11, 'b', 1);
  seedFile(m, 12, 'c', 1);
  seedFile(m, 13, 'd', 1);
  seedFile(m, 14, 'e', 1);
  m.children.set(1, [10, 11, 12, 13, 14]);
  m.roots.push(1);
  const snap = new ClientMirrorSnapshot(m);

  // Row order: [root, a, b, c, d, e]
  const rows = snap.visibleRows({ expanded: new Set([1]), offset: 2, limit: 2 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'b');
  assert.equal(rows[1].name, 'c');
});

test('visibleRows: limit=0 returns empty array', () => {
  const m = createMirror();
  seedDir(m, 1, 'root', null, 0);
  m.roots.push(1);
  const snap = new ClientMirrorSnapshot(m);
  const rows = snap.visibleRows({ expanded: new Set([1]), offset: 0, limit: 0 });
  assert.deepEqual([...rows], []);
});

test('visibleRows: invisible-but-expanded parent suppresses its children', () => {
  // `.git` is hard-hidden in Project view. If expanded, its children
  // must NOT appear — they'd render at depth=1 with nothing above them.
  const m = createMirror();
  seedDir(m, 1, 'visible', null, 1);
  m.byId.set(2, entry({ id: 2, parentId: null, name: '.git', kind: 1, isHidden: true }));
  m.directChildCounts.set(2, 2);
  seedFile(m, 20, 'leaked-a', 2);
  seedFile(m, 21, 'leaked-b', 2);
  m.children.set(2, [20, 21]);
  m.roots.push(1, 2);
  const snap = new ClientMirrorSnapshot(m);

  const rows = snap.visibleRows({
    expanded: new Set([1, 2]),
    offset: 0,
    limit: 100,
  });
  // Only the visible root should render; `.git` and its children dropped.
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'visible');
});

test('visibleRows: deep nested expansion reports correct depths + DFS order', () => {
  // root -> mid -> leaf
  const m = createMirror();
  seedDir(m, 1, 'root', null, 1);
  seedDir(m, 2, 'mid', 1, 1);
  seedFile(m, 3, 'leaf.txt', 2);
  m.children.set(1, [2]);
  m.children.set(2, [3]);
  m.roots.push(1);
  const snap = new ClientMirrorSnapshot(m);

  const rows = snap.visibleRows({
    expanded: new Set([1, 2]),
    offset: 0,
    limit: 100,
  });
  assert.deepEqual(
    rows.map((r) => r.name),
    ['root', 'mid', 'leaf.txt'],
  );
  assert.deepEqual(
    rows.map((r) => r.depth),
    [0, 1, 2],
  );
  assert.deepEqual(
    rows.map((r) => r.isExpanded),
    [true, true, false],
  );
});

test('visibleRows: child list out of order is sorted by name', () => {
  const m = createMirror();
  seedDir(m, 1, 'root', null, 3);
  seedFile(m, 10, 'zzz', 1);
  seedFile(m, 11, 'aaa', 1);
  seedFile(m, 12, 'mmm', 1);
  // Children map holds wire-order (id-allocation order).
  m.children.set(1, [10, 11, 12]);
  m.roots.push(1);
  const snap = new ClientMirrorSnapshot(m);

  const rows = snap.visibleRows({ expanded: new Set([1]), offset: 0, limit: 100 });
  assert.deepEqual(
    rows.slice(1).map((r) => r.name),
    ['aaa', 'mmm', 'zzz'],
  );
});

test('visibleRows: authoritative child order survives evicted entry metadata', () => {
  const m = createMirror();
  seedDir(m, 1, 'root', null, 2);
  seedFile(m, 10, 'first.txt', 1);
  // Entry 11 is intentionally absent: only its structural id remains.
  m.children.set(1, [10, 11]);
  m.orderedChildren.add(1);
  m.roots.push(1);

  const rows = new ClientMirrorSnapshot(m).visibleRows({
    expanded: new Set([1]),
    offset: 0,
    limit: 100,
  });
  assert.deepEqual(
    rows.map((row) => row.id),
    [1, 10, 11],
  );
  assert.equal(rows[2].pending, true);
});

test('visibleRows: cache miss (expanded dir without children entry) is skipped silently', () => {
  const m = createMirror();
  seedDir(m, 1, 'root', null, 1);
  seedDir(m, 2, 'child-dir', 1, 5);
  m.children.set(1, [2]);
  // Intentionally NO m.children.set(2, ...) — the worker hasn't
  // delivered child-dir's children yet, but the session has it expanded.
  m.roots.push(1);
  const snap = new ClientMirrorSnapshot(m);

  const rows = snap.visibleRows({
    expanded: new Set([1, 2]),
    offset: 0,
    limit: 100,
  });
  // Should not throw; child-dir shows up but descent stops there.
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'root');
  assert.equal(rows[1].name, 'child-dir');
  assert.equal(rows[1].hasChildren, true); // directChildCounts=5 > 0
  assert.equal(rows[1].isExpanded, true);
});

test('visibleRows: siblings of invisible-expanded parent still render', () => {
  // Regression guard: the DFS pruning must not bleed past the
  // invisible node. Sibling after a hard-hidden expanded subtree
  // (`.git`) should still appear.
  const m = createMirror();
  seedDir(m, 1, 'root', null, 2);
  m.byId.set(2, entry({ id: 2, parentId: 1, name: '.git', kind: 1, isHidden: true }));
  m.directChildCounts.set(2, 1);
  seedFile(m, 20, 'nope', 2);
  m.children.set(2, [20]);
  seedFile(m, 3, 'visible-sibling', 1);
  m.children.set(1, [2, 3]);
  m.roots.push(1);
  const snap = new ClientMirrorSnapshot(m);

  const rows = snap.visibleRows({
    expanded: new Set([1, 2]),
    offset: 0,
    limit: 100,
  });
  assert.deepEqual(
    rows.map((r) => r.name),
    ['root', 'visible-sibling'],
  );
});

// ─── 8.7: cache-miss placeholder rows ────────────────────────────────

test('visibleRows: root id missing from byId emits a pending placeholder', () => {
  // The client got a setExpanded reply that named a root id but the
  // entry payload hasn't landed yet. The virtualizer still needs a row
  // at that offset so scrollTop is stable; visibleRows emits a
  // placeholder with `pending: true` at depth 0.
  const m = createMirror();
  m.roots.push(42); // No byId entry.
  const snap = new ClientMirrorSnapshot(m);

  const rows = snap.visibleRows({
    expanded: new Set(),
    offset: 0,
    limit: 10,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 42);
  assert.equal(rows[0].pending, true);
  assert.equal(rows[0].depth, 0);
  assert.equal(rows[0].hasChildren, false);
  assert.equal(rows[0].isExpanded, false);
});

test('visibleRows: missing expanded child id emits placeholder at child depth', () => {
  // root is known and expanded; its child list references id 99 which
  // isn't yet in byId. The placeholder renders at depth=1 with
  // pending: true so the skeleton indents correctly.
  const m = createMirror();
  seedDir(m, 1, 'root', null, 1);
  m.children.set(1, [99]);
  m.roots.push(1);
  const snap = new ClientMirrorSnapshot(m);

  const rows = snap.visibleRows({
    expanded: new Set([1]),
    offset: 0,
    limit: 10,
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'root');
  assert.equal(rows[1].id, 99);
  assert.equal(rows[1].pending, true);
  assert.equal(rows[1].depth, 1);
});

test('visibleRows: mixed real + placeholder rows interleave at correct positions', () => {
  // Child list: [known-a, missing, known-b]. Sorted by name — but
  // the placeholder has no name so it sorts to the top (empty string
  // sorts before any real name). Assert we get the expected DFS
  // shape: root, placeholder, known-a, known-b.
  const m = createMirror();
  seedDir(m, 1, 'root', null, 3);
  seedFile(m, 10, 'known-a.txt', 1);
  seedFile(m, 11, 'known-b.txt', 1);
  // 99 is referenced but missing.
  m.children.set(1, [10, 11, 99]);
  m.roots.push(1);
  const snap = new ClientMirrorSnapshot(m);

  const rows = snap.visibleRows({
    expanded: new Set([1]),
    offset: 0,
    limit: 10,
  });
  assert.equal(rows.length, 4);
  assert.equal(rows[0].name, 'root');
  // Real rows present, pending row present at correct depth.
  const pendingRow = rows.find((r) => r.pending === true);
  assert.ok(pendingRow, 'pending row emitted');
  assert.equal(pendingRow.id, 99);
  assert.equal(pendingRow.depth, 1);
  const names = rows.filter((r) => r.pending !== true).map((r) => r.name);
  assert.deepEqual(names, ['root', 'known-a.txt', 'known-b.txt']);
});

test('visibleRows: placeholder respects offset + limit', () => {
  // Two missing root ids. offset=1, limit=1 should skip the first
  // placeholder and return the second.
  const m = createMirror();
  m.roots.push(50, 51);
  const snap = new ClientMirrorSnapshot(m);

  const rows = snap.visibleRows({ expanded: new Set(), offset: 1, limit: 1 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 51);
  assert.equal(rows[0].pending, true);
});
