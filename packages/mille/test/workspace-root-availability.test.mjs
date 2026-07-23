import { strict as assert } from 'node:assert';
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

const UNAVAILABLE = 4;
const DIRECTORY = 1;
const settings = {
  ...DEFAULT_EXPLORER_SETTINGS,
  compactFolders: false,
};

function fixture() {
  const sandbox = mkdtempSync(join(tmpdir(), 'mille-root-availability-'));
  const root = join(sandbox, 'workspace');
  const parked = join(sandbox, 'workspace-offline');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'main.ts'), 'export {};');
  return { sandbox, root, parked };
}

test('root disappearance and recovery preserve identity without stale descendants', async () => {
  const { sandbox, root, parked } = fixture();
  const fx = new FileExplorer({ roots: [root], settings });
  try {
    await fx.populateFromRoots();
    const retained = fx.getSnapshot();
    const rootBefore = retained.roots()[0];
    const leafBefore = await fx.getByUri({
      scheme: 'file',
      path: join(root, 'src', 'main.ts'),
    });
    assert.ok(rootBefore && leafBefore);

    renameSync(root, parked);
    const unavailableVersion = await fx.refreshWorkspaceRoots();
    const unavailable = fx.getSnapshot();
    assert.equal(unavailable.treeVersion, unavailableVersion);
    assert.equal(unavailable.roots()[0].id, rootBefore.id);
    assert.equal(unavailable.roots()[0].kind, UNAVAILABLE);
    assert.equal(unavailable.roots()[0].isReadonly, true);
    assert.deepEqual(unavailable.childrenOf(rootBefore.id), []);
    assert.equal(unavailable.getById(leafBefore.id), null);
    assert.ok(retained.getById(leafBefore.id));
    assert.equal(await fx.refreshWorkspaceRoots(), unavailableVersion);

    renameSync(parked, root);
    const recoveredVersion = await fx.refreshWorkspaceRoots();
    const recovered = fx.getSnapshot();
    assert.equal(recoveredVersion, unavailableVersion + 1);
    assert.equal(recovered.roots()[0].id, rootBefore.id);
    assert.equal(recovered.roots()[0].kind, DIRECTORY);
    assert.deepEqual(recovered.childrenOf(rootBefore.id), []);

    const page = await fx.list(rootBefore.id, { depth: 2 });
    assert.ok(page.entries.some((entry) => entry.name === 'src'));
    assert.equal(fx.getSnapshot().roots()[0].id, rootBefore.id);
  } finally {
    await fx.dispose();
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('initially missing roots publish an unavailable row instead of failing', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'mille-root-missing-'));
  const missing = join(sandbox, 'not-mounted');
  const fx = new FileExplorer({ roots: [missing], settings });
  try {
    assert.equal(await fx.populateFromRoots(), 0);
    const version = fx.getTreeVersion();
    const root = fx.getSnapshot().roots()[0];
    assert.ok(root);
    assert.equal(root.kind, UNAVAILABLE);
    assert.equal(root.isReadonly, true);
    assert.equal(fx.getSnapshot().treeVersion, version);
    assert.equal(await fx.refreshWorkspaceRoots(), version);
  } finally {
    await fx.dispose();
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test(
  'permission-denied roots use the same stable unavailable state',
  {
    skip: process.platform === 'win32' || process.getuid?.() === 0,
  },
  async () => {
    const { sandbox, root } = fixture();
    const fx = new FileExplorer({ roots: [root], settings });
    try {
      await fx.populateFromRoots();
      const rootId = fx.getSnapshot().roots()[0]?.id;
      assert.ok(rootId !== undefined);
      chmodSync(root, 0o000);
      await fx.refreshWorkspaceRoots();
      assert.equal(fx.getSnapshot().roots()[0]?.id, rootId);
      assert.equal(fx.getSnapshot().roots()[0]?.kind, UNAVAILABLE);

      chmodSync(root, 0o700);
      await fx.refreshWorkspaceRoots();
      assert.equal(fx.getSnapshot().roots()[0]?.id, rootId);
      assert.equal(fx.getSnapshot().roots()[0]?.kind, DIRECTORY);
    } finally {
      chmodSync(root, 0o700);
      await fx.dispose();
      rmSync(sandbox, { recursive: true, force: true });
    }
  },
);

test('port refresh synchronizes unavailable and recovered roots to every mirror', async () => {
  const { sandbox, root, parked } = fixture();
  const host = await createFileExplorerHost({
    roots: [root],
    settings,
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

    renameSync(root, parked);
    const unavailableVersion = await clientA.refreshWorkspaceRoots();
    for (const client of [clientA, clientB]) {
      const snapshot = client.getSnapshot();
      assert.equal(snapshot.treeVersion, unavailableVersion);
      assert.equal(snapshot.roots()[0].id, rootId);
      assert.equal(snapshot.roots()[0].kind, UNAVAILABLE);
    }

    renameSync(parked, root);
    const recoveredVersion = await clientB.refreshWorkspaceRoots();
    for (const client of [clientA, clientB]) {
      const snapshot = client.getSnapshot();
      assert.equal(snapshot.treeVersion, recoveredVersion);
      assert.equal(snapshot.roots()[0].id, rootId);
      assert.equal(snapshot.roots()[0].kind, DIRECTORY);
    }
  } finally {
    await clientA.dispose();
    await clientB.dispose();
    await host.dispose();
    rmSync(sandbox, { recursive: true, force: true });
  }
});
