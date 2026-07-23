import { strict as assert } from 'node:assert';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
  const sandbox = mkdtempSync(join(tmpdir(), 'mille-undo-'));
  const root = join(sandbox, 'workspace');
  mkdirSync(join(root, 'inbox'), { recursive: true });
  writeFileSync(join(root, 'note.txt'), 'hello');
  writeFileSync(join(root, 'inbox', 'inner.txt'), 'inner');
  return { sandbox, root };
}

async function idAt(fx, path) {
  const id = await fx.resolvePath(path);
  assert.ok(id !== null, `expected ${path}`);
  return id;
}

test('default delete soft-trashes and undo restores content', async () => {
  const { sandbox, root } = fixture();
  const fx = new FileExplorer({ roots: [root], settings, watchDebounceMs: 60_000 });
  try {
    await fx.populateFromRoots();
    const noteId = await idAt(fx, join(root, 'note.txt'));
    assert.equal(fx.canUndo(), false);
    assert.equal(fx.peekUndo(), null);

    await fx.delete(noteId); // default trash:true
    assert.equal(existsSync(join(root, 'note.txt')), false);
    assert.ok(existsSync(join(root, '.mille-trash')));
    assert.equal(fx.canUndo(), true);
    const peek = fx.peekUndo();
    assert.ok(peek);
    assert.equal(peek.kind, 'delete');
    assert.equal(peek.undoable, true);

    const result = await fx.undo();
    assert.equal(result.kind, 'delete');
    assert.equal(readFileSync(join(root, 'note.txt'), 'utf8'), 'hello');
    assert.ok(await fx.resolvePath(join(root, 'note.txt')));
    assert.equal(fx.canUndo(), false);
  } finally {
    await fx.dispose();
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('permanent delete is not undoable', async () => {
  const { sandbox, root } = fixture();
  const fx = new FileExplorer({ roots: [root], settings, watchDebounceMs: 60_000 });
  try {
    await fx.populateFromRoots();
    const noteId = await idAt(fx, join(root, 'note.txt'));
    await fx.delete(noteId, { trash: false });
    assert.equal(existsSync(join(root, 'note.txt')), false);
    assert.equal(fx.canUndo(), false);
    await assert.rejects(fx.undo(), (error) => error?.code === 'EINVAL');
  } finally {
    await fx.dispose();
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('undo reverses create, rename, and move in LIFO order', async () => {
  const { sandbox, root } = fixture();
  const fx = new FileExplorer({ roots: [root], settings, watchDebounceMs: 60_000 });
  try {
    await fx.populateFromRoots();
    const rootId = await idAt(fx, root);
    const inboxId = await idAt(fx, join(root, 'inbox'));

    const created = await fx.create(rootId, 'fresh.txt', 0);
    writeFileSync(join(root, 'fresh.txt'), 'payload');
    // create() makes empty file; ensure content for later
    assert.equal(fx.peekUndo()?.kind, 'create');

    const renamed = await fx.rename(created.id, 'renamed.txt');
    assert.equal(renamed.name, 'renamed.txt');
    assert.equal(fx.peekUndo()?.kind, 'rename');

    const moved = await fx.move(renamed.id, inboxId);
    assert.equal(moved.parentId, inboxId);
    assert.equal(fx.peekUndo()?.kind, 'move');
    assert.equal(existsSync(join(root, 'inbox', 'renamed.txt')), true);

    // Undo move
    await fx.undo();
    assert.equal(existsSync(join(root, 'renamed.txt')), true);
    assert.equal(existsSync(join(root, 'inbox', 'renamed.txt')), false);

    // Undo rename
    await fx.undo();
    assert.equal(existsSync(join(root, 'fresh.txt')), true);

    // Undo create → file removed
    await fx.undo();
    assert.equal(existsSync(join(root, 'fresh.txt')), false);
    assert.equal(fx.canUndo(), false);
  } finally {
    await fx.dispose();
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('capabilities advertise Trash support', async () => {
  const { sandbox, root } = fixture();
  const fx = new FileExplorer({ roots: [root], settings });
  try {
    // Trash = 1<<3 = 8
    assert.equal((fx.capabilities & 8) !== 0, true);
  } finally {
    await fx.dispose();
    rmSync(sandbox, { recursive: true, force: true });
  }
});
