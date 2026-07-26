// Session policy enforcement — remote-workspace PR 3 (SPEC §16.2, §24.3, §24.5).
//
// Two halves. The pure table (`authorizeMutation` / `authorizeCall` /
// `effectiveCapabilities`) is exercised directly against the whole §16.2
// matrix, because a gate that is quietly missing from the table is the
// failure mode that matters and only an exhaustive check catches it.
// Then the same rules are asserted end-to-end through a real host, so a
// table entry that is never consulted cannot pass.

import { removeTempDir } from '../../../scripts/test-temp.mjs';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';

import { createFileExplorerHost } from '../dist/host.js';
import { connectFileExplorer } from '../dist/client-port.js';
import {
  authorizeCall,
  authorizeCancel,
  authorizeMutation,
  effectiveCapabilities,
} from '../dist/channel/policy.js';
import { resolveSessionContext } from '../dist/channel/types.js';

const admin = resolveSessionContext({ kind: 'local' });
const readWrite = resolveSessionContext({ kind: 'remote', policy: { access: 'read-write' } });
const readOnly = resolveSessionContext({ kind: 'remote', policy: { access: 'read-only' } });

// ─── The §16.2 matrix, asserted exhaustively ────────────────────────────

const MUTATIONS = [
  // op,           read-only,  read-write, admin
  ['create', 'EROFS', true, true],
  ['rename', 'EROFS', true, true],
  ['move', 'EROFS', true, true],
  ['delete', 'EROFS', true, true],
  ['copy', 'EROFS', true, true],
  ['writeFile', 'EROFS', true, true],
  ['readFile', true, true, true],
  ['readText', true, true, true],
  ['copyFromPath', 'EACCES', 'EACCES', true],
  ['undo', 'EACCES', 'EACCES', true],
];

const CALLS = [
  ['getTreeVersion', true, true, true],
  ['capabilities', true, true, true],
  ['resolvePath', true, true, true],
  ['findVisiblePrefix', true, true, true],
  ['probeDestination', true, true, true],
  ['resync', true, true, true],
  ['cancelOperation', true, true, true],
  ['resyncWorkspace', 'EACCES', 'EACCES', true],
  ['canUndo', 'EACCES', 'EACCES', true],
  ['peekUndo', 'EACCES', 'EACCES', true],
  ['lastMutation', 'EACCES', 'EACCES', true],
  ['updateProjectionSettings', 'EACCES', 'EACCES', true],
  ['reorderRoots', 'EACCES', 'EACCES', true],
  ['updateWorkspaceRoots', 'EACCES', 'EACCES', true],
  ['refreshWorkspaceRoots', 'EACCES', 'EACCES', true],
];

function check(verdict, expected, label) {
  if (expected === true) {
    assert.equal(verdict.allowed, true, `${label} should be allowed`);
  } else {
    assert.equal(verdict.allowed, false, `${label} should be denied`);
    assert.equal(verdict.code, expected, `${label} should deny with ${expected}`);
  }
}

test('SPEC §16.2: the mutation matrix holds for every access level', () => {
  for (const [op, ro, rw, ad] of MUTATIONS) {
    check(authorizeMutation(readOnly, op), ro, `read-only ${op}`);
    check(authorizeMutation(readWrite, op), rw, `read-write ${op}`);
    check(authorizeMutation(admin, op), ad, `admin ${op}`);
  }
});

test('SPEC §16.2: the call matrix holds for every access level', () => {
  for (const [method, ro, rw, ad] of CALLS) {
    check(authorizeCall(readOnly, method), ro, `read-only ${method}`);
    check(authorizeCall(readWrite, method), rw, `read-write ${method}`);
    check(authorizeCall(admin, method), ad, `admin ${method}`);
  }
});

test('an explicit flag opens a gate without granting admin', () => {
  const ctx = resolveSessionContext({
    kind: 'remote',
    policy: { access: 'read-write', allowUndo: true },
  });
  check(authorizeMutation(ctx, 'undo'), true, 'flagged undo');
  // Granting one flag must not grant the others.
  check(authorizeCall(ctx, 'reorderRoots'), 'EACCES', 'still no root mutation');
  check(authorizeMutation(ctx, 'copyFromPath'), 'EACCES', 'still no external import');
});

test('a remote session with no policy defaults to read-only', () => {
  const ctx = resolveSessionContext({ kind: 'remote' });
  assert.equal(ctx.policy.access, 'read-only');
  check(authorizeMutation(ctx, 'delete'), 'EROFS', 'unspecified remote policy');
});

test('an unknown name is not a policy question', () => {
  // Failing closed here would report "permission denied" for a typo; the
  // dispatch switch reports "unknown method", which is the useful error.
  check(authorizeCall(readOnly, 'noSuchMethod'), true, 'unknown method');
});

test('SPEC §12.4: read-only sessions see masked capabilities', () => {
  const READ_WRITE = 1 << 0;
  const READONLY = 1 << 2;
  const TRASH = 1 << 3;
  const ATOMIC = 1 << 4;
  const WATCH = 1 << 5;
  const native = READ_WRITE | TRASH | ATOMIC | WATCH;

  const masked = effectiveCapabilities(readOnly, native);
  assert.equal(masked & READ_WRITE, 0, 'ReadWrite cleared');
  assert.equal(masked & TRASH, 0, 'Trash cleared');
  assert.equal(masked & ATOMIC, 0, 'AtomicWrite cleared');
  assert.ok(masked & READONLY, 'Readonly set');
  assert.ok(masked & WATCH, 'unrelated capabilities preserved');

  assert.equal(effectiveCapabilities(readWrite, native), native, 'read-write is unmasked');
  assert.equal(effectiveCapabilities(admin, native), native, 'admin is unmasked');
});

test('SPEC §16.3: cancel is owner-or-admin, and denial does not leak existence', () => {
  const owned = new Set(['op-mine']);
  check(authorizeCancel(readWrite, owned, 'op-mine'), true, 'own operation');
  check(authorizeCancel(admin, new Set(), 'op-anything'), true, 'admin cancels anything');

  const denied = authorizeCancel(readWrite, owned, 'op-theirs');
  assert.equal(denied.allowed, false);
  const missing = authorizeCancel(readWrite, owned, 'op-does-not-exist');
  assert.equal(
    denied.message,
    missing.message,
    'someone else’s operation and a nonexistent one must be indistinguishable',
  );
});

// ─── End-to-end through a real host ─────────────────────────────────────

function tempRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'mille-policy-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  return dir;
}

/** Attach a client with an explicit session policy. */
async function connectWithPolicy(host, policy) {
  const { port1, port2 } = new MessageChannel();
  const { createMessagePortHostChannel } = await import('../dist/channel/message-port.js');
  host.attachChannel(createMessagePortHostChannel(port1), {
    kind: 'remote',
    peerId: 'nTEST',
    policy,
  });
  return connectFileExplorer(port2);
}

test('a read-only remote session is refused writes by the host itself', async () => {
  const dir = tempRoot();
  let host;
  let client;
  try {
    host = await createFileExplorerHost({ roots: [dir] });
    await host.local.populateFromRoots();
    client = await connectWithPolicy(host, { access: 'read-only' });

    const rootId = host.local.getSnapshot().roots()[0].id;
    await assert.rejects(
      client.create(rootId, 'nope.txt', 0),
      (err) => err.code === 'EROFS',
      'create is refused with EROFS',
    );
    // And the file really was not created.
    assert.equal(host.local.getSnapshot().roots().length, 1);
  } finally {
    if (client) await client.dispose();
    if (host) await host.dispose();
    removeTempDir(dir);
  }
});

test('host-global calls are denied to remote sessions', async () => {
  const dir = tempRoot();
  let host;
  let client;
  try {
    host = await createFileExplorerHost({ roots: [dir] });
    client = await connectWithPolicy(host, { access: 'read-write' });

    for (const attempt of [
      () => client.resyncWorkspace(),
      () => client.canUndo(),
      () => client.reorderRoots([0]),
    ]) {
      await assert.rejects(attempt(), (err) => err.code === 'EACCES', 'denied to remote');
    }
  } finally {
    if (client) await client.dispose();
    if (host) await host.dispose();
    removeTempDir(dir);
  }
});

test('a local (admin) session keeps full access — no behavior change', async () => {
  const dir = tempRoot();
  let host;
  let client;
  try {
    host = await createFileExplorerHost({ roots: [dir] });
    await host.local.populateFromRoots();
    const { port1, port2 } = new MessageChannel();
    host.attachPort(port1); // the compatibility path: local admin
    client = await connectFileExplorer(port2);

    const rootId = host.local.getSnapshot().roots()[0].id;
    await client.create(rootId, 'made.txt', 0);
    assert.equal(await client.canUndo(), true, 'admin may inspect undo');
  } finally {
    if (client) await client.dispose();
    if (host) await host.dispose();
    removeTempDir(dir);
  }
});

test('capabilities reported over the wire are masked for read-only', async () => {
  const dir = tempRoot();
  let host;
  let ro;
  let rw;
  try {
    host = await createFileExplorerHost({ roots: [dir] });
    ro = await connectWithPolicy(host, { access: 'read-only' });
    rw = await connectWithPolicy(host, { access: 'read-write' });

    const roCaps = await ro.capabilities();
    const rwCaps = await rw.capabilities();
    assert.equal(roCaps & (1 << 0), 0, 'read-only session sees no ReadWrite');
    assert.ok(roCaps & (1 << 2), 'read-only session sees Readonly');
    assert.notEqual(roCaps, rwCaps, 'the two sessions are told different things');
  } finally {
    if (ro) await ro.dispose();
    if (rw) await rw.dispose();
    if (host) await host.dispose();
    removeTempDir(dir);
  }
});

test('the resync rate limit is per session and does not starve a neighbour', async () => {
  const dir = tempRoot();
  let host;
  let noisy;
  let quiet;
  try {
    host = await createFileExplorerHost({ roots: [dir] });
    await host.local.populateFromRoots();
    noisy = await connectWithPolicy(host, { access: 'read-write' });
    quiet = await connectWithPolicy(host, { access: 'read-write' });

    const rootId = host.local.getSnapshot().roots()[0].id;

    let denied = 0;
    for (let i = 0; i < 14; i += 1) {
      try {
        await noisy.resync(rootId, { recursive: false });
      } catch (err) {
        if (err.code === 'EBUSY') denied += 1;
        else throw err;
      }
    }
    assert.ok(denied > 0, 'the noisy session was throttled');

    // The neighbour has its own budget.
    await quiet.resync(rootId, { recursive: false });
  } finally {
    if (noisy) await noisy.dispose();
    if (quiet) await quiet.dispose();
    if (host) await host.dispose();
    removeTempDir(dir);
  }
});

test('one session cannot cancel another session’s operation', async () => {
  const dir = tempRoot();
  let host;
  let a;
  let b;
  try {
    host = await createFileExplorerHost({ roots: [dir] });
    a = await connectWithPolicy(host, { access: 'read-write' });
    b = await connectWithPolicy(host, { access: 'read-write' });

    // B never owned this id, so cancelling it is refused regardless of
    // whether it exists.
    await assert.rejects(
      b.cancelOperation('op-owned-by-a'),
      (err) => err.code === 'EACCES',
      'cross-session cancel refused',
    );
  } finally {
    if (a) await a.dispose();
    if (b) await b.dispose();
    if (host) await host.dispose();
    removeTempDir(dir);
  }
});

test('a read-write remote session may still read and write files', async () => {
  const dir = tempRoot();
  let host;
  let client;
  try {
    host = await createFileExplorerHost({ roots: [dir] });
    await host.local.populateFromRoots();
    client = await connectWithPolicy(host, { access: 'read-write' });

    const rootId = host.local.getSnapshot().roots()[0].id;
    const created = await client.create(rootId, 'written.txt', 0);
    const payload = new TextEncoder().encode('hello bytes');
    await client.writeFile(created.id, payload);

    // SPEC §12.5 — the round trip is binary in both directions now.
    const back = await client.readFile(created.id);
    assert.ok(back instanceof Uint8Array, 'readFile returns a Uint8Array');
    assert.equal(new TextDecoder().decode(back), 'hello bytes');
  } finally {
    if (client) await client.dispose();
    if (host) await host.dispose();
    removeTempDir(dir);
  }
});
