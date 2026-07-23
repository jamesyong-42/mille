import { strict as assert } from 'node:assert';
import { performance } from 'node:perf_hooks';

import {
  classifyActiveEntry,
  shouldAutoRevealActiveEntry,
} from '../dist/index.js';

const samples = Number(process.env.MILLE_ACTIVE_POLICY_SAMPLES ?? 100_000);
const p95BudgetMs = Number(
  process.env.MILLE_ACTIVE_POLICY_P95_BUDGET_MS ?? 0.01,
);
assert.ok(Number.isInteger(samples) && samples > 0);
assert.ok(Number.isFinite(p95BudgetMs) && p95BudgetMs > 0);

const baseEntry = {
  id: 1,
  parentId: null,
  name: 'active.ts',
  kind: 0,
  size: 0,
  mtimeMs: 0,
  ctimeMs: 0,
  isIgnored: false,
  isReadonly: false,
  isHidden: false,
};
const cases = [
  {
    input: { origin: 'workspace', entry: baseEntry },
    expected: 'visible',
  },
  {
    input: {
      origin: 'workspace',
      entry: { ...baseEntry, isHidden: true },
      showHiddenFiles: false,
    },
    expected: 'hidden',
  },
  {
    input: {
      origin: 'workspace',
      entry: { ...baseEntry, isIgnored: true },
      showIgnoredFiles: false,
    },
    expected: 'ignored',
  },
  {
    input: { origin: 'generated', entry: baseEntry },
    expected: 'generated',
  },
  {
    input: { origin: 'external', entry: null },
    expected: 'external',
  },
  {
    input: { origin: 'workspace', entry: null },
    expected: 'missing',
  },
];

const timings = [];
const counts = new Map();
for (let sample = 0; sample < samples; sample += 1) {
  const fixture = cases[sample % cases.length];
  const started = performance.now();
  const disposition = classifyActiveEntry(fixture.input);
  shouldAutoRevealActiveEntry(disposition, {
    revealHidden: true,
    revealIgnored: true,
    revealGenerated: true,
  });
  timings.push(performance.now() - started);
  assert.equal(disposition, fixture.expected);
  counts.set(disposition, (counts.get(disposition) ?? 0) + 1);
}

timings.sort((left, right) => left - right);
const percentile = (quantile) =>
  timings[
    Math.min(timings.length - 1, Math.floor(timings.length * quantile))
  ] ?? 0;
const result = {
  samples,
  dispositionCounts: Object.fromEntries(counts),
  medianMs: Number(percentile(0.5).toFixed(6)),
  p95Ms: Number(percentile(0.95).toFixed(6)),
  maxMs: Number(percentile(1).toFixed(6)),
  p95BudgetMs,
};
console.log(JSON.stringify(result));
assert.ok(
  result.p95Ms <= p95BudgetMs,
  `active-entry policy p95 ${result.p95Ms}ms > ${p95BudgetMs}ms`,
);
