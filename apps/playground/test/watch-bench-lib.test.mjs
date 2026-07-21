import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildOperationPlan,
  executeOperation,
  parseBuildIdentity,
  summarizeLatencies,
} from '../scripts/watch-bench-lib.mjs';

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
  };
  assert.deepEqual(parseBuildIdentity(JSON.stringify(identity)), identity);
  assert.equal(parseBuildIdentity('not-json'), null);
  assert.equal(parseBuildIdentity(JSON.stringify({ packageVersion: '0.1.0' })), null);
  assert.equal(parseBuildIdentity(undefined), null);
});
