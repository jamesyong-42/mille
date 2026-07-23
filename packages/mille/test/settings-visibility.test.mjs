import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';

import {
  connectFileExplorer,
  createFileExplorerHost,
  DEFAULT_EXPLORER_SETTINGS,
  FileExplorer,
} from '../dist/index.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mille-settings-visibility-'));
  writeFileSync(join(root, 'visible.txt'), '');
  writeFileSync(join(root, '.env'), '');
  writeFileSync(join(root, '.DS_Store'), '');
  mkdirSync(join(root, 'generated'));
  writeFileSync(join(root, 'generated', 'nested.txt'), '');
  return root;
}

async function snapshotFor(root, override) {
  const fx = new FileExplorer({
    roots: [root],
    respectIgnore: false,
    settings: { ...DEFAULT_EXPLORER_SETTINGS, excludeGlobs: ['generated/'], ...override },
  });
  await fx.populateFromRoots();
  return { fx, snapshot: fx.getSnapshot() };
}

test('native visibility settings and exclude globs drive every projection query', async () => {
  const root = fixture();
  const { fx, snapshot } = await snapshotFor(root, {
    showHiddenFiles: false,
    showIgnoredFiles: true,
  });
  try {
    const rootEntry = snapshot.roots()[0];
    assert.ok(rootEntry);
    const expanded = new Set([rootEntry.id]);
    const rows = snapshot.visibleRows({ expanded, offset: 0, limit: 100 });
    const names = rows.map((row) => row.name);
    assert.deepEqual(names, [rootEntry.name, 'generated', 'visible.txt']);
    assert.equal(snapshot.visibleRowCount(expanded).known, rows.length);
    assert.deepEqual(
      snapshot.visibleRowIds({ expanded, offset: 0, limit: 100 }),
      rows.map((row) => row.id),
    );
    const generated = rows.find((row) => row.name === 'generated');
    assert.ok(generated?.isIgnored);
    assert.equal(snapshot.visibleRowIndex(generated.id, expanded), 1);
    assert.equal(snapshot.showHiddenFiles, false);
    assert.equal(snapshot.showIgnoredFiles, true);

    const all = snapshot.visibleRows({
      expanded,
      offset: 0,
      limit: 100,
      includeIgnored: true,
    });
    assert.ok(all.some((row) => row.name === '.env'));
    assert.ok(all.some((row) => row.name === '.DS_Store'));
  } finally {
    await fx.dispose();
  }
});

test('showIgnoredFiles=false suppresses configured excludes without orphaning descendants', async () => {
  const root = fixture();
  const { fx, snapshot } = await snapshotFor(root, {
    showHiddenFiles: true,
    showIgnoredFiles: false,
  });
  try {
    const rootEntry = snapshot.roots()[0];
    assert.ok(rootEntry);
    const expanded = new Set([rootEntry.id]);
    const names = snapshot.visibleRows({ expanded, offset: 0, limit: 100 }).map((row) => row.name);
    assert.ok(names.includes('.env'));
    assert.ok(!names.includes('.DS_Store'));
    assert.ok(!names.includes('generated'));
    assert.ok(!names.includes('nested.txt'));
  } finally {
    await fx.dispose();
  }
});

test('host handshake preserves resolved visibility in the port snapshot', async () => {
  const root = fixture();
  const host = await createFileExplorerHost({
    roots: [root],
    settings: {
      ...DEFAULT_EXPLORER_SETTINGS,
      showHiddenFiles: false,
      showIgnoredFiles: true,
    },
  });
  const { port1, port2 } = new MessageChannel();
  try {
    await host.local.populateFromRoots();
    host.attachPort(port1);
    const client = await connectFileExplorer(port2);
    try {
      const snapshot = client.getSnapshot();
      assert.equal(snapshot.showHiddenFiles, false);
      assert.equal(snapshot.showIgnoredFiles, true);
    } finally {
      await client.dispose();
    }
  } finally {
    await host.dispose();
  }
});
