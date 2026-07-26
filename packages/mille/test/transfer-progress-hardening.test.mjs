import { removeTempDir } from '../../../scripts/test-temp.mjs';
import { strict as assert } from 'node:assert';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MessageChannel } from 'node:worker_threads';

import {
  connectFileExplorer,
  createFileExplorerHost,
  DEFAULT_EXPLORER_SETTINGS,
  FileExplorer,
} from '../dist/index.js';

const settings = {
  ...DEFAULT_EXPLORER_SETTINGS,
  compactFolders: false,
};

function parseDetail(detail) {
  return JSON.parse(detail);
}

test('P0: cancelling overwrite preserves the original destination', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'mille-overwrite-stage-'));
  const workspace = join(sandbox, 'workspace');
  const external = join(sandbox, 'external');
  mkdirSync(join(workspace, 'inbox', 'bundle'), { recursive: true });
  mkdirSync(join(external, 'bundle'), { recursive: true });
  writeFileSync(join(workspace, 'inbox', 'bundle', 'keep.txt'), 'ORIGINAL');
  for (let i = 0; i < 200; i += 1) {
    writeFileSync(join(external, 'bundle', `f-${i}.txt`), `new-${i}`);
  }
  writeFileSync(join(external, 'bundle', 'keep.txt'), 'REPLACEMENT');

  const fx = new FileExplorer({ roots: [workspace], settings, watchDebounceMs: 60_000 });
  try {
    await fx.populateFromRoots();
    const inbox = await fx.resolvePath(join(workspace, 'inbox'));
    assert.ok(inbox !== null);
    const operationId = 'op-overwrite-cancel';
    let cancelled = false;
    const sub = fx.on('warning', (payload) => {
      if (payload?.code === 'OP_PROGRESS' && !cancelled) {
        cancelled = true;
        assert.equal(fx.cancelOperation(operationId), true);
      }
    });
    try {
      await assert.rejects(
        fx.copyFromPath(join(external, 'bundle'), inbox, 'bundle', {
          operationId,
          collision: 'overwrite',
          reportProgress: true,
        }),
        (error) => error?.code === 'ECANCELED',
      );
    } finally {
      sub.dispose();
    }
    assert.equal(cancelled, true);
    assert.equal(
      readFileSync(join(workspace, 'inbox', 'bundle', 'keep.txt'), 'utf8'),
      'ORIGINAL',
      'original destination content must survive cancelled overwrite',
    );
    assert.equal(existsSync(join(workspace, 'inbox', 'bundle', 'f-0.txt')), false);
  } finally {
    await fx.dispose();
    removeTempDir(sandbox);
  }
});

test('P1: reportProgress false suppresses OP_PROGRESS but still completes', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'mille-report-progress-'));
  const workspace = join(sandbox, 'workspace');
  const external = join(sandbox, 'external');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(external, 'bundle'), { recursive: true });
  for (let i = 0; i < 32; i += 1) {
    writeFileSync(join(external, 'bundle', `f-${i}.txt`), `${i}`);
  }
  const fx = new FileExplorer({ roots: [workspace], settings, watchDebounceMs: 60_000 });
  const codes = [];
  const sub = fx.on('warning', (payload) => {
    if (typeof payload?.code === 'string' && payload.code.startsWith('OP_')) {
      codes.push(payload.code);
    }
  });
  try {
    await fx.populateFromRoots();
    const rootId = await fx.resolvePath(workspace);
    await fx.copyFromPath(join(external, 'bundle'), rootId, undefined, {
      operationId: 'op-silent',
      reportProgress: false,
    });
    assert.deepEqual(codes, ['OP_COMPLETE']);
  } finally {
    sub.dispose();
    await fx.dispose();
    removeTempDir(sandbox);
  }
});

test('P1: duplicate operationId is rejected', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'mille-dup-op-'));
  const workspace = join(sandbox, 'workspace');
  const external = join(sandbox, 'external');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(external, 'bundle'), { recursive: true });
  for (let i = 0; i < 80; i += 1) {
    writeFileSync(join(external, 'bundle', `f-${i}.txt`), `${i}`);
  }
  const fx = new FileExplorer({ roots: [workspace], settings, watchDebounceMs: 60_000 });
  try {
    await fx.populateFromRoots();
    const rootId = await fx.resolvePath(workspace);
    let firstStarted = false;
    const started = new Promise((resolve) => {
      const sub = fx.on('warning', (payload) => {
        if (payload?.code === 'OP_PROGRESS' && !firstStarted) {
          firstStarted = true;
          sub.dispose();
          resolve(undefined);
        }
      });
    });
    const first = fx.copyFromPath(join(external, 'bundle'), rootId, 'a', {
      operationId: 'same-id',
      reportProgress: true,
    });
    await started;
    await assert.rejects(
      fx.copyFromPath(join(external, 'bundle'), rootId, 'b', {
        operationId: 'same-id',
        reportProgress: true,
      }),
      (error) => error?.code === 'EINVAL',
    );
    await first;
  } finally {
    await fx.dispose();
    removeTempDir(sandbox);
  }
});

test('P1: merge completion reports done equal to total', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'mille-merge-total-'));
  const workspace = join(sandbox, 'workspace');
  mkdirSync(join(workspace, 'inbox', 'bundle'), { recursive: true });
  mkdirSync(join(workspace, 'src', 'bundle'), { recursive: true });
  writeFileSync(join(workspace, 'inbox', 'bundle', 'a.txt'), 'old-a');
  writeFileSync(join(workspace, 'inbox', 'bundle', 'keep.txt'), 'keep');
  writeFileSync(join(workspace, 'src', 'bundle', 'a.txt'), 'new-a');
  writeFileSync(join(workspace, 'src', 'bundle', 'b.txt'), 'new-b');
  const fx = new FileExplorer({ roots: [workspace], settings, watchDebounceMs: 60_000 });
  let complete = null;
  const sub = fx.on('warning', (payload) => {
    if (payload?.code === 'OP_COMPLETE') complete = parseDetail(payload.detail);
  });
  try {
    await fx.populateFromRoots();
    const source = await fx.resolvePath(join(workspace, 'src', 'bundle'));
    const inbox = await fx.resolvePath(join(workspace, 'inbox'));
    await fx.copy(source, inbox, undefined, {
      collision: 'merge',
      operationId: 'op-merge-total',
      reportProgress: true,
    });
    assert.ok(complete);
    assert.equal(complete.status, 'completed');
    assert.equal(complete.done, complete.total);
  } finally {
    sub.dispose();
    await fx.dispose();
    removeTempDir(sandbox);
  }
});

test('P1: port clients receive OP_PROGRESS warnings', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'mille-port-progress-'));
  const workspace = join(sandbox, 'workspace');
  const external = join(sandbox, 'external');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(external, 'bundle'), { recursive: true });
  for (let i = 0; i < 40; i += 1) {
    writeFileSync(join(external, 'bundle', `f-${i}.txt`), `${i}`);
  }
  const host = await createFileExplorerHost({ roots: [workspace], settings });
  await host.local.populateFromRoots();
  const channel = new MessageChannel();
  host.attachPort(channel.port1);
  const client = await connectFileExplorer(channel.port2);
  const remoteCodes = [];
  const sub = client.on('warning', (payload) => {
    if (typeof payload?.code === 'string') remoteCodes.push(payload.code);
  });
  try {
    const rootId = await client.resolvePath(workspace);
    await client.copyFromPath(join(external, 'bundle'), rootId, undefined, {
      operationId: 'op-port-progress',
      reportProgress: true,
    });
    // Allow warning frames to drain.
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(remoteCodes.includes('OP_PROGRESS'), `got ${JSON.stringify(remoteCodes)}`);
    assert.ok(remoteCodes.includes('OP_COMPLETE'), `got ${JSON.stringify(remoteCodes)}`);
  } finally {
    sub.dispose();
    await client.dispose();
    channel.port1.close();
    channel.port2.close();
    await host.dispose();
    removeTempDir(sandbox);
  }
});

test('P2: port cancelOperation returns false for missing ids', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'mille-port-cancel-'));
  const workspace = join(sandbox, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const host = await createFileExplorerHost({ roots: [workspace], settings });
  await host.local.populateFromRoots();
  const channel = new MessageChannel();
  host.attachPort(channel.port1);
  const client = await connectFileExplorer(channel.port2);
  try {
    const result = await client.cancelOperation('missing-op');
    assert.equal(result, false);
  } finally {
    await client.dispose();
    channel.port1.close();
    channel.port2.close();
    await host.dispose();
    removeTempDir(sandbox);
  }
});
