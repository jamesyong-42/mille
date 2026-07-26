import { strict as assert } from 'node:assert';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MessageChannel } from 'node:worker_threads';

import {
  connectFileExplorer,
  createFileExplorerHost,
  DEFAULT_EXPLORER_SETTINGS,
  FileExplorer,
} from '../dist/index.js';

const settings = {
  ...DEFAULT_EXPLORER_SETTINGS,
  compactFolders: false,
};

function fixture() {
  const sandbox = mkdtempSync(join(tmpdir(), 'mille-copy-from-path-'));
  const workspace = join(sandbox, 'workspace');
  const external = join(sandbox, 'external');
  mkdirSync(join(workspace, 'inbox'), { recursive: true });
  mkdirSync(join(external, 'bundle', 'nested'), { recursive: true });
  writeFileSync(join(external, 'note.txt'), 'hello-from-outside');
  writeFileSync(join(external, 'bundle', 'nested', 'deep.txt'), 'nested-payload');
  writeFileSync(join(external, 'bundle', 'readme.md'), 'bundle-readme');
  writeFileSync(join(workspace, 'inbox', 'note.txt'), 'already-here');
  return { sandbox, workspace, external };
}

async function idAt(fx, path) {
  const id = await fx.resolvePath(path);
  assert.ok(id !== null, `expected indexed path: ${path}`);
  return id;
}

function childByName(snapshot, parentId, name) {
  const childIds =
    typeof snapshot.childrenOf === 'function'
      ? snapshot.childrenOf(parentId)
      : snapshot
          .visibleRows({
            expanded: new Set([parentId]),
            offset: 0,
            limit: 10_000,
            includeIgnored: true,
          })
          .filter((entry) => entry.parentId === parentId)
          .map((entry) => entry.id);
  for (const id of childIds) {
    const entry = snapshot.getById(id);
    if (entry?.name === name) return entry;
  }
  return null;
}

test('copyFromPath imports file content and never creates empty placeholders', async () => {
  const { sandbox, workspace, external } = fixture();
  const fx = new FileExplorer({ roots: [workspace], settings });
  try {
    await fx.populateFromRoots();
    const inboxId = await idAt(fx, join(workspace, 'inbox'));

    const imported = await fx.copyFromPath(join(external, 'note.txt'), inboxId, undefined, {
      collision: 'rename',
    });
    assert.equal(imported.name, 'note copy.txt');
    assert.equal(imported.parentId, inboxId);
    assert.equal(
      readFileSync(join(workspace, 'inbox', 'note copy.txt'), 'utf8'),
      'hello-from-outside',
    );
    assert.notEqual(imported.size, 0, 'imported file must retain payload size');

    await assert.rejects(
      fx.copyFromPath(join(external, 'note.txt'), inboxId),
      (error) => error?.code === 'EEXIST',
    );
    assert.equal(
      readFileSync(join(workspace, 'inbox', 'note.txt'), 'utf8'),
      'already-here',
      'collision:error must not overwrite existing content',
    );
  } finally {
    await fx.dispose();
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('copyFromPath recursively imports directories with nested content', async () => {
  const { sandbox, workspace, external } = fixture();
  const fx = new FileExplorer({ roots: [workspace], settings });
  try {
    await fx.populateFromRoots();
    const inboxId = await idAt(fx, join(workspace, 'inbox'));

    const imported = await fx.copyFromPath(join(external, 'bundle'), inboxId);
    assert.equal(imported.name, 'bundle');
    assert.equal(imported.kind, 1);
    assert.equal(
      readFileSync(join(workspace, 'inbox', 'bundle', 'readme.md'), 'utf8'),
      'bundle-readme',
    );
    assert.equal(
      readFileSync(join(workspace, 'inbox', 'bundle', 'nested', 'deep.txt'), 'utf8'),
      'nested-payload',
    );

    const snap = fx.getSnapshot();
    const bundle = childByName(snap, inboxId, 'bundle');
    assert.ok(bundle);
    const nested = childByName(snap, bundle.id, 'nested');
    assert.ok(nested, 'nested directory must be indexed');
    assert.ok(childByName(snap, nested.id, 'deep.txt'), 'nested file must be indexed');
    assert.ok(childByName(snap, bundle.id, 'readme.md'));
  } finally {
    await fx.dispose();
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('copyFromPath surfaces missing sources without leaving placeholders', async () => {
  const { sandbox, workspace } = fixture();
  const fx = new FileExplorer({ roots: [workspace], settings });
  try {
    await fx.populateFromRoots();
    const inboxId = await idAt(fx, join(workspace, 'inbox'));
    const missing = join(sandbox, 'no-such-file.txt');

    await assert.rejects(
      fx.copyFromPath(missing, inboxId),
      (error) => error?.code === 'ENOENT',
    );
    assert.equal(existsSync(join(workspace, 'inbox', 'no-such-file.txt')), false);
    const snap = fx.getSnapshot();
    assert.equal(childByName(snap, inboxId, 'no-such-file.txt'), null);
  } finally {
    await fx.dispose();
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('port copyFromPath flushes the imported entry to attached mirrors', async () => {
  const { sandbox, workspace, external } = fixture();
  const host = await createFileExplorerHost({
    roots: [workspace],
    settings,
  });
  await host.local.populateFromRoots();
  const channel = new MessageChannel();
  host.attachPort(channel.port1);
  const client = await connectFileExplorer(channel.port2);
  try {
    const inboxId = await idAt(client, join(workspace, 'inbox'));
    const imported = await client.copyFromPath(join(external, 'note.txt'), inboxId, 'from-port.txt');
    assert.equal(imported.name, 'from-port.txt');
    assert.equal(
      readFileSync(join(workspace, 'inbox', 'from-port.txt'), 'utf8'),
      'hello-from-outside',
    );

    const resolved = await host.local.resolvePath(join(workspace, 'inbox', 'from-port.txt'));
    assert.ok(resolved !== null);
    assert.equal(host.local.getSnapshot().getById(resolved)?.name, 'from-port.txt');
  } finally {
    await client.dispose();
    channel.port1.close();
    channel.port2.close();
    await host.dispose();
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
