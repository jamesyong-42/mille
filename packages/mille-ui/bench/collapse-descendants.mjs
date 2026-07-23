import { strict as assert } from 'node:assert';
import { performance } from 'node:perf_hooks';

import { expandedDescendantIds } from '../dist/index.js';

const wideEntries = Number(process.env.MILLE_COLLAPSE_WIDE_ENTRIES ?? 100_000);
const deepEntries = Number(process.env.MILLE_COLLAPSE_DEEP_ENTRIES ?? 10_000);
const samples = Number(process.env.MILLE_COLLAPSE_SAMPLES ?? 30);
const wideP95BudgetMs = Number(process.env.MILLE_COLLAPSE_WIDE_P95_BUDGET_MS ?? 15);
const deepP95BudgetMs = Number(process.env.MILLE_COLLAPSE_DEEP_P95_BUDGET_MS ?? 8);

function entry(id, parentId) {
  return {
    id,
    parentId,
    name: `folder-${id}`,
    kind: 1,
    size: 0,
    mtimeMs: 0,
    ctimeMs: 0,
    isIgnored: false,
    isReadonly: false,
    isHidden: false,
  };
}

function fixture(count, parentFor) {
  const entries = new Map([[1, entry(1, null)]]);
  const expanded = new Set([1]);
  for (let id = 2; id <= count; id += 1) {
    entries.set(id, entry(id, parentFor(id)));
    expanded.add(id);
  }
  return {
    snapshot: { getById: (id) => entries.get(id) ?? null },
    expanded,
  };
}

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

function run(input) {
  const timings = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const started = performance.now();
    const result = expandedDescendantIds(input.snapshot, input.expanded, 1);
    timings.push(performance.now() - started);
    assert.equal(result.length, input.expanded.size - 1);
  }
  return summarize(timings);
}

const deep = run(fixture(deepEntries, (id) => id - 1));
const wide = run(fixture(wideEntries, () => 1));
const result = {
  samples,
  wideEntries,
  deepEntries,
  wide,
  deep,
  wideP95BudgetMs,
  deepP95BudgetMs,
};
console.log(JSON.stringify(result));
assert.ok(wide.p95Ms <= wideP95BudgetMs, `wide p95 ${wide.p95Ms}ms > ${wideP95BudgetMs}ms`);
assert.ok(deep.p95Ms <= deepP95BudgetMs, `deep p95 ${deep.p95Ms}ms > ${deepP95BudgetMs}ms`);
