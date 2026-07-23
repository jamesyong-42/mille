import { strict as assert } from 'node:assert';
import { performance } from 'node:perf_hooks';

import { fileSearchRequestForIds } from '../dist/index.js';

const singleSamples = Number(process.env.MILLE_SEARCH_SCOPE_SINGLE_SAMPLES ?? 100_000);
const batchTargets = Number(process.env.MILLE_SEARCH_SCOPE_BATCH_TARGETS ?? 1_000);
const batchSamples = Number(process.env.MILLE_SEARCH_SCOPE_BATCH_SAMPLES ?? 100);
const singleP95BudgetMs = Number(process.env.MILLE_SEARCH_SCOPE_SINGLE_P95_BUDGET_MS ?? 0.02);
const batchP95BudgetMs = Number(process.env.MILLE_SEARCH_SCOPE_BATCH_P95_BUDGET_MS ?? 5);

function entry(id, parentId, name) {
  return {
    id,
    parentId,
    name,
    kind: 1,
    size: 0,
    mtimeMs: 0,
    ctimeMs: 0,
    isIgnored: false,
    isReadonly: false,
    isHidden: false,
  };
}

const entries = new Map([
  [1, entry(1, null, 'workspace')],
  [2, entry(2, 1, 'packages')],
]);
const ids = [];
for (let index = 0; index < batchTargets; index += 1) {
  const id = index + 3;
  entries.set(id, entry(id, 2, `package-${index}`));
  ids.push(id);
}
const snapshot = { getById: (id) => entries.get(id) ?? null };

function summarize(values) {
  values.sort((left, right) => left - right);
  const at = (quantile) =>
    values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * quantile) - 1))] ?? 0;
  return {
    medianMs: Number(at(0.5).toFixed(6)),
    p95Ms: Number(at(0.95).toFixed(6)),
    maxMs: Number(at(1).toFixed(6)),
  };
}

function run(samples, kind, targets) {
  const timings = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const started = performance.now();
    const request = fileSearchRequestForIds(snapshot, kind, targets);
    timings.push(performance.now() - started);
    assert.ok(request);
    assert.equal(request.targets.length, targets.length);
  }
  return summarize(timings);
}

const single = run(singleSamples, 'findInFolder', [2]);
const batch = run(batchSamples, 'include', ids);
const result = {
  singleSamples,
  batchTargets,
  batchSamples,
  single,
  batch,
  singleP95BudgetMs,
  batchP95BudgetMs,
};
console.log(JSON.stringify(result));
assert.ok(
  single.p95Ms <= singleP95BudgetMs,
  `single scope p95 ${single.p95Ms}ms > ${singleP95BudgetMs}ms`,
);
assert.ok(
  batch.p95Ms <= batchP95BudgetMs,
  `batch scope p95 ${batch.p95Ms}ms > ${batchP95BudgetMs}ms`,
);
