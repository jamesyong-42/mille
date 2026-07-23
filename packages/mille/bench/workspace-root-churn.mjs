import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { buildIdentity, DEFAULT_EXPLORER_SETTINGS, FileExplorer } from '../dist/index.js';

const baseEntries = Number(process.env.MILLE_ROOT_CHURN_BASE_ENTRIES ?? 32_768);
const candidateCount = Number(process.env.MILLE_ROOT_CHURN_CANDIDATES ?? 16);
const samples = Number(process.env.MILLE_ROOT_CHURN_SAMPLES ?? 100);
const p95BudgetMs = Number(process.env.MILLE_ROOT_CHURN_P95_BUDGET_MS ?? 16);
const sandbox = mkdtempSync(join(tmpdir(), 'mille-root-churn-bench-'));
const base = join(sandbox, 'base');
mkdirSync(base);
for (let index = 0; index < baseEntries; index += 1) {
  writeFileSync(join(base, `file-${String(index).padStart(5, '0')}.txt`), '');
}
const candidates = Array.from({ length: candidateCount }, (_, index) =>
  join(sandbox, `candidate-${String(index).padStart(2, '0')}`),
);
for (const candidate of candidates) {
  mkdirSync(candidate);
  writeFileSync(join(candidate, 'marker.txt'), '');
}

const fx = new FileExplorer({
  roots: [base, candidates[0]],
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
  const baseId = fx.getSnapshot().roots()[0]?.id;
  assert.ok(baseId !== undefined);
  const timings = [];

  for (let sample = 0; sample < samples + 10; sample += 1) {
    const candidate = candidates[(sample + 1) % candidates.length];
    const start = performance.now();
    const version = await fx.updateWorkspaceRoots([base, candidate]);
    const currentRoots = fx.getSnapshot().roots();
    const elapsed = performance.now() - start;
    assert.equal(currentRoots.length, 2);
    assert.equal(currentRoots[0].id, baseId);
    assert.equal(currentRoots[1].name, basename(candidate));
    assert.equal(fx.getSnapshot().treeVersion, version);
    if (sample >= 10) timings.push(elapsed);
  }

  const stable = [base, candidates[(samples + 10) % candidates.length]];
  const stableVersion = fx.getTreeVersion();
  const noOpTimings = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const start = performance.now();
    assert.equal(await fx.updateWorkspaceRoots(stable), stableVersion);
    noOpTimings.push(performance.now() - start);
  }
  assert.equal(fx.getTreeVersion(), stableVersion);

  const result = {
    identity: buildIdentity(),
    indexedEntries: baseEntries + 2,
    candidates: candidateCount,
    samples,
    replacement: summarize(timings),
    noOp: summarize(noOpTimings),
    p95BudgetMs,
  };
  console.log(JSON.stringify(result));
  assert.ok(
    result.replacement.p95Ms <= p95BudgetMs,
    `workspace-root replacement p95 ${result.replacement.p95Ms}ms > ${p95BudgetMs}ms`,
  );
} finally {
  await fx.dispose();
  rmSync(sandbox, { recursive: true, force: true });
}
