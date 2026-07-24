// Phase 6.1 microbench — memfs seed + refresh + watcher convergence.
// Fails the process if budgets are exceeded (CI gate).

import { performance } from 'node:perf_hooks';

const {
  createMemoryFileSystemProvider,
  createProviderTreeSession,
  createUri,
  withLatency,
} = await import('../dist/provider.js');

const N = 2_000;
const WRITE_BURST = 100;

// Remote-like walk probe. 6 directories × 4 files = 38 provider calls; at
// LAT_MS each, a strictly serial walk costs ~190 ms, so the budget below
// fails if the walk stops overlapping calls.
const LAT_DIRS = 6;
const LAT_FILES = 4;
const LAT_MS = 5;

// Budgets (ms) — generous enough for CI noise, tight enough to catch regressions.
const BUDGET = {
  seedMs: 80,
  refreshMs: 120,
  flattenMs: 40,
  writeBurstMs: 80,
  watcherConvergenceMs: 200,
  maxWatcherNotifications: 8,
  latencyWalkMs: 120,
};

const files = {};
for (let i = 0; i < N; i += 1) {
  const dir = `d${i % 50}`;
  files[`/${dir}/f${i}.ts`] = `// ${i}\n`;
}

const t0 = performance.now();
const fs = createMemoryFileSystemProvider({ files });
const t1 = performance.now();

const session = createProviderTreeSession(fs, createUri('memfs', '/'), {
  debounceMs: 8,
});
const snap = await session.refresh();
const t2 = performance.now();

const expanded = new Set();
function walk(n) {
  expanded.add(n.entry.id);
  for (const c of n.children) walk(c);
}
walk(snap.root);
const rows = snap.flatten(expanded);
const t3 = performance.now();

let notifications = 0;
session.onDidChange(() => {
  notifications += 1;
});

const t4 = performance.now();
for (let i = 0; i < WRITE_BURST; i += 1) {
  await fs.writeFile(
    createUri('memfs', `/d0/extra-${i}.ts`),
    new TextEncoder().encode('x'),
  );
}
const t5 = performance.now();

// Wait for watcher debounce + trailing single-flight refresh.
const convergeStart = performance.now();
const deadline = convergeStart + 2_000;
while (performance.now() < deadline) {
  await new Promise((r) => setTimeout(r, 10));
  // After quiet period with no new writes, one more beat for trailing refresh.
  if (notifications >= 1 && performance.now() - t5 > 50) break;
}
const t6 = performance.now();

const latencyFiles = {};
for (let d = 0; d < LAT_DIRS; d += 1) {
  for (let f = 0; f < LAT_FILES; f += 1) {
    latencyFiles[`/l${d}/f${f}.ts`] = 'x';
  }
}
const latencySession = createProviderTreeSession(
  withLatency(createMemoryFileSystemProvider({ files: latencyFiles }), {
    delayMs: LAT_MS,
  }),
  createUri('memfs', '/'),
  { debounceMs: 8 },
);
const t7 = performance.now();
await latencySession.refresh();
const t8 = performance.now();
latencySession.dispose();

const result = {
  seedFiles: N,
  seedMs: +(t1 - t0).toFixed(2),
  refreshMs: +(t2 - t1).toFixed(2),
  flatRows: rows.length,
  flattenMs: +(t3 - t2).toFixed(2),
  writeBurst: WRITE_BURST,
  writeBurstMs: +(t5 - t4).toFixed(2),
  watcherNotifications: notifications,
  watcherConvergenceMs: +(t6 - t5).toFixed(2),
  latencyWalkCalls: LAT_DIRS * (LAT_FILES + 2) + 2,
  latencyWalkMs: +(t8 - t7).toFixed(2),
};

console.log(JSON.stringify(result));

const failures = [];
if (result.seedMs > BUDGET.seedMs) {
  failures.push(`seedMs ${result.seedMs} > ${BUDGET.seedMs}`);
}
if (result.refreshMs > BUDGET.refreshMs) {
  failures.push(`refreshMs ${result.refreshMs} > ${BUDGET.refreshMs}`);
}
if (result.flattenMs > BUDGET.flattenMs) {
  failures.push(`flattenMs ${result.flattenMs} > ${BUDGET.flattenMs}`);
}
if (result.writeBurstMs > BUDGET.writeBurstMs) {
  failures.push(`writeBurstMs ${result.writeBurstMs} > ${BUDGET.writeBurstMs}`);
}
if (result.watcherConvergenceMs > BUDGET.watcherConvergenceMs) {
  failures.push(
    `watcherConvergenceMs ${result.watcherConvergenceMs} > ${BUDGET.watcherConvergenceMs}`,
  );
}
if (result.watcherNotifications > BUDGET.maxWatcherNotifications) {
  failures.push(
    `watcherNotifications ${result.watcherNotifications} > ${BUDGET.maxWatcherNotifications}`,
  );
}
if (result.watcherNotifications < 1) {
  failures.push('watcherNotifications expected ≥ 1');
}
if (result.latencyWalkMs > BUDGET.latencyWalkMs) {
  failures.push(
    `latencyWalkMs ${result.latencyWalkMs} > ${BUDGET.latencyWalkMs} (walk stopped overlapping provider calls?)`,
  );
}

session.dispose();

if (failures.length > 0) {
  console.error('BUDGET FAIL:', failures.join('; '));
  process.exitCode = 1;
}
