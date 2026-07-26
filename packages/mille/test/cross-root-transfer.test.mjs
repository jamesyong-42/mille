import { removeTempDir } from '../../../scripts/test-temp.mjs';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function fixture() {
  const sandbox = mkdtempSync(join(tmpdir(), 'mille-cross-root-'));
  const rootA = join(sandbox, 'root-a');
  const rootB = join(sandbox, 'root-b');
  mkdirSync(join(rootA, 'left', 'folder'), { recursive: true });
  mkdirSync(join(rootA, 'right'), { recursive: true });
  mkdirSync(rootB);
  writeFileSync(join(rootA, 'left', 'shared.txt'), 'source');
  writeFileSync(join(rootA, 'left', 'folder', 'nested.txt'), 'nested');
  writeFileSync(join(rootB, 'shared.txt'), 'destination');
  return { sandbox, rootA, rootB };
}

async function idAt(fx, path) {
  const id = await fx.resolvePath(path);
  assert.ok(id !== null, `expected indexed path: ${path}`);
  return id;
}

test('cross-root transfer is opt-in and collisions never overwrite by default', async () => {
  const { sandbox, rootA, rootB } = fixture();
  const fx = new FileExplorer({ roots: [rootA, rootB], settings });
  try {
    await fx.populateFromRoots();
    const source = await idAt(fx, join(rootA, 'left', 'shared.txt'));
    const rootBId = await idAt(fx, rootB);
    const version = fx.getTreeVersion();

    for (const operation of ['move', 'copy']) {
      await assert.rejects(
        fx[operation](source, rootBId),
        (error) => error?.code === 'EUNSUPPORTED',
      );
      assert.equal(fx.getTreeVersion(), version);
      assert.equal(readFileSync(join(rootA, 'left', 'shared.txt'), 'utf8'), 'source');
      assert.equal(readFileSync(join(rootB, 'shared.txt'), 'utf8'), 'destination');
    }

    for (const operation of ['move', 'copy']) {
      await assert.rejects(
        fx[operation](source, rootBId, undefined, { crossRoot: true }),
        (error) => error?.code === 'EEXIST',
      );
      assert.equal(fx.getTreeVersion(), version);
      assert.equal(readFileSync(join(rootA, 'left', 'shared.txt'), 'utf8'), 'source');
      assert.equal(readFileSync(join(rootB, 'shared.txt'), 'utf8'), 'destination');
    }

    const copied = await fx.copy(source, rootBId, undefined, {
      crossRoot: true,
      collision: 'rename',
    });
    assert.equal(copied.name, 'shared copy.txt');
    assert.equal(readFileSync(join(rootB, 'shared copy.txt'), 'utf8'), 'source');
    assert.equal(copied.parentId, rootBId);

    const moved = await fx.move(source, rootBId, undefined, {
      crossRoot: true,
      collision: 'rename',
    });
    assert.equal(moved.id, source);
    assert.equal(moved.name, 'shared copy 2.txt');
    assert.equal(readFileSync(join(rootB, 'shared copy 2.txt'), 'utf8'), 'source');
  } finally {
    await fx.dispose();
    removeTempDir(sandbox);
  }
});

test('same-root and cross-root reparent preserve subtree identity atomically', async () => {
  const { sandbox, rootA, rootB } = fixture();
  const fx = new FileExplorer({ roots: [rootA, rootB], settings });
  try {
    await fx.populateFromRoots();
    const source = await idAt(fx, join(rootA, 'left', 'shared.txt'));
    const right = await idAt(fx, join(rootA, 'right'));
    const sameRootMoved = await fx.move(source, right);
    assert.equal(sameRootMoved.id, source);
    assert.equal(sameRootMoved.parentId, right);
    assert.equal(await fx.resolvePath(join(rootA, 'left', 'shared.txt')), null);
    assert.equal(await fx.resolvePath(join(rootA, 'right', 'shared.txt')), source);

    const folder = await idAt(fx, join(rootA, 'left', 'folder'));
    const nested = await idAt(fx, join(rootA, 'left', 'folder', 'nested.txt'));
    const rootBId = await idAt(fx, rootB);
    const retained = fx.getSnapshot();
    const moved = await fx.move(folder, rootBId, 'moved-folder', {
      crossRoot: true,
    });
    const current = fx.getSnapshot();
    assert.equal(moved.id, folder);
    assert.equal(moved.parentId, rootBId);
    assert.equal(current.getById(nested)?.parentId, folder);
    assert.equal(await fx.resolvePath(join(rootB, 'moved-folder')), folder);
    assert.equal(await fx.resolvePath(join(rootB, 'moved-folder', 'nested.txt')), nested);
    assert.equal(await fx.resolvePath(join(rootA, 'left', 'folder')), null);
    assert.ok(retained.getById(nested));
    assert.equal(readFileSync(join(rootB, 'moved-folder', 'nested.txt'), 'utf8'), 'nested');
  } finally {
    await fx.dispose();
    removeTempDir(sandbox);
  }
});

test('port cross-root move updates every mirror before resolving', async () => {
  const { sandbox, rootA, rootB } = fixture();
  const host = await createFileExplorerHost({ roots: [rootA, rootB], settings });
  await host.local.populateFromRoots();
  const channelA = new MessageChannel();
  const channelB = new MessageChannel();
  host.attachPort(channelA.port1);
  host.attachPort(channelB.port1);
  const clientA = await connectFileExplorer(channelA.port2);
  const clientB = await connectFileExplorer(channelB.port2);
  try {
    const folder = await clientA.resolvePath(join(rootA, 'left', 'folder'));
    const nested = await clientA.resolvePath(join(rootA, 'left', 'folder', 'nested.txt'));
    const rootBId = await clientA.resolvePath(rootB);
    assert.ok(folder !== null && nested !== null && rootBId !== null);
    assert.equal(await clientB.resolvePath(join(rootA, 'left', 'folder')), folder);
    assert.equal(await clientB.resolvePath(join(rootA, 'left', 'folder', 'nested.txt')), nested);

    await clientA.move(folder, rootBId, undefined, { crossRoot: true });
    for (const client of [clientA, clientB]) {
      const snapshot = client.getSnapshot();
      assert.equal(snapshot.getById(folder)?.parentId, rootBId);
      assert.equal(snapshot.getById(nested)?.parentId, folder);
      assert.equal(await client.resolvePath(join(rootB, 'folder', 'nested.txt')), nested);
    }
  } finally {
    await clientA.dispose();
    await clientB.dispose();
    await host.dispose();
    removeTempDir(sandbox);
  }
});
