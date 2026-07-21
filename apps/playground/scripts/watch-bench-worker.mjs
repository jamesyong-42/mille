import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

import {
  buildOperationPlan,
  executeOperation,
  parseBuildIdentity,
  summarizeLatencies,
} from './watch-bench-lib.mjs';

const root = process.env.MILLE_WATCH_BENCH_ROOT;
const reportPath = process.env.MILLE_WATCH_BENCH_REPORT;
const operations = Number(process.env.MILLE_WATCH_BENCH_OPERATIONS ?? 240);
const pauseMs = Number(process.env.MILLE_WATCH_BENCH_PAUSE_MS ?? 0);
const timeoutMs = Number(process.env.MILLE_WATCH_BENCH_TIMEOUT_MS ?? 5_000);

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
    await observationPromise;
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
  const summary = {
    count: completed.length,
    failed: failed.length,
    durationMs,
    operationsPerSecond: durationMs > 0 ? completed.length / (durationMs / 1_000) : 0,
    mirror: summarizeLatencies(completed.map((item) => item.mirrorLatencyMs)),
    paint: summarizeLatencies(completed.map((item) => item.paintLatencyMs)),
  };
  const report = {
    generatedAt: new Date().toISOString(),
    buildIdentity: parseBuildIdentity(process.env.MILLE_BUILD_IDENTITY_JSON),
    root,
    requestedOperations: operations,
    pauseMs,
    timeoutMs,
    summary,
    failed,
    observations: completed,
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `complete: ${summary.count}/${operations} observed, ${summary.failed} missed, ` +
      `mirror p50=${summary.mirror.p50.toFixed(1)}ms p95=${summary.mirror.p95.toFixed(1)}ms, ` +
      `paint p50=${summary.paint.p50.toFixed(1)}ms p95=${summary.paint.p95.toFixed(1)}ms, ` +
      `${summary.operationsPerSecond.toFixed(1)} ops/s`,
  );
  post({ type: 'complete', summary, reportPath });
}

run().catch((error) => {
  post({
    type: 'fatal',
    message: error instanceof Error ? (error.stack ?? error.message) : String(error),
  });
  process.exitCode = 1;
});
