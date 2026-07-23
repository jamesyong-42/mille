import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';

import {
  connectFileExplorer,
  createFileExplorerHost,
  DEFAULT_EXPLORER_SETTINGS,
  FileExplorer,
} from '../dist/index.js';

const SETTINGS = {
  ...DEFAULT_EXPLORER_SETTINGS,
  compactFolders: false,
  fileNestingPatterns: {
    '*.js': ['${capture}.js.map'],
    '*.ts': ['${capture}.test.ts'],
  },
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mille-settings-nesting-'));
  writeFileSync(join(root, 'notes.md'), '');
  writeFileSync(join(root, 'source.ts'), '');
  writeFileSync(join(root, 'source.test.ts'), '');
  writeFileSync(join(root, 'bundle.js'), '');
  writeFileSync(join(root, 'bundle.js.map'), '');
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

test('native file nesting drives rows, counts, ids, index, and prefix navigation', async () => {
  const root = fixture();
  const fx = new FileExplorer({ roots: [root], settings: SETTINGS });
  try {
    await fx.populateFromRoots();
    const snapshot = fx.getSnapshot();
    const rootEntry = snapshot.roots()[0];
    assert.ok(rootEntry);
    const rootExpanded = new Set([rootEntry.id]);
    const topRows = snapshot.visibleRows({ expanded: rootExpanded, offset: 0, limit: 100 });
    const source = topRows.find((row) => row.name === 'source.ts');
    const bundle = topRows.find((row) => row.name === 'bundle.js');
    assert.ok(source);
    assert.ok(bundle);
    assert.equal(source.hasChildren, true);
    assert.equal(bundle.hasChildren, true);
    assert.ok(!topRows.some((row) => row.name === 'source.test.ts'));
    assert.ok(!topRows.some((row) => row.name === 'bundle.js.map'));
    assert.equal(snapshot.projectedChildCount(source.id), 1);

    const expanded = new Set([rootEntry.id, source.id, bundle.id]);
    const rows = snapshot.visibleRows({ expanded, offset: 0, limit: 100 });
    const testRow = rows.find((row) => row.name === 'source.test.ts');
    const mapRow = rows.find((row) => row.name === 'bundle.js.map');
    assert.equal(testRow?.depth, 2);
    assert.equal(mapRow?.depth, 2);
    assert.equal(snapshot.visibleRowCount(expanded).known, rows.length);
    assert.deepEqual(
      snapshot.visibleRowIds({ expanded, offset: 0, limit: 100 }),
      rows.map((row) => row.id),
    );
    assert.equal(snapshot.visibleRowIndex(testRow.id, expanded), rows.indexOf(testRow));
    assert.equal(snapshot.visiblePrefixMatch('source.test', source.id, true, expanded), testRow.id);
  } finally {
    await fx.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('lazy port expansion and live rename preserve the nesting projection', async () => {
  const root = fixture();
  const host = await createFileExplorerHost({
    roots: [root],
    initialWalk: 'roots-only',
    settings: SETTINGS,
  });
  const { port1, port2 } = new MessageChannel();
  host.attachPort(port1);
  const client = await connectFileExplorer(port2);
  try {
    const rootEntry = await waitFor(() => client.getSnapshot().roots()[0]);
    client.setExpanded({ add: [rootEntry.id] });
    const source = await waitFor(() => {
      const rows = client
        .getSnapshot()
        .visibleRows({ expanded: new Set([rootEntry.id]), offset: 0, limit: 100 });
      const row = rows.find((candidate) => candidate.name === 'source.ts');
      return row?.hasChildren ? row : undefined;
    });
    assert.ok(
      !client
        .getSnapshot()
        .visibleRows({ expanded: new Set([rootEntry.id]), offset: 0, limit: 100 })
        .some((row) => row.name === 'source.test.ts'),
    );

    client.setExpanded({ add: [source.id] });
    const nested = await waitFor(() =>
      client
        .getSnapshot()
        .visibleRows({
          expanded: new Set([rootEntry.id, source.id]),
          offset: 0,
          limit: 100,
        })
        .find((row) => row.name === 'source.test.ts' && row.depth === 2),
    );

    await client.rename(nested.id, 'source.spec.ts');
    await waitFor(() => {
      const rows = client.getSnapshot().visibleRows({
        expanded: new Set([rootEntry.id, source.id]),
        offset: 0,
        limit: 100,
      });
      const parent = rows.find((row) => row.id === source.id);
      const renamed = rows.find((row) => row.name === 'source.spec.ts');
      return parent?.hasChildren === false && renamed?.depth === 1 ? renamed : undefined;
    });

    await client.rename(nested.id, 'source.test.ts');
    await waitFor(() =>
      client
        .getSnapshot()
        .visibleRows({
          expanded: new Set([rootEntry.id, source.id]),
          offset: 0,
          limit: 100,
        })
        .find((row) => row.name === 'source.test.ts' && row.depth === 2),
    );
  } finally {
    await client.dispose();
    await host.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
