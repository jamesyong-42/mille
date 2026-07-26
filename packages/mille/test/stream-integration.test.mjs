// Real host ⇄ real client over a byte stream — remote-workspace PR 2
// (SPEC §24.3).
//
// This is the test that proves the point of the whole PR: a genuine
// FileExplorerHost (native walker and all) serving a genuine
// PortFileExplorer across paired PassThroughs, with no MessagePort
// anywhere. Swap the PassThroughs for a Truffle mesh socket and the same
// code is a remote workspace.

import { removeTempDir } from '../../../scripts/test-temp.mjs';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Duplex } from 'node:stream';

import { createFileExplorerHost } from '../dist/host.js';
import { connectFileExplorerChannel } from '../dist/client-port.js';
import { createFramedStreamHostChannel, createFramedStreamClientChannel } from '../dist/node.js';

function duplexPair() {
  const a2b = new PassThrough();
  const b2a = new PassThrough();
  const a = Duplex.from({ readable: b2a, writable: a2b });
  const b = Duplex.from({ readable: a2b, writable: b2a });
  for (const s of [a, b, a2b, b2a]) s.on('error', () => {});
  return { a, b };
}

function tempRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'mille-stream-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'index.ts'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'src', 'util.ts'), 'export const b = 2;\n');
  writeFileSync(join(dir, 'README.md'), '# hello\n');
  return dir;
}

/** Host + client wired over a framed stream pair. */
async function connectOverStream(dir) {
  const host = await createFileExplorerHost({ roots: [dir], initialWalk: 'roots-only' });
  const { a, b } = duplexPair();
  const hostChannel = createFramedStreamHostChannel(a);
  const sub = host.attachChannel(hostChannel, {
    kind: 'remote',
    peerId: 'nTEST123',
    peerName: 'test-peer',
    exportId: 'fixture',
    policy: { access: 'read-write' },
  });
  const client = await connectFileExplorerChannel(createFramedStreamClientChannel(b));
  return { host, client, sub, hostChannel };
}

test('handshake, snapshot, expand and viewport all cross a byte stream', async () => {
  const dir = tempRoot();
  let host;
  let client;
  try {
    ({ host, client } = await connectOverStream(dir));

    assert.equal(host.sessionCount, 1, 'the stream produced a real session');

    // `initialWalk: 'roots-only'` runs asynchronously on first attach, so
    // roots ride a later delta rather than the handshake snapshot.
    const rootsBy = Date.now() + 5000;
    while (client.getSnapshot().roots().length === 0 && Date.now() < rootsBy) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const snap = client.getSnapshot();
    assert.ok(snap.roots().length >= 1, 'client received roots over the stream');

    const rootId = snap.roots()[0].id;
    await client.setExpanded({ add: [rootId], remove: [] });
    client.setViewport({ offset: 0, limit: 50, overscan: 8 });

    // Give the host's 16 ms fan-out tick a few turns to deliver the delta.
    // `expanded` is the caller's set — the mirror does not track it, so the
    // projection has to be told which folders are open.
    const expanded = new Set([rootId]);
    const deadline = Date.now() + 5000;
    let rows = [];
    while (Date.now() < deadline) {
      rows = client.getSnapshot().visibleRows({ offset: 0, limit: 50, expanded });
      if (rows.length > 1) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(rows.length > 1, `expanded root produced rows over the stream (got ${rows.length})`);
    const names = rows.map((r) => r.name);
    assert.ok(names.includes('src') || names.includes('README.md'), `saw ${names.join(', ')}`);
  } finally {
    if (client) await client.dispose();
    if (host) await host.dispose();
    removeTempDir(dir);
  }
});

test('an RPC call round-trips over the stream', async () => {
  const dir = tempRoot();
  let host;
  let client;
  try {
    ({ host, client } = await connectOverStream(dir));
    const id = await client.resolvePath('src');
    assert.ok(typeof id === 'number' || id === null, 'resolvePath answered over the stream');
  } finally {
    if (client) await client.dispose();
    if (host) await host.dispose();
    removeTempDir(dir);
  }
});

test('destroying the stream rejects pending work and freezes the mirror', async () => {
  const dir = tempRoot();
  let host;
  let client;
  try {
    const wired = await connectOverStream(dir);
    host = wired.host;
    client = wired.client;

    const before = client.getSnapshot();
    const rootCount = before.roots().length;

    const connectionEvents = [];
    client.onConnection((ev) => connectionEvents.push(ev));

    // Fire a call, then kill the transport underneath it.
    const pending = client.resolvePath('src');
    wired.hostChannel.close();

    await assert.rejects(pending, (err) => {
      assert.match(String(err.message), /connection closed|ECANCELED|disposed/i);
      return true;
    });

    await new Promise((r) => setTimeout(r, 50));
    assert.equal(connectionEvents.length, 1, 'one connection event');
    assert.equal(connectionEvents[0].state, 'closed');

    // SPEC §18.3 — the last snapshot stays readable after the drop.
    const after = client.getSnapshot();
    assert.equal(after.roots().length, rootCount, 'mirror still readable while stale');

    // A further call fails fast rather than hanging.
    await assert.rejects(client.resolvePath('src'));
  } finally {
    if (client) await client.dispose();
    if (host) await host.dispose();
    removeTempDir(dir);
  }
});

test('a malformed frame retires one session without disposing the host', async () => {
  const dir = tempRoot();
  let host;
  let clientA;
  try {
    // Session A: healthy.
    const wiredA = await connectOverStream(dir);
    host = wiredA.host;
    clientA = wiredA.client;
    assert.equal(host.sessionCount, 1);

    // Session B: attaches, then speaks garbage.
    const { a, b } = duplexPair();
    host.attachChannel(createFramedStreamHostChannel(a), {
      kind: 'remote',
      policy: { access: 'read-only' },
    });
    assert.equal(host.sessionCount, 2);
    b.write(Buffer.from('this is not a MLLE frame at all, not even close'));

    const deadline = Date.now() + 3000;
    while (host.sessionCount > 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }

    // SPEC NFR-005 — the bad session is gone, the host and session A are not.
    assert.equal(host.sessionCount, 1, 'only the malformed session was retired');
    const id = await clientA.resolvePath('src');
    assert.ok(typeof id === 'number' || id === null, 'session A still serves calls');
  } finally {
    if (clientA) await clientA.dispose();
    if (host) await host.dispose();
    removeTempDir(dir);
  }
});
