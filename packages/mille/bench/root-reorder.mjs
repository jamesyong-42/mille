import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { DEFAULT_EXPLORER_SETTINGS, FileExplorer, buildIdentity } from '../dist/index.js';

const rootCount = Number(process.env.MILLE_ROOT_REORDER_ROOTS ?? 32);
const entriesPerRoot = Number(process.env.MILLE_ROOT_REORDER_ENTRIES_PER_ROOT ?? 1024);
const samples = Number(process.env.MILLE_ROOT_REORDER_SAMPLES ?? 100);
const p95BudgetMs = Number(process.env.MILLE_ROOT_REORDER_P95_BUDGET_MS ?? 8);
const sandbox = mkdtempSync(join(tmpdir(), 'mille-root-reorder-bench-'));
const roots = Array.from({ length: rootCount }, (_, index) =>
  join(sandbox, `root-${String(index).padStart(4, '0')}`),
);
for (const root of roots) {
  mkdirSync(root);
  for (let index = 0; index < entriesPerRoot; index += 1) {
    writeFileSync(join(root, `file-${String(index).padStart(5, '0')}.txt`), '');
  }
}

const fx = new FileExplorer({
  roots,
  settings: { ...DEFAULT_EXPLORER_SETTINGS, compactFolders: false },
});

function percentile(values, p) {
  return values[Math.min(values.length - 1, Math.floor(values.length * p))];
}

function summarize(values) {
  values.sort((a, b) => a - b);
  return {
    medianMs: Number(percentile(values, 0.5).toFixed(3)),
    p95Ms: Number(percentile(values, 0.95).toFixed(3)),
    maxMs: Number(values.at(-1).toFixed(3)),
  };
}

try {
  await fx.populateFromRoots();
  const original = fx
    .getSnapshot()
    .roots()
    .map((root) => root.id);
  assert.equal(original.length, rootCount);
  const reversed = [...original].reverse();
  const reorderTimings = [];

  for (let sample = 0; sample < samples + 20; sample += 1) {
    const expected = sample % 2 === 0 ? reversed : original;
    const start = performance.now();
    const version = fx.reorderRoots(expected);
    const observed = fx
      .getSnapshot()
      .roots()
      .map((root) => root.id);
    const elapsed = performance.now() - start;
    assert.equal(fx.getSnapshot().treeVersion, version);
    assert.deepEqual(observed, expected);
    if (sample >= 20) reorderTimings.push(elapsed);
  }

  const stable = fx
    .getSnapshot()
    .roots()
    .map((root) => root.id);
  const stableVersion = fx.getTreeVersion();
  const noOpTimings = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const start = performance.now();
    assert.equal(fx.reorderRoots(stable), stableVersion);
    noOpTimings.push(performance.now() - start);
  }
  assert.equal(fx.getTreeVersion(), stableVersion);

  const reorder = summarize(reorderTimings);
  const noOp = summarize(noOpTimings);
  const result = {
    identity: buildIdentity(),
    roots: rootCount,
    indexedEntries: rootCount * (entriesPerRoot + 1),
    samples,
    reorder,
    noOp,
    p95BudgetMs,
  };
  console.log(JSON.stringify(result));
  assert.ok(reorder.p95Ms <= p95BudgetMs, `root reorder p95 ${reorder.p95Ms}ms > ${p95BudgetMs}ms`);
} finally {
  await fx.dispose();
  rmSync(sandbox, { recursive: true, force: true });
}
