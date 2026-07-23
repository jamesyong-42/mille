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
  const root = mkdtempSync(join(tmpdir(), 'mille-settings-compact-'));
  const a = join(root, 'a');
  const b = join(a, 'b');
  const c = join(b, 'c');
  mkdirSync(c, { recursive: true });
  writeFileSync(join(c, 'file.txt'), '');
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

test('native compact projection uses leaf identity and segment label consistently', async () => {
  const root = fixture();
  const fx = new FileExplorer({
    roots: [root],
    settings: { ...DEFAULT_EXPLORER_SETTINGS, compactFolders: true },
  });
  try {
    await fx.populateFromRoots();
    const snapshot = fx.getSnapshot();
    const rootEntry = snapshot.roots()[0];
    assert.ok(rootEntry);
    const rootExpanded = new Set([rootEntry.id]);
    const compactRows = snapshot.visibleRows({
      expanded: rootExpanded,
      offset: 0,
      limit: 10,
    });
    assert.equal(compactRows.length, 2);
    assert.deepEqual(compactRows[1].pathSegments, ['a', 'b', 'c']);
    assert.equal(compactRows[1].name, 'c');
    assert.deepEqual(snapshot.projectedChildrenOf(rootEntry.id), [compactRows[1].id]);
    assert.equal(snapshot.visibleRowCount(rootExpanded).known, 2);
    assert.equal(snapshot.visibleRowIndex(compactRows[1].id, rootExpanded), 1);

    const fullyExpanded = new Set([rootEntry.id, compactRows[1].id]);
    const rows = snapshot.visibleRows({ expanded: fullyExpanded, offset: 0, limit: 10 });
    assert.deepEqual(
      rows.map((row) => row.pathSegments?.join('/') ?? row.name),
      [rootEntry.name, 'a/b/c', 'file.txt'],
    );
    assert.equal(snapshot.visibleRowCount(fullyExpanded).known, rows.length);
  } finally {
    await fx.dispose();
  }
});

test('lazy host hydrates only a compact directory chain and preserves it in the port mirror', async () => {
  const root = fixture();
  const host = await createFileExplorerHost({
    roots: [root],
    initialWalk: 'roots-only',
    settings: { ...DEFAULT_EXPLORER_SETTINGS, compactFolders: true },
  });
  const { port1, port2 } = new MessageChannel();
  host.attachPort(port1);
  const client = await connectFileExplorer(port2);
  try {
    const rootEntry = await waitFor(() => client.getSnapshot().roots()[0]);
    client.setExpanded({ add: [rootEntry.id] });
    const compactRow = await waitFor(() => {
      const rows = client
        .getSnapshot()
        .visibleRows({ expanded: new Set([rootEntry.id]), offset: 0, limit: 10 });
      return rows.find((row) => row.pathSegments?.join('/') === 'a/b/c');
    });
    assert.deepEqual(compactRow.pathSegments, ['a', 'b', 'c']);
    assert.equal(client.getSnapshot().compactFolders, true);

    client.setExpanded({ add: [compactRow.id] });
    const file = await waitFor(() =>
      client
        .getSnapshot()
        .visibleRows({
          expanded: new Set([rootEntry.id, compactRow.id]),
          offset: 0,
          limit: 10,
        })
        .find((row) => row.name === 'file.txt'),
    );
    assert.equal(file.depth, 2);
  } finally {
    await client.dispose();
    await host.dispose();
  }
});
