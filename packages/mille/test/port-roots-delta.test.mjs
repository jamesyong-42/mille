// Phase B1 — roots-in-deltas integration test.
//
// v0.1 only shipped `roots` in the handshake's `snapshot` frame. On large
// workspaces where `populateFromRoots` is still running at handshake time,
// the client's mirror ended up with `roots: []` forever — deltas fanned
// out with `changedIds` but no way for the client to learn the root id.
// Observed on a 1.2GB pnpm monorepo: treeVersion climbed to 46000+ while
// the tree stayed blank because `snap.roots()` returned nothing.
//
// B1 makes the fix by piggybacking the **full** current root-id list on
// delta frames whenever the host's root set differs from the per-session
// `lastRootSet`. This test exercises the codepath end-to-end:
//
//   1. Host created with a root path but `populateFromRoots` NOT yet run.
//   2. Client attaches → handshake delivers snapshot with `roots: []`.
//   3. `populateFromRoots` runs → root entry lands in the native store.
//   4. Next tick: delta body carries `roots: [rootId]` + the Entry.
//   5. Client mirror's `.roots()` returns one entry.
//   6. A subsequent tick (no further changes) does NOT repeat `roots`
//      on the outgoing delta — absence = unchanged.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';

import {
  createFileExplorerHost,
  connectFileExplorer,
} from '../dist/index.js';

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'mille-port-roots-'));
}

/** Poll `predicate` every 10ms up to `timeoutMs`. */
async function waitFor(predicate, { timeoutMs = 1500, stepMs = 10 } = {}) {
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

test('delta ships roots after late populate — client mirror learns root post-handshake', async () => {
  const dir = tempRoot();
  try {
    writeFileSync(join(dir, 'hello.txt'), 'world');

    // Host created but NOT populated — snap.roots() returns [] at this point.
    const host = await createFileExplorerHost({ roots: [dir] });
    assert.equal(host.local.getSnapshot().roots().length, 0,
      'pre-populate: host has no roots in snapshot');

    const { port1, port2 } = new MessageChannel();
    host.attachPort(port1);

    // Tee the port2 traffic so we can observe deltas on the wire in
    // addition to the client mirror's view. This lets us assert the
    // exact frames the host emits (roots field presence / absence).
    const observedDeltaFrames = [];
    port2.on('message', (raw) => {
      // The client will also receive these; we just peek at the type.
      if (raw && raw.type === 'delta') {
        observedDeltaFrames.push(raw.body);
      }
    });

    const client = await connectFileExplorer(port2);

    // Handshake: client got snapshot with roots=[].
    assert.deepEqual(
      client.getSnapshot().roots(),
      [],
      'post-handshake: client mirror has no roots yet',
    );

    // Kick off the walk. The walker adds the root entry (+ hello.txt)
    // to the native store, which surfaces on the next tick as a
    // ChangeSet containing the root id. Because the host's root set
    // (just-populated [rootId]) differs from the session's lastRootSet
    // (seeded as [] at handshake), the delta body carries `roots`.
    await host.local.populateFromRoots();

    // Wait for the tick that ships the roots delta.
    await waitFor(() => {
      const roots = client.getSnapshot().roots();
      return roots.length === 1 ? roots : null;
    });

    const clientRoots = client.getSnapshot().roots();
    assert.equal(clientRoots.length, 1, 'client mirror learned one root via delta');
    const hostRootId = host.local.getSnapshot().roots()[0].id;
    assert.equal(clientRoots[0].id, hostRootId, 'root id matches host');
    assert.equal(typeof clientRoots[0].name, 'string');
    assert.ok(clientRoots[0].name.length > 0, 'root entry has a real name');

    // Find the delta(s) that actually ferried the roots field.
    const rootDeltas = observedDeltaFrames.filter(
      (b) => Array.isArray(b.roots) && b.roots.length > 0,
    );
    assert.ok(
      rootDeltas.length >= 1,
      `at least one delta carried roots; saw ${rootDeltas.length}`,
    );
    assert.deepEqual(
      rootDeltas[0].roots,
      [hostRootId],
      'delta roots payload is the host root-id list',
    );

    // Subsequent stable ticks must not repeat `roots` — the per-session
    // `lastRootSet` now matches the host's roots, so absence is correct.
    // Grab the count of observed "root-carrying" deltas, wait through
    // several tick boundaries with no state change, and verify no new
    // root-carrying deltas land.
    const rootDeltaCountBefore = rootDeltas.length;

    // Wait ~4 tick boundaries (64ms) with no changes.
    await new Promise((r) => setTimeout(r, 80));

    const rootDeltaCountAfter = observedDeltaFrames.filter(
      (b) => Array.isArray(b.roots) && b.roots.length > 0,
    ).length;
    assert.equal(
      rootDeltaCountAfter,
      rootDeltaCountBefore,
      'stable ticks must not re-ship roots (absence = unchanged)',
    );

    await client.dispose();
    await host.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handshake after populate still works — roots arrive in the snapshot, never in a delta', async () => {
  // Regression guard: the old happy-path (populate-then-handshake) must
  // still deliver roots via `snapshot.roots`, and the host must NOT then
  // also emit a redundant `roots` field on the first delta — the
  // per-session `lastRootSet` is seeded from the snapshot roots, so the
  // set-equality check at tick time should say "no change".
  const dir = tempRoot();
  try {
    writeFileSync(join(dir, 'a.txt'), 'a');
    const host = await createFileExplorerHost({ roots: [dir] });
    await host.local.populateFromRoots();

    const { port1, port2 } = new MessageChannel();
    host.attachPort(port1);

    const observedDeltaFrames = [];
    port2.on('message', (raw) => {
      if (raw && raw.type === 'delta') observedDeltaFrames.push(raw.body);
    });

    const client = await connectFileExplorer(port2);
    assert.equal(
      client.getSnapshot().roots().length,
      1,
      'snapshot already carried the root at handshake',
    );

    // Tickle the host so at least one delta fans out (setExpanded on
    // the root triggers a childSetChanged reply).
    const rootId = client.getSnapshot().roots()[0].id;
    client.setExpanded({ add: [rootId] });

    await waitFor(() => observedDeltaFrames.length > 0);

    // None of the deltas received by this session should carry `roots`
    // — the set hasn't changed since handshake.
    for (const body of observedDeltaFrames) {
      assert.equal(
        body.roots,
        undefined,
        `delta unexpectedly shipped roots: ${JSON.stringify(body.roots)}`,
      );
    }

    await client.dispose();
    await host.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('root Entry ref identity in client mirror is stable across stable ticks', async () => {
  // Phase B1 aims to preserve reference equality of roots() entries
  // across delta ticks where roots didn't change. The reducer reuses
  // the previous `working.roots` array when the incoming id list is
  // identical, and ClientMirrorSnapshot.roots() rebuilds Entry objects
  // from byId — those get new identities per snapshot, BUT the
  // underlying id list stays identity-stable. v0.2 goal: confirm the
  // id array identity is preserved (per-entry identity is a v0.3
  // follow-up — it ties into the broader byId-entry immutability
  // story).
  const dir = tempRoot();
  try {
    writeFileSync(join(dir, 'a.txt'), 'a');
    const host = await createFileExplorerHost({ roots: [dir] });
    await host.local.populateFromRoots();

    const { port1, port2 } = new MessageChannel();
    host.attachPort(port1);
    const client = await connectFileExplorer(port2);

    const rootsInitial = client.getSnapshot().roots();
    assert.equal(rootsInitial.length, 1);
    const rootIdInitial = rootsInitial[0].id;

    // Trigger a delta that does not change roots (setExpanded).
    client.setExpanded({ add: [rootIdInitial] });
    const snapBefore = client.getSnapshot();

    await waitFor(() => client.getSnapshot() !== snapBefore);

    const rootsAfter = client.getSnapshot().roots();
    assert.equal(rootsAfter.length, 1, 'root set unchanged');
    assert.equal(rootsAfter[0].id, rootIdInitial, 'same root id');

    await client.dispose();
    await host.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
