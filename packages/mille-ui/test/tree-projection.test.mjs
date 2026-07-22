import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { readTreeProjection } from '../dist/hooks/treeProjection.js';

function makeSnapshot(treeVersion, counters, projectionVersion = treeVersion) {
  const rows = [{ id: 1, name: 'root' }];
  return {
    treeVersion,
    projectionVersion,
    decorationVersion: 0,
    roots: () => rows,
    visibleRowCount: () => {
      counters.count += 1;
      return { known: rows.length, pendingExpansions: new Set() };
    },
    visibleRows: ({ offset, limit }) => {
      counters.rows += 1;
      counters.maxLimit = Math.max(counters.maxLimit, limit);
      return rows.slice(offset, offset + limit);
    },
    getById: () => null,
    directChildCount: () => null,
    hasChildren: () => false,
    getDecorations: () => [],
  };
}

test('decoration-only snapshots reuse the windowed structural projection', () => {
  const counters = { count: 0, rows: 0, maxLimit: 0 };
  const expanded = new Set([1]);
  const first = readTreeProjection(makeSnapshot(7, counters), expanded, null);
  const decorationOnly = readTreeProjection(
    makeSnapshot(7, counters),
    expanded,
    first,
  );

  assert.equal(decorationOnly, first);
  assert.deepEqual(counters, { count: 1, rows: 0, maxLimit: 0 });
});

test('tree-version and expansion changes refresh counts without reading rows', () => {
  const counters = { count: 0, rows: 0, maxLimit: 0 };
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
  assert.deepEqual(counters, { count: 3, rows: 0, maxLimit: 0 });
});

test('viewport hydration rematerializes without advancing treeVersion', () => {
  const counters = { count: 0, rows: 0, maxLimit: 0 };
  const expanded = new Set();
  const first = readTreeProjection(makeSnapshot(7, counters, 10), expanded, null);
  const hydrated = readTreeProjection(makeSnapshot(7, counters, 11), expanded, first);

  assert.notEqual(hydrated, first);
  assert.deepEqual(counters, { count: 2, rows: 0, maxLimit: 0 });
});

test('row windows are bounded and the complete projection stays lazy', () => {
  const counters = { count: 0, rows: 0, maxLimit: 0 };
  const projection = readTreeProjection(makeSnapshot(7, counters), new Set(), null);

  assert.deepEqual(projection.readRows(0, 1).map((row) => row.id), [1]);
  assert.equal(counters.rows, 1);
  assert.equal(counters.maxLimit, 1);
  assert.deepEqual(projection.readAllRows().map((row) => row.id), [1]);
  assert.equal(counters.rows, 2, 'full projection materializes only on explicit demand');
});
