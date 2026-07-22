import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { readTreeProjection } from '../dist/hooks/treeProjection.js';

function makeSnapshot(treeVersion, counters) {
  const rows = [{ id: 1, name: 'root' }];
  return {
    treeVersion,
    decorationVersion: 0,
    roots: () => rows,
    visibleRowCount: () => {
      counters.count += 1;
      return { known: rows.length, pendingExpansions: new Set() };
    },
    visibleRows: () => {
      counters.rows += 1;
      return rows;
    },
    getById: () => null,
    directChildCount: () => null,
    hasChildren: () => false,
    getDecorations: () => [],
  };
}

test('decoration-only snapshots reuse the complete structural projection', () => {
  const counters = { count: 0, rows: 0 };
  const expanded = new Set([1]);
  const first = readTreeProjection(makeSnapshot(7, counters), expanded, null);
  const decorationOnly = readTreeProjection(
    makeSnapshot(7, counters),
    expanded,
    first,
  );

  assert.equal(decorationOnly, first);
  assert.deepEqual(counters, { count: 1, rows: 1 });
});

test('tree-version and expansion changes each rematerialize exactly once', () => {
  const counters = { count: 0, rows: 0 };
  const expanded = new Set([1]);
  const first = readTreeProjection(makeSnapshot(7, counters), expanded, null);
  const nextTree = readTreeProjection(makeSnapshot(8, counters), expanded, first);
  const nextExpansion = readTreeProjection(
    makeSnapshot(8, counters),
    new Set([1, 2]),
    nextTree,
  );

  assert.notEqual(nextTree, first);
  assert.notEqual(nextExpansion, nextTree);
  assert.deepEqual(counters, { count: 3, rows: 3 });
});
