import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { buildIdentity, DEFAULT_EXPLORER_SETTINGS, FileExplorer } from '../dist/index.js';

const entries = Number(process.env.MILLE_CROSS_ROOT_ENTRIES ?? 8_192);
const samples = Number(process.env.MILLE_CROSS_ROOT_SAMPLES ?? 30);
const warmups = Number(process.env.MILLE_CROSS_ROOT_WARMUPS ?? 5);
const p95BudgetMs = Number(process.env.MILLE_CROSS_ROOT_P95_BUDGET_MS ?? 16);
const sandbox = mkdtempSync(join(tmpdir(), 'mille-cross-root-bench-'));
const rootA = join(sandbox, 'root-a');
const rootB = join(sandbox, 'root-b');
const payload = join(rootA, 'payload');
mkdirSync(payload, { recursive: true });
mkdirSync(rootB);
for (let index = 0; index < entries; index += 1) {
  writeFileSync(join(payload, `file-${String(index).padStart(5, '0')}.txt`), '');
}

const fx = new FileExplorer({
  roots: [rootA, rootB],
  settings: { ...DEFAULT_EXPLORER_SETTINGS, compactFolders: false },
});

function percentile(values, p) {
  return values[Math.min(values.length - 1, Math.floor(values.length * p))];
}

function summarize(values) {
  values.sort((a, b) => a - b);
  return {
    medianMs: Number(percentile(values, 0.5).toFixed(3)),
    p95Ms: Number(percentile(values, 0.95).toFixed(3)),
    maxMs: Number(values.at(-1).toFixed(3)),
  };
}

try {
  await fx.populateFromRoots();
  const payloadId = await fx.resolvePath(payload);
  const rootAId = await fx.resolvePath(rootA);
  const rootBId = await fx.resolvePath(rootB);
  assert.ok(payloadId !== null && rootAId !== null && rootBId !== null);
  const timings = [];

  for (let sample = 0; sample < samples + warmups; sample += 1) {
    const destination = sample % 2 === 0 ? rootBId : rootAId;
    const destinationPath = sample % 2 === 0 ? rootB : rootA;
    const started = performance.now();
    const moved = await fx.move(payloadId, destination, undefined, {
      crossRoot: true,
    });
    const elapsed = performance.now() - started;
    assert.equal(moved.id, payloadId);
    assert.equal(moved.parentId, destination);
    assert.equal(await fx.resolvePath(join(destinationPath, 'payload')), payloadId);
    if (sample >= warmups) timings.push(elapsed);
  }

  const result = {
    identity: buildIdentity(),
    indexedEntries: entries + 3,
    samples,
    move: summarize(timings),
    p95BudgetMs,
  };
  console.log(JSON.stringify(result));
  assert.ok(
    result.move.p95Ms <= p95BudgetMs,
    `cross-root move p95 ${result.move.p95Ms}ms > ${p95BudgetMs}ms`,
  );
} finally {
  await fx.dispose();
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
