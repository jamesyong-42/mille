import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

const settings = { ...DEFAULT_EXPLORER_SETTINGS, compactFolders: false };

function fixture() {
  const sandbox = mkdtempSync(join(tmpdir(), 'mille-resync-'));
  const root = join(sandbox, 'workspace');
  mkdirSync(join(root, 'src', 'deep'), { recursive: true });
  mkdirSync(join(root, 'other'), { recursive: true });
  writeFileSync(join(root, 'src', 'deep', 'stale.txt'), 'stale');
  writeFileSync(join(root, 'other', 'keep.txt'), 'keep');
  return { sandbox, root };
}

function childByName(snapshot, parentId, name) {
  const childIds =
    typeof snapshot.childrenOf === 'function'
      ? snapshot.childrenOf(parentId)
      : snapshot
          .visibleRows({
            expanded: new Set([parentId]),
            offset: 0,
            limit: 10_000,
            includeIgnored: true,
          })
          .filter((entry) => entry.parentId === parentId)
          .map((entry) => entry.id);
  for (const id of childIds) {
    const entry = snapshot.getById(id);
    if (entry?.name === name) return entry;
  }
  return null;
}

async function waitFor(read, predicate, message, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = read();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`${message}; last=${JSON.stringify(last)}`);
}

test('recursive subtree resync authoritatively adds, removes, and preserves unrelated state', async () => {
  const { sandbox, root } = fixture();
  const fx = new FileExplorer({ roots: [root], settings, watchDebounceMs: 60_000 });
  try {
    await fx.populateFromRoots();
    const initial = fx.getSnapshot();
    const rootEntry = initial.roots()[0];
    const src = childByName(initial, rootEntry.id, 'src');
    const deep = childByName(initial, src.id, 'deep');
    const stale = childByName(initial, deep.id, 'stale.txt');
    const other = childByName(initial, rootEntry.id, 'other');
    const keep = childByName(initial, other.id, 'keep.txt');
    assert.ok(src && deep && stale && other && keep);
    let treeChanges = 0;
    const changeSubscription = fx.on('change:tree', () => {
      treeChanges += 1;
    });

    try {
      rmSync(join(root, 'src', 'deep', 'stale.txt'));
      writeFileSync(join(root, 'src', 'deep', 'fresh.txt'), 'fresh');
      const version = await fx.resync(src.id, { recursive: true });
      const refreshed = fx.getSnapshot();
      assert.equal(refreshed.treeVersion, version);
      assert.equal(refreshed.getById(src.id)?.id, src.id);
      assert.equal(refreshed.getById(stale.id), null);
      assert.ok(childByName(refreshed, deep.id, 'fresh.txt'));
      assert.equal(refreshed.getById(keep.id)?.id, keep.id);
      await waitFor(
        () => treeChanges,
        (count) => count === 1,
        'changed resync did not emit exactly one tree notice',
      );
      assert.equal(await fx.resync(src.id, { recursive: true }), version);
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(treeChanges, 1, 'no-op resync must not emit a tree notice');

      rmSync(join(root, 'other', 'keep.txt'));
      await fx.resync(keep.id, { recursive: true });
      assert.equal(fx.getSnapshot().getById(keep.id), null, 'file refresh reconciles its parent');
    } finally {
      changeSubscription.dispose();
    }
  } finally {
    await fx.dispose();
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('workspace resync reconciles every configured root subtree', async () => {
  const { sandbox, root } = fixture();
  const secondRoot = join(sandbox, 'shared');
  mkdirSync(secondRoot);
  const fx = new FileExplorer({
    roots: [root, secondRoot],
    settings,
    watchDebounceMs: 60_000,
  });
  try {
    await fx.populateFromRoots();
    writeFileSync(join(root, 'root-fresh.txt'), 'one');
    writeFileSync(join(secondRoot, 'shared-fresh.txt'), 'two');
    const version = await fx.resyncWorkspace();
    const snapshot = fx.getSnapshot();
    assert.equal(snapshot.treeVersion, version);
    const [first, second] = snapshot.roots();
    assert.ok(childByName(snapshot, first.id, 'root-fresh.txt'));
    assert.ok(childByName(snapshot, second.id, 'shared-fresh.txt'));
    assert.equal(await fx.resyncWorkspace(), version);
  } finally {
    await fx.dispose();
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('port subtree resync is a synchronization point for every attached mirror', async () => {
  const { sandbox, root } = fixture();
  const host = await createFileExplorerHost({
    roots: [root],
    settings,
    watchDebounceMs: 60_000,
  });
  await host.local.populateFromRoots();
  const channelA = new MessageChannel();
  const channelB = new MessageChannel();
  host.attachPort(channelA.port1);
  host.attachPort(channelB.port1);
  const clientA = await connectFileExplorer(channelA.port2);
  const clientB = await connectFileExplorer(channelB.port2);
  try {
    const rootId = clientA.getSnapshot().roots()[0]?.id;
    assert.ok(rootId !== undefined);
    clientA.setExpanded({ add: [rootId] });
    clientB.setExpanded({ add: [rootId] });
    await waitFor(
      () => clientA.getSnapshot().directChildCount(rootId) ?? 0,
      (count) => count > 0,
      'root expansion did not hydrate client A',
    );
    await waitFor(
      () => clientB.getSnapshot().directChildCount(rootId) ?? 0,
      (count) => count > 0,
      'root expansion did not hydrate client B',
    );

    writeFileSync(join(root, 'port-fresh.txt'), 'port');
    const version = await clientA.resync(rootId, { recursive: true });
    for (const client of [clientA, clientB]) {
      const snapshot = client.getSnapshot();
      assert.equal(snapshot.treeVersion, version);
      assert.ok(childByName(snapshot, rootId, 'port-fresh.txt'));
    }
  } finally {
    await clientA.dispose();
    await clientB.dispose();
    await host.dispose();
    rmSync(sandbox, { recursive: true, force: true });
  }
});
