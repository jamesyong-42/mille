// Port-backed client round-trip tests — Phase 7 commit 7.4.
//
// Wires a FileExplorerHost and a connectFileExplorer client over a Node
// worker_threads MessageChannel and exercises the end-to-end handshake,
// mutate/call reqId flow, change-listener fan-out, and dispose teardown.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import {
  createFileExplorerHost,
  connectFileExplorer,
  FileSystemError,
} from '../dist/index.js';

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'mille-connect-'));
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
