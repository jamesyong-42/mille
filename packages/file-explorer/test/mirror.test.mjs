// Unit tests for mirror working-state helpers — Phase 8 commit 8.1.
//
// The working state itself is a plain object of Maps/Sets; these tests
// lock in constructor defaults and the shallow-clone contract the
// reducer relies on (mutating a cloned map MUST NOT leak back into the
// source).

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createMirror, cloneMirror } from '../dist/mirror.js';

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
  src.byId.set(1, {
    id: 1,
    parentId: null,
    name: 'root',
    kind: 1,
    size: 0,
    mtimeMs: 0,
    ctimeMs: 0,
    symlinkTargetIsDir: null,
    pathSegments: null,
    isIgnored: false,
    isReadonly: false,
    isHidden: false,
  });
  src.directChildCounts.set(1, 3);
  src.pendingExpansions.add(1);
  src.roots.push(1);
  src.volatileSubtrees.add(1);
  src.treeVersion = 5;
  src.decorationVersion = 2;

  const clone = cloneMirror(src);

  // Mutations to the clone must not leak back.
  clone.byId.set(2, {
    id: 2,
    parentId: 1,
    name: 'child',
    kind: 0,
    size: 10,
    mtimeMs: 0,
    ctimeMs: 0,
    symlinkTargetIsDir: null,
    pathSegments: null,
    isIgnored: false,
    isReadonly: false,
    isHidden: false,
  });
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
