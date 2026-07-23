// Tests for the CommandRegistry and the default command set.
//
// No React, no real engine — we assemble a minimal manual `ctx` object
// and a fake `fx` that records each method call. Every command delegates
// to one of `fx.setExpanded | create | rename | delete | move | copy`
// or `host.onOpen | onRevealInEditor`, which is exactly what we check.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createCommandRegistry,
  defaultCommands,
  treeDefaults,
  mutationDefaults,
} from '../dist/commands/index.js';

// Numeric EntryKind constants (mirror api.d.ts; engine types expose kind as number).
const KIND_FILE = 0;
const KIND_DIRECTORY = 1;

function makeFakeFx() {
  const calls = [];
  return {
    calls,
    setExpanded: (diff) => { calls.push(['setExpanded', diff]); },
    resync: async (id, options) => {
      calls.push(['resync', { id, options }]);
      return 1;
    },
    resyncWorkspace: async () => {
      calls.push(['resyncWorkspace']);
      return 1;
    },
    create: async (parentId, name, kind) => {
      calls.push(['create', { parentId, name, kind }]);
      return { id: 999, parentId, name, kind, size: 0, mtimeMs: 0, ctimeMs: 0, isIgnored: false, isReadonly: false, isHidden: false };
    },
    rename: async (id, newName) => {
      calls.push(['rename', { id, newName }]);
      return { id, parentId: null, name: newName, kind: KIND_FILE, size: 0, mtimeMs: 0, ctimeMs: 0, isIgnored: false, isReadonly: false, isHidden: false };
    },
    delete: async (id, options) => {
      calls.push(['delete', { id, options }]);
    },
    move: async (id, newParentId, newName) => {
      calls.push(['move', { id, newParentId, newName }]);
      return { id, parentId: newParentId, name: newName ?? 'x', kind: KIND_FILE, size: 0, mtimeMs: 0, ctimeMs: 0, isIgnored: false, isReadonly: false, isHidden: false };
    },
    copy: async (id, newParentId, newName) => {
      calls.push(['copy', { id, newParentId, newName }]);
      return { id: id + 1000, parentId: newParentId, name: newName ?? 'x-copy', kind: KIND_FILE, size: 0, mtimeMs: 0, ctimeMs: 0, isIgnored: false, isReadonly: false, isHidden: false };
    },
  };
}

function makeSnapshot(entries = new Map()) {
  return {
    treeVersion: 0,
    decorationVersion: 0,
    roots: () => Array.from(entries.values()).filter((e) => e.parentId === null),
    getById: (id) => entries.get(id) ?? null,
    directChildCount: () => null,
    hasChildren: () => false,
    childrenOf: () => [],
    visibleRows: () => [],
    visibleRowCount: () => ({ known: 0, pendingExpansions: new Set() }),
    getDecorations: () => [],
  };
}

function makeCtx({
  fx,
  snapshot = makeSnapshot(),
  focusedEntry = null,
  focusedId = focusedEntry?.id ?? null,
  selectedIds = new Set(),
  selectedEntries = [],
  isMultiSelect = false,
  isRenaming = false,
  host = {},
  expansion,
} = {}) {
  return {
    fx,
    snapshot,
    focusedEntry,
    focusedId,
    selectedIds,
    selectedEntries,
    isMultiSelect,
    isRenaming,
    host,
    ...(expansion ? { expansion } : {}),
  };
}

function folderEntry(id, parentId = null) {
  return { id, parentId, name: 'dir-' + id, kind: KIND_DIRECTORY, size: 0, mtimeMs: 0, ctimeMs: 0, isIgnored: false, isReadonly: false, isHidden: false };
}

function fileEntry(id, parentId = null) {
  return { id, parentId, name: 'file-' + id, kind: KIND_FILE, size: 0, mtimeMs: 0, ctimeMs: 0, isIgnored: false, isReadonly: false, isHidden: false };
}

// ─── Registry basics ───────────────────────────────────────────────────────

describe('CommandRegistry — basics', () => {
  it('registers and retrieves commands by id', () => {
    const cmd = { id: 'x.foo', label: 'Foo', run: () => {} };
    const reg = createCommandRegistry([cmd]);
    assert.equal(reg.get('x.foo'), cmd);
    assert.equal(reg.get('x.nope'), undefined);
  });

  it('all() returns all registered commands', () => {
    const a = { id: 'a', label: 'A', run: () => {} };
    const b = { id: 'b', label: 'B', run: () => {} };
    const reg = createCommandRegistry([a, b]);
    const all = reg.all();
    assert.equal(all.length, 2);
    assert.ok(all.includes(a));
    assert.ok(all.includes(b));
  });

  it('dispatch() calls run with materialized context', async () => {
    const seen = [];
    const cmd = {
      id: 'x.run',
      label: 'Run',
      run: (ctx, args) => { seen.push({ ctx, args }); },
    };
    const reg = createCommandRegistry([cmd]);
    const fx = makeFakeFx();
    const ctx = makeCtx({ fx });
    reg.setContextProvider(() => ctx);
    await reg.dispatch('x.run', { hello: 'world' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].ctx, ctx);
    assert.deepEqual(seen[0].args, { hello: 'world' });
  });

  it('dispatch throws on unknown id', () => {
    const reg = createCommandRegistry();
    reg.setContextProvider(() => makeCtx({ fx: makeFakeFx() }));
    assert.throws(() => reg.dispatch('nope'), /unknown command/);
  });

  it('dispatch throws when no context provider is installed', () => {
    const reg = createCommandRegistry([{ id: 'a', label: 'A', run: () => {} }]);
    assert.throws(() => reg.dispatch('a'), /context provider/);
  });

  it('register() overrides a prior command; dispose() restores', async () => {
    const original = { id: 'dup', label: 'Original', run: () => 'O' };
    const override = { id: 'dup', label: 'Override', run: () => 'V' };
    const reg = createCommandRegistry([original]);
    assert.equal(reg.get('dup'), original);
    const disp = reg.register(override);
    assert.equal(reg.get('dup'), override);
    disp.dispose();
    assert.equal(reg.get('dup'), original);
  });

  it('register() dispose on single registration removes it entirely', () => {
    const reg = createCommandRegistry();
    const c = { id: 'solo', label: 'Solo', run: () => {} };
    const disp = reg.register(c);
    assert.equal(reg.get('solo'), c);
    disp.dispose();
    assert.equal(reg.get('solo'), undefined);
  });
});

// ─── Tree commands ─────────────────────────────────────────────────────────

describe('defaultCommands — tree structure', () => {
  it('tree.expand calls fx.setExpanded with focused id', () => {
    const reg = createCommandRegistry(defaultCommands);
    const fx = makeFakeFx();
    const ctx = makeCtx({ fx, focusedEntry: folderEntry(7) });
    reg.setContextProvider(() => ctx);
    reg.dispatch('tree.expand');
    assert.deepEqual(fx.calls, [['setExpanded', { add: [7] }]]);
  });

  it('tree.expand accepts explicit ids arg', () => {
    const reg = createCommandRegistry(defaultCommands);
    const fx = makeFakeFx();
    reg.setContextProvider(() => makeCtx({ fx, focusedEntry: folderEntry(1) }));
    reg.dispatch('tree.expand', { ids: [10, 20] });
    assert.deepEqual(fx.calls, [['setExpanded', { add: [10, 20] }]]);
  });

  it('tree.collapse calls fx.setExpanded({ remove })', () => {
    const reg = createCommandRegistry(defaultCommands);
    const fx = makeFakeFx();
    reg.setContextProvider(() => makeCtx({ fx, focusedEntry: folderEntry(7) }));
    reg.dispatch('tree.collapse');
    assert.deepEqual(fx.calls, [['setExpanded', { remove: [7] }]]);
  });

  it('tree.collapseAll collects every known root folder and collapses them', () => {
    const reg = createCommandRegistry(defaultCommands);
    const fx = makeFakeFx();
    const entries = new Map([[1, folderEntry(1)]]);
    const ctx = makeCtx({ fx, snapshot: makeSnapshot(entries) });
    reg.setContextProvider(() => ctx);
    reg.dispatch('tree.collapseAll');
    assert.equal(fx.calls.length, 1);
    assert.equal(fx.calls[0][0], 'setExpanded');
    assert.deepEqual(fx.calls[0][1], { remove: [1] });
  });

  it('tree.collapseDescendants removes only expanded descendants through controlled state', () => {
    const reg = createCommandRegistry(defaultCommands);
    const fx = makeFakeFx();
    const entries = new Map([
      [1, folderEntry(1)],
      [2, folderEntry(2, 1)],
      [3, folderEntry(3, 2)],
      [4, folderEntry(4, 1)],
      [9, folderEntry(9)],
    ]);
    const expansionCalls = [];
    reg.setContextProvider(() =>
      makeCtx({
        fx,
        snapshot: makeSnapshot(entries),
        focusedEntry: entries.get(2),
        expansion: {
          expandedIds: new Set([1, 2, 3, 4, 9]),
          setExpanded: (diff) => expansionCalls.push(diff),
        },
      }),
    );
    reg.dispatch('tree.collapseDescendants');
    assert.deepEqual(expansionCalls, [{ remove: [3] }]);
    assert.deepEqual(fx.calls, []);
  });

  it('tree.collapseAll removes the actual controlled expansion set', () => {
    const reg = createCommandRegistry(defaultCommands);
    const fx = makeFakeFx();
    const expansionCalls = [];
    reg.setContextProvider(() =>
      makeCtx({
        fx,
        expansion: {
          expandedIds: new Set([1, 20, 300]),
          setExpanded: (diff) => expansionCalls.push(diff),
        },
      }),
    );
    reg.dispatch('tree.collapseAll');
    assert.deepEqual(expansionCalls, [{ remove: [1, 20, 300] }]);
    assert.deepEqual(fx.calls, []);
  });

  it('tree.revealPath expands ancestor ids for the given id', () => {
    const reg = createCommandRegistry(defaultCommands);
    const fx = makeFakeFx();
    // Tree: root(1) → folder(2) → file(3)
    const entries = new Map([
      [1, folderEntry(1)],
      [2, folderEntry(2, 1)],
      [3, fileEntry(3, 2)],
    ]);
    const ctx = makeCtx({ fx, snapshot: makeSnapshot(entries) });
    reg.setContextProvider(() => ctx);
    reg.dispatch('tree.revealPath', { id: 3 });
    assert.equal(fx.calls.length, 1);
    assert.equal(fx.calls[0][0], 'setExpanded');
    assert.deepEqual(fx.calls[0][1].add, [2, 1]);
  });

  it('tree.selectAll is a no-op by default (Provider overrides)', () => {
    const reg = createCommandRegistry(treeDefaults);
    const fx = makeFakeFx();
    reg.setContextProvider(() => makeCtx({ fx }));
    reg.dispatch('tree.selectAll');
    assert.equal(fx.calls.length, 0);
  });
});

// ─── Mutation commands ─────────────────────────────────────────────────────

describe('defaultCommands — mutations', () => {
  it('file.create delegates to fx.create with resolved parent', async () => {
    const reg = createCommandRegistry(mutationDefaults);
    const fx = makeFakeFx();
    reg.setContextProvider(() => makeCtx({ fx, focusedEntry: folderEntry(10) }));
    await reg.dispatch('file.create', { name: 'new.ts' });
    assert.deepEqual(fx.calls, [
      ['create', { parentId: 10, name: 'new.ts', kind: KIND_FILE }],
    ]);
  });

  it('file.create accepts explicit parentId + folder kind', async () => {
    const reg = createCommandRegistry(mutationDefaults);
    const fx = makeFakeFx();
    reg.setContextProvider(() => makeCtx({ fx }));
    await reg.dispatch('file.create', { parentId: 5, name: 'sub', kind: 'folder' });
    assert.deepEqual(fx.calls, [
      ['create', { parentId: 5, name: 'sub', kind: KIND_DIRECTORY }],
    ]);
  });

  it('file.rename delegates to fx.rename using focused id by default', async () => {
    const reg = createCommandRegistry(mutationDefaults);
    const fx = makeFakeFx();
    reg.setContextProvider(() =>
      makeCtx({ fx, focusedEntry: fileEntry(42) }),
    );
    await reg.dispatch('file.rename', { newName: 'renamed.ts' });
    assert.deepEqual(fx.calls, [['rename', { id: 42, newName: 'renamed.ts' }]]);
  });

  it('file.delete uses ctx.selectedIds by default and toTrash=true', async () => {
    const reg = createCommandRegistry(mutationDefaults);
    const fx = makeFakeFx();
    reg.setContextProvider(() =>
      makeCtx({ fx, selectedIds: new Set([1, 2]) }),
    );
    await reg.dispatch('file.delete');
    assert.equal(fx.calls.length, 2);
    assert.deepEqual(fx.calls[0], ['delete', { id: 1, options: { trash: true, recursive: true } }]);
    assert.deepEqual(fx.calls[1], ['delete', { id: 2, options: { trash: true, recursive: true } }]);
  });

  it('file.delete respects toTrash=false override', async () => {
    const reg = createCommandRegistry(mutationDefaults);
    const fx = makeFakeFx();
    reg.setContextProvider(() =>
      makeCtx({ fx, focusedEntry: fileEntry(7) }),
    );
    await reg.dispatch('file.delete', { toTrash: false });
    assert.deepEqual(fx.calls, [
      ['delete', { id: 7, options: { trash: false, recursive: true } }],
    ]);
  });

  it('file.move delegates to fx.move per id', async () => {
    const reg = createCommandRegistry(mutationDefaults);
    const fx = makeFakeFx();
    reg.setContextProvider(() =>
      makeCtx({ fx, selectedIds: new Set([3, 4]) }),
    );
    await reg.dispatch('file.move', { targetParentId: 99 });
    assert.equal(fx.calls.length, 2);
    assert.equal(fx.calls[0][0], 'move');
    assert.equal(fx.calls[0][1].newParentId, 99);
  });

  it('file.copy delegates to fx.copy per id', async () => {
    const reg = createCommandRegistry(mutationDefaults);
    const fx = makeFakeFx();
    reg.setContextProvider(() =>
      makeCtx({ fx, focusedEntry: fileEntry(5) }),
    );
    await reg.dispatch('file.copy', { targetParentId: 88 });
    assert.equal(fx.calls.length, 1);
    assert.equal(fx.calls[0][0], 'copy');
    assert.equal(fx.calls[0][1].newParentId, 88);
  });

  it('file.open delegates to host.onOpen with the focused entry', () => {
    const reg = createCommandRegistry(mutationDefaults);
    const fx = makeFakeFx();
    const opened = [];
    const entry = fileEntry(11);
    reg.setContextProvider(() =>
      makeCtx({
        fx,
        focusedEntry: entry,
        host: { onOpen: (e, event) => opened.push({ entry: e, event }) },
      }),
    );
    reg.dispatch('file.open');
    assert.equal(opened.length, 1);
    assert.equal(opened[0].entry, entry);
    assert.deepEqual(opened[0].event, {
      mode: 'permanent',
      source: 'command',
    });
    // No engine call.
    assert.equal(fx.calls.length, 0);
  });

  it('file.revealInEditor delegates to host.onRevealInEditor', () => {
    const reg = createCommandRegistry(mutationDefaults);
    const fx = makeFakeFx();
    const revealed = [];
    const entry = fileEntry(12);
    reg.setContextProvider(() =>
      makeCtx({
        fx,
        focusedEntry: entry,
        host: { onRevealInEditor: (e) => revealed.push(e) },
      }),
    );
    reg.dispatch('file.revealInEditor');
    assert.equal(revealed.length, 1);
    assert.equal(revealed[0], entry);
  });

  it('path actions delegate a root-aware canonical target to host hooks', async () => {
    const reg = createCommandRegistry(mutationDefaults);
    const fx = makeFakeFx();
    const root = folderEntry(1);
    const folder = folderEntry(2, 1);
    const entry = fileEntry(3, 2);
    const snapshot = makeSnapshot(
      new Map([
        [root.id, root],
        [folder.id, folder],
        [entry.id, entry],
      ]),
    );
    const calls = [];
    reg.setContextProvider(() =>
      makeCtx({
        fx,
        snapshot,
        focusedEntry: entry,
        host: {
          copyPath: (target, kind) => calls.push({ action: 'copyPath', kind, target }),
          revealInFileManager: (target) => calls.push({ action: 'reveal', target }),
          openContainingFolder: (target) => calls.push({ action: 'containing', target }),
          openTerminalForEntry: (target) => calls.push({ action: 'terminal', target }),
        },
      }),
    );

    await reg.dispatch('file.copyAbsolutePath');
    await reg.dispatch('file.copyRelativePath');
    await reg.dispatch('file.revealInFileManager');
    await reg.dispatch('file.openContainingFolder');
    await reg.dispatch('file.openTerminal');

    assert.deepEqual(
      calls.map(({ action, kind, target }) => [
        action,
        kind ?? null,
        target.rootId,
        target.rootQualifiedPath,
        target.rootRelativePath,
      ]),
      [
        ['copyPath', 'absolute', 1, 'dir-1/dir-2/file-3', 'dir-2/file-3'],
        ['copyPath', 'relative', 1, 'dir-1/dir-2/file-3', 'dir-2/file-3'],
        ['reveal', null, 1, 'dir-1/dir-2/file-3', 'dir-2/file-3'],
        ['containing', null, 1, 'dir-1/dir-2/file-3', 'dir-2/file-3'],
        ['terminal', null, 1, 'dir-1/dir-2/file-3', 'dir-2/file-3'],
      ],
    );
    assert.ok(calls.every(({ target }) => target.entry === entry));
    assert.deepEqual(fx.calls, []);
  });

  it('refresh commands use host feedback hooks when supplied', async () => {
    const reg = createCommandRegistry(defaultCommands);
    const fx = makeFakeFx();
    const refreshed = [];
    reg.setContextProvider(() =>
      makeCtx({
        fx,
        focusedEntry: folderEntry(2, 1),
        host: { refresh: (target) => refreshed.push(target) },
      }),
    );
    await reg.dispatch('tree.refresh');
    await reg.dispatch('workspace.refresh');
    assert.deepEqual(refreshed, [
      { kind: 'subtree', id: 2, recursive: true },
      { kind: 'workspace' },
    ]);
    assert.deepEqual(fx.calls, []);
  });

  it('refresh commands fall back to engine reconciliation', async () => {
    const reg = createCommandRegistry(defaultCommands);
    const fx = makeFakeFx();
    reg.setContextProvider(() =>
      makeCtx({ fx, focusedEntry: fileEntry(3, 2) }),
    );
    await reg.dispatch('tree.refresh');
    await reg.dispatch('workspace.refresh');
    assert.deepEqual(fx.calls, [
      ['resync', { id: 3, options: { recursive: true } }],
      ['resyncWorkspace'],
    ]);
  });

  it('scoped search commands hand off root-aware single and multi-folder requests', async () => {
    const reg = createCommandRegistry(defaultCommands);
    const fx = makeFakeFx();
    const root = folderEntry(1);
    const src = folderEntry(2, 1);
    const testFolder = folderEntry(3, 1);
    const snapshot = makeSnapshot(
      new Map([
        [root.id, root],
        [src.id, src],
        [testFolder.id, testFolder],
      ]),
    );
    const requests = [];
    reg.setContextProvider(() =>
      makeCtx({
        fx,
        snapshot,
        focusedEntry: src,
        selectedIds: new Set([src.id, testFolder.id]),
        selectedEntries: [src, testFolder],
        isMultiSelect: true,
        host: { searchScope: (request) => requests.push(request) },
      }),
    );

    await reg.dispatch('search.findInFolder');
    await reg.dispatch('search.include');
    await reg.dispatch('search.exclude', { ids: [testFolder.id] });

    assert.deepEqual(
      requests.map((request) => ({
        kind: request.kind,
        paths: request.targets.map((target) => target.rootRelativePath),
      })),
      [
        { kind: 'findInFolder', paths: ['dir-2'] },
        { kind: 'include', paths: ['dir-2', 'dir-3'] },
        { kind: 'exclude', paths: ['dir-3'] },
      ],
    );
    assert.deepEqual(fx.calls, []);
  });
});

// ─── Keybinding lookup via registry ────────────────────────────────────────

describe('CommandRegistry — keybindings', () => {
  it('getBinding(string) finds a command by its keybinding', () => {
    const cmd = { id: 'x.rename', label: 'Rename', keybinding: 'F2', run: () => {} };
    const reg = createCommandRegistry([cmd]);
    const found = reg.getBinding('F2');
    assert.equal(found, cmd);
    assert.equal(reg.getBinding('F3'), undefined);
  });

  it('getBinding(KeyboardEvent) matches a simple F2 event', () => {
    const cmd = { id: 'x.rename', label: 'Rename', keybinding: 'F2', run: () => {} };
    const reg = createCommandRegistry([cmd]);
    const ev = { key: 'F2' };
    const found = reg.getBinding(ev);
    assert.equal(found, cmd);
  });

  it('getBinding handles array-of-keybindings', () => {
    const cmd = {
      id: 'x.del',
      label: 'Delete',
      keybinding: ['Delete', 'Backspace'],
      run: () => {},
    };
    const reg = createCommandRegistry([cmd]);
    assert.equal(reg.getBinding({ key: 'Delete' }), cmd);
    assert.equal(reg.getBinding({ key: 'Backspace' }), cmd);
    assert.equal(reg.getBinding({ key: 'Enter' }), undefined);
  });

  it('getBinding with modifier', () => {
    const cmd = { id: 'x.copy', label: 'Copy', keybinding: 'Mod+C', run: () => {} };
    const reg = createCommandRegistry([cmd]);
    const ev = process.platform === 'darwin'
      ? { key: 'c', metaKey: true }
      : { key: 'c', ctrlKey: true };
    assert.equal(reg.getBinding(ev), cmd);
  });
});

// ─── Override composition ──────────────────────────────────────────────────

describe('Override composition — file.delete wrapped with confirm', () => {
  it('skips engine call when confirm returns false', async () => {
    const reg = createCommandRegistry(defaultCommands);
    const original = reg.get('file.delete');
    assert.ok(original, 'defaultCommands must include file.delete');

    // Host override that wraps with a confirm gate.
    const override = {
      id: 'file.delete',
      label: 'Delete (with confirm)',
      run: async (ctx, args) => {
        const ok = await ctx.host.confirm?.('Delete?');
        if (!ok) return;
        return original.run(ctx, args);
      },
    };
    reg.register(override);

    const fx = makeFakeFx();
    reg.setContextProvider(() =>
      makeCtx({
        fx,
        focusedEntry: fileEntry(1),
        host: { confirm: async () => false },
      }),
    );

    await reg.dispatch('file.delete');
    assert.equal(fx.calls.length, 0, 'fx.delete must not be called when confirm returns false');
  });

  it('invokes the original when confirm returns true', async () => {
    const reg = createCommandRegistry(defaultCommands);
    const original = reg.get('file.delete');
    assert.ok(original);

    const override = {
      id: 'file.delete',
      label: 'Delete (with confirm)',
      run: async (ctx, args) => {
        const ok = await ctx.host.confirm?.('Delete?');
        if (!ok) return;
        return original.run(ctx, args);
      },
    };
    reg.register(override);

    const fx = makeFakeFx();
    reg.setContextProvider(() =>
      makeCtx({
        fx,
        focusedEntry: fileEntry(1),
        host: { confirm: async () => true },
      }),
    );

    await reg.dispatch('file.delete');
    assert.equal(fx.calls.length, 1);
    assert.equal(fx.calls[0][0], 'delete');
    assert.equal(fx.calls[0][1].id, 1);
  });

  it('disposing the override restores the original behavior', async () => {
    const reg = createCommandRegistry(defaultCommands);
    const original = reg.get('file.delete');
    assert.ok(original);

    const override = {
      id: 'file.delete',
      label: 'wrapper',
      run: async () => { /* swallow */ },
    };
    const disp = reg.register(override);
    assert.equal(reg.get('file.delete'), override);

    disp.dispose();
    assert.equal(reg.get('file.delete'), original);
  });
});
