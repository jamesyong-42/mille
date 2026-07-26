import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';

import { createFileExplorerHost, connectFileExplorer } from '../dist/index.js';
import { decodeClientEntries } from '../dist/entry-codec.js';

function entryCount(delta) {
  return delta.viewportPatch instanceof ArrayBuffer
    ? decodeClientEntries(delta.viewportPatch).length
    : 0;
}

async function waitFor(predicate, timeoutMs = 2000) {
  const started = performance.now();
  while (performance.now() - started <= timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

test('setViewport re-fetches and retains rows evicted by a bounded mirror', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mille-viewport-retention-'));
  let host;
  let client;
  try {
    for (let i = 0; i < 64; i++) {
      writeFileSync(join(dir, `file-${String(i).padStart(3, '0')}.txt`), String(i));
    }

    host = await createFileExplorerHost({ roots: [dir] });
    await host.local.populateFromRoots();

    const { port1, port2 } = new MessageChannel();
    host.attachPort(port1);
    const deltas = [];
    port2.on('message', (message) => {
      if (message?.type === 'delta') deltas.push(message.body);
    });
    client = await connectFileExplorer(port2, { mirrorCap: 8, prefetchRows: 5 });

    const root = host.local.getSnapshot().roots()[0];
    assert.ok(root, 'host root exists');
    const expanded = new Set([root.id]);
    const hostRows = host.local.getSnapshot().visibleRows({
      expanded,
      offset: 0,
      limit: 100,
    });

    const expected = hostRows.slice(0, 5);
    client.setViewport({ offset: 0, limit: expected.length, overscan: 0 });
    client.setExpanded({ add: [root.id] });
    await waitFor(() => expected.every((row) => client.getSnapshot().getById(row.id) !== null));

    // Move far enough to overflow the eight-entry cap and release this window,
    // then return to prove the host re-sends it.
    const farWindow = hostRows.slice(20, 25);
    client.setViewport({ offset: 20, limit: farWindow.length, overscan: 0 });
    await waitFor(() => farWindow.every((row) => client.getSnapshot().getById(row.id) !== null));
    const beforeReturn = deltas.length;
    const expectedIds = expected.map((row) => row.id);
    client.setViewport({ offset: 0, limit: expected.length, overscan: 0 });

    try {
      await waitFor(
        () =>
          expected.every((row) => client.getSnapshot().getById(row.id) !== null) &&
          deltas
            .slice(beforeReturn)
            .some(
              (delta) =>
                Array.isArray(delta.viewportIds) &&
                delta.viewportIds.length === expectedIds.length &&
                delta.viewportIds.every((id, index) => id === expectedIds[index]),
            ),
      );
    } catch (error) {
      error.message += `; viewport deltas=${JSON.stringify(
        deltas.map((delta) => ({
          viewportIds: delta.viewportIds,
          entryCount: entryCount(delta),
        })),
      )}`;
      throw error;
    }
    for (const row of expected) {
      assert.equal(client.getSnapshot().getById(row.id)?.name, row.name);
    }

    const firstPatch = deltas
      .slice(beforeReturn)
      .find(
        (delta) =>
          Array.isArray(delta.viewportIds) &&
          delta.viewportIds.length === expectedIds.length &&
          delta.viewportIds.every((id, index) => id === expectedIds[index]),
      );
    assert.deepEqual(firstPatch?.viewportIds, expectedIds);
    assert.equal(firstPatch.entriesJson, undefined, 'viewport patch omits JSON entries');
    assert.equal(entryCount(firstPatch), expected.length);

    const shifted = hostRows.slice(1, 1 + expected.length);
    const beforeShift = deltas.length;
    client.setViewport({ offset: 1, limit: shifted.length, overscan: 0 });
    await waitFor(() => deltas.length > beforeShift);
    const shiftedPatch = deltas
      .slice(beforeShift)
      .find((delta) => Array.isArray(delta.viewportIds));
    assert.deepEqual(
      shiftedPatch?.viewportIds,
      shifted.map((row) => row.id),
    );
    assert.equal(
      entryCount(shiftedPatch),
      1,
      'one-row scroll only transfers the newly-entered row',
    );
    assert.ok(shifted.every((row) => client.getSnapshot().getById(row.id) !== null));
  } finally {
    await client?.dispose().catch(() => {});
    await host?.dispose().catch(() => {});
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
