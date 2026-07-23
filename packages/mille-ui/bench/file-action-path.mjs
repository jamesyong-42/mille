import { strict as assert } from 'node:assert';
import { performance } from 'node:perf_hooks';

import { fileActionTargetForId } from '../dist/index.js';

const shallowSamples = Number(process.env.MILLE_FILE_ACTION_SHALLOW_SAMPLES ?? 100_000);
const deepSamples = Number(process.env.MILLE_FILE_ACTION_DEEP_SAMPLES ?? 1_000);
const shallowP95BudgetMs = Number(
  process.env.MILLE_FILE_ACTION_SHALLOW_P95_BUDGET_MS ?? 0.02,
);
const deepP95BudgetMs = Number(
  process.env.MILLE_FILE_ACTION_DEEP_P95_BUDGET_MS ?? 5,
);

function entry(id, parentId, name) {
  return {
    id,
    parentId,
    name,
    kind: id === 1 ? 1 : 0,
    size: 0,
    mtimeMs: 0,
    ctimeMs: 0,
    isIgnored: false,
    isReadonly: false,
    isHidden: false,
  };
}

function snapshotAtDepth(depth) {
  const entries = new Map();
  for (let id = 1; id <= depth; id += 1) {
    entries.set(id, entry(id, id === 1 ? null : id - 1, `p${id}`));
  }
  return {
    snapshot: { getById: (id) => entries.get(id) ?? null },
    targetId: depth,
  };
}

function summarize(values) {
  values.sort((left, right) => left - right);
  const at = (quantile) =>
    values[Math.min(values.length - 1, Math.floor(values.length * quantile))] ?? 0;
  return {
    medianMs: Number(at(0.5).toFixed(6)),
    p95Ms: Number(at(0.95).toFixed(6)),
    maxMs: Number(at(1).toFixed(6)),
  };
}

function run(samples, fixture) {
  const timings = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const started = performance.now();
    const target = fileActionTargetForId(fixture.snapshot, fixture.targetId);
    timings.push(performance.now() - started);
    assert.ok(target);
  }
  return summarize(timings);
}

const shallow = run(shallowSamples, snapshotAtDepth(8));
const maximumDepth = run(deepSamples, snapshotAtDepth(4_096));
const result = {
  shallowSamples,
  deepSamples,
  shallow,
  maximumDepth,
  shallowP95BudgetMs,
  deepP95BudgetMs,
};
console.log(JSON.stringify(result));
assert.ok(
  shallow.p95Ms <= shallowP95BudgetMs,
  `shallow path p95 ${shallow.p95Ms}ms > ${shallowP95BudgetMs}ms`,
);
assert.ok(
  maximumDepth.p95Ms <= deepP95BudgetMs,
  `maximum-depth path p95 ${maximumDepth.p95Ms}ms > ${deepP95BudgetMs}ms`,
);
