import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { buildIdentity, DEFAULT_EXPLORER_SETTINGS, FileExplorer } from '../dist/index.js';

const samples = Number(process.env.MILLE_COLLISION_SAMPLES ?? 40);
const warmups = Number(process.env.MILLE_COLLISION_WARMUPS ?? 5);
const p95BudgetMs = Number(process.env.MILLE_COLLISION_P95_BUDGET_MS ?? 5);

const sandbox = mkdtempSync(join(tmpdir(), 'mille-collision-bench-'));
const root = join(sandbox, 'workspace');
mkdirSync(join(root, 'inbox'), { recursive: true });
mkdirSync(join(root, 'src'), { recursive: true });
writeFileSync(join(root, 'inbox', 'note.txt'), 'destination');
writeFileSync(join(root, 'src', 'note.txt'), 'source');

const fx = new FileExplorer({
  roots: [root],
  settings: { ...DEFAULT_EXPLORER_SETTINGS, compactFolders: false },
  watchDebounceMs: 60_000,
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
  const source = await fx.resolvePath(join(root, 'src', 'note.txt'));
  const inbox = await fx.resolvePath(join(root, 'inbox'));
  assert.ok(source !== null && inbox !== null);

  const skipTimings = [];
  const overwriteTimings = [];

  for (let sample = 0; sample < samples + warmups; sample += 1) {
    writeFileSync(join(root, 'inbox', 'note.txt'), 'destination');
    await fx.resync(inbox, { recursive: false });

    const startedSkip = performance.now();
    const skipped = await fx.copy(source, inbox, undefined, { collision: 'skip' });
    const skipElapsed = performance.now() - startedSkip;
    assert.equal(skipped.name, 'note.txt');
    assert.equal(readFileSync(join(root, 'inbox', 'note.txt'), 'utf8'), 'destination');
    if (sample >= warmups) skipTimings.push(skipElapsed);

    const startedOverwrite = performance.now();
    const overwritten = await fx.copy(source, inbox, undefined, { collision: 'overwrite' });
    const overwriteElapsed = performance.now() - startedOverwrite;
    assert.equal(overwritten.name, 'note.txt');
    assert.equal(readFileSync(join(root, 'inbox', 'note.txt'), 'utf8'), 'source');
    if (sample >= warmups) overwriteTimings.push(overwriteElapsed);
  }

  const result = {
    identity: buildIdentity(),
    samples,
    skip: summarize(skipTimings),
    overwrite: summarize(overwriteTimings),
    p95BudgetMs,
  };
  console.log(JSON.stringify(result));
  assert.ok(result.skip.p95Ms <= p95BudgetMs, `skip p95 ${result.skip.p95Ms}ms > ${p95BudgetMs}ms`);
  assert.ok(
    result.overwrite.p95Ms <= p95BudgetMs,
    `overwrite p95 ${result.overwrite.p95Ms}ms > ${p95BudgetMs}ms`,
  );
} finally {
  await fx.dispose();
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
