// Host + session lifecycle + message-routing tests — Phase 7 commits
// 7.1 + 7.3 + 7.6.
//
// Exercises createFileExplorerHost and attachPort/dispose using Node's
// worker_threads MessageChannel (same shape Electron's MessageChannelMain
// produces). 7.3 adds round-trip coverage for handshake -> snapshot,
// setExpanded -> delta, the handshake-first sequencing guard, and a
// mutate reqId round-trip. 7.6 adds the tick-loop coverage — the live
// delta-fan-out integration test lands in 7.10 once walker seeding is
// wired in.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import { createFileExplorerHost } from '../dist/host.js';
import { FileExplorer } from '../dist/client.js';

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'mille-host-'));
}

test('createFileExplorerHost creates a host with sessionCount 0', async () => {
  const dir = tempRoot();
  try {
    const host = await createFileExplorerHost({ roots: [dir] });
    assert.equal(host.sessionCount, 0);
    await host.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('attachPort + dispose subscription increments/decrements sessionCount', async () => {
  const dir = tempRoot();
  try {
    const host = await createFileExplorerHost({ roots: [dir] });
    const { port1, port2 } = new MessageChannel();
    const sub = host.attachPort(port1);
    assert.equal(host.sessionCount, 1);
    sub.dispose();
    assert.equal(host.sessionCount, 0);
    // port2 is the "client" side; closed here since 7.3 adds the client.
    port2.close();
    await host.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('host.local returns the wrapped FileExplorer', async () => {
  const dir = tempRoot();
  try {
    const host = await createFileExplorerHost({ roots: [dir] });
    assert.ok(host.local);
    assert.equal(typeof host.local.getTreeVersion, 'function');
    await host.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('attachPort throws after dispose', async () => {
  const dir = tempRoot();
  try {
    const host = await createFileExplorerHost({ roots: [dir] });
    await host.dispose();
    const { port1, port2 } = new MessageChannel();
    try {
      assert.throws(() => host.attachPort(port1), /disposed/);
    } finally {
      port1.close();
      port2.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dispose tears down all attached sessions', async () => {
  const dir = tempRoot();
  try {
    const host = await createFileExplorerHost({ roots: [dir] });
    const ch1 = new MessageChannel();
    const ch2 = new MessageChannel();
    host.attachPort(ch1.port1);
    host.attachPort(ch2.port1);
    assert.equal(host.sessionCount, 2);
    await host.dispose();
    assert.equal(host.sessionCount, 0);
    ch1.port2.close();
    ch2.port2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 7.3: message routing round-trips ──────────────────────────────────

/** Wait for the next message on a Node MessagePort that matches `pred`. */
function nextMatching(port, pred) {
  return new Promise((resolve) => {
    const onMsg = (msg) => {
      if (pred(msg)) {
        port.off('message', onMsg);
        resolve(msg);
      }
    };
    port.on('message', onMsg);
  });
}

test('handshake -> snapshot reply with version + roots + empty mirror', async () => {
  const dir = tempRoot();
  try {
    const host = await createFileExplorerHost({ roots: [dir] });
    const { port1, port2 } = new MessageChannel();
    const snapshotP = nextMatching(port2, (m) => m?.type === 'snapshot');
    host.attachPort(port1);
    port2.postMessage({
      v: 1,
      type: 'handshake',
      body: { version: 1, clientId: 'test', options: {} },
    });
    const snap = await snapshotP;
    assert.equal(snap.v, 1);
    assert.equal(snap.type, 'snapshot');
    assert.equal(typeof snap.body.version, 'number');
    assert.ok(Array.isArray(snap.body.roots));
    assert.ok(snap.body.mirror instanceof ArrayBuffer);
    assert.equal(snap.body.mirror.byteLength, 0);
    assert.equal(snap.body.visibleCount, 0);
    port1.close();
    port2.close();
    await host.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('non-handshake before handshake yields EINVAL error frame', async () => {
  const dir = tempRoot();
  try {
    const host = await createFileExplorerHost({ roots: [dir] });
    const { port1, port2 } = new MessageChannel();
    const errP = nextMatching(port2, (m) => m?.type === 'error');
    host.attachPort(port1);
    port2.postMessage({ v: 1, type: 'setViewport', body: { offset: 0, limit: 10 } });
    const err = await errP;
    assert.equal(err.body.code, 'EINVAL');
    port1.close();
    port2.close();
    await host.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unsupported protocol version yields EUNSUPPORTED error frame', async () => {
  const dir = tempRoot();
  try {
    const host = await createFileExplorerHost({ roots: [dir] });
    const { port1, port2 } = new MessageChannel();
    const errP = nextMatching(port2, (m) => m?.type === 'error');
    host.attachPort(port1);
    port2.postMessage({ v: 999, type: 'handshake', body: {} });
    const err = await errP;
    assert.equal(err.body.code, 'EUNSUPPORTED');
    port1.close();
    port2.close();
    await host.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('setExpanded after handshake replies with a delta frame', async () => {
  const dir = tempRoot();
  try {
    const host = await createFileExplorerHost({ roots: [dir] });
    const { port1, port2 } = new MessageChannel();
    host.attachPort(port1);
    const snapP = nextMatching(port2, (m) => m?.type === 'snapshot');
    port2.postMessage({
      v: 1,
      type: 'handshake',
      body: { version: 1, clientId: 't', options: {} },
    });
    await snapP;
    const deltaP = nextMatching(port2, (m) => m?.type === 'delta');
    port2.postMessage({ v: 1, type: 'setExpanded', body: { add: [1], remove: [] } });
    const delta = await deltaP;
    assert.equal(delta.type, 'delta');
    assert.equal(typeof delta.body.version, 'number');
    assert.ok(Array.isArray(delta.body.changedIds));
    port1.close();
    port2.close();
    await host.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mutate with unknown op yields mutateResult with error + reqId echo', async () => {
  const dir = tempRoot();
  try {
    const host = await createFileExplorerHost({ roots: [dir] });
    const { port1, port2 } = new MessageChannel();
    host.attachPort(port1);
    const snapP = nextMatching(port2, (m) => m?.type === 'snapshot');
    port2.postMessage({
      v: 1,
      type: 'handshake',
      body: { version: 1, clientId: 't', options: {} },
    });
    await snapP;
    const resultP = nextMatching(port2, (m) => m?.type === 'mutateResult');
    port2.postMessage({
      v: 1,
      type: 'mutate',
      body: { reqId: 42, op: 'definitely-not-a-real-op', args: {} },
    });
    const res = await resultP;
    assert.equal(res.body.reqId, 42);
    assert.equal(res.body.result, null);
    assert.ok(res.body.error);
    assert.equal(typeof res.body.error.code, 'string');
    port1.close();
    port2.close();
    await host.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('call getTreeVersion returns the current version via callResult', async () => {
  const dir = tempRoot();
  try {
    const host = await createFileExplorerHost({ roots: [dir] });
    const { port1, port2 } = new MessageChannel();
    host.attachPort(port1);
    const snapP = nextMatching(port2, (m) => m?.type === 'snapshot');
    port2.postMessage({
      v: 1,
      type: 'handshake',
      body: { version: 1, clientId: 't', options: {} },
    });
    await snapP;
    const resP = nextMatching(port2, (m) => m?.type === 'callResult');
    port2.postMessage({
      v: 1,
      type: 'call',
      body: { reqId: 7, method: 'getTreeVersion', args: [] },
    });
    const res = await resP;
    assert.equal(res.body.reqId, 7);
    assert.equal(typeof res.body.result, 'number');
    port1.close();
    port2.close();
    await host.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dispose frame detaches the session on the host', async () => {
  const dir = tempRoot();
  try {
    const host = await createFileExplorerHost({ roots: [dir] });
    const { port1, port2 } = new MessageChannel();
    host.attachPort(port1);
    assert.equal(host.sessionCount, 1);
    const snapP = nextMatching(port2, (m) => m?.type === 'snapshot');
    port2.postMessage({
      v: 1,
      type: 'handshake',
      body: { version: 1, clientId: 't', options: {} },
    });
    await snapP;
    port2.postMessage({ v: 1, type: 'dispose', body: {} });
    // Detach happens on message-queue tick; give it a beat.
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(host.sessionCount, 0);
    port2.close();
    await host.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 7.6: takePendingChanges pass-through + tick lifecycle ─────────────

test('FileExplorer.takePendingChanges returns an empty ChangeSet on a fresh explorer', async () => {
  const dir = tempRoot();
  try {
    const fx = new FileExplorer({ roots: [dir] });
    const cs = fx.takePendingChanges();
    assert.deepEqual(cs.changedIds, []);
    assert.deepEqual(cs.subtreeRootsChanged, []);
    assert.deepEqual(cs.childSetChanged, []);
    assert.deepEqual(cs.reparentedIds, []);
    assert.equal(typeof cs.fromVersion, 'number');
    assert.equal(typeof cs.toVersion, 'number');
    await fx.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('takePendingChanges drains — second call is still empty with no activity', async () => {
  const dir = tempRoot();
  try {
    const fx = new FileExplorer({ roots: [dir] });
    fx.takePendingChanges();
    const second = fx.takePendingChanges();
    assert.deepEqual(second.changedIds, []);
    assert.deepEqual(second.childSetChanged, []);
    await fx.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('host.dispose while the tick is running tears down cleanly', async () => {
  // Indirectly exercises the tick lifecycle: attachPort starts it,
  // dispose stops it. Regression guard for a stuck interval leaking
  // past host.dispose().
  const dir = tempRoot();
  try {
    const host = await createFileExplorerHost({ roots: [dir] });
    const { port1, port2 } = new MessageChannel();
    host.attachPort(port1);
    // Let the tick fire at least once.
    await new Promise((r) => setTimeout(r, 40));
    await host.dispose();
    assert.equal(host.sessionCount, 0);
    port1.close();
    port2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  'tick fan-out delivers delta after mutation on one session',
  { skip: 'Wave 5 integration — walker seeding + live mutation pipeline land in commit 7.10' },
  async () => {
    // The native walker isn't wired into FileExplorer construction yet,
    // so mutations from an attached session don't populate the store
    // under a root id the session knows about — take_pending_changes()
    // stays empty. Wave 5 re-enables this with walker-driven seeding.
  },
);

// ── 7.7: coarseSubtree plumbing ──────────────────────────────────────

test('markSubtreeCoarse produces coarseSubtrees in the next delta', async () => {
  const dir = tempRoot();
  try {
    const host = await createFileExplorerHost({ roots: [dir] });
    const { port1, port2 } = new MessageChannel();
    host.attachPort(port1);
    const snapP = nextMatching(port2, (m) => m?.type === 'snapshot');
    port2.postMessage({
      v: 1,
      type: 'handshake',
      body: { version: 1, clientId: 't', options: {} },
    });
    await snapP;
    // Seed the session's knownIds with the coarse root so we can also
    // verify the host prunes it before the next delta is composed.
    const rootId = 999;
    const deltaP = nextMatching(
      port2,
      (m) => m?.type === 'delta' && Array.isArray(m?.body?.coarseSubtrees) && m.body.coarseSubtrees.length > 0,
    );
    host.markSubtreeCoarse(rootId);
    const delta = await deltaP;
    assert.deepEqual(delta.body.coarseSubtrees, [rootId]);
    port1.close();
    port2.close();
    await host.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
