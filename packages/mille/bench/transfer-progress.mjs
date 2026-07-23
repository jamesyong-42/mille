import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { buildIdentity, DEFAULT_EXPLORER_SETTINGS, FileExplorer } from '../dist/index.js';

const files = Number(process.env.MILLE_TRANSFER_PROGRESS_FILES ?? 256);
const samples = Number(process.env.MILLE_TRANSFER_PROGRESS_SAMPLES ?? 12);
const warmups = Number(process.env.MILLE_TRANSFER_PROGRESS_WARMUPS ?? 2);
const p95BudgetMs = Number(process.env.MILLE_TRANSFER_PROGRESS_P95_BUDGET_MS ?? 250);

const sandbox = mkdtempSync(join(tmpdir(), 'mille-transfer-progress-bench-'));
const workspace = join(sandbox, 'workspace');
const external = join(sandbox, 'external', 'bundle');
mkdirSync(workspace, { recursive: true });
mkdirSync(external, { recursive: true });
for (let i = 0; i < files; i += 1) {
  writeFileSync(join(external, `f-${String(i).padStart(4, '0')}.txt`), `p${i}\n`);
}

const fx = new FileExplorer({
  roots: [workspace],
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
  const rootId = await fx.resolvePath(workspace);
  assert.ok(rootId !== null);
  const timings = [];
  let lastProgressCount = 0;

  for (let sample = 0; sample < samples + warmups; sample += 1) {
    const inboxName = `inbox-${sample}`;
    mkdirSync(join(workspace, inboxName), { recursive: true });
    await fx.resync(rootId, { recursive: false });
    const inboxId = await fx.resolvePath(join(workspace, inboxName));
    assert.ok(inboxId !== null);

    let progressEvents = 0;
    const sub = fx.on('warning', (payload) => {
      if (payload?.code === 'OP_PROGRESS') progressEvents += 1;
    });
    const started = performance.now();
    await fx.copyFromPath(external, inboxId, 'bundle', {
      operationId: `bench-${sample}`,
      reportProgress: true,
    });
    const elapsed = performance.now() - started;
    sub.dispose();
    assert.ok(progressEvents >= 1, 'expected progress events');
    lastProgressCount = progressEvents;
    if (sample >= warmups) timings.push(elapsed);
  }

  const result = {
    identity: buildIdentity(),
    files,
    samples,
    lastProgressCount,
    import: summarize(timings),
    p95BudgetMs,
  };
  console.log(JSON.stringify(result));
  assert.ok(
    result.import.p95Ms <= p95BudgetMs,
    `progress-aware import p95 ${result.import.p95Ms}ms > ${p95BudgetMs}ms`,
  );
} finally {
  await fx.dispose();
  rmSync(sandbox, { recursive: true, force: true });
}
