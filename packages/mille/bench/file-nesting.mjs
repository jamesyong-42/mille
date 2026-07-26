import { performance } from 'node:perf_hooks';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_EXPLORER_SETTINGS, FileExplorer } from '../dist/index.js';

const pairs = Number(process.env.MILLE_NESTING_PAIRS ?? 20_000);
const unrelated = Number(process.env.MILLE_NESTING_UNRELATED ?? 10_000);
const samples = Number(process.env.MILLE_NESTING_SAMPLES ?? 40);
const budgetMs = Number(process.env.MILLE_NESTING_P95_BUDGET_MS ?? 10);
const coldBudgetMs = Number(process.env.MILLE_NESTING_COLD_BUDGET_MS ?? 100);
const root = mkdtempSync(join(tmpdir(), 'mille-nesting-bench-'));

for (let index = 0; index < pairs; index++) {
  const stem = `source-${String(index).padStart(6, '0')}`;
  writeFileSync(join(root, `${stem}.ts`), '');
  writeFileSync(join(root, `${stem}.test.ts`), '');
}
for (let index = 0; index < unrelated; index++) {
  writeFileSync(join(root, `zz-note-${String(index).padStart(6, '0')}.md`), '');
}

const fx = new FileExplorer({
  roots: [root],
  settings: {
    ...DEFAULT_EXPLORER_SETTINGS,
    compactFolders: false,
    fileNestingPatterns: {
      '*.ts': ['${capture}.test.ts'],
    },
  },
});

try {
  await fx.populateFromRoots();
  const snapshot = fx.getSnapshot();
  const rootEntry = snapshot.roots()[0];
  assert.ok(rootEntry);
  const expanded = new Set([rootEntry.id]);
  const expectedTopLevel = pairs + unrelated;
  const coldStart = performance.now();
  const firstProjected = snapshot.projectedChildrenOf(rootEntry.id);
  const coldPlanMs = performance.now() - coldStart;
  assert.equal(firstProjected.length, expectedTopLevel);
  const firstRows = snapshot.visibleRows({ expanded, offset: 0, limit: 200 });
  assert.equal(firstRows.length, 200);
  const source = firstRows.find((row) => row.name.endsWith('.ts'));
  assert.ok(source);
  assert.equal(source.hasChildren, true);
  assert.equal(snapshot.projectedChildCount(source.id), 1);

  const timings = [];
  for (let sample = 0; sample < samples + 5; sample++) {
    const start = performance.now();
    const projected = snapshot.projectedChildrenOf(rootEntry.id);
    const rows = snapshot.visibleRows({ expanded, offset: 0, limit: 200 });
    const elapsed = performance.now() - start;
    assert.equal(projected.length, expectedTopLevel);
    assert.equal(rows.length, 200);
    if (sample >= 5) timings.push(elapsed);
  }

  timings.sort((a, b) => a - b);
  const percentile = (p) => timings[Math.min(timings.length - 1, Math.floor(timings.length * p))];
  const result = {
    entries: pairs * 2 + unrelated + 1,
    nestedChildren: pairs,
    projectedTopLevel: expectedTopLevel,
    samples,
    coldPlanMs: Number(coldPlanMs.toFixed(2)),
    medianMs: Number(percentile(0.5).toFixed(2)),
    p95Ms: Number(percentile(0.95).toFixed(2)),
    budgetMs,
    coldBudgetMs,
  };
  console.log(JSON.stringify(result));
  assert.ok(
    result.coldPlanMs <= coldBudgetMs,
    `cold file nesting plan ${result.coldPlanMs}ms > ${coldBudgetMs}ms`,
  );
  assert.ok(result.p95Ms <= budgetMs, `file nesting p95 ${result.p95Ms}ms > ${budgetMs}ms`);
} finally {
  await fx.dispose();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
