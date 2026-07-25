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

/**
 * Wrap a host-side port so frames reach the client `delayMs` late.
 *
 * The synchronization point is only interesting when a mirror is *behind*.
 * On an idle machine every client applies its delta within the tick the host
 * waits out, which is why the race only ever surfaced under CI load. Delaying
 * one client reproduces that state deterministically.
 */
function slowPort(port, delayMs) {
  return {
    postMessage: (message, transfer) => {
      setTimeout(() => {
        try {
          port.postMessage(message, transfer);
        } catch {
          /* channel closed mid-flight */
        }
      }, delayMs);
    },
    addEventListener: (_type, listener) => {
      port.on('message', (data) => listener({ data }));
    },
    removeEventListener: () => {},
    start: () => port.start?.(),
    close: () => port.close?.(),
  };
}

test('port resync waits for a lagging mirror, not just a tick', async () => {
  const { sandbox, root } = fixture();
  const host = await createFileExplorerHost({ roots: [root], settings });
  await host.local.populateFromRoots();

  const fast = new MessageChannel();
  const slow = new MessageChannel();
  host.attachPort(fast.port1);
  // 60 ms is far longer than the setImmediate the host used to settle for.
  host.attachPort(slowPort(slow.port1, 60));
  const fastClient = await connectFileExplorer(fast.port2);
  const slowClient = await connectFileExplorer(slow.port2);

  try {
    const rootId = fastClient.getSnapshot().roots()[0]?.id;
    assert.ok(rootId !== undefined);
    fastClient.setExpanded({ add: [rootId] });
    slowClient.setExpanded({ add: [rootId] });
    await waitFor(
      () => fastClient.getSnapshot().directChildCount(rootId) ?? 0,
      (count) => count > 0,
      'fast client did not hydrate',
    );
    await waitFor(
      () => slowClient.getSnapshot().directChildCount(rootId) ?? 0,
      (count) => count > 0,
      'slow client did not hydrate',
    );

    writeFileSync(join(root, 'late.txt'), 'late');
    const version = await fastClient.resync(rootId, { recursive: true });

    // No polling: resolving is supposed to mean every mirror is caught up.
    assert.equal(
      slowClient.getSnapshot().treeVersion,
      version,
      'lagging mirror was still behind when resync resolved',
    );
    assert.ok(childByName(slowClient.getSnapshot(), rootId, 'late.txt'));
  } finally {
    await fastClient.dispose();
    await slowClient.dispose();
    await host.dispose();
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('resync still resolves when a client never acknowledges', async () => {
  const { frame, PROTOCOL_VERSION } = await import('../dist/protocol.js');
  const { sandbox, root } = fixture();
  const host = await createFileExplorerHost({ roots: [root], settings });
  await host.local.populateFromRoots();

  const live = new MessageChannel();
  const mute = new MessageChannel();
  host.attachPort(live.port1);
  host.attachPort(mute.port1);
  const client = await connectFileExplorer(live.port2);

  // A client predating the ack frame: it handshakes, receives deltas, and
  // never replies. The host must not wait on it forever.
  mute.port2.on('message', () => {});
  mute.port2.postMessage(
    frame('handshake', {
      version: PROTOCOL_VERSION,
      clientId: 'silent',
      options: {},
    }),
  );

  try {
    const rootId = client.getSnapshot().roots()[0]?.id;
    assert.ok(rootId !== undefined);
    client.setExpanded({ add: [rootId] });
    await waitFor(
      () => client.getSnapshot().directChildCount(rootId) ?? 0,
      (count) => count > 0,
      'client did not hydrate',
    );

    writeFileSync(join(root, 'quiet.txt'), 'quiet');
    const started = Date.now();
    const version = await client.resync(rootId, { recursive: true });
    const elapsed = Date.now() - started;

    // Bounded by the fallback, and the acking client is still correct.
    assert.ok(elapsed < 4_000, `resync took ${elapsed} ms — fallback did not fire`);
    assert.equal(client.getSnapshot().treeVersion, version);
    assert.ok(childByName(client.getSnapshot(), rootId, 'quiet.txt'));
  } finally {
    await client.dispose();
    mute.port2.close();
    await host.dispose();
    rmSync(sandbox, { recursive: true, force: true });
  }
});
