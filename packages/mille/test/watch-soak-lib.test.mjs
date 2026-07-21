import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { evaluateExpectation, snapshotEntries, summarizeByKind } from '../bench/watch-soak-lib.mjs';

function snapshot(entries, children) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return {
    roots: () => entries.filter((entry) => entry.parentId === null),
    childrenOf: (id) => children.get(id) ?? [],
    getById: (id) => byId.get(id) ?? null,
  };
}

const root = { id: 1, parentId: null, name: 'root', kind: 1, size: 0 };
const folder = { id: 2, parentId: 1, name: 'src', kind: 1, size: 0 };
const file = { id: 3, parentId: 2, name: 'index.ts', kind: 0, size: 42 };
const tree = snapshot(
  [root, folder, file],
  new Map([
    [1, [2]],
    [2, [3]],
  ]),
);

test('snapshotEntries walks every reachable entry exactly once', () => {
  assert.deepEqual(
    snapshotEntries(tree).map((entry) => entry.id),
    [1, 2, 3],
  );
});

test('evaluateExpectation checks kind, size, presence, and absence', () => {
  assert.deepEqual(
    evaluateExpectation(tree, {
      present: [{ name: 'index.ts', kind: 0, size: 42 }],
      absent: ['deleted.ts'],
    }),
    { ok: true, missing: [], unexpected: [], visibleEntryCount: 3 },
  );

  const failed = evaluateExpectation(tree, {
    present: [{ name: 'index.ts', kind: 0, size: 99 }],
    absent: ['src'],
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.missing.length, 1);
  assert.deepEqual(failed.unexpected, ['src']);
});

test('summarizeByKind produces independent latency distributions', () => {
  const summary = summarizeByKind([
    { kind: 'create', latencyMs: 10 },
    { kind: 'create', latencyMs: 30 },
    { kind: 'delete', latencyMs: 20 },
  ]);
  assert.deepEqual(summary.create, {
    count: 2,
    min: 10,
    mean: 20,
    p50: 10,
    p95: 30,
    p99: 30,
    max: 30,
  });
  assert.equal(summary.delete.count, 1);
  assert.equal(summary.delete.p95, 20);
});
