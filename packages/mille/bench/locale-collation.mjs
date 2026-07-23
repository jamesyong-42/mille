import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { DEFAULT_EXPLORER_SETTINGS, FileExplorer } from '../dist/index.js';

const entries = Number(process.env.MILLE_LOCALE_ENTRIES ?? 30_000);
const samples = Number(process.env.MILLE_LOCALE_SAMPLES ?? 20);
const updateBudgetMs = Number(process.env.MILLE_LOCALE_UPDATE_P95_BUDGET_MS ?? 90);
const readyBudgetMs = Number(process.env.MILLE_LOCALE_READY_P95_BUDGET_MS ?? 100);
const root = mkdtempSync(join(tmpdir(), 'mille-locale-bench-'));
const stems = ['alpha', 'éclair', 'zebra', 'åska', 'älg', 'öga', 'pollo', 'polvo'];

for (let index = 0; index < entries; index++) {
  const stem = stems[index % stems.length];
  writeFileSync(join(root, `${stem}-${index}.txt`), '');
}
for (const name of ['z-sentinel.txt', 'å-sentinel.txt', 'file2.txt', 'file10.txt']) {
  writeFileSync(join(root, name), '');
}

const settings = (locale) => ({
  ...DEFAULT_EXPLORER_SETTINGS,
  compactFolders: false,
  foldersOnTop: false,
  locale,
});
const fx = new FileExplorer({ roots: [root], settings: settings('en') });

function percentile(values, p) {
  return values[Math.min(values.length - 1, Math.floor(values.length * p))];
}

function indexOfName(snapshot, rootId, name) {
  return snapshot.childrenOf(rootId).findIndex((id) => snapshot.getById(id)?.name === name);
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

  for (let sample = 0; sample < samples + 2; sample++) {
    const locale = sample % 2 === 0 ? 'sv' : 'en';
    const start = performance.now();
    const version = fx.updateProjectionSettings(settings(locale));
    const updatedAt = performance.now();
    const snapshot = fx.getSnapshot();
    const rows = snapshot.visibleRows({ expanded, offset: 0, limit: 200 });
    const readyAt = performance.now();
    assert.equal(snapshot.treeVersion, version);
    assert.equal(rows.length, 200);
    const zIndex = indexOfName(snapshot, rootEntry.id, 'z-sentinel.txt');
    const aRingIndex = indexOfName(snapshot, rootEntry.id, 'å-sentinel.txt');
    const twoIndex = indexOfName(snapshot, rootEntry.id, 'file2.txt');
    const tenIndex = indexOfName(snapshot, rootEntry.id, 'file10.txt');
    assert.ok(zIndex >= 0 && aRingIndex >= 0 && twoIndex >= 0 && tenIndex >= 0);
    assert.equal(locale === 'sv', zIndex < aRingIndex);
    assert.ok(twoIndex < tenIndex);
    if (sample >= 2) {
      updateTimings.push(updatedAt - start);
      readyTimings.push(readyAt - start);
    }
  }

  updateTimings.sort((left, right) => left - right);
  readyTimings.sort((left, right) => left - right);
  const result = {
    entries: entries + 4,
    samples,
    populateMs: Number(populateMs.toFixed(2)),
    updateMedianMs: Number(percentile(updateTimings, 0.5).toFixed(2)),
    updateP95Ms: Number(percentile(updateTimings, 0.95).toFixed(2)),
    readyMedianMs: Number(percentile(readyTimings, 0.5).toFixed(2)),
    readyP95Ms: Number(percentile(readyTimings, 0.95).toFixed(2)),
    updateBudgetMs,
    readyBudgetMs,
  };
  console.log(JSON.stringify(result));
  assert.ok(
    result.updateP95Ms <= updateBudgetMs,
    `locale update p95 ${result.updateP95Ms}ms > ${updateBudgetMs}ms`,
  );
  assert.ok(
    result.readyP95Ms <= readyBudgetMs,
    `locale ready p95 ${result.readyP95Ms}ms > ${readyBudgetMs}ms`,
  );
} finally {
  await fx.dispose();
  rmSync(root, { recursive: true, force: true });
}
