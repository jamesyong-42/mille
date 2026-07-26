import { removeTempDir } from '../../../scripts/test-temp.mjs';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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

function fixture() {
  const sandbox = mkdtempSync(join(tmpdir(), 'mille-root-order-'));
  const roots = ['alpha', 'beta', 'gamma'].map((name) => join(sandbox, name));
  for (const root of roots) mkdirSync(root);
  return { sandbox, roots };
}

const settings = {
  ...DEFAULT_EXPLORER_SETTINGS,
  compactFolders: false,
};

function rootIds(snapshot) {
  return snapshot.roots().map((root) => root.id);
}

test('local root reorder is atomic, immutable, observable, and idempotent', async () => {
  const { sandbox, roots } = fixture();
  const fx = new FileExplorer({ roots, settings });
  try {
    await fx.populateFromRoots();
    const retained = fx.getSnapshot();
    const original = rootIds(retained);
    const reordered = [original[2], original[0], original[1]];
    let changes = 0;
    const subscription = fx.on('change:tree', () => {
      changes += 1;
    });

    const version = fx.reorderRoots(reordered);
    assert.equal(version, retained.treeVersion + 1);
    assert.deepEqual(rootIds(fx.getSnapshot()), reordered);
    assert.deepEqual(rootIds(retained), original);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(changes, 1);

    assert.equal(fx.reorderRoots(reordered), version);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(changes, 1);

    for (const invalid of [
      reordered.slice(0, 2),
      [reordered[0], reordered[0], reordered[2]],
      [reordered[0], reordered[1], 999_999],
    ]) {
      assert.throws(
        () => fx.reorderRoots(invalid),
        (error) => error?.code === 'EINVAL',
      );
      assert.equal(fx.getTreeVersion(), version);
      assert.deepEqual(rootIds(fx.getSnapshot()), reordered);
    }
    subscription.dispose();
  } finally {
    await fx.dispose();
    removeTempDir(sandbox);
  }
});

test('port root reorder synchronizes every attached immutable mirror before resolving', async () => {
  const { sandbox, roots } = fixture();
  const host = await createFileExplorerHost({ roots, settings });
  await host.local.populateFromRoots();
  const channelA = new MessageChannel();
  const channelB = new MessageChannel();
  host.attachPort(channelA.port1);
  host.attachPort(channelB.port1);
  const clientA = await connectFileExplorer(channelA.port2);
  const clientB = await connectFileExplorer(channelB.port2);
  try {
    const retained = clientB.getSnapshot();
    const original = rootIds(retained);
    const reordered = [original[1], original[2], original[0]];

    const version = await clientA.reorderRoots(reordered);
    assert.equal(clientA.getSnapshot().treeVersion, version);
    assert.equal(clientB.getSnapshot().treeVersion, version);
    assert.deepEqual(rootIds(clientA.getSnapshot()), reordered);
    assert.deepEqual(rootIds(clientB.getSnapshot()), reordered);
    assert.deepEqual(rootIds(retained), original);

    await assert.rejects(
      clientB.reorderRoots([reordered[0], reordered[0], reordered[2]]),
      (error) => error?.code === 'EINVAL',
    );
    assert.equal(clientA.getSnapshot().treeVersion, version);
    assert.deepEqual(rootIds(clientA.getSnapshot()), reordered);
  } finally {
    await clientA.dispose();
    await clientB.dispose();
    await host.dispose();
    removeTempDir(sandbox);
  }
});
