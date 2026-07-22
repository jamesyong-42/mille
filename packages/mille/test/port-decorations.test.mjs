// Phase A1.4 — port-backed decoration roundtrip tests.
//
// Two-client harness: client A registers a DecorationProvider over a
// MessageChannel into a real FileExplorerHost, client B attaches to
// the same host. Scenarios verify that:
//   1. Initial register fans a decoration out to every client,
//      including the registering one.
//   2. Provider's `onDidChange(ids)` updates the decoration on every
//      client.
//   3. Disposing the provider clears the decoration everywhere.
//   4. Two providers contributing to the same id merge as a set.
//
// The pattern mirrors connect.test.mjs so the Node worker_threads
// MessageChannel shape (`port1`/`port2`) matches Electron's
// MessageChannelMain — no renderer harness required.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';

import { createFileExplorerHost, connectFileExplorer } from '../dist/index.js';

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'mille-port-dec-'));
}

/** Wait for `predicate` to return truthy, polling every 10 ms up to `timeoutMs`. */
async function waitFor(predicate, { timeoutMs = 1000, stepMs = 10 } = {}) {
  const start = Date.now();
  for (;;) {
    const result = predicate();
    if (result) return result;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: predicate timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/**
 * Minimal manually-driven DecorationProvider. Tests call `fire(ids)`
 * to simulate `onDidChange`; `entries` is a Map<id, Decoration|null>
 * that `provide()` reads from.
 */
function makeProvider(id, entries = new Map()) {
  const listeners = new Set();
  return {
    id,
    entries,
    fire(ids) {
      for (const l of [...listeners]) l(ids);
    },
    onDidChange(listener) {
      listeners.add(listener);
      return {
        dispose: () => {
          listeners.delete(listener);
        },
      };
    },
    provide(entry) {
      return entries.get(entry.id) ?? null;
    },
  };
}

/**
 * Build a host, two ports, two clients against a temp root populated
 * with one file so both mirrors see the same entry id. Returns a
 * teardown helper for the test's `finally` block.
 */
async function twoClientSetup() {
  const dir = tempRoot();
  writeFileSync(join(dir, 'file-a.txt'), 'a');
  const host = await createFileExplorerHost({ roots: [dir] });
  await host.local.populateFromRoots();

  const ch1 = new MessageChannel();
  const ch2 = new MessageChannel();
  host.attachPort(ch1.port1);
  host.attachPort(ch2.port1);
  const clientA = await connectFileExplorer(ch1.port2);
  const clientB = await connectFileExplorer(ch2.port2);

  // Find the id from the host, then hydrate it through bounded expansion on
  // both clients before registering providers.
  const hostSnap = host.local.getSnapshot();
  const rootId = hostSnap.roots()[0].id;
  const kidIds = hostSnap.childrenOf(rootId);
  const fileId = kidIds.find((id) => hostSnap.getById(id)?.name === 'file-a.txt');
  assert.ok(fileId !== undefined, 'test fixture: file-a.txt present');
  clientA.setExpanded({ add: [rootId] });
  clientB.setExpanded({ add: [rootId] });
  await waitFor(() =>
    clientA.getSnapshot().getById(fileId) !== null && clientB.getSnapshot().getById(fileId) !== null
      ? true
      : null,
  );

  return {
    host,
    clientA,
    clientB,
    rootId,
    fileId,
    async teardown() {
      try {
        await clientA.dispose();
      } catch {
        /* ignore */
      }
      try {
        await clientB.dispose();
      } catch {
        /* ignore */
      }
      try {
        await host.dispose();
      } catch {
        /* ignore */
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('provider register fans a decoration out to every client', async () => {
  const s = await twoClientSetup();
  try {
    const p = makeProvider('scm', new Map([[s.fileId, { badge: 'M', color: 'yellow' }]]));
    const reg = s.clientA.registerDecorationProvider(p);

    // Wait for the delta to fan out; 16ms tick × a couple of hops.
    await waitFor(() => {
      const decs = s.clientA.getSnapshot().getDecorations(s.fileId);
      return decs.length > 0 ? decs : null;
    });
    const decsA = s.clientA.getSnapshot().getDecorations(s.fileId);
    assert.equal(decsA.length, 1);
    assert.equal(decsA[0].badge, 'M');

    const decsB = await waitFor(() => {
      const d = s.clientB.getSnapshot().getDecorations(s.fileId);
      return d.length > 0 ? d : null;
    });
    assert.equal(decsB.length, 1);
    assert.equal(decsB[0].badge, 'M');
    assert.equal(decsB[0].color, 'yellow');

    reg.dispose();
  } finally {
    await s.teardown();
  }
});

test('onDidChange(ids) update propagates to every client', async () => {
  const s = await twoClientSetup();
  try {
    const entries = new Map([[s.fileId, { badge: 'M' }]]);
    const p = makeProvider('scm', entries);
    const reg = s.clientA.registerDecorationProvider(p);

    await waitFor(() => s.clientB.getSnapshot().getDecorations(s.fileId).length > 0);

    // Flip the letter.
    entries.set(s.fileId, { badge: 'A' });
    p.fire([s.fileId]);

    const updated = await waitFor(() => {
      const d = s.clientB.getSnapshot().getDecorations(s.fileId);
      return d.length === 1 && d[0].badge === 'A' ? d : null;
    });
    assert.equal(updated[0].badge, 'A');

    const updatedA = s.clientA.getSnapshot().getDecorations(s.fileId);
    assert.equal(updatedA[0].badge, 'A');

    reg.dispose();
  } finally {
    await s.teardown();
  }
});

test('disposing the provider clears decorations everywhere', async () => {
  const s = await twoClientSetup();
  try {
    const p = makeProvider('scm', new Map([[s.fileId, { badge: 'M' }]]));
    const reg = s.clientA.registerDecorationProvider(p);
    await waitFor(() => s.clientB.getSnapshot().getDecorations(s.fileId).length > 0);

    reg.dispose();
    await waitFor(() => s.clientB.getSnapshot().getDecorations(s.fileId).length === 0);
    await waitFor(() => s.clientA.getSnapshot().getDecorations(s.fileId).length === 0);

    assert.deepEqual(s.clientA.getSnapshot().getDecorations(s.fileId), []);
    assert.deepEqual(s.clientB.getSnapshot().getDecorations(s.fileId), []);
  } finally {
    await s.teardown();
  }
});

test('two providers on the same id merge — both decorations observable', async () => {
  const s = await twoClientSetup();
  try {
    const git = makeProvider('scm', new Map([[s.fileId, { badge: 'M', color: 'yellow' }]]));
    const rules = makeProvider(
      'agent-rules',
      new Map([[s.fileId, { badge: '\u{1F916}', tooltip: 'agent rule' }]]),
    );

    const regGit = s.clientA.registerDecorationProvider(git);
    const regRules = s.clientA.registerDecorationProvider(rules);

    const decs = await waitFor(() => {
      const d = s.clientB.getSnapshot().getDecorations(s.fileId);
      return d.length === 2 ? d : null;
    });
    assert.equal(decs.length, 2);
    const badges = decs.map((d) => d.badge).sort();
    assert.deepEqual(badges, ['M', '\u{1F916}'].sort());

    regGit.dispose();
    regRules.dispose();
  } finally {
    await s.teardown();
  }
});
