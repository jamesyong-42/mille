import { strict as assert } from 'node:assert';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
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
  showHiddenFiles: true,
};

function fixture() {
  const sandbox = mkdtempSync(join(tmpdir(), 'mille-undo-'));
  const root = join(sandbox, 'workspace');
  mkdirSync(join(root, 'inbox'), { recursive: true });
  writeFileSync(join(root, 'note.txt'), 'hello');
  writeFileSync(join(root, 'inbox', 'inner.txt'), 'inner');
  writeFileSync(join(root, 'existing.txt'), 'IMPORTANT');
  writeFileSync(join(root, 'a.txt'), 'A');
  writeFileSync(join(root, 'b.txt'), 'B');
  return { sandbox, root };
}

async function idAt(fx, path) {
  const id = await fx.resolvePath(path);
  assert.ok(id !== null, `expected ${path}`);
  return id;
}

function childNames(fx, parentId) {
  const snap = fx.getSnapshot();
  const ids =
    typeof snap.childrenOf === 'function'
      ? snap.childrenOf(parentId)
      : snap
          .visibleRows({
            expanded: new Set([parentId]),
            offset: 0,
            limit: 10_000,
            includeIgnored: true,
          })
          .filter((e) => e.parentId === parentId)
          .map((e) => e.id);
  return ids.map((id) => snap.getById(id)?.name).filter(Boolean).sort();
}

test('P0: create refuses to truncate an existing file', async () => {
  const { sandbox, root } = fixture();
  const fx = new FileExplorer({ roots: [root], settings, watchDebounceMs: 60_000 });
  try {
    await fx.populateFromRoots();
    const rootId = await idAt(fx, root);
    await assert.rejects(
      fx.create(rootId, 'existing.txt', 0),
      (error) => error?.code === 'EEXIST',
    );
    assert.equal(readFileSync(join(root, 'existing.txt'), 'utf8'), 'IMPORTANT');
    assert.equal(fx.canUndo(), false);
  } finally {
    await fx.dispose();
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('P0: rename refuses to overwrite an existing sibling', async () => {
  const { sandbox, root } = fixture();
  const fx = new FileExplorer({ roots: [root], settings, watchDebounceMs: 60_000 });
  try {
    await fx.populateFromRoots();
    const aId = await idAt(fx, join(root, 'a.txt'));
    await assert.rejects(fx.rename(aId, 'b.txt'), (error) => error?.code === 'EEXIST');
    assert.equal(existsSync(join(root, 'a.txt')), true);
    assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'A');
    assert.equal(readFileSync(join(root, 'b.txt'), 'utf8'), 'B');
    assert.equal(fx.canUndo(), false);
  } finally {
    await fx.dispose();
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('P0: undo-create refuses to delete an unrelated replacement', async () => {
  const { sandbox, root } = fixture();
  const fx = new FileExplorer({ roots: [root], settings, watchDebounceMs: 60_000 });
  try {
    await fx.populateFromRoots();
    const rootId = await idAt(fx, root);
    const created = await fx.create(rootId, 'fresh.txt', 0);
    assert.equal(fx.peekUndo()?.kind, 'create');
    // Externally replace the file with unrelated content / identity.
    rmSync(join(root, 'fresh.txt'));
    writeFileSync(join(root, 'fresh.txt'), 'UNRELATED REPLACEMENT');
    // Store still thinks create owns the id — resync would update, but even
    // without resync, size/mtime identity must fail.
    await assert.rejects(fx.undo(), (error) => error?.code === 'EINVAL');
    assert.equal(readFileSync(join(root, 'fresh.txt'), 'utf8'), 'UNRELATED REPLACEMENT');
    // Failed undo must leave the journal entry so the user can retry after cleanup.
    assert.equal(fx.canUndo(), true);
    assert.equal(fx.peekUndo()?.kind, 'create');
    void created;
  } finally {
    await fx.dispose();
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('P0: undo-create refuses same-size empty file replacement (inode identity)', async () => {
  const { sandbox, root } = fixture();
  const fx = new FileExplorer({ roots: [root], settings, watchDebounceMs: 60_000 });
  try {
    await fx.populateFromRoots();
    const rootId = await idAt(fx, root);
    await fx.create(rootId, 'empty.txt', 0);
    // Replace empty with a different empty file — size matches, identity does not.
    rmSync(join(root, 'empty.txt'));
    writeFileSync(join(root, 'empty.txt'), '');
    await assert.rejects(fx.undo(), (error) => error?.code === 'EINVAL');
    assert.equal(existsSync(join(root, 'empty.txt')), true);
    assert.equal(fx.canUndo(), true);
  } finally {
    await fx.dispose();
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('P0: undo-create refuses non-empty directory (descendant guard)', async () => {
  const { sandbox, root } = fixture();
  const fx = new FileExplorer({ roots: [root], settings, watchDebounceMs: 60_000 });
  try {
    await fx.populateFromRoots();
    const rootId = await idAt(fx, root);
    const dir = await fx.create(rootId, 'newdir', 1);
    // Externally add valuable content after create.
    writeFileSync(join(root, 'newdir', 'valuable.txt'), 'KEEP ME');
    await assert.rejects(fx.undo(), (error) => error?.code === 'EINVAL');
    assert.equal(readFileSync(join(root, 'newdir', 'valuable.txt'), 'utf8'), 'KEEP ME');
    assert.equal(fx.canUndo(), true);
    void dir;
  } finally {
    await fx.dispose();
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('P0: undo-rename refuses when destination was replaced', async () => {
  const { sandbox, root } = fixture();
  const fx = new FileExplorer({ roots: [root], settings, watchDebounceMs: 60_000 });
  try {
    await fx.populateFromRoots();
    const rootId = await idAt(fx, root);
    const created = await fx.create(rootId, 'orig.txt', 0);
    await fx.rename(created.id, 'renamed.txt');
    // Replace the renamed path with an unrelated file.
    rmSync(join(root, 'renamed.txt'));
    writeFileSync(join(root, 'renamed.txt'), 'IMPOSTOR');
    await assert.rejects(fx.undo(), (error) => error?.code === 'EINVAL');
    assert.equal(readFileSync(join(root, 'renamed.txt'), 'utf8'), 'IMPOSTOR');
    // Must not have moved the impostor to orig.txt.
    assert.equal(existsSync(join(root, 'orig.txt')), false);
    assert.equal(fx.canUndo(), true);
  } finally {
    await fx.dispose();
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('P0: soft-delete refuses symlink-hijacked recycle base', async () => {
  const { sandbox, root } = fixture();
  // Plant a symlink at $TMPDIR/mille-recycle itself pointing outside.
  // ensure_managed_recycle_base must remove the hijack and use a real dir.
  const pool = join(tmpdir(), 'mille-recycle');
  const external = join(sandbox, 'evil-target');
  mkdirSync(external, { recursive: true });
  let poolBackup = null;
  try {
    if (existsSync(pool)) {
      poolBackup = join(sandbox, 'mille-recycle-backup');
      const { renameSync } = await import('node:fs');
      try {
        renameSync(pool, poolBackup);
      } catch {
        /* fall through */
      }
    }
    const { symlinkSync, lstatSync, rmSync: rm } = await import('node:fs');
    try {
      rm(pool, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    symlinkSync(external, pool);

    const fx = new FileExplorer({ roots: [root], settings, watchDebounceMs: 60_000 });
    try {
      await fx.populateFromRoots();
      const noteId = await idAt(fx, join(root, 'note.txt'));
      await fx.delete(noteId);
      assert.equal(existsSync(join(root, 'note.txt')), false);
      const st = lstatSync(pool);
      assert.equal(st.isSymbolicLink(), false, 'recycle pool must not remain a symlink');
      const evilNames = readdirSync(external);
      assert.equal(
        evilNames.includes('note.txt'),
        false,
        `workspace file must not land in symlink target; found ${evilNames.join(',')}`,
      );
      await fx.undo();
      assert.equal(readFileSync(join(root, 'note.txt'), 'utf8'), 'hello');
    } finally {
      await fx.dispose();
    }
  } finally {
    try {
      const { renameSync, rmSync: rm } = await import('node:fs');
      rm(pool, { recursive: true, force: true });
      if (poolBackup && existsSync(poolBackup)) {
        renameSync(poolBackup, pool);
      }
    } catch {
      /* best-effort cleanup */
    }
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('P0: overwrite-move is reported non-undoable', async () => {
  const { sandbox, root } = fixture();
  const fx = new FileExplorer({ roots: [root], settings, watchDebounceMs: 60_000 });
  try {
    await fx.populateFromRoots();
    const aId = await idAt(fx, join(root, 'a.txt'));
    const rootId = await idAt(fx, root);
    // Move a onto b with overwrite — destination B is destroyed.
    await fx.move(aId, rootId, 'b.txt', { collision: 'overwrite' });
    assert.equal(readFileSync(join(root, 'b.txt'), 'utf8'), 'A');
    assert.equal(existsSync(join(root, 'a.txt')), false);
    assert.equal(fx.canUndo(), false);
    const last = fx.lastMutation();
    assert.ok(last);
    assert.equal(last.undoable, false);
    assert.match(String(last.reason ?? ''), /overwrite|cannot be restored/i);
  } finally {
    await fx.dispose();
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('default soft-delete is outside the workspace tree and undo restores', async () => {
  const { sandbox, root } = fixture();
  const fx = new FileExplorer({ roots: [root], settings, watchDebounceMs: 60_000 });
  try {
    await fx.populateFromRoots();
    const noteId = await idAt(fx, join(root, 'note.txt'));
    await fx.delete(noteId);
    assert.equal(existsSync(join(root, 'note.txt')), false);
    // Must not appear as a workspace child.
    const rootId = await idAt(fx, root);
    await fx.resync(rootId, { recursive: true });
    const names = childNames(fx, rootId);
    assert.equal(names.includes('.mille-trash'), false);
    assert.equal(fx.canUndo(), true);
    await fx.undo();
    assert.equal(readFileSync(join(root, 'note.txt'), 'utf8'), 'hello');
  } finally {
    await fx.dispose();
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('permanent delete is reported non-undoable via lastMutation', async () => {
  const { sandbox, root } = fixture();
  const fx = new FileExplorer({ roots: [root], settings, watchDebounceMs: 60_000 });
  try {
    await fx.populateFromRoots();
    const noteId = await idAt(fx, join(root, 'note.txt'));
    await fx.delete(noteId, { trash: false });
    assert.equal(fx.canUndo(), false);
    const last = fx.lastMutation();
    assert.ok(last);
    assert.equal(last.kind, 'delete');
    assert.equal(last.undoable, false);
    assert.match(String(last.reason ?? ''), /permanent/i);
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

    // Keep the file empty so create-undo identity (size fingerprint) holds
    // through rename/move.
    const created = await fx.create(rootId, 'fresh.txt', 0);
    assert.equal(fx.peekUndo()?.kind, 'create');

    const renamed = await fx.rename(created.id, 'renamed.txt');
    assert.equal(fx.peekUndo()?.kind, 'rename');

    const moved = await fx.move(renamed.id, inboxId);
    assert.equal(moved.parentId, inboxId);
    assert.equal(fx.peekUndo()?.kind, 'move');

    await fx.undo(); // undo move
    assert.equal(existsSync(join(root, 'renamed.txt')), true);

    await fx.undo(); // undo rename
    assert.equal(existsSync(join(root, 'fresh.txt')), true);

    await fx.undo(); // undo create
    assert.equal(existsSync(join(root, 'fresh.txt')), false);
    assert.equal(fx.canUndo(), false);
  } finally {
    await fx.dispose();
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('port undo flushes mirrors before resolve', async () => {
  const { sandbox, root } = fixture();
  const host = await createFileExplorerHost({ roots: [root], settings });
  await host.local.populateFromRoots();
  const channel = new MessageChannel();
  host.attachPort(channel.port1);
  const client = await connectFileExplorer(channel.port2);
  try {
    const noteId = await client.resolvePath(join(root, 'note.txt'));
    assert.ok(noteId !== null);
    // Delete via host local so journal is on the same explorer.
    await host.local.delete(noteId);
    // Port client must see the tree change after a resync/delta — force via undo
    // on host through mutation path: call client.undo which mutates.
    // First sync client by resyncing.
    const rootId = await client.resolvePath(root);
    await client.resync(rootId, { recursive: true });
    assert.equal(await client.resolvePath(join(root, 'note.txt')), null);

    // Undo via port mutation queue.
    await client.undo();
    // Immediately after resolve, mirror must already include restored entry
    // (mutation queue flushes before mutateResult).
    const restored = client.getSnapshot().getById
      ? await client.resolvePath(join(root, 'note.txt'))
      : null;
    assert.ok(restored !== null, 'port mirror must show restored entry before undo resolves');
    assert.equal(readFileSync(join(root, 'note.txt'), 'utf8'), 'hello');
  } finally {
    await client.dispose();
    channel.port1.close();
    channel.port2.close();
    await host.dispose();
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('capabilities advertise Trash support', async () => {
  const { sandbox, root } = fixture();
  const fx = new FileExplorer({ roots: [root], settings });
  try {
    assert.equal((fx.capabilities & 8) !== 0, true);
  } finally {
    await fx.dispose();
    rmSync(sandbox, { recursive: true, force: true });
  }
});
