import { strict as assert } from 'node:assert';
import { performance } from 'node:perf_hooks';

import { planEditorTabOpen } from './editor-tabs.mjs';

const samples = Number(process.env.MILLE_EDITOR_TAB_SAMPLES ?? 10_000);
const pinnedCount = Number(process.env.MILLE_EDITOR_TAB_PINNED ?? 64);
const p95BudgetMs = Number(process.env.MILLE_EDITOR_TAB_P95_BUDGET_MS ?? 0.25);
assert.ok(Number.isInteger(samples) && samples > 0);
assert.ok(Number.isInteger(pinnedCount) && pinnedCount >= 0);
assert.ok(Number.isFinite(p95BudgetMs) && p95BudgetMs > 0);

const entry = (id) => ({ id, name: `file-${id}.ts` });
let baseTabs = [];
for (let index = 0; index < pinnedCount; index += 1) {
  baseTabs = planEditorTabOpen(baseTabs, entry(index + 1), 'permanent').tabs;
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

const previewTimings = [];
const promotionTimings = [];
let previewTabs = baseTabs;
for (let sample = 0; sample < samples; sample += 1) {
  const target = entry(pinnedCount + sample + 1);
  const previewStarted = performance.now();
  const preview = planEditorTabOpen(previewTabs, target, 'preview');
  previewTimings.push(performance.now() - previewStarted);
  previewTabs = preview.tabs;
  assert.equal(previewTabs.filter((tab) => tab.preview).length, 1);
  assert.equal(previewTabs.filter((tab) => !tab.preview).length, pinnedCount);

  const promotionStarted = performance.now();
  const promoted = planEditorTabOpen(preview.tabs, target, 'permanent');
  promotionTimings.push(performance.now() - promotionStarted);
  assert.equal(promoted.tabs.filter((tab) => tab.preview).length, 0);
}

const result = {
  samples,
  pinnedCount,
  previewReplace: summarize(previewTimings),
  previewPromote: summarize(promotionTimings),
  p95BudgetMs,
};
console.log(JSON.stringify(result));
assert.ok(
  result.previewReplace.p95Ms <= p95BudgetMs,
  `preview replacement p95 ${result.previewReplace.p95Ms}ms > ${p95BudgetMs}ms`,
);
assert.ok(
  result.previewPromote.p95Ms <= p95BudgetMs,
  `preview promotion p95 ${result.previewPromote.p95Ms}ms > ${p95BudgetMs}ms`,
);
