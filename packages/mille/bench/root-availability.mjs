import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { buildIdentity, DEFAULT_EXPLORER_SETTINGS, FileExplorer } from '../dist/index.js';

const entries = Number(process.env.MILLE_ROOT_AVAILABILITY_ENTRIES ?? 8_192);
const samples = Number(process.env.MILLE_ROOT_AVAILABILITY_SAMPLES ?? 30);
const warmups = Number(process.env.MILLE_ROOT_AVAILABILITY_WARMUPS ?? 5);
const p95BudgetMs = Number(process.env.MILLE_ROOT_AVAILABILITY_P95_BUDGET_MS ?? 16);
const sandbox = mkdtempSync(join(tmpdir(), 'mille-root-availability-bench-'));
const root = join(sandbox, 'workspace');
const parked = join(sandbox, 'workspace-offline');
mkdirSync(root);
for (let index = 0; index < entries; index += 1) {
  writeFileSync(join(root, `file-${String(index).padStart(5, '0')}.txt`), '');
}

const fx = new FileExplorer({
  roots: [root],
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
  const rootId = fx.getSnapshot().roots()[0]?.id;
  assert.ok(rootId !== undefined);
  const disappear = [];
  const recover = [];

  for (let sample = 0; sample < samples + warmups; sample += 1) {
    renameSync(root, parked);
    let started = performance.now();
    await fx.refreshWorkspaceRoots();
    const disappearElapsed = performance.now() - started;
    assert.equal(fx.getSnapshot().roots()[0]?.id, rootId);
    assert.equal(fx.getSnapshot().roots()[0]?.kind, 4);
    assert.equal(fx.getSnapshot().childrenOf(rootId).length, 0);

    renameSync(parked, root);
    started = performance.now();
    await fx.refreshWorkspaceRoots();
    const recoverElapsed = performance.now() - started;
    assert.equal(fx.getSnapshot().roots()[0]?.id, rootId);
    assert.equal(fx.getSnapshot().roots()[0]?.kind, 1);
    if (sample >= warmups) {
      disappear.push(disappearElapsed);
      recover.push(recoverElapsed);
    }

    // Rebuild the known subtree outside the timed section so the next
    // disappearance measures full stale-subtree eviction again.
    await fx.populateFromRoots();
  }

  const stableVersion = fx.getTreeVersion();
  const noOp = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const started = performance.now();
    assert.equal(await fx.refreshWorkspaceRoots(), stableVersion);
    noOp.push(performance.now() - started);
  }

  const result = {
    identity: buildIdentity(),
    indexedEntries: entries + 1,
    samples,
    disappearance: summarize(disappear),
    recovery: summarize(recover),
    noOp: summarize(noOp),
    p95BudgetMs,
  };
  console.log(JSON.stringify(result));
  assert.ok(
    result.disappearance.p95Ms <= p95BudgetMs,
    `root disappearance p95 ${result.disappearance.p95Ms}ms > ${p95BudgetMs}ms`,
  );
  assert.ok(
    result.recovery.p95Ms <= p95BudgetMs,
    `root recovery p95 ${result.recovery.p95Ms}ms > ${p95BudgetMs}ms`,
  );
} finally {
  await fx.dispose();
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
