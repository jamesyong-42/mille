import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';

import { createFileExplorerHost } from '../dist/index.js';
import { decodeClientEntries } from '../dist/entry-codec.js';

function nextMatching(port, predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      port.off('message', onMessage);
      reject(new Error(`nextMatching timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const onMessage = (message) => {
      if (!predicate(message)) return;
      clearTimeout(timer);
      port.off('message', onMessage);
      resolve(message);
    };
    port.on('message', onMessage);
  });
}

test('handshake and expansion hydrate only roots plus the mounted viewport', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mille-bounded-hydration-'));
  let host;
  const { port1, port2 } = new MessageChannel();
  try {
    for (let index = 0; index < 256; index++) {
      writeFileSync(join(dir, `file-${String(index).padStart(3, '0')}.txt`), 'x');
    }
    host = await createFileExplorerHost({ roots: [dir] });
    await host.local.populateFromRoots();
    host.attachPort(port1);

    const snapshotPromise = nextMatching(port2, (message) => message?.type === 'snapshot');
    port2.postMessage({
      v: 1,
      type: 'handshake',
      body: { version: 1, clientId: 'bounded-hydration', options: {} },
    });
    const snapshot = await snapshotPromise;
    assert.ok(snapshot.body.mirror instanceof ArrayBuffer, 'handshake uses binary entries');
    assert.equal(snapshot.body.entriesJson, undefined, 'handshake omits JSON entries');
    const snapshotEntries = decodeClientEntries(snapshot.body.mirror);
    assert.equal(snapshotEntries.length, snapshot.body.roots.length, 'handshake ships roots only');

    const rootId = snapshot.body.roots[0];
    const viewportPromise = nextMatching(
      port2,
      (message) => message?.type === 'delta' && Array.isArray(message.body.viewportIds),
    );
    port2.postMessage({
      v: 1,
      type: 'setViewport',
      body: { offset: 0, limit: 16, overscan: 0 },
    });
    await viewportPromise;

    const expansionPromise = nextMatching(
      port2,
      (message) => message?.type === 'delta' && message.body.childLists !== undefined,
    );
    port2.postMessage({
      v: 1,
      type: 'setExpanded',
      body: { add: [rootId], remove: [] },
    });
    const expansion = await expansionPromise;
    const orderedChildren = expansion.body.childLists[String(rootId)];
    assert.equal(orderedChildren.length, 256, 'full structure arrives as compact ordered ids');
    assert.equal(expansion.body.entriesJson, undefined, 'expansion omits JSON entries');
    const expansionEntries =
      expansion.body.viewportPatch instanceof ArrayBuffer
        ? decodeClientEntries(expansion.body.viewportPatch)
        : [];
    assert.ok(
      expansionEntries.length <= 15,
      `entry payload stays inside the 16-row viewport; got ${expansionEntries.length}`,
    );
  } finally {
    port1.close();
    port2.close();
    await host?.dispose().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});
