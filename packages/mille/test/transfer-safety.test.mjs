import { removeTempDir } from '../../../scripts/test-temp.mjs';
import { strict as assert } from 'node:assert';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { DEFAULT_EXPLORER_SETTINGS, FileExplorer } from '../dist/index.js';

const settings = {
  ...DEFAULT_EXPLORER_SETTINGS,
  compactFolders: false,
};

function fixture() {
  const sandbox = mkdtempSync(join(tmpdir(), 'mille-transfer-safety-'));
  const root = join(sandbox, 'workspace');
  const outside = join(sandbox, 'outside');
  mkdirSync(join(root, 'inbox'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(root, 'src', 'note.txt'), 'source-payload');
  writeFileSync(join(root, 'inbox', 'note.txt'), 'destination-payload');
  writeFileSync(join(outside, 'secret.txt'), 'outside-secret');
  mkdirSync(join(root, 'src', 'bundle'), { recursive: true });
  writeFileSync(join(root, 'src', 'bundle', 'a.txt'), 'a-src');
  mkdirSync(join(root, 'inbox', 'bundle'), { recursive: true });
  writeFileSync(join(root, 'inbox', 'bundle', 'a.txt'), 'a-old');
  writeFileSync(join(root, 'inbox', 'bundle', 'keep.txt'), 'keep-dst');
  return { sandbox, root, outside };
}

async function idAt(fx, path) {
  const id = await fx.resolvePath(path);
  assert.ok(id !== null, `expected indexed path: ${path}`);
  return id;
}

test('P0: overwrite of a file onto itself does not delete the source', async () => {
  const { sandbox, root } = fixture();
  const fx = new FileExplorer({ roots: [root], settings });
  try {
    await fx.populateFromRoots();
    const source = await idAt(fx, join(root, 'src', 'note.txt'));
    const parent = await idAt(fx, join(root, 'src'));
    await assert.rejects(
      fx.copy(source, parent, undefined, { collision: 'overwrite' }),
      (error) => error?.code === 'EINVAL',
    );
    assert.equal(readFileSync(join(root, 'src', 'note.txt'), 'utf8'), 'source-payload');
    assert.ok(fx.getSnapshot().getById(source));
  } finally {
    await fx.dispose();
    removeTempDir(sandbox);
  }
});

test('P0: newName traversal cannot escape the workspace root', async () => {
  const { sandbox, root, outside } = fixture();
  const fx = new FileExplorer({ roots: [root], settings });
  try {
    await fx.populateFromRoots();
    const source = await idAt(fx, join(root, 'src', 'note.txt'));
    const rootId = await idAt(fx, root);
    await assert.rejects(
      fx.copy(source, rootId, '../escaped.txt'),
      (error) => error?.code === 'EINVAL',
    );
    assert.equal(existsSync(join(outside, 'escaped.txt')), false);
    assert.equal(existsSync(join(sandbox, 'escaped.txt')), false);
  } finally {
    await fx.dispose();
    removeTempDir(sandbox);
  }
});

test('P0: copyFromPath into a workspace symlink that escapes the root is rejected', async () => {
  const { sandbox, root, outside } = fixture();
  const link = join(root, 'escape-link');
  try {
    symlinkSync(outside, link, 'dir');
  } catch {
    // Platform may disallow dir symlinks; skip in that case.
    removeTempDir(sandbox);
    return;
  }
  const fx = new FileExplorer({ roots: [root], settings });
  try {
    await fx.populateFromRoots();
    const linkId = await idAt(fx, link);
    await assert.rejects(
      fx.copyFromPath(join(outside, 'secret.txt'), linkId, 'leaked.txt'),
      (error) => error?.code === 'EINVAL',
    );
    assert.equal(existsSync(join(outside, 'leaked.txt')), false);
  } finally {
    await fx.dispose();
    removeTempDir(sandbox);
  }
});

test('P1: move with collision merge preserves destination-only children', async () => {
  const { sandbox, root } = fixture();
  const fx = new FileExplorer({ roots: [root], settings });
  try {
    await fx.populateFromRoots();
    const source = await idAt(fx, join(root, 'src', 'bundle'));
    const inbox = await idAt(fx, join(root, 'inbox'));
    await fx.move(source, inbox, undefined, { collision: 'merge' });
    assert.equal(readFileSync(join(root, 'inbox', 'bundle', 'a.txt'), 'utf8'), 'a-src');
    assert.equal(readFileSync(join(root, 'inbox', 'bundle', 'keep.txt'), 'utf8'), 'keep-dst');
    assert.equal(existsSync(join(root, 'src', 'bundle')), false);
  } finally {
    await fx.dispose();
    removeTempDir(sandbox);
  }
});

test('P1: merge updates existing snapshot metadata for overwritten files', async () => {
  const { sandbox, root } = fixture();
  // Make source content shorter so size changes visibly.
  writeFileSync(join(root, 'src', 'bundle', 'a.txt'), 'x');
  const fx = new FileExplorer({ roots: [root], settings });
  try {
    await fx.populateFromRoots();
    const source = await idAt(fx, join(root, 'src', 'bundle'));
    const inbox = await idAt(fx, join(root, 'inbox'));
    const beforeId = await idAt(fx, join(root, 'inbox', 'bundle', 'a.txt'));
    const before = fx.getSnapshot().getById(beforeId);
    assert.ok(before);
    assert.equal(before.size, Buffer.byteLength('a-old'));

    await fx.copy(source, inbox, undefined, { collision: 'merge' });
    assert.equal(readFileSync(join(root, 'inbox', 'bundle', 'a.txt'), 'utf8'), 'x');
    const afterId = await idAt(fx, join(root, 'inbox', 'bundle', 'a.txt'));
    const after = fx.getSnapshot().getById(afterId);
    assert.ok(after);
    assert.equal(after.size, 1, 'snapshot size must match merged disk content');
    assert.equal(readFileSync(join(root, 'inbox', 'bundle', 'keep.txt'), 'utf8'), 'keep-dst');
  } finally {
    await fx.dispose();
    removeTempDir(sandbox);
  }
});

test('probeDestination reports free vs exists without mutating', async () => {
  const { sandbox, root } = fixture();
  const fx = new FileExplorer({ roots: [root], settings });
  try {
    await fx.populateFromRoots();
    const inbox = await idAt(fx, join(root, 'inbox'));
    const free = await fx.probeDestination(inbox, 'brand-new.txt');
    assert.equal(free.status, 'free');
    const exists = await fx.probeDestination(inbox, 'note.txt');
    assert.equal(exists.status, 'exists');
    await assert.rejects(fx.probeDestination(inbox, '../x.txt'), (error) => error?.code === 'EINVAL');
  } finally {
    await fx.dispose();
    removeTempDir(sandbox);
  }
});
