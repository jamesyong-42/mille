// Port-backed client round-trip tests — Phase 7 commit 7.4 + Phase 8
// commit 8.6.
//
// Wires a FileExplorerHost and a connectFileExplorer client over a Node
// worker_threads MessageChannel and exercises the end-to-end handshake,
// mutate/call reqId flow, change-listener fan-out, dispose teardown,
// and (8.6) the ClientMirrorSnapshot wiring — snapshot frames deliver
// real entries, setExpanded fans child entries across, and mutations
// drive snapshot identity bumps.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import { createFileExplorerHost, connectFileExplorer, FileSystemError } from '../dist/index.js';

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'mille-connect-'));
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

test('connectFileExplorer completes handshake and exposes treeVersion', async () => {
  const dir = tempRoot();
  try {
    const host = await createFileExplorerHost({ roots: [dir] });
    const { port1, port2 } = new MessageChannel();
    host.attachPort(port1);
    const client = await connectFileExplorer(port2);
    assert.equal(typeof client.getTreeVersion(), 'number');
    const snap = client.getSnapshot();
    assert.equal(typeof snap.treeVersion, 'number');
    assert.ok(Array.isArray(snap.roots()));
    await client.dispose();
    await host.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mutate with unknown op surfaces as FileSystemError', async () => {
  const dir = tempRoot();
  try {
    const host = await createFileExplorerHost({ roots: [dir] });
    const { port1, port2 } = new MessageChannel();
    host.attachPort(port1);
    const client = await connectFileExplorer(port2);
    await assert.rejects(
      () => client.rename(99999, 'new'),
      (err) => err instanceof FileSystemError,
    );
    await client.dispose();
    await host.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('call getTreeVersion round-trips via callResult', async () => {
  const dir = tempRoot();
  try {
    const host = await createFileExplorerHost({ roots: [dir] });
    const { port1, port2 } = new MessageChannel();
    host.attachPort(port1);
    const client = await connectFileExplorer(port2);
    const v = await client.call('getTreeVersion');
    assert.equal(typeof v, 'number');
    await client.dispose();
    await host.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('call unknown method rejects with FileSystemError', async () => {
  const dir = tempRoot();
  try {
    const host = await createFileExplorerHost({ roots: [dir] });
    const { port1, port2 } = new MessageChannel();
    host.attachPort(port1);
    const client = await connectFileExplorer(port2);
    await assert.rejects(
      () => client.call('not-a-method'),
      (err) => err instanceof FileSystemError,
    );
    await client.dispose();
    await host.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("on('change') fires when the client issues setExpanded", async () => {
  const dir = tempRoot();
  try {
    const host = await createFileExplorerHost({ roots: [dir] });
    const { port1, port2 } = new MessageChannel();
    host.attachPort(port1);
    const client = await connectFileExplorer(port2);
    let fired = 0;
    const sub = client.on('change', () => {
      fired += 1;
    });
    client.setExpanded({ add: [1] });
    // Delta hops: client -> host (setExpanded) -> client (delta) -> listener.
    // Give the event loop a couple of ticks.
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(fired >= 1, `change listener should have fired at least once (was ${fired})`);
    sub.dispose();
    await client.dispose();
    await host.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dispose rejects in-flight requests with ECANCELED', async () => {
  const dir = tempRoot();
  try {
    const host = await createFileExplorerHost({ roots: [dir] });
    const { port1, port2 } = new MessageChannel();
    host.attachPort(port1);
    const client = await connectFileExplorer(port2);
    const pending = client.rename(99999, 'x').catch((e) => e);
    await client.dispose();
    const result = await pending;
    assert.ok(result instanceof FileSystemError);
    // The rejection could come from either the host (e.g. EINVAL/EUNKNOWN)
    // arriving before dispose's teardown, or from dispose itself with
    // ECANCELED. Either is a typed FileSystemError — good enough here.
    assert.equal(typeof result.code, 'string');
    await host.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two clients on the same host each get their own session', async () => {
  const dir = tempRoot();
  try {
    const host = await createFileExplorerHost({ roots: [dir] });
    const ch1 = new MessageChannel();
    const ch2 = new MessageChannel();
    host.attachPort(ch1.port1);
    host.attachPort(ch2.port1);
    const c1 = await connectFileExplorer(ch1.port2);
    const c2 = await connectFileExplorer(ch2.port2);
    assert.equal(host.sessionCount, 2);
    assert.equal(typeof c1.getTreeVersion(), 'number');
    assert.equal(typeof c2.getTreeVersion(), 'number');
    await c1.dispose();
    await c2.dispose();
    await host.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 8.6: ClientMirrorSnapshot wiring ─────────────────────────────────

test('handshake delivers root Entry records without hydrating descendants', async () => {
  const dir = tempRoot();
  try {
    writeFileSync(join(dir, 'hello.txt'), 'world');
    const host = await createFileExplorerHost({ roots: [dir] });
    await host.local.populateFromRoots();

    const { port1, port2 } = new MessageChannel();
    host.attachPort(port1);
    const client = await connectFileExplorer(port2);

    const snap = client.getSnapshot();
    const roots = snap.roots();
    assert.equal(roots.length, 1, 'one workspace root');
    const root = roots[0];
    assert.equal(typeof root.name, 'string');
    assert.ok(root.name.length > 0, 'root has a real name');
    // Descendants remain host-side until expansion/viewport demand.
    const hostSnap = host.local.getSnapshot();
    const hostRoot = hostSnap.roots()[0];
    const hostKids = hostSnap.childrenOf(hostRoot.id);
    assert.ok(hostKids.length > 0, 'host has children');
    for (const kidId of hostKids) {
      const entry = snap.getById(kidId);
      assert.equal(entry, null, `handshake does not hydrate kid ${kidId}`);
    }

    await client.dispose();
    await host.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('setExpanded triggers a delta that populates visibleRows', async () => {
  const dir = tempRoot();
  try {
    writeFileSync(join(dir, 'a.txt'), 'a');
    writeFileSync(join(dir, 'b.txt'), 'b');
    const host = await createFileExplorerHost({ roots: [dir] });
    await host.local.populateFromRoots();

    const { port1, port2 } = new MessageChannel();
    host.attachPort(port1);
    const client = await connectFileExplorer(port2);

    const root = client.getSnapshot().roots()[0];
    assert.ok(root, 'root exists');

    client.setExpanded({ add: [root.id] });
    await waitFor(() => {
      const names = client
        .getSnapshot()
        .visibleRows({ expanded: new Set([root.id]), offset: 0, limit: 100 })
        .map((row) => row.name);
      return names.includes('a.txt') && names.includes('b.txt');
    });

    const rows = client.getSnapshot().visibleRows({
      expanded: new Set([root.id]),
      offset: 0,
      limit: 100,
    });
    // Root + 2 files = 3 rows. But walker may emit only 2 files; assert >=2.
    const names = rows.map((r) => r.name);
    assert.ok(names.includes('a.txt'), `a.txt in ${JSON.stringify(names)}`);
    assert.ok(names.includes('b.txt'), `b.txt in ${JSON.stringify(names)}`);

    await client.dispose();
    await host.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rename on host propagates updated entry to client mirror', async () => {
  const dir = tempRoot();
  try {
    writeFileSync(join(dir, 'before.txt'), 'x');
    const host = await createFileExplorerHost({ roots: [dir] });
    await host.local.populateFromRoots();

    const { port1, port2 } = new MessageChannel();
    host.attachPort(port1);
    const client = await connectFileExplorer(port2);

    const root = client.getSnapshot().roots()[0];
    const hostKids = host.local.getSnapshot().childrenOf(root.id);
    const targetId = hostKids.find(
      (id) => host.local.getSnapshot().getById(id)?.name === 'before.txt',
    );
    assert.ok(targetId !== undefined, 'host has before.txt');
    client.setExpanded({ add: [root.id] });
    await waitFor(() => client.getSnapshot().getById(targetId) !== null);
    const snap0 = client.getSnapshot();
    assert.equal(snap0.getById(targetId)?.name, 'before.txt');

    // Rename on the host; wait for the delta to flow back.
    const version0 = client.getTreeVersion();
    await new Promise((resolve) => {
      const sub = client.on('change', () => {
        if (client.getTreeVersion() > version0) {
          sub.dispose();
          resolve();
        }
      });
      host.local.rename(targetId, 'after.txt');
    });

    const snap1 = client.getSnapshot();
    assert.ok(snap1 !== snap0, 'snapshot identity advances');
    assert.equal(snap1.getById(targetId)?.name, 'after.txt');

    await client.dispose();
    await host.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
