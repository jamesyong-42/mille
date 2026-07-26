import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MessageChannel } from 'node:worker_threads';

import { connectFileExplorer, createFileExplorerHost } from '../dist/index.js';

async function waitFor(predicate, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value !== null && value !== undefined && value !== false) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

function childByName(snapshot, parentId, name) {
  for (const id of snapshot.childrenOf(parentId)) {
    const entry = snapshot.getById(id);
    if (entry?.name === name) return entry;
  }
  return null;
}

test('external changes flow through host deltas and survive collapse/re-expand', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mille-watch-host-'));
  const host = await createFileExplorerHost({
    roots: [root],
    initialWalk: 'roots-only',
    watchDebounceMs: 40,
  });
  const { port1, port2 } = new MessageChannel();
  host.attachPort(port1);
  const client = await connectFileExplorer(port2);
  try {
    const rootId = await waitFor(() => client.getSnapshot().roots()[0]?.id);
    client.setExpanded({ add: [rootId] });

    writeFileSync(join(root, 'first.txt'), 'first');
    const firstId = await waitFor(() => {
      const entry = childByName(host.local.getSnapshot(), rootId, 'first.txt');
      return entry?.id;
    });
    await waitFor(() => client.getSnapshot().getById(firstId));

    client.setExpanded({ remove: [rootId] });
    writeFileSync(join(root, 'while-collapsed.txt'), 'second');
    const secondId = await waitFor(() => {
      const entry = childByName(host.local.getSnapshot(), rootId, 'while-collapsed.txt');
      return entry?.id;
    });
    assert.equal(client.getSnapshot().getById(secondId), null);

    client.setExpanded({ add: [rootId] });
    await waitFor(() => client.getSnapshot().getById(secondId));

    rmSync(join(root, 'first.txt'));
    await waitFor(() => client.getSnapshot().getById(firstId) === null);
  } finally {
    await client.dispose();
    await host.dispose();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
