import { strict as assert } from 'node:assert';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  readdirSync,
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
  const sandbox = mkdtempSync(join(tmpdir(), 'mille-collision-'));
  const root = join(sandbox, 'workspace');
  mkdirSync(join(root, 'inbox'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'inbox', 'note.txt'), 'destination');
  writeFileSync(join(root, 'src', 'note.txt'), 'source');
  mkdirSync(join(root, 'src', 'bundle'), { recursive: true });
  writeFileSync(join(root, 'src', 'bundle', 'a.txt'), 'a-src');
  writeFileSync(join(root, 'src', 'bundle', 'b.txt'), 'b-src');
  mkdirSync(join(root, 'inbox', 'bundle'), { recursive: true });
  writeFileSync(join(root, 'inbox', 'bundle', 'a.txt'), 'a-dst');
  writeFileSync(join(root, 'inbox', 'bundle', 'keep.txt'), 'keep-dst');
  return { sandbox, root };
}

async function idAt(fx, path) {
  const id = await fx.resolvePath(path);
  assert.ok(id !== null, `expected indexed path: ${path}`);
  return id;
}

test('collision overwrite replaces file content', async () => {
  const { sandbox, root } = fixture();
  const fx = new FileExplorer({ roots: [root], settings });
  try {
    await fx.populateFromRoots();
    const source = await idAt(fx, join(root, 'src', 'note.txt'));
    const inbox = await idAt(fx, join(root, 'inbox'));
    const result = await fx.copy(source, inbox, undefined, { collision: 'overwrite' });
    assert.equal(result.name, 'note.txt');
    assert.equal(readFileSync(join(root, 'inbox', 'note.txt'), 'utf8'), 'source');
  } finally {
    await fx.dispose();
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('collision skip leaves the destination untouched', async () => {
  const { sandbox, root } = fixture();
  const fx = new FileExplorer({ roots: [root], settings });
  try {
    await fx.populateFromRoots();
    const source = await idAt(fx, join(root, 'src', 'note.txt'));
    const inbox = await idAt(fx, join(root, 'inbox'));
    const result = await fx.copy(source, inbox, undefined, { collision: 'skip' });
    assert.equal(result.name, 'note.txt');
    assert.equal(readFileSync(join(root, 'inbox', 'note.txt'), 'utf8'), 'destination');
  } finally {
    await fx.dispose();
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('collision merge combines directory trees without deleting siblings', async () => {
  const { sandbox, root } = fixture();
  const fx = new FileExplorer({ roots: [root], settings });
  try {
    await fx.populateFromRoots();
    const source = await idAt(fx, join(root, 'src', 'bundle'));
    const inbox = await idAt(fx, join(root, 'inbox'));
    const result = await fx.copy(source, inbox, undefined, { collision: 'merge' });
    assert.equal(result.name, 'bundle');
    assert.equal(readFileSync(join(root, 'inbox', 'bundle', 'a.txt'), 'utf8'), 'a-src');
    assert.equal(readFileSync(join(root, 'inbox', 'bundle', 'b.txt'), 'utf8'), 'b-src');
    assert.equal(readFileSync(join(root, 'inbox', 'bundle', 'keep.txt'), 'utf8'), 'keep-dst');
  } finally {
    await fx.dispose();
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('self-copy of a directory into its descendant is rejected', async () => {
  const { sandbox, root } = fixture();
  const fx = new FileExplorer({ roots: [root], settings });
  try {
    await fx.populateFromRoots();
    const bundle = await idAt(fx, join(root, 'src', 'bundle'));
    await assert.rejects(
      fx.copy(bundle, bundle, undefined, { collision: 'rename' }),
      (error) => error?.code === 'EINVAL',
    );
  } finally {
    await fx.dispose();
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('case-only sibling names collide on case-insensitive volumes', async () => {
  const { sandbox, root } = fixture();
  // Create a second sibling that differs only by case when the volume allows.
  const lower = join(root, 'inbox', 'readme.txt');
  writeFileSync(lower, 'lower');
  const upperName = 'README.txt';
  const upperPath = join(root, 'src', upperName);
  writeFileSync(upperPath, 'upper');

  const fx = new FileExplorer({ roots: [root], settings });
  try {
    await fx.populateFromRoots();
    // On case-insensitive FS (default macOS), creating README.txt under inbox
    // where readme.txt exists is a case collision.
    const source = await idAt(fx, upperPath);
    const inbox = await idAt(fx, join(root, 'inbox'));
    const names = readdirSync(join(root, 'inbox'));
    const hasLower = names.some((n) => n === 'readme.txt');
    if (!hasLower) {
      // Case-sensitive volume — rename the on-disk sibling explicitly.
      return;
    }
    await assert.rejects(
      fx.copy(source, inbox, upperName, { collision: 'error' }),
      (error) => error?.code === 'EEXIST',
    );
    assert.equal(readFileSync(lower, 'utf8'), 'lower');

    const renamed = await fx.copy(source, inbox, upperName, { collision: 'rename' });
    assert.ok(renamed.name.toLowerCase().includes('copy'));
    assert.equal(
      readFileSync(join(root, 'inbox', renamed.name), 'utf8'),
      'upper',
    );
  } finally {
    await fx.dispose();
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
