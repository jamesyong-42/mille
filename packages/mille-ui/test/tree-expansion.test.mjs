import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { expandedDescendantIds } from '../dist/index.js';

const entry = (id, parentId) => ({
  id,
  parentId,
  name: `entry-${id}`,
  kind: 1,
  size: 0,
  mtimeMs: 0,
  ctimeMs: 0,
  isIgnored: false,
  isReadonly: false,
  isHidden: false,
});

const snapshot = (entries) => ({ getById: (id) => entries.get(id) ?? null });

test('expanded descendant selection preserves root and unrelated branches', () => {
  const entries = new Map([
    [1, entry(1, null)],
    [2, entry(2, 1)],
    [3, entry(3, 2)],
    [4, entry(4, 1)],
    [5, entry(5, null)],
    [6, entry(6, 5)],
  ]);
  assert.deepEqual(
    expandedDescendantIds(snapshot(entries), new Set([1, 2, 3, 4, 6]), 2),
    [3],
  );
  assert.deepEqual(
    expandedDescendantIds(snapshot(entries), new Set([1, 2, 3]), 1, true),
    [1, 2, 3],
  );
});

test('expanded descendant selection rejects missing roots and parent cycles', () => {
  const entries = new Map([
    [1, entry(1, null)],
    [7, entry(7, 8)],
    [8, entry(8, 7)],
  ]);
  assert.deepEqual(expandedDescendantIds(snapshot(entries), new Set([7, 8]), 99), []);
  assert.deepEqual(expandedDescendantIds(snapshot(entries), new Set([7, 8]), 1), []);
});
