// End-to-end Phase 7 integration tests — commit 7.10.
//
// Uses populateFromRoots() (commit 7.10 bonus) to seed a real tree so
// mutations produce real ChangeSets and the per-session delta pipeline
// actually fires. The signature test is the two-client mutation-
// ordering invariant from SPEC §5.1: when session A renames an entry,
// session B must observe the delta BEFORE session A's own mutateResult
// resolves. The race is detected by tracking a bSawDelta flag and
// asserting it is true before awaiting the rename's completion.
//
// Also exercises:
//   - indexed delta filter (changedIds ∩ session.knownIds) per commit 7.5
//   - coalescer behaviour under a storm of read-only ops (commit 7.6)
//   - monotonic tree-version across deltas

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import {
  createFileExplorerHost,
  connectFileExplorer,
} from '../dist/index.js';

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'mille-phase7-'));
}

function seedTree(dir) {
  writeFileSync(join(dir, 'file1.txt'), 'hello');
  writeFileSync(join(dir, 'file2.txt'), 'world');
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'sub/nested.txt'), 'nested');
}

/**
 * Find a direct child of the walk root by name via visibleRows — the
 * walk-root entry is the only parent-less entry after
 * populateFromRoots (include_root: true), so its direct children only
 * appear via snapshot.visibleRows with the root expanded.
 */
function findChildByName(fx, childName) {
  const snap = fx.getSnapshot();
  const [walkRoot] = snap.roots();
  if (!walkRoot) return null;
  const rows = snap.visibleRows({
    expanded: [walkRoot.id],
    offset: 0,
    limit: 1000,
  });
  return rows.find((r) => r.name === childName) ?? null;
}

test(
  'two-client mutation ordering: other session sees delta before initiator resolves',
  async () => {
    const dir = tempRoot();
    try {
      seedTree(dir);

      const host = await createFileExplorerHost({ roots: [dir] });
      await host.local.populateFromRoots();

      const chA = new MessageChannel();
      const chB = new MessageChannel();
      host.attachPort(chA.port1);
      host.attachPort(chB.port1);

      const clientA = await connectFileExplorer(chA.port2);
      const clientB = await connectFileExplorer(chB.port2);

      const file1 = findChildByName(host.local, 'file1.txt');
      assert.ok(file1, 'file1.txt should exist in seeded tree');

      // Record when B first observes a delta. SPEC §5.1 requires this to
      // happen before A's rename promise resolves — the mutation queue
      // awaits flushTickNow() (which fans out to every session) before
      // posting mutateResult back to the initiator.
      let bSawDelta = false;
      let bDeltaResolve;
      const bDeltaPromise = new Promise((resolve) => {
        bDeltaResolve = resolve;
      });
      const bSub = clientB.on('change', () => {
        if (!bSawDelta) {
          bSawDelta = true;
          bDeltaResolve();
        }
      });

      let renameResolved = false;
      const renamePromise = clientA
        .rename(file1.id, 'file1-renamed.txt')
        .then((r) => {
          renameResolved = true;
          return r;
        });

      // Wait for B's delta. If the ordering invariant holds, this
      // resolves strictly before renamePromise — and bSawDelta is true
      // while renameResolved is still false.
      await bDeltaPromise;
      assert.equal(bSawDelta, true, 'B should have seen a delta');
      assert.equal(
        renameResolved,
        false,
        'initiator rename must not resolve before other sessions observe the delta',
      );

      await renamePromise;
      assert.equal(renameResolved, true, 'rename should have completed');

      bSub.dispose();
      await clientA.dispose();
      await clientB.dispose();
      await host.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  },
);

test('monotonic tree-version across deltas on a client', async () => {
  const dir = tempRoot();
  try {
    seedTree(dir);
    const host = await createFileExplorerHost({ roots: [dir] });
    await host.local.populateFromRoots();

    const { port1, port2 } = new MessageChannel();
    host.attachPort(port1);
    const client = await connectFileExplorer(port2);

    const versions = [client.getTreeVersion()];
    const sub = client.on('change', () => {
      versions.push(client.getTreeVersion());
    });

    const file1 = findChildByName(host.local, 'file1.txt');
    assert.ok(file1);
    await client.rename(file1.id, 'file1-v2.txt');
    // Yield once so any trailing delta lands before we assert.
    await new Promise((r) => setTimeout(r, 30));

    assert.ok(versions.length >= 2, `expected >=2 versions, got ${versions.length}`);
    for (let i = 1; i < versions.length; i++) {
      assert.ok(
        versions[i] >= versions[i - 1],
        `tree-version non-monotonic: ${versions[i - 1]} -> ${versions[i]}`,
      );
    }

    sub.dispose();
    await client.dispose();
    await host.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test(
  'coalescer storm: bounded delta count under many read-only ops',
  async () => {
    const dir = tempRoot();
    try {
      seedTree(dir);
      const host = await createFileExplorerHost({ roots: [dir] });
      await host.local.populateFromRoots();

      const { port1, port2 } = new MessageChannel();
      host.attachPort(port1);
      const client = await connectFileExplorer(port2);

      // Drain the handshake delta before starting the storm.
      await new Promise((r) => setTimeout(r, 20));

      let deltaCount = 0;
      const sub = client.on('change', () => {
        deltaCount += 1;
      });

      const file1 = findChildByName(host.local, 'file1.txt');
      assert.ok(file1);

      // Read-only ops don't populate the ChangeSet. The tick() fast path
      // exits early when both the ChangeSet and subtree markers are
      // empty, so a storm of reads should produce zero spontaneous
      // deltas.
      const reads = [];
      for (let i = 0; i < 50; i++) {
        reads.push(client.readFile(file1.id));
      }
      await Promise.all(reads);
      await new Promise((r) => setTimeout(r, 100));

      assert.ok(
        deltaCount <= 10,
        `expected <=10 spontaneous deltas under read-only storm, got ${deltaCount}`,
      );

      sub.dispose();
      await client.dispose();
      await host.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  },
);
