// Phase-5 create (new-file / new-folder) flow tests.
//
// Covers:
//   1. Mod+N → fx.create called with kind=file; rename input opens on new entry.
//   2. Mod+Shift+N → fx.create called with kind=directory; rename input opens.
//   3. Explicit dispatch of file.create with { name } → fx.create called,
//      rename input does NOT open.
//   4. First provisional name conflict fallback (`__mille_new_file__` →
//      `__new_1` etc.) works.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { Window } from 'happy-dom';

const hdWindow = new Window({ url: 'http://localhost/' });
const hdDocument = hdWindow.document;

function installGlobal(name, value) {
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
    enumerable: false,
  });
}

installGlobal('window', hdWindow);
installGlobal('document', hdDocument);
installGlobal('navigator', hdWindow.navigator);
installGlobal('HTMLElement', hdWindow.HTMLElement);
installGlobal('HTMLInputElement', hdWindow.HTMLInputElement);
installGlobal('Node', hdWindow.Node);
installGlobal('Element', hdWindow.Element);
installGlobal('MessageChannel', hdWindow.MessageChannel);
installGlobal('IS_REACT_ACT_ENVIRONMENT', true);
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  installGlobal('ResizeObserver', ResizeObserverMock);
}

// Node's `process` is always available in Node test; nothing extra needed.

const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');

const { FileTree } = await import('../dist/index.js');
const { createCommandRegistry, defaultCommands } = await import('../dist/commands.js');
const { createFakeEngine, createFakeSnapshot } = await import('../dist/testing.js');

// ─── Helpers ──────────────────────────────────────────────────────────

function makeRow(p) {
  return {
    id: p.id,
    parentId: p.parentId,
    name: p.name,
    kind: p.kind ?? 1,
    size: 0,
    mtimeMs: 0,
    ctimeMs: 0,
    isIgnored: false,
    isReadonly: false,
    isHidden: false,
    depth: p.depth,
    hasChildren: p.hasChildren ?? false,
    isExpanded: p.isExpanded ?? false,
  };
}

function makeObservers({ height = 400, width = 600 } = {}) {
  const observeElementRect = (_instance, cb) => {
    cb({ width, height });
    return () => {};
  };
  const observeElementOffset = (_instance, cb) => {
    cb(0, false);
    return () => {};
  };
  return { observeElementRect, observeElementOffset };
}

function mount() {
  const container = hdDocument.createElement('div');
  hdDocument.body.appendChild(container);
  return { container, root: createRoot(container) };
}

function fireKey(el, key, { metaKey = false, ctrlKey = false, altKey = false, shiftKey = false } = {}) {
  const evt = new hdWindow.KeyboardEvent('keydown', {
    key,
    metaKey,
    ctrlKey,
    altKey,
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  el.dispatchEvent(evt);
}

function clickRow(row) {
  const evt = new hdWindow.MouseEvent('click', {
    bubbles: true,
    cancelable: true,
  });
  row.dispatchEvent(evt);
}

function treeSelector(container) {
  return container.querySelector('[role="tree"]');
}

function renameInput(container) {
  return container.querySelector('input[data-mille-rename-input=""]');
}

function sampleRows() {
  return [
    makeRow({ id: 1, parentId: null, name: 'root', depth: 0, hasChildren: true, isExpanded: true }),
    makeRow({ id: 2, parentId: 1, name: 'hello.ts', depth: 1, kind: 0 }),
  ];
}

async function mountTree(container, root, fx, extra = {}) {
  const obs = makeObservers();
  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'Create',
        rowHeight: 22,
        overscan: 50,
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
        ...extra,
      }),
    );
  });
}

// ─── Tests ────────────────────────────────────────────────────────────

test('Mod+N creates a file under focused parent and opens rename on it', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));

  // Wire fx.create to also append a visible row for the new entry so
  // the renamed-on-entry input has something to render against.
  let nextId = 100;
  fx.create = async (parentId, name, kind) => {
    const id = nextId++;
    fx.calls.create.push({ parentId, name, kind });
    const rows = [
      ...sampleRows(),
      makeRow({ id, parentId, name, depth: 1, kind }),
    ];
    fx.emitDelta(createFakeSnapshot({ rows, treeVersion: 2 }));
    return {
      id, parentId, name, kind,
      size: 0, mtimeMs: 0, ctimeMs: 0,
      isIgnored: false, isReadonly: false, isHidden: false,
    };
  };

  const { container, root } = mount();
  await mountTree(container, root, fx);

  const tree = treeSelector(container);
  const rowEls = container.querySelectorAll('[role="treeitem"]');
  // Focus on the root folder so the create-parent resolves to root.
  await act(async () => { clickRow(rowEls[0]); });

  const onDarwin = process.platform === 'darwin';
  await act(async () => {
    fireKey(tree, 'n', onDarwin ? { metaKey: true } : { ctrlKey: true });
  });
  // Allow any pending microtasks (our create awaits fx.create).
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });

  assert.equal(fx.calls.create.length, 1, 'fx.create was called');
  const call = fx.calls.create[0];
  assert.equal(call.parentId, 1, 'created under focused folder');
  assert.equal(call.kind, 0, 'kind = file');
  assert.equal(call.name, '__mille_new_file__', 'used provisional name');

  // The rename input should be open on the newly-created id.
  const input = renameInput(container);
  assert.ok(input, 'rename input opened after create');
  assert.equal(input.value, '__mille_new_file__');

  await act(async () => { root.unmount(); });
  container.remove();
});

test('Mod+Shift+N creates a directory under focused parent and opens rename', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));

  let nextId = 200;
  fx.create = async (parentId, name, kind) => {
    const id = nextId++;
    fx.calls.create.push({ parentId, name, kind });
    const rows = [
      ...sampleRows(),
      makeRow({ id, parentId, name, depth: 1, kind }),
    ];
    fx.emitDelta(createFakeSnapshot({ rows, treeVersion: 2 }));
    return {
      id, parentId, name, kind,
      size: 0, mtimeMs: 0, ctimeMs: 0,
      isIgnored: false, isReadonly: false, isHidden: false,
    };
  };

  const { container, root } = mount();
  await mountTree(container, root, fx);

  const tree = treeSelector(container);
  const rowEls = container.querySelectorAll('[role="treeitem"]');
  await act(async () => { clickRow(rowEls[0]); });

  const onDarwin = process.platform === 'darwin';
  await act(async () => {
    fireKey(
      tree,
      'n',
      onDarwin ? { metaKey: true, shiftKey: true } : { ctrlKey: true, shiftKey: true },
    );
  });
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });

  assert.equal(fx.calls.create.length, 1);
  assert.equal(fx.calls.create[0].kind, 1, 'kind = directory');
  assert.equal(fx.calls.create[0].name, '__mille_new_directory__');

  const input = renameInput(container);
  assert.ok(input, 'rename input opened after folder create');

  await act(async () => { root.unmount(); });
  container.remove();
});

test('Explicit file.create dispatch with { name } calls fx.create and does NOT open rename', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));

  // Install the default registry (provides the real file.create command).
  const commands = createCommandRegistry(defaultCommands);
  commands.setContextProvider(() => ({
    fx,
    snapshot: fx.getSnapshot(),
    focusedId: 1,
    focusedEntry: {
      id: 1, parentId: null, name: 'root', kind: 1,
      size: 0, mtimeMs: 0, ctimeMs: 0,
      isIgnored: false, isReadonly: false, isHidden: false,
    },
    selectedIds: new Set(),
    selectedEntries: [],
    isMultiSelect: false,
    isRenaming: false,
    host: {},
  }));

  const { container, root } = mount();
  // Render the tree inside a provider with the command registry.
  const { FileTreeProvider } = await import('../dist/index.js');
  const obs = makeObservers();
  await act(async () => {
    root.render(
      createElement(
        FileTreeProvider,
        { fx, commands },
        createElement(FileTree, {
          ariaLabel: 'ExplicitCreate',
          rowHeight: 22,
          overscan: 50,
          __testObserveElementRect: obs.observeElementRect,
          __testObserveElementOffset: obs.observeElementOffset,
        }),
      ),
    );
  });

  await act(async () => {
    await commands.dispatch('file.create', { name: 'foo.ts' });
  });

  assert.equal(fx.calls.create.length, 1);
  assert.equal(fx.calls.create[0].name, 'foo.ts');
  assert.equal(fx.calls.create[0].parentId, 1);
  // kind defaults to file (0).
  assert.equal(fx.calls.create[0].kind, 0);

  // No rename input should appear because the explicit dispatch bypassed
  // the keyboard-driven provisional-create + open-rename flow.
  assert.equal(renameInput(container), null);

  await act(async () => { root.unmount(); });
  container.remove();
});

test('Provisional name collision falls back to __new_1, __new_2, ...', async () => {
  // Monkey-patch fx.create to reject the first two attempts then succeed.
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));

  const attempted = [];
  let nextId = 300;
  fx.create = async (parentId, name, kind) => {
    attempted.push(name);
    if (name === '__mille_new_file__' || name === '__new_1') {
      const err = new Error('name reserved');
      err.code = 'EEXIST';
      throw err;
    }
    // Third attempt succeeds — emit delta so the new row is visible.
    const id = nextId++;
    const rows = [
      ...sampleRows(),
      makeRow({ id, parentId, name, depth: 1, kind }),
    ];
    fx.emitDelta(createFakeSnapshot({ rows, treeVersion: 2 }));
    return {
      id, parentId, name, kind,
      size: 0, mtimeMs: 0, ctimeMs: 0,
      isIgnored: false, isReadonly: false, isHidden: false,
    };
  };

  const { container, root } = mount();
  await mountTree(container, root, fx);

  const tree = treeSelector(container);
  const rowEls = container.querySelectorAll('[role="treeitem"]');
  await act(async () => { clickRow(rowEls[0]); });
  const onDarwin = process.platform === 'darwin';
  await act(async () => {
    fireKey(tree, 'n', onDarwin ? { metaKey: true } : { ctrlKey: true });
  });
  // The create loop is async; flush a generous number of microtasks.
  for (let i = 0; i < 10; i += 1) {
    await act(async () => { await Promise.resolve(); });
  }

  assert.deepEqual(attempted.slice(0, 3), [
    '__mille_new_file__',
    '__new_1',
    '__new_2',
  ]);

  // Rename input should open on the successful third attempt.
  const input = renameInput(container);
  assert.ok(input, 'rename input opened after successful fallback');

  await act(async () => { root.unmount(); });
  container.remove();
});
