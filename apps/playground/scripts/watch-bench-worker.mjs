import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';

import {
  buildOperationPlan,
  executeOperation,
  parseBuildIdentity,
  summarizeLatencies,
} from './watch-bench-lib.mjs';
import { evaluateRenderQuality } from './watch-bench-render-lib.mjs';

const root = process.env.MILLE_WATCH_BENCH_ROOT;
const reportPath = process.env.MILLE_WATCH_BENCH_REPORT;
const operations = Number(process.env.MILLE_WATCH_BENCH_OPERATIONS ?? 240);
const seedFiles = Number(process.env.MILLE_WATCH_BENCH_SEED_FILES ?? 0);
const pauseMs = Number(process.env.MILLE_WATCH_BENCH_PAUSE_MS ?? 0);
const timeoutMs = Number(process.env.MILLE_WATCH_BENCH_TIMEOUT_MS ?? 5_000);
const budgets = {
  maxPaintP95Ms: Number(process.env.MILLE_WATCH_BENCH_MAX_PAINT_P95_MS ?? 150),
  maxReactP95Ms: Number(process.env.MILLE_WATCH_BENCH_MAX_REACT_P95_MS ?? 25),
  maxFrameIntervalMs: Number(process.env.MILLE_WATCH_BENCH_MAX_FRAME_INTERVAL_MS ?? 50),
};

if (!root || !reportPath) {
  throw new Error('watch benchmark worker requires root and report paths');
}

const observations = new Map();
const waiters = new Map();

process.parentPort.on('message', (event) => {
  const message = event.data;
  if (message?.type !== 'observed') return;
  const resolve = waiters.get(message.observation.id);
  if (resolve) {
    waiters.delete(message.observation.id);
    resolve(message.observation);
  } else {
    observations.set(message.observation.id, message.observation);
  }
});

function post(message) {
  process.parentPort.postMessage(message);
}

function waitForObservation(id) {
  const early = observations.get(id);
  if (early) {
    observations.delete(id);
    return Promise.resolve(early);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(id);
      reject(new Error(`operation ${id} was not reflected within ${timeoutMs}ms`));
    }, timeoutMs);
    waiters.set(id, (observation) => {
      clearTimeout(timer);
      resolve(observation);
    });
  });
}

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

async function run() {
  const plan = buildOperationPlan(operations);
  const planHash = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
  const completed = [];
  const failed = [];

  // Prove the watcher → host → renderer path is live before starting the
  // clock. FSEvents and the roots-only expansion can both have cold-start
  // latency that should not turn the first measured mutation into a miss.
  const warmups = [
    {
      id: -2,
      kind: 'warmup-create',
      label: 'warming watcher (create)',
      action: { type: 'write', path: '__mille_watch_bench_warmup__.txt', contents: 'warmup' },
      expectation: {
        present: [{ name: '__mille_watch_bench_warmup__.txt', kind: 0, size: 6 }],
        absent: [],
      },
    },
    {
      id: -1,
      kind: 'warmup-delete',
      label: 'warming watcher (delete)',
      action: { type: 'remove', path: '__mille_watch_bench_warmup__.txt', recursive: false },
      expectation: { present: [], absent: ['__mille_watch_bench_warmup__.txt'] },
    },
  ];
  for (const operation of warmups) {
    await executeOperation(root, operation);
    const completedAt = performance.timeOrigin + performance.now();
    const observationPromise = waitForObservation(operation.id);
    post({ type: 'issued', operation, completedAt, warmup: true });
    try {
      await observationPromise;
    } catch (error) {
      post({ type: 'timeout', operation, timeoutMs, warmup: true });
      throw error;
    }
  }

  const startedAt = performance.timeOrigin + performance.now();

  for (const operation of plan) {
    await executeOperation(root, operation);
    const completedAt = performance.timeOrigin + performance.now();
    const observationPromise = waitForObservation(operation.id);
    post({ type: 'issued', operation, completedAt });
    try {
      completed.push(await observationPromise);
    } catch (error) {
      failed.push({ id: operation.id, kind: operation.kind, message: String(error) });
      post({ type: 'timeout', operation, timeoutMs });
    }
    await sleep(pauseMs);
  }

  const finishedAt = performance.timeOrigin + performance.now();
  const durationMs = finishedAt - startedAt;
  const summaryWithoutGate = {
    count: completed.length,
    failed: failed.length,
    durationMs,
    operationsPerSecond: durationMs > 0 ? completed.length / (durationMs / 1_000) : 0,
    mirror: summarizeLatencies(completed.map((item) => item.mirrorLatencyMs)),
    commit: summarizeLatencies(completed.map((item) => item.commitLatencyMs)),
    reactDuration: summarizeLatencies(completed.map((item) => item.reactDurationMs)),
    paint: summarizeLatencies(completed.map((item) => item.paintLatencyMs)),
    commitToPaint: summarizeLatencies(completed.map((item) => item.commitToPaintMs)),
    frameInterval: summarizeLatencies(completed.map((item) => item.frameIntervalMs)),
  };
  const summary = {
    ...summaryWithoutGate,
    qualityGate: evaluateRenderQuality(summaryWithoutGate, budgets),
  };
  const report = {
    generatedAt: new Date().toISOString(),
    buildIdentity: parseBuildIdentity(process.env.MILLE_BUILD_IDENTITY_JSON),
    environment: {
      node: process.version,
      electron: process.versions.electron ?? null,
      chrome: process.versions.chrome ?? null,
      platform: process.platform,
      arch: process.arch,
    },
    root,
    requestedOperations: operations,
    reference: { seedFiles },
    pauseMs,
    timeoutMs,
    budgets,
    planHash,
    plan,
    summary,
    failed,
    observations: completed,
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `complete: ${summary.count}/${operations} observed, ${summary.failed} missed, ` +
      `mirror p50=${summary.mirror.p50.toFixed(1)}ms p95=${summary.mirror.p95.toFixed(1)}ms, ` +
      `paint p50=${summary.paint.p50.toFixed(1)}ms p95=${summary.paint.p95.toFixed(1)}ms, ` +
      `React p95=${summary.reactDuration.p95.toFixed(1)}ms, ` +
      `${summary.operationsPerSecond.toFixed(1)} ops/s`,
  );
  if (!summary.qualityGate.passed) {
    console.error(`quality gate failed: ${summary.qualityGate.violations.join('; ')}`);
  }
  post({ type: 'complete', summary, reportPath });
}

run().catch((error) => {
  post({
    type: 'fatal',
    message: error instanceof Error ? (error.stack ?? error.message) : String(error),
  });
  process.exitCode = 1;
});
