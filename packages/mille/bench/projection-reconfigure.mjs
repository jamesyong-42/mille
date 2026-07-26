import { performance } from 'node:perf_hooks';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_EXPLORER_SETTINGS, FileExplorer } from '../dist/index.js';

const pairs = Number(process.env.MILLE_RECONFIGURE_PAIRS ?? 15_000);
const unrelated = Number(process.env.MILLE_RECONFIGURE_UNRELATED ?? 20_000);
const samples = Number(process.env.MILLE_RECONFIGURE_SAMPLES ?? 20);
const updateBudgetMs = Number(process.env.MILLE_RECONFIGURE_UPDATE_P95_BUDGET_MS ?? 125);
const readyBudgetMs = Number(process.env.MILLE_RECONFIGURE_READY_P95_BUDGET_MS ?? 160);
const noopBudgetMs = Number(process.env.MILLE_RECONFIGURE_NOOP_P95_BUDGET_MS ?? 0.1);
const root = mkdtempSync(join(tmpdir(), 'mille-reconfigure-bench-'));

for (let index = 0; index < pairs; index++) {
  const stem = `source-${String(index).padStart(6, '0')}`;
  writeFileSync(join(root, `${stem}.ts`), '');
  writeFileSync(join(root, `${stem}.test.ts`), '');
}
for (let index = 0; index < unrelated; index++) {
  const prefix = index % 101 === 0 ? '.' : 'zz-';
  writeFileSync(join(root, `${prefix}note-${String(index).padStart(6, '0')}.md`), '');
}

const baseline = {
  ...DEFAULT_EXPLORER_SETTINGS,
  compactFolders: false,
  fileNestingPatterns: {},
};
const alternate = {
  ...DEFAULT_EXPLORER_SETTINGS,
  caseSensitive: true,
  foldersOnTop: false,
  showHiddenFiles: false,
  showIgnoredFiles: false,
  compactFolders: false,
  excludeGlobs: ['zz-note-*.md'],
  fileNestingPatterns: {
    '*.ts': ['${capture}.test.ts'],
  },
};
const fx = new FileExplorer({ roots: [root], settings: baseline });

function percentile(values, p) {
  return values[Math.min(values.length - 1, Math.floor(values.length * p))];
}

try {
  const populateStart = performance.now();
  await fx.populateFromRoots();
  const populateMs = performance.now() - populateStart;
  const rootEntry = fx.getSnapshot().roots()[0];
  assert.ok(rootEntry);
  const expanded = new Set([rootEntry.id]);
  const updateTimings = [];
  const readyTimings = [];
  const excludeAddTimings = [];
  const excludeRemoveTimings = [];

  for (let sample = 0; sample < samples + 2; sample++) {
    const settings = sample % 2 === 0 ? alternate : baseline;
    const start = performance.now();
    const version = fx.updateProjectionSettings(settings);
    const updatedAt = performance.now();
    const snapshot = fx.getSnapshot();
    const rows = snapshot.visibleRows({ expanded, offset: 0, limit: 200 });
    const readyAt = performance.now();
    assert.equal(snapshot.treeVersion, version);
    assert.equal(rows.length, 200);
    assert.equal(snapshot.showHiddenFiles, settings.showHiddenFiles);
    if (sample >= 2) {
      const updateMs = updatedAt - start;
      updateTimings.push(updateMs);
      readyTimings.push(readyAt - start);
      (settings === alternate ? excludeAddTimings : excludeRemoveTimings).push(updateMs);
    }
  }

  updateTimings.sort((a, b) => a - b);
  readyTimings.sort((a, b) => a - b);
  excludeAddTimings.sort((a, b) => a - b);
  excludeRemoveTimings.sort((a, b) => a - b);
  const stableSettings = samples % 2 === 0 ? baseline : alternate;
  const stableVersion = fx.getTreeVersion();
  const noopTimings = [];
  for (let sample = 0; sample < 100; sample++) {
    const start = performance.now();
    assert.equal(fx.updateProjectionSettings(stableSettings), stableVersion);
    noopTimings.push(performance.now() - start);
  }
  noopTimings.sort((a, b) => a - b);

  const result = {
    entries: pairs * 2 + unrelated + 1,
    samples,
    populateMs: Number(populateMs.toFixed(2)),
    updateMedianMs: Number(percentile(updateTimings, 0.5).toFixed(2)),
    updateP95Ms: Number(percentile(updateTimings, 0.95).toFixed(2)),
    excludeAddMedianMs: Number(percentile(excludeAddTimings, 0.5).toFixed(2)),
    excludeAddP95Ms: Number(percentile(excludeAddTimings, 0.95).toFixed(2)),
    excludeRemoveMedianMs: Number(percentile(excludeRemoveTimings, 0.5).toFixed(2)),
    excludeRemoveP95Ms: Number(percentile(excludeRemoveTimings, 0.95).toFixed(2)),
    readyMedianMs: Number(percentile(readyTimings, 0.5).toFixed(2)),
    readyP95Ms: Number(percentile(readyTimings, 0.95).toFixed(2)),
    noopP95Ms: Number(percentile(noopTimings, 0.95).toFixed(3)),
    updateBudgetMs,
    readyBudgetMs,
    noopBudgetMs,
  };
  console.log(JSON.stringify(result));
  assert.ok(
    result.updateP95Ms <= updateBudgetMs,
    `projection update p95 ${result.updateP95Ms}ms > ${updateBudgetMs}ms`,
  );
  assert.ok(
    result.readyP95Ms <= readyBudgetMs,
    `projection ready p95 ${result.readyP95Ms}ms > ${readyBudgetMs}ms`,
  );
  assert.ok(
    result.noopP95Ms <= noopBudgetMs,
    `projection no-op p95 ${result.noopP95Ms}ms > ${noopBudgetMs}ms`,
  );
} finally {
  await fx.dispose();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
