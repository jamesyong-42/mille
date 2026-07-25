#!/usr/bin/env node

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';

import {
  buildOperationPlan,
  executeOperation,
  probeWatcherEnvironment,
  summarizeLatencies,
} from '../../../apps/playground/scripts/watch-bench-lib.mjs';
import { buildIdentity, FileExplorer } from '../dist/index.js';
import { snapshotEntries, summarizeByKind, waitForExpectation } from './watch-soak-lib.mjs';

function numberOption(args, name, fallback, { min = 0 } = {}) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(args[index + 1]);
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`${name} requires a number >= ${min}`);
  }
  return value;
}

function stringOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

async function runObservedOperation(fx, root, operation, options) {
  await executeOperation(root, operation);
  const completedAt = performance.now();
  const expectation = await waitForExpectation(fx, operation.expectation, options);
  const latencyMs = performance.now() - completedAt;
  return { expectation, latencyMs };
}

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(`Usage: node bench/watch-soak.mjs [options]

Options:
  --operations N  Deterministic mixed operations (default 1000)
  --debounce MS   Native watcher debounce (default 40)
  --timeout MS    Per-operation convergence timeout (default 3000)
  --poll MS       Snapshot polling interval (default 5)
  --pause MS      Pause after each operation (default 0)
  --max-p95 MS    Fail when observed p95 exceeds this budget (default 150)
  --report PATH   Write the complete JSON report
  --keep          Preserve the temporary workspace
`);
  process.exit(0);
}

const options = {
  operations: Math.floor(numberOption(args, '--operations', 1_000, { min: 1 })),
  debounceMs: Math.floor(numberOption(args, '--debounce', 40)),
  timeoutMs: Math.floor(numberOption(args, '--timeout', 3_000, { min: 100 })),
  pollMs: Math.floor(numberOption(args, '--poll', 5, { min: 1 })),
  pauseMs: Math.floor(numberOption(args, '--pause', 0)),
  maxP95Ms: numberOption(args, '--max-p95', 150, { min: 1 }),
  reportPath: stringOption(args, '--report'),
  keep: args.includes('--keep'),
};

const sandbox = await mkdtemp(join(tmpdir(), 'mille-watch-soak-'));
const identity = buildIdentity();
const plan = buildOperationPlan(options.operations);
const planHash = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
const eventCounts = { events: 0, batches: 0, treeChanges: 0, byKind: {} };
const eventLog = [];
const observations = [];
const failures = [];
let fx = null;
let exitCode = 0;

try {
  const preflight = await probeWatcherEnvironment(sandbox);
  console.log('[mille watch soak] build', JSON.stringify(identity));
  console.log('[mille watch soak] preflight', JSON.stringify(preflight));
  console.log(
    `[mille watch soak] operations=${options.operations} debounce=${options.debounceMs}ms ` +
      `timeout=${options.timeoutMs}ms max-p95=${options.maxP95Ms}ms plan=${planHash.slice(0, 12)}`,
  );

  if (!preflight.ok) {
    console.error(
      `[mille watch soak] watcher environment unavailable (${preflight.code}): ${preflight.message}`,
    );
    process.exitCode = 2;
  } else {
    fx = new FileExplorer({ roots: [sandbox], watchDebounceMs: options.debounceMs });
    const subscriptions = [
      fx.on('event', (event) => {
        eventCounts.events += 1;
        const kind = String(event.kind);
        eventCounts.byKind[kind] = (eventCounts.byKind[kind] ?? 0) + 1;
        eventLog.push({
          atMs: performance.now(),
          kind,
          path: event.path ?? null,
          oldName: event.oldName ?? null,
          newName: event.newName ?? null,
          id: event.id ?? null,
        });
      }),
      fx.on('batch', () => {
        eventCounts.batches += 1;
      }),
      fx.on('change:tree', () => {
        eventCounts.treeChanges += 1;
      }),
    ];

    try {
      await fx.populateFromRoots();
      const warmups = [
        {
          id: -2,
          kind: 'warmup-create',
          action: { type: 'write', path: '__warmup__.txt', contents: 'warmup' },
          expectation: { present: [{ name: '__warmup__.txt', kind: 0, size: 6 }], absent: [] },
        },
        {
          id: -1,
          kind: 'warmup-delete',
          action: { type: 'remove', path: '__warmup__.txt', recursive: false },
          expectation: { present: [], absent: ['__warmup__.txt'] },
        },
      ];
      for (const operation of warmups) {
        const result = await runObservedOperation(fx, sandbox, operation, options);
        if (!result.expectation.ok) {
          throw new Error(
            `watcher warmup failed for ${operation.kind}: ${JSON.stringify(result.expectation)}`,
          );
        }
      }

      const startedAt = performance.now();
      for (const operation of plan) {
        try {
          const result = await runObservedOperation(fx, sandbox, operation, options);
          if (result.expectation.ok) {
            observations.push({
              id: operation.id,
              kind: operation.kind,
              latencyMs: result.latencyMs,
            });
          } else {
            failures.push({
              id: operation.id,
              kind: operation.kind,
              latencyMs: result.latencyMs,
              ...result.expectation,
              snapshot: snapshotEntries(fx.getSnapshot()).map((entry) => ({
                id: entry.id,
                parentId: entry.parentId,
                name: entry.name,
                kind: entry.kind,
                size: entry.size,
              })),
            });
          }
        } catch (error) {
          failures.push({
            id: operation.id,
            kind: operation.kind,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        await sleep(options.pauseMs);
      }
      const durationMs = performance.now() - startedAt;
      const latency = summarizeLatencies(observations.map((item) => item.latencyMs));
      const summary = {
        requested: options.operations,
        observed: observations.length,
        failed: failures.length,
        durationMs,
        operationsPerSecond: observations.length / (durationMs / 1_000),
        latency,
        byKind: summarizeByKind(observations),
        eventCounts,
      };
      const report = {
        generatedAt: new Date().toISOString(),
        buildIdentity: identity,
        environment: {
          node: process.version,
          platform: process.platform,
          arch: process.arch,
        },
        options,
        planHash,
        preflight,
        summary,
        eventLog,
        failures,
        observations,
      };

      console.log(
        `[mille watch soak] ${summary.observed}/${summary.requested} observed, ` +
          `${summary.failed} missed, p50=${latency.p50.toFixed(1)}ms ` +
          `p95=${latency.p95.toFixed(1)}ms p99=${latency.p99.toFixed(1)}ms ` +
          `max=${latency.max.toFixed(1)}ms ${summary.operationsPerSecond.toFixed(1)} ops/s`,
      );
      console.log('[mille watch soak] by kind', JSON.stringify(summary.byKind));
      console.log('[mille watch soak] events', JSON.stringify(eventCounts));

      if (options.reportPath) {
        const reportPath = isAbsolute(options.reportPath)
          ? options.reportPath
          : resolve(process.cwd(), options.reportPath);
        await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
        console.log(`[mille watch soak] report ${reportPath}`);
      }

      if (failures.length > 0) exitCode = 1;
      if (latency.p95 > options.maxP95Ms) {
        console.error(
          `[mille watch soak] p95 ${latency.p95.toFixed(1)}ms exceeds ${options.maxP95Ms}ms budget`,
        );
        exitCode = 1;
      }
    } finally {
      for (const subscription of subscriptions) subscription.dispose();
    }
  }
} catch (error) {
  console.error(
    '[mille watch soak]',
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  exitCode = 1;
} finally {
  await fx?.dispose();
  if (options.keep) console.log(`[mille watch soak] preserved workspace ${sandbox}`);
  else await rm(sandbox, { recursive: true, force: true });
}

if (process.exitCode !== 2) process.exitCode = exitCode;
