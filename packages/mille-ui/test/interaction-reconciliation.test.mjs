import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { reconcileTreeInteraction } from '../dist/hooks/interactionReconciliation.js';

const rows = (ids) => ids.map((id) => ({ id }));

test('unrelated structural churn preserves selection set identity, focus, and anchor', () => {
  const selectedIds = new Set([2, 4]);
  const result = reconcileTreeInteraction(
    rows([1, 2, 3, 4]),
    rows([10, 1, 2, 3, 4]),
    selectedIds,
    4,
    2,
  );
  assert.equal(result.selectedIds, selectedIds);
  assert.equal(result.focusedId, 4);
  assert.equal(result.anchorId, 2);
});

test('deleted selected ids are pruned without clearing surviving selection', () => {
  const result = reconcileTreeInteraction(
    rows([1, 2, 3, 4]),
    rows([1, 3, 4]),
    new Set([2, 4]),
    4,
    2,
  );
  assert.deepEqual([...result.selectedIds], [4]);
  assert.equal(result.focusedId, 4);
  assert.equal(result.anchorId, 4);
});

test('deleting the sole focused selection selects and focuses the next survivor', () => {
  const result = reconcileTreeInteraction(
    rows([1, 2, 3, 4]),
    rows([1, 2, 4]),
    new Set([3]),
    3,
    3,
  );
  assert.deepEqual([...result.selectedIds], [4]);
  assert.equal(result.focusedId, 4);
  assert.equal(result.anchorId, 4);
});

test('removing the entire projection clears deleted interaction ids', () => {
  const result = reconcileTreeInteraction(rows([1]), [], new Set([1]), 1, 1);
  assert.equal(result.selectedIds.size, 0);
  assert.equal(result.focusedId, null);
  assert.equal(result.anchorId, null);
});
