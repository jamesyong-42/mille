import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildOperationPlan,
  executeOperation,
  parseBuildIdentity,
  seedReferenceTree,
  summarizeLatencies,
} from '../scripts/watch-bench-lib.mjs';
import {
  benchmarkExitCode,
  createRenderObservation,
  createTreeCommit,
  evaluateRenderQuality,
  isCommitEligible,
} from '../scripts/watch-bench-render-lib.mjs';

test('operation plan covers every watcher mutation shape', () => {
  const plan = buildOperationPlan(12);
  assert.deepEqual(
    plan.map((operation) => operation.kind),
    [
      'mkdir',
      'create',
      'modify',
      'append',
      'rename-file',
      'copy',
      'delete-file',
      'mkdir-nested',
      'create-nested',
      'rename-directory',
      'rename-directory-tree',
      'delete-directory-tree',
    ],
  );
  assert.deepEqual(
    buildOperationPlan(14).map((operation) => operation.id),
    Array.from({ length: 14 }, (_, index) => index + 1),
  );
});

test('one complete operation cycle leaves the sandbox consistent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mille-watch-bench-test-'));
  try {
    const plan = buildOperationPlan(12);
    for (const operation of plan) await executeOperation(root, operation);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('operation payload sizes match watcher expectations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mille-watch-bench-size-'));
  try {
    const plan = buildOperationPlan(4);
    for (const operation of plan) await executeOperation(root, operation);
    const file = join(root, 'bench-dir-0001', 'created-0001.txt');
    assert.equal((await stat(file)).size, 640);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reference-tree seeding is deterministic and reports exact tree size', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mille-watch-bench-reference-'));
  try {
    assert.deepEqual(await seedReferenceTree(root, 5, { filesPerDirectory: 2 }), {
      files: 5,
      directories: 3,
      entries: 8,
    });
    assert.deepEqual(await readdir(root), ['reference-0001', 'reference-0002', 'reference-0003']);
    assert.deepEqual(await readdir(join(root, 'reference-0001')), [
      'reference-000001.txt',
      'reference-000002.txt',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('latency summary reports stable nearest-rank percentiles', () => {
  assert.deepEqual(summarizeLatencies([]), {
    min: 0,
    mean: 0,
    p50: 0,
    p95: 0,
    p99: 0,
    max: 0,
  });
  assert.deepEqual(summarizeLatencies([5, 1, 4, 2, 3]), {
    min: 1,
    mean: 3,
    p50: 3,
    p95: 5,
    p99: 5,
    max: 5,
  });
});

test('build identity parser accepts diagnostic payloads and rejects malformed input', () => {
  const identity = {
    packageVersion: '0.1.0',
    nativeVersion: '0.1.0',
    resolvedPath: '/tmp/mille.node',
    nativeProfile: 'debug',
    uiPackageVersion: '0.2.1',
  };
  assert.deepEqual(parseBuildIdentity(JSON.stringify(identity)), identity);
  assert.equal(parseBuildIdentity('not-json'), null);
  assert.equal(parseBuildIdentity(JSON.stringify({ packageVersion: '0.1.0' })), null);
  assert.equal(parseBuildIdentity(undefined), null);
});

test('render observation correlates an eligible React commit and two frame timestamps', () => {
  const commit = createTreeCommit(
    {
      phase: 'update',
      treeVersion: 42,
      actualDurationMs: 3,
      baseDurationMs: 12,
      startTimeMs: 25,
      commitTimeMs: 30,
    },
    1_000,
  );
  assert.equal(isCommitEligible(commit, 1_020, 42), true);
  assert.equal(isCommitEligible(commit, 1_031, 42), false);
  assert.equal(isCommitEligible(commit, 1_020, 43), false);
  assert.deepEqual(
    createRenderObservation({
      id: 7,
      kind: 'rename-directory',
      operationCompletedAt: 1_020,
      mirrorAt: 1_026,
      mirrorTreeVersion: 42,
      commit,
      firstFrameAt: 1_036,
      secondFrameAt: 1_052,
    }),
    {
      id: 7,
      kind: 'rename-directory',
      treeVersion: 42,
      mirrorLatencyMs: 6,
      commitLatencyMs: 10,
      reactDurationMs: 3,
      reactBaseDurationMs: 12,
      paintLatencyMs: 32,
      commitToPaintMs: 22,
      frameIntervalMs: 16,
      observedAt: 1_052,
    },
  );
});

test('render quality gate reports each exceeded correctness or smoothness budget', () => {
  const passing = {
    failed: 0,
    paint: { p95: 100 },
    reactDuration: { p95: 8 },
    frameInterval: { max: 20 },
  };
  const budgets = {
    maxPaintP95Ms: 150,
    maxReactP95Ms: 16,
    maxFrameIntervalMs: 50,
  };
  assert.deepEqual(evaluateRenderQuality(passing, budgets), {
    passed: true,
    violations: [],
  });

  const failed = evaluateRenderQuality(
    {
      failed: 2,
      paint: { p95: 151 },
      reactDuration: { p95: 17 },
      frameInterval: { max: 51 },
    },
    budgets,
  );
  assert.equal(failed.passed, false);
  assert.equal(failed.violations.length, 4);
});

test('automated benchmark exit status follows fatal and quality-gate outcomes', () => {
  assert.equal(benchmarkExitCode({ type: 'issued' }), null);
  assert.equal(benchmarkExitCode({ type: 'fatal' }), 1);
  assert.equal(
    benchmarkExitCode({ type: 'complete', summary: { qualityGate: { passed: true } } }),
    0,
  );
  assert.equal(
    benchmarkExitCode({ type: 'complete', summary: { qualityGate: { passed: false } } }),
    1,
  );
});
