// AC-004: remote filesystem changes reach a remote mirror through the
// watcher/delta path, without the client polling per file.
//
// This is the criterion that had no coverage at all. Every other probe drove
// *client-initiated* operations — browse, expand, mutate — which proves the
// request path works and says nothing about whether a file someone else
// touches on the serving machine ever arrives. That is arguably the headline
// feature of a remote workspace, so it gets its own suite.
//
// Runs over an in-process fake mesh with a real watcher on a real temp
// directory: the filesystem events are genuine, only the transport is local.

import { removeTempDir } from '../../../scripts/test-temp.mjs';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Duplex } from 'node:stream';
import { EventEmitter } from 'node:events';

import { serveMille, connectMille } from '../dist/index.js';

const WATCH_DEBOUNCE_MS = 40;

async function waitFor(predicate, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value !== null && value !== undefined && value !== false) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function socketPair() {
  const a2b = new PassThrough();
  const b2a = new PassThrough();
  const server = Duplex.from({ readable: a2b, writable: b2a });
  const client = Duplex.from({ readable: b2a, writable: a2b });
  for (const s of [server, client, a2b, b2a]) s.on('error', () => {});
  server.remotePeerId = 'nWATCH001CNTRL';
  server.remotePeerName = 'watch peer';
  return { server, client };
}

class FakeMeshServer extends EventEmitter {
  #listener;
  port;
  constructor(listener) {
    super();
    this.#listener = listener;
  }
  listen(port) {
    this.port = port;
    queueMicrotask(() => this.emit('listening'));
    return this;
  }
  close(cb) {
    this.closed = true;
    if (cb) queueMicrotask(cb);
    return this;
  }
  accept(socket) {
    this.#listener(socket);
  }
}

function loopbackMesh() {
  const mesh = { net: {}, servers: [] };
  mesh.net.createServer = (listener) => {
    const s = new FakeMeshServer(listener);
    mesh.servers.push(s);
    return s;
  };
  mesh.net.connect = () => {
    const { server, client } = socketPair();
    queueMicrotask(() => {
      if (mesh.servers[0] && !mesh.servers[0].closed) mesh.servers[0].accept(server);
      client.emit('connect');
    });
    return client;
  };
  return mesh;
}

/** A served export with the watcher on a short debounce. */
async function servedWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'mille-watch-remote-'));
  writeFileSync(join(dir, 'existing.txt'), 'here first\n');

  const mesh = loopbackMesh();
  const server = await serveMille(mesh, {
    exports: {
      work: {
        label: 'Watched',
        roots: [dir],
        access: 'read-write',
        explorer: { initialWalk: 'roots-only', watchDebounceMs: WATCH_DEBOUNCE_MS },
      },
    },
  });
  const remote = await connectMille(mesh, {
    peer: 'fake',
    exportId: 'work',
    access: 'read-write',
    reconnect: false,
  });

  const rootId = await waitFor(() => remote.explorer.getSnapshot().roots()[0]?.id, 'root id');
  await remote.explorer.setExpanded({ add: [rootId], remove: [] });
  remote.explorer.setViewport({ offset: 0, limit: 100, overscan: 8 });

  return { dir, server, remote, rootId, expanded: new Set([rootId]) };
}

/**
 * Rows the client can currently see.
 *
 * The client mirror has no `childrenOf` — that lives on the native snapshot.
 * `visibleRows` is the projection a renderer actually consumes, so asserting
 * against it is closer to what a user would observe anyway.
 */
function rows(remote, expanded) {
  return remote.explorer.getSnapshot().visibleRows({ offset: 0, limit: 200, expanded });
}

function visibleNames(remote, expanded) {
  return rows(remote, expanded).map((r) => r.name);
}

test('AC-004: a file created on the server appears in the remote mirror', async () => {
  const { dir, server, remote, rootId, expanded } = await servedWorkspace();
  try {
    await waitFor(() => visibleNames(remote, expanded).includes('existing.txt'), 'initial listing');

    // Nobody asked for this. It happens on the serving machine, and the
    // client must learn about it through the watcher → delta path.
    writeFileSync(join(dir, 'appeared.txt'), 'written by someone else\n');

    await waitFor(
      () => visibleNames(remote, expanded).includes('appeared.txt'),
      'externally created file to reach the client',
    );
  } finally {
    await remote.close();
    await server.close();
    removeTempDir(dir);
  }
});

test('AC-004: a deletion on the server is reflected remotely', async () => {
  const { dir, server, remote, rootId, expanded } = await servedWorkspace();
  try {
    await waitFor(() => visibleNames(remote, expanded).includes('existing.txt'), 'initial listing');

    rmSync(join(dir, 'existing.txt'));

    await waitFor(
      () => !visibleNames(remote, expanded).includes('existing.txt'),
      'deletion to reach the client',
    );
  } finally {
    await remote.close();
    await server.close();
    removeTempDir(dir);
  }
});

test('AC-004: a rename on the server arrives as one change, not add+drop of identity', async () => {
  const { dir, server, remote, rootId, expanded } = await servedWorkspace();
  try {
    await waitFor(() => visibleNames(remote, expanded).includes('existing.txt'), 'initial listing');

    renameSync(join(dir, 'existing.txt'), join(dir, 'renamed.txt'));

    await waitFor(
      () =>
        visibleNames(remote, expanded).includes('renamed.txt') &&
        !visibleNames(remote, expanded).includes('existing.txt'),
      'rename to reach the client',
    );
  } finally {
    await remote.close();
    await server.close();
    removeTempDir(dir);
  }
});

test('AC-004: a new directory and its contents arrive on expansion', async () => {
  const { dir, server, remote, rootId, expanded } = await servedWorkspace();
  try {
    await waitFor(() => visibleNames(remote, expanded).includes('existing.txt'), 'initial listing');

    mkdirSync(join(dir, 'fresh'));
    writeFileSync(join(dir, 'fresh', 'inner.ts'), 'export const x = 1;\n');

    const freshId = await waitFor(
      () => rows(remote, expanded).find((r) => r.name === 'fresh')?.id ?? null,
      'new directory to reach the client',
    );

    await remote.explorer.setExpanded({ add: [freshId], remove: [] });
    const deeper = new Set([rootId, freshId]);
    await waitFor(() => visibleNames(remote, deeper).includes('inner.ts'), 'its child on expand');
  } finally {
    await remote.close();
    await server.close();
    removeTempDir(dir);
  }
});

test('AC-004: the client is not polling — changes arrive with no client calls', async () => {
  const { dir, server, remote, rootId, expanded } = await servedWorkspace();
  try {
    await waitFor(() => visibleNames(remote, expanded).includes('existing.txt'), 'initial listing');

    // Count client→host traffic while a change happens. A polling
    // implementation would have to ask; a push implementation does not.
    let callsDuringWindow = 0;
    const explorer = remote.explorer;
    const originalResolve = explorer.resolvePath.bind(explorer);
    explorer.resolvePath = (...args) => {
      callsDuringWindow += 1;
      return originalResolve(...args);
    };

    writeFileSync(join(dir, 'pushed.txt'), 'no polling required\n');
    await waitFor(
      () => visibleNames(remote, expanded).includes('pushed.txt'),
      'pushed change to arrive',
    );

    assert.equal(callsDuringWindow, 0, 'the change arrived without the client requesting it');
    explorer.resolvePath = originalResolve;
  } finally {
    await remote.close();
    await server.close();
    removeTempDir(dir);
  }
});
