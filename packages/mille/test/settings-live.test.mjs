import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';

import {
  connectFileExplorer,
  createFileExplorerHost,
  DEFAULT_EXPLORER_SETTINGS,
  FileExplorer,
} from '../dist/index.js';

const INITIAL = {
  ...DEFAULT_EXPLORER_SETTINGS,
  compactFolders: false,
  fileNestingPatterns: {},
};
const UPDATED = {
  ...DEFAULT_EXPLORER_SETTINGS,
  caseSensitive: true,
  foldersOnTop: false,
  showHiddenFiles: false,
  showIgnoredFiles: false,
  compactFolders: false,
  excludeGlobs: ['*.txt'],
  fileNestingPatterns: {
    '*.ts': ['${capture}.test.ts'],
  },
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mille-settings-live-'));
  mkdirSync(join(root, 'z-dir'));
  writeFileSync(join(root, 'a.txt'), '');
  writeFileSync(join(root, '.hidden'), '');
  writeFileSync(join(root, 'source.ts'), '');
  writeFileSync(join(root, 'source.test.ts'), '');
  return root;
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    const value = predicate();
    if (value !== undefined && value !== false) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

function names(snapshot, rootId) {
  return snapshot
    .visibleRows({ expanded: new Set([rootId]), offset: 0, limit: 100 })
    .slice(1)
    .map((row) => row.name);
}

test('local projection settings update atomically and no-op idempotently', async () => {
  const root = fixture();
  const fx = new FileExplorer({ roots: [root], settings: INITIAL });
  try {
    await fx.populateFromRoots();
    const before = fx.getSnapshot();
    const rootEntry = before.roots()[0];
    assert.ok(rootEntry);
    assert.deepEqual(names(before, rootEntry.id), [
      'z-dir',
      '.hidden',
      'a.txt',
      'source.test.ts',
      'source.ts',
    ]);

    let changes = 0;
    const subscription = fx.on('change:tree', () => {
      changes += 1;
    });
    const version = fx.updateProjectionSettings(UPDATED);
    const after = fx.getSnapshot();
    assert.equal(version, before.treeVersion + 1);
    assert.equal(after.treeVersion, version);
    assert.equal(after.showHiddenFiles, false);
    assert.deepEqual(names(after, rootEntry.id), ['source.ts', 'z-dir']);
    const source = after
      .visibleRows({ expanded: new Set([rootEntry.id]), offset: 0, limit: 100 })
      .find((row) => row.name === 'source.ts');
    assert.equal(source?.hasChildren, true);
    assert.ok(names(before, rootEntry.id).includes('.hidden'));
    assert.ok(names(before, rootEntry.id).includes('source.test.ts'));

    assert.equal(fx.updateProjectionSettings(UPDATED), version);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(changes, 1);
    subscription.dispose();
  } finally {
    await fx.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('exclude globs add and remove without erasing repository-ignore provenance', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mille-excludes-live-'));
  writeFileSync(join(root, '.gitignore'), 'repository.log\n');
  writeFileSync(join(root, 'repository.log'), '');
  writeFileSync(join(root, 'generated.log'), '');
  writeFileSync(join(root, 'visible.txt'), '');
  const settings = {
    ...INITIAL,
    showHiddenFiles: false,
    showIgnoredFiles: false,
  };
  const fx = new FileExplorer({ roots: [root], settings });
  try {
    await fx.populateFromRoots();
    const before = fx.getSnapshot();
    const rootEntry = before.roots()[0];
    assert.ok(rootEntry);
    const generatedId = await fx.resolvePath(join(root, 'generated.log'));
    const repositoryId = await fx.resolvePath(join(root, 'repository.log'));
    assert.ok(generatedId !== null);
    assert.ok(repositoryId !== null);
    assert.deepEqual(names(before, rootEntry.id), ['generated.log', 'visible.txt']);
    assert.equal(before.getById(generatedId)?.isIgnored, false);
    assert.equal(before.getById(repositoryId)?.isIgnored, true);

    const excludedVersion = fx.updateProjectionSettings({
      ...settings,
      excludeGlobs: ['*.log'],
    });
    const excluded = fx.getSnapshot();
    assert.equal(excluded.treeVersion, excludedVersion);
    assert.deepEqual(names(excluded, rootEntry.id), ['visible.txt']);
    assert.equal(excluded.getById(generatedId)?.isIgnored, true);
    assert.equal(excluded.getById(repositoryId)?.isIgnored, true);
    assert.deepEqual(names(before, rootEntry.id), ['generated.log', 'visible.txt']);

    const created = await fx.create(rootEntry.id, 'created.log', 0);
    assert.equal(created.isIgnored, true);
    writeFileSync(join(root, 'future.log'), '');
    await fx.prefetch(rootEntry.id, { depth: 1 });
    const futureId = await fx.resolvePath(join(root, 'future.log'));
    assert.ok(futureId !== null);
    assert.equal(fx.getSnapshot().getById(futureId)?.isIgnored, true);
    assert.deepEqual(names(fx.getSnapshot(), rootEntry.id), ['visible.txt']);
    const versionBeforeRestore = fx.getTreeVersion();
    const restoredVersion = fx.updateProjectionSettings(settings);
    const restored = fx.getSnapshot();
    assert.equal(restoredVersion, versionBeforeRestore + 1);
    assert.deepEqual(names(restored, rootEntry.id), [
      'created.log',
      'future.log',
      'generated.log',
      'visible.txt',
    ]);
    assert.equal(restored.getById(generatedId)?.isIgnored, false);
    assert.equal(restored.getById(created.id)?.isIgnored, false);
    assert.equal(restored.getById(futureId)?.isIgnored, false);
    assert.equal(restored.getById(repositoryId)?.isIgnored, true);
    assert.equal(fx.updateProjectionSettings(settings), restoredVersion);
  } finally {
    await fx.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('one port update reaches every client before the initiator resolves', async () => {
  const root = fixture();
  const host = await createFileExplorerHost({ roots: [root], settings: INITIAL });
  await host.local.populateFromRoots();
  const channelA = new MessageChannel();
  const channelB = new MessageChannel();
  host.attachPort(channelA.port1);
  host.attachPort(channelB.port1);
  const clientA = await connectFileExplorer(channelA.port2);
  const clientB = await connectFileExplorer(channelB.port2);
  try {
    const rootEntry = clientA.getSnapshot().roots()[0];
    assert.ok(rootEntry);
    clientA.setExpanded({ add: [rootEntry.id] });
    clientB.setExpanded({ add: [rootEntry.id] });
    await waitFor(() =>
      names(clientA.getSnapshot(), rootEntry.id).includes('source.test.ts') ? true : undefined,
    );
    await waitFor(() =>
      names(clientB.getSnapshot(), rootEntry.id).includes('source.test.ts') ? true : undefined,
    );
    const retained = clientB.getSnapshot();

    const version = await clientA.updateProjectionSettings(UPDATED);
    assert.equal(clientA.getSnapshot().treeVersion, version);
    assert.equal(clientB.getSnapshot().treeVersion, version);
    assert.equal(clientA.getSnapshot().showHiddenFiles, false);
    assert.equal(clientB.getSnapshot().showHiddenFiles, false);
    assert.deepEqual(names(clientA.getSnapshot(), rootEntry.id), ['source.ts', 'z-dir']);
    assert.deepEqual(names(clientB.getSnapshot(), rootEntry.id), ['source.ts', 'z-dir']);
    assert.ok(names(retained, rootEntry.id).includes('.hidden'));
    assert.ok(names(retained, rootEntry.id).includes('source.test.ts'));

    const source = clientA
      .getSnapshot()
      .visibleRows({ expanded: new Set([rootEntry.id]), offset: 0, limit: 100 })
      .find((row) => row.name === 'source.ts');
    assert.ok(source?.hasChildren);
    clientA.setExpanded({ add: [source.id] });
    await waitFor(() =>
      clientA
        .getSnapshot()
        .visibleRows({
          expanded: new Set([rootEntry.id, source.id]),
          offset: 0,
          limit: 100,
        })
        .find((row) => row.name === 'source.test.ts' && row.depth === 2),
    );
  } finally {
    await clientA.dispose();
    await clientB.dispose();
    await host.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
