import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { DEFAULT_EXPLORER_SETTINGS, FileExplorer } from '../dist/index.js';

const stableFiles = Number(process.env.MILLE_RESYNC_STABLE_FILES ?? 5_000);
const churnFiles = Number(process.env.MILLE_RESYNC_CHURN_FILES ?? 100);
const churnSamples = Number(process.env.MILLE_RESYNC_CHURN_SAMPLES ?? 10);
const noOpWarmups = Number(process.env.MILLE_RESYNC_NOOP_WARMUPS ?? 3);
const noOpSamples = Number(process.env.MILLE_RESYNC_NOOP_SAMPLES ?? 20);
const churnP95BudgetMs = Number(process.env.MILLE_RESYNC_CHURN_P95_BUDGET_MS ?? 100);
const noOpP95BudgetMs = Number(process.env.MILLE_RESYNC_NOOP_P95_BUDGET_MS ?? 50);

function summarize(values) {
  values.sort((left, right) => left - right);
  const at = (quantile) =>
    values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * quantile) - 1))] ?? 0;
  return {
    medianMs: Number(at(0.5).toFixed(3)),
    p95Ms: Number(at(0.95).toFixed(3)),
    maxMs: Number(at(1).toFixed(3)),
  };
}

const sandbox = mkdtempSync(join(tmpdir(), 'mille-resync-bench-'));
const root = join(sandbox, 'workspace');
mkdirSync(root);
for (let index = 0; index < stableFiles; index += 1) {
  writeFileSync(join(root, `stable-${index}.txt`), `${index}`);
}
let volatileNames = [];
for (let index = 0; index < churnFiles; index += 1) {
  const name = `volatile-0-${index}.txt`;
  volatileNames.push(name);
  writeFileSync(join(root, name), 'initial');
}

const fx = new FileExplorer({
  roots: [root],
  settings: { ...DEFAULT_EXPLORER_SETTINGS, compactFolders: false },
  watchDebounceMs: 60_000,
});
try {
  await fx.populateFromRoots();
  const rootId = fx.getSnapshot().roots()[0]?.id;
  assert.ok(rootId !== undefined);
  const churnTimings = [];
  for (let sample = 1; sample <= churnSamples; sample += 1) {
    for (const name of volatileNames) rmSync(join(root, name));
    volatileNames = [];
    for (let index = 0; index < churnFiles; index += 1) {
      const name = `volatile-${sample}-${index}.txt`;
      volatileNames.push(name);
      writeFileSync(join(root, name), `${sample}`);
    }
    const started = performance.now();
    await fx.resync(rootId, { recursive: true });
    churnTimings.push(performance.now() - started);
    assert.equal(
      fx.getSnapshot().childrenOf(rootId).length,
      stableFiles + churnFiles,
      'resync must converge to the exact disk child count',
    );
  }

  const stableVersion = fx.getTreeVersion();
  for (let sample = 0; sample < noOpWarmups; sample += 1) {
    await fx.resync(rootId, { recursive: true });
    assert.equal(fx.getTreeVersion(), stableVersion, 'warm no-op must not advance tree version');
  }
  const noOpTimings = [];
  for (let sample = 0; sample < noOpSamples; sample += 1) {
    const started = performance.now();
    await fx.resync(rootId, { recursive: true });
    noOpTimings.push(performance.now() - started);
    assert.equal(fx.getTreeVersion(), stableVersion, 'no-op resync must not advance tree version');
  }

  const churn = summarize(churnTimings);
  const noOp = summarize(noOpTimings);
  const result = {
    stableFiles,
    churnFiles,
    churnSamples,
    noOpWarmups,
    noOpSamples,
    churn,
    noOp,
    churnP95BudgetMs,
    noOpP95BudgetMs,
  };
  console.log(JSON.stringify(result));
  assert.ok(
    churn.p95Ms <= churnP95BudgetMs,
    `churn resync p95 ${churn.p95Ms}ms > ${churnP95BudgetMs}ms`,
  );
  assert.ok(
    noOp.p95Ms <= noOpP95BudgetMs,
    `no-op resync p95 ${noOp.p95Ms}ms > ${noOpP95BudgetMs}ms`,
  );
} finally {
  await fx.dispose();
  rmSync(sandbox, { recursive: true, force: true });
}
