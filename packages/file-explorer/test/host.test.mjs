// Host + session lifecycle smoke tests — Phase 7 commit 7.1.
//
// Exercises createFileExplorerHost and attachPort/dispose using Node's
// worker_threads MessageChannel (same shape Electron's MessageChannelMain
// produces). Protocol routing lands in 7.3; these tests only prove
// session bookkeeping.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import { createFileExplorerHost } from '../dist/host.js';

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
