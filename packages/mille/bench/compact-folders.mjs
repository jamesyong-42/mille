import { performance } from 'node:perf_hooks';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_EXPLORER_SETTINGS, FileExplorer } from '../dist/index.js';

const depth = Number(process.env.MILLE_COMPACT_DEPTH ?? 200);
const samples = Number(process.env.MILLE_COMPACT_SAMPLES ?? 2_000);
const budgetMs = Number(process.env.MILLE_COMPACT_P95_BUDGET_MS ?? 5);
const root = mkdtempSync(join(tmpdir(), 'mille-compact-bench-'));
let cursor = root;
for (let i = 0; i < depth; i++) {
  cursor = join(cursor, 'd');
  mkdirSync(cursor);
}
writeFileSync(join(cursor, 'leaf.txt'), '');

const fx = new FileExplorer({
  roots: [root],
  settings: { ...DEFAULT_EXPLORER_SETTINGS, compactFolders: true },
});
try {
  await fx.populateFromRoots();
  const snapshot = fx.getSnapshot();
  const rootEntry = snapshot.roots()[0];
  assert.ok(rootEntry);
  const expanded = new Set([rootEntry.id]);
  const first = snapshot.visibleRows({ expanded, offset: 0, limit: 10 });
  assert.equal(first.length, 2);
  assert.equal(first[1].pathSegments.length, depth);

  const timings = [];
  for (let i = 0; i < samples + 100; i++) {
    const start = performance.now();
    const rows = snapshot.visibleRows({ expanded, offset: 0, limit: 10 });
    const count = snapshot.visibleRowCount(expanded).known;
    const elapsed = performance.now() - start;
    assert.equal(rows.length, count);
    if (i >= 100) timings.push(elapsed);
  }
  timings.sort((a, b) => a - b);
  const at = (p) => timings[Math.min(timings.length - 1, Math.floor(timings.length * p))];
  const result = {
    depth,
    samples,
    medianMs: Number(at(0.5).toFixed(3)),
    p95Ms: Number(at(0.95).toFixed(3)),
    budgetMs,
  };
  console.log(JSON.stringify(result));
  assert.ok(result.p95Ms <= budgetMs, `compact projection p95 ${result.p95Ms}ms > ${budgetMs}ms`);
} finally {
  await fx.dispose();
}
