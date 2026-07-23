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

function fixture() {
  const sandbox = mkdtempSync(join(tmpdir(), 'mille-live-roots-'));
  const alpha = join(sandbox, 'alpha');
  const beta = join(sandbox, 'beta');
  const gamma = join(sandbox, 'gamma');
  for (const root of [alpha, beta, gamma]) mkdirSync(root);
  mkdirSync(join(alpha, 'nested'));
  writeFileSync(join(alpha, 'nested', 'alpha.txt'), 'alpha');
  writeFileSync(join(beta, 'beta.txt'), 'beta');
  writeFileSync(join(gamma, 'gamma.txt'), 'gamma');
  return { sandbox, alpha, beta, gamma };
}

const settings = {
  ...DEFAULT_EXPLORER_SETTINGS,
  compactFolders: false,
};

function roots(snapshot) {
  return snapshot.roots().map((root) => ({ id: root.id, name: root.name }));
}

async function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

test('local workspace-root replacement is atomic, lazy, and failure-safe', async () => {
  const { sandbox, alpha, beta, gamma } = fixture();
  const fx = new FileExplorer({ roots: [alpha, beta], settings });
  try {
    await fx.populateFromRoots();
    const retained = fx.getSnapshot();
    const [alphaRoot, betaRoot] = retained.roots();
    const alphaLeaf = await fx.getByUri({
      scheme: 'file',
      path: join(alpha, 'nested', 'alpha.txt'),
    });
    assert.ok(alphaRoot && betaRoot && alphaLeaf);
    let changes = 0;
    const subscription = fx.on('change:tree', () => {
      changes += 1;
    });

    const version = await fx.updateWorkspaceRoots([beta, gamma]);
    const current = fx.getSnapshot();
    assert.equal(version, retained.treeVersion + 1);
    assert.deepEqual(roots(current), [
      { id: betaRoot.id, name: 'beta' },
      { id: current.roots()[1].id, name: 'gamma' },
    ]);
    assert.equal(current.getById(alphaRoot.id), null);
    assert.equal(current.getById(alphaLeaf.id), null);
    assert.equal(await fx.getByUri({ scheme: 'file', path: alpha }), null);
    assert.deepEqual(roots(retained), [
      { id: alphaRoot.id, name: 'alpha' },
      { id: betaRoot.id, name: 'beta' },
    ]);
    assert.ok(retained.getById(alphaLeaf.id));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(changes, 1);

    const gammaRoot = current.roots()[1];
    assert.ok(gammaRoot);
    assert.equal(
      current.childrenOf(gammaRoot.id).length,
      0,
      'new root should be seeded without eager descendants',
    );
    const gammaPage = await fx.list(gammaRoot.id, { depth: 1 });
    assert.deepEqual(
      gammaPage.entries.map((entry) => entry.name),
      ['gamma.txt'],
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    const changesAfterHydration = changes;
    assert.equal(await fx.updateWorkspaceRoots([beta, gamma]), fx.getTreeVersion());
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(changes, changesAfterHydration);

    const stableVersion = fx.getTreeVersion();
    const stableRoots = roots(fx.getSnapshot());
    const invalidCases = [
      {
        roots: [beta, beta],
        code: 'EINVAL',
      },
      {
        roots: [beta, join(beta, 'nested')],
        code: 'EINVAL',
      },
      {
        roots: [beta, join(sandbox, 'missing')],
        code: 'ENOENT',
      },
      {
        roots: [beta, join(gamma, 'gamma.txt')],
        code: 'ENOTDIR',
      },
    ];
    for (const invalid of invalidCases) {
      await assert.rejects(
        fx.updateWorkspaceRoots(invalid.roots),
        (error) => error?.code === invalid.code,
      );
      assert.equal(fx.getTreeVersion(), stableVersion);
      assert.deepEqual(roots(fx.getSnapshot()), stableRoots);
    }

    const emptyVersion = await fx.updateWorkspaceRoots([]);
    assert.equal(emptyVersion, stableVersion + 1);
    assert.deepEqual(fx.getSnapshot().roots(), []);
    const readdedVersion = await fx.updateWorkspaceRoots([alpha]);
    const readdedAlpha = fx.getSnapshot().roots()[0];
    assert.equal(readdedVersion, emptyVersion + 1);
    assert.ok(readdedAlpha);
    assert.notEqual(readdedAlpha.id, alphaRoot.id);
    assert.equal(fx.getSnapshot().childrenOf(readdedAlpha.id).length, 0);
    subscription.dispose();
  } finally {
    await fx.dispose();
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('one port root replacement updates every mirror before resolving', async () => {
  const { sandbox, alpha, beta, gamma } = fixture();
  const host = await createFileExplorerHost({
    roots: [alpha, beta],
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
    const initial = clientB.getSnapshot();
    const [alphaRoot, betaRoot] = initial.roots();
    assert.ok(alphaRoot && betaRoot);
    const alphaLeafPath = join(alpha, 'nested', 'alpha.txt');
    const alphaLeafA = await clientA.resolvePath(alphaLeafPath);
    const alphaLeafB = await clientB.resolvePath(alphaLeafPath);
    assert.ok(alphaLeafA !== null && alphaLeafB !== null);
    assert.equal(alphaLeafA, alphaLeafB);
    const retained = clientB.getSnapshot();

    const version = await clientA.updateWorkspaceRoots([beta, gamma]);
    for (const client of [clientA, clientB]) {
      assert.equal(client.getSnapshot().treeVersion, version);
      assert.deepEqual(
        client
          .getSnapshot()
          .roots()
          .map((root) => root.name),
        ['beta', 'gamma'],
      );
      assert.equal(client.getSnapshot().roots()[0].id, betaRoot.id);
      assert.equal(client.getSnapshot().getById(alphaRoot.id), null);
      assert.equal(client.getSnapshot().getById(alphaLeafA), null);
    }
    assert.deepEqual(
      retained.roots().map((root) => root.name),
      ['alpha', 'beta'],
    );

    await assert.rejects(
      clientB.updateWorkspaceRoots([beta, join(sandbox, 'missing')]),
      (error) => error?.code === 'ENOENT',
    );
    assert.equal(clientA.getSnapshot().treeVersion, version);
    assert.deepEqual(
      clientA
        .getSnapshot()
        .roots()
        .map((root) => root.name),
      ['beta', 'gamma'],
    );
  } finally {
    await clientA.dispose();
    await clientB.dispose();
    await host.dispose();
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('watcher follows added roots and stops reconciling removed roots', async () => {
  const { sandbox, alpha, beta } = fixture();
  const fx = new FileExplorer({
    roots: [alpha],
    settings,
    watchDebounceMs: 20,
  });
  try {
    await fx.populateFromRoots();
    await fx.updateWorkspaceRoots([beta]);
    const betaRoot = fx.getSnapshot().roots()[0];
    assert.ok(betaRoot);

    writeFileSync(join(beta, 'added-after-root-change.txt'), 'live');
    const added = await waitFor(() =>
      fx
        .getSnapshot()
        .childrenOf(betaRoot.id)
        .map((id) => fx.getSnapshot().getById(id))
        .find((entry) => entry?.name === 'added-after-root-change.txt'),
    );
    assert.equal(added.parentId, betaRoot.id);

    const version = fx.getTreeVersion();
    writeFileSync(join(alpha, 'removed-root-change.txt'), 'ignored');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(fx.getTreeVersion(), version);
    assert.equal(
      await fx.getByUri({
        scheme: 'file',
        path: join(alpha, 'removed-root-change.txt'),
      }),
      null,
    );
  } finally {
    await fx.dispose();
    rmSync(sandbox, { recursive: true, force: true });
  }
});
