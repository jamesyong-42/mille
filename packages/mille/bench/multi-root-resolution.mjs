import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { DEFAULT_EXPLORER_SETTINGS, FileExplorer } from '../dist/index.js';

const samples = Number(process.env.MILLE_MULTI_ROOT_SAMPLES ?? 500);
const p95BudgetMs = Number(process.env.MILLE_MULTI_ROOT_P95_BUDGET_MS ?? 5);
const sandbox = mkdtempSync(join(tmpdir(), 'mille-multi-root-bench-'));
const left = join(sandbox, 'left', 'workspace');
const right = join(sandbox, 'right', 'workspace');
mkdirSync(left, { recursive: true });
mkdirSync(right, { recursive: true });
writeFileSync(join(left, 'left-only.txt'), '');
writeFileSync(join(right, 'right-only.txt'), '');

const fx = new FileExplorer({
  roots: [left, right],
  settings: { ...DEFAULT_EXPLORER_SETTINGS, compactFolders: false },
});

function percentile(values, p) {
  return values[Math.min(values.length - 1, Math.floor(values.length * p))];
}

try {
  await fx.populateFromRoots();
  const leftRoot = await fx.getByUri({ scheme: 'file', path: left });
  const rightRoot = await fx.getByUri({ scheme: 'file', path: right });
  assert.ok(leftRoot && rightRoot);
  const timings = [];

  for (let sample = 0; sample < samples + 20; sample++) {
    const root = sample % 2 === 0 ? leftRoot : rightRoot;
    const expected = sample % 2 === 0 ? 'left-only.txt' : 'right-only.txt';
    const start = performance.now();
    const page = await fx.list(root.id, { depth: 1 });
    const elapsed = performance.now() - start;
    assert.deepEqual(
      page.entries.map((entry) => entry.name),
      [expected],
    );
    if (sample >= 20) timings.push(elapsed);
  }

  timings.sort((a, b) => a - b);
  const result = {
    roots: 2,
    duplicateBasename: 'workspace',
    samples,
    medianMs: Number(percentile(timings, 0.5).toFixed(3)),
    p95Ms: Number(percentile(timings, 0.95).toFixed(3)),
    maxMs: Number(timings.at(-1).toFixed(3)),
    p95BudgetMs,
  };
  console.log(JSON.stringify(result));
  assert.ok(
    result.p95Ms <= p95BudgetMs,
    `same-basename root list p95 ${result.p95Ms}ms > ${p95BudgetMs}ms`,
  );
} finally {
  await fx.dispose();
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
