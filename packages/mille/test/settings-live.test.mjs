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
  compactFolders: false,
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
    assert.deepEqual(names(after, rootEntry.id), ['a.txt', 'source.ts', 'z-dir']);
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
    assert.deepEqual(names(clientA.getSnapshot(), rootEntry.id), ['a.txt', 'source.ts', 'z-dir']);
    assert.deepEqual(names(clientB.getSnapshot(), rootEntry.id), ['a.txt', 'source.ts', 'z-dir']);
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
