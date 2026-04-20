// Phase 7 — clipboard flows.
//
// Coverage:
//   - Mod+C populates copyIds; Mod+X populates cutIds; sets are disjoint.
//   - Cut rows render `data-mille-cut="true"`.
//   - Mod+V after Mod+X dispatches `fx.move`; after Mod+C dispatches
//     `fx.copy`; with empty clipboard is a no-op.
//   - Multi-select delete asks for a single pluralized confirm and
//     aborts when denied.
//   - Esc clears the clipboard.

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

const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');

const { FileTree, FileTreeProvider } = await import('../dist/index.js');
const { createCommandRegistry, defaultCommands, mutationDefaults } = await import(
  '../dist/commands.js'
);
const { createFakeEngine, createFakeSnapshot } = await import('../dist/testing.js');

// ─── Helpers ──────────────────────────────────────────────────────────

const KIND_FILE = 0;
const KIND_DIRECTORY = 1;

function makeRow(p) {
  return {
    id: p.id,
    parentId: p.parentId,
    name: p.name,
    kind: p.kind ?? KIND_DIRECTORY,
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

function clickRow(row, { metaKey = false, shiftKey = false, ctrlKey = false } = {}) {
  const evt = new hdWindow.MouseEvent('click', {
    metaKey,
    shiftKey,
    ctrlKey,
    bubbles: true,
    cancelable: true,
  });
  row.dispatchEvent(evt);
}

function sampleRows() {
  // root/folder (id 1) containing three files.
  return [
    makeRow({ id: 1, parentId: null, name: 'root', depth: 0, hasChildren: true, isExpanded: true }),
    makeRow({ id: 2, parentId: 1, name: 'alpha.ts', depth: 1, kind: KIND_FILE }),
    makeRow({ id: 3, parentId: 1, name: 'beta.ts', depth: 1, kind: KIND_FILE }),
    makeRow({ id: 4, parentId: 1, name: 'gamma.ts', depth: 1, kind: KIND_FILE }),
  ];
}

function treeSelector(container) {
  return container.querySelector('[role="tree"]');
}

function rowElements(container) {
  return Array.from(container.querySelectorAll('[role="treeitem"]'));
}

function rowByEntryId(container, id) {
  return container.querySelector(`[data-mille-row-id="${id}"]`);
}

function selectedIds(container) {
  return Array.from(container.querySelectorAll('[data-mille-selected="true"]'))
    .map((el) => Number(el.getAttribute('data-mille-row-id')))
    .sort((a, b) => a - b);
}

function cutIds(container) {
  return Array.from(container.querySelectorAll('[data-mille-cut="true"]'))
    .map((el) => Number(el.getAttribute('data-mille-row-id')))
    .sort((a, b) => a - b);
}

/**
 * Mount a FileTree wrapped in a FileTreeProvider that wires the
 * default command set plus any extra commands passed in. Exposes the
 * registry + host hooks so tests can observe dispatches. The provider
 * sets a context provider that reflects live selection / clipboard via
 * closures; those are populated by the tree as it runs (via
 * `onSelectionChange` / `onClipboardChange` observers).
 */
function mountTreeWithRegistry({
  fx,
  host = {},
  commandOverrides = [],
} = {}) {
  const registry = createCommandRegistry([...mutationDefaults, ...commandOverrides]);
  // Live state mirrored from the tree's observers so the
  // command context reflects what the user "sees".
  let latestSelected = new Set();
  let latestFocused = null;
  let latestCut = new Set();
  let latestCopy = new Set();
  registry.setContextProvider(() => ({
    fx,
    snapshot: fx.getSnapshot(),
    focusedId: latestFocused,
    focusedEntry: latestFocused !== null ? fx.getSnapshot().getById(latestFocused) : null,
    selectedIds: latestSelected,
    selectedEntries: [],
    isMultiSelect: latestSelected.size > 1,
    isRenaming: false,
    host,
    cutIds: latestCut,
    copyIds: latestCopy,
  }));

  const { container, root } = mount();
  const obs = makeObservers();

  return {
    container,
    root,
    registry,
    async render() {
      await act(async () => {
        root.render(
          createElement(
            FileTreeProvider,
            { fx, commands: registry },
            createElement(FileTree, {
              ariaLabel: 'Clipboard',
              rowHeight: 22,
              overscan: 50,
              onSelectionChange: (ids) => { latestSelected = new Set(ids); },
              onFocusedIdChange: (id) => { latestFocused = id; },
              onClipboardChange: ({ cutIds: c, copyIds: p }) => {
                latestCut = new Set(c);
                latestCopy = new Set(p);
              },
              __testObserveElementRect: obs.observeElementRect,
              __testObserveElementOffset: obs.observeElementOffset,
            }),
          ),
        );
      });
    },
    getLatestCut: () => latestCut,
    getLatestCopy: () => latestCopy,
    async cleanup() {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────

test('Mod+C on selected rows populates copyIds and leaves cutIds empty', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));

  const h = mountTreeWithRegistry({ fx });
  await h.render();

  const tree = treeSelector(h.container);
  const rows = rowElements(h.container);
  // Click row 2 (alpha.ts) to select + focus it.
  await act(async () => { clickRow(rows[1]); });
  // Cmd-click row 3 (beta.ts) to add to selection.
  await act(async () => { clickRow(rows[2], { metaKey: true }); });
  assert.deepEqual(selectedIds(h.container), [2, 3]);

  await act(async () => { fireKey(tree, 'c', { metaKey: true }); });

  const latestCopy = h.getLatestCopy();
  const latestCut = h.getLatestCut();
  assert.deepEqual(Array.from(latestCopy).sort(), [2, 3]);
  assert.equal(latestCut.size, 0);

  await h.cleanup();
});

test('Mod+X on selected rows populates cutIds and leaves copyIds empty', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));

  const h = mountTreeWithRegistry({ fx });
  await h.render();

  const tree = treeSelector(h.container);
  const rows = rowElements(h.container);
  await act(async () => { clickRow(rows[1]); });
  await act(async () => { clickRow(rows[3], { metaKey: true }); });
  assert.deepEqual(selectedIds(h.container), [2, 4]);

  await act(async () => { fireKey(tree, 'x', { metaKey: true }); });

  assert.deepEqual(Array.from(h.getLatestCut()).sort(), [2, 4]);
  assert.equal(h.getLatestCopy().size, 0);

  await h.cleanup();
});

test('Mod+X then Mod+C clears cutIds and populates copyIds (sets are disjoint)', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));

  const h = mountTreeWithRegistry({ fx });
  await h.render();

  const tree = treeSelector(h.container);
  const rows = rowElements(h.container);
  await act(async () => { clickRow(rows[1]); });
  await act(async () => { fireKey(tree, 'x', { metaKey: true }); });
  assert.deepEqual(Array.from(h.getLatestCut()).sort(), [2]);

  // Now select a different row and copy it.
  await act(async () => { clickRow(rows[2]); });
  await act(async () => { fireKey(tree, 'c', { metaKey: true }); });

  assert.equal(h.getLatestCut().size, 0);
  assert.deepEqual(Array.from(h.getLatestCopy()).sort(), [3]);

  await h.cleanup();
});

test('Row with id in cutIds renders data-mille-cut="true"', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));

  const h = mountTreeWithRegistry({ fx });
  await h.render();

  const tree = treeSelector(h.container);
  const rows = rowElements(h.container);
  await act(async () => { clickRow(rows[1]); });
  await act(async () => { fireKey(tree, 'x', { metaKey: true }); });

  assert.deepEqual(cutIds(h.container), [2]);
  // Sanity: other rows are NOT marked cut.
  const row3 = rowByEntryId(h.container, 3);
  assert.equal(row3.getAttribute('data-mille-cut'), null);

  await h.cleanup();
});

test('Mod+V after Mod+X dispatches fx.move with the cut ids under the focused folder', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));

  const h = mountTreeWithRegistry({ fx });
  await h.render();

  const tree = treeSelector(h.container);
  const rows = rowElements(h.container);
  // Cut the file alpha.ts (id 2).
  await act(async () => { clickRow(rows[1]); });
  await act(async () => { fireKey(tree, 'x', { metaKey: true }); });
  assert.deepEqual(Array.from(h.getLatestCut()).sort(), [2]);

  // Focus the folder (id 1) so paste targets it.
  await act(async () => { clickRow(rows[0]); });

  // Paste.
  await act(async () => { fireKey(tree, 'v', { metaKey: true }); });

  // file.paste resolves target parent = focused folder id (1), then
  // calls fx.move for each id in cutIds.
  assert.equal(fx.calls.move.length, 1, 'expected exactly one move call');
  assert.equal(fx.calls.move[0].id, 2);
  assert.equal(fx.calls.move[0].newParentId, 1);

  // Copy path should NOT have been called.
  assert.equal(fx.calls.copy.length, 0);

  await h.cleanup();
});

test('Mod+V after Mod+C dispatches fx.copy with the copy ids', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));

  const h = mountTreeWithRegistry({ fx });
  await h.render();

  const tree = treeSelector(h.container);
  const rows = rowElements(h.container);
  // Copy beta.ts (id 3) + gamma.ts (id 4).
  await act(async () => { clickRow(rows[2]); });
  await act(async () => { clickRow(rows[3], { metaKey: true }); });
  await act(async () => { fireKey(tree, 'c', { metaKey: true }); });

  // Focus root folder so paste targets it.
  await act(async () => { clickRow(rows[0]); });

  await act(async () => { fireKey(tree, 'v', { metaKey: true }); });

  assert.equal(fx.calls.copy.length, 2, 'expected fx.copy for each copy id');
  const newParents = fx.calls.copy.map((c) => c.newParentId).sort();
  assert.deepEqual(newParents, [1, 1]);
  const copiedIds = fx.calls.copy.map((c) => c.id).sort();
  assert.deepEqual(copiedIds, [3, 4]);

  // Move path should NOT have been called.
  assert.equal(fx.calls.move.length, 0);

  await h.cleanup();
});

test('Mod+V with empty clipboard is a no-op (neither move nor copy fires)', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));

  const h = mountTreeWithRegistry({ fx });
  await h.render();

  const tree = treeSelector(h.container);
  const rows = rowElements(h.container);
  await act(async () => { clickRow(rows[0]); });

  await act(async () => { fireKey(tree, 'v', { metaKey: true }); });

  assert.equal(fx.calls.move.length, 0);
  assert.equal(fx.calls.copy.length, 0);

  await h.cleanup();
});

test('Multi-select Delete asks host.confirm once and aborts on false', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));

  const prompts = [];
  const host = {
    confirm: (message) => {
      prompts.push(message);
      return false; // user cancels
    },
  };

  const h = mountTreeWithRegistry({ fx, host });
  await h.render();

  const tree = treeSelector(h.container);
  const rows = rowElements(h.container);
  await act(async () => { clickRow(rows[1]); });
  await act(async () => { clickRow(rows[2], { metaKey: true }); });
  await act(async () => { clickRow(rows[3], { metaKey: true }); });
  assert.equal(selectedIds(h.container).length, 3);

  await act(async () => { fireKey(tree, 'Delete'); });
  // Allow any pending promise chain inside the async `run` to settle.
  await act(async () => { await Promise.resolve(); });

  assert.equal(prompts.length, 1, 'expected one confirm prompt');
  assert.equal(prompts[0], 'Delete 3 items?');
  assert.equal(fx.calls.delete.length, 0, 'delete should NOT run after a false confirm');

  await h.cleanup();
});

test('Multi-select Delete proceeds when host.confirm returns true', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));

  const prompts = [];
  const host = {
    confirm: (message) => {
      prompts.push(message);
      return true;
    },
  };

  const h = mountTreeWithRegistry({ fx, host });
  await h.render();

  const tree = treeSelector(h.container);
  const rows = rowElements(h.container);
  await act(async () => { clickRow(rows[1]); });
  await act(async () => { clickRow(rows[2], { metaKey: true }); });

  await act(async () => { fireKey(tree, 'Delete'); });
  // Drain the microtask queue so the awaited fx.delete calls complete.
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });

  assert.equal(prompts.length, 1);
  assert.equal(prompts[0], 'Delete 2 items?');
  assert.equal(fx.calls.delete.length, 2);

  await h.cleanup();
});

test('Escape clears the clipboard', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));

  const h = mountTreeWithRegistry({ fx });
  await h.render();

  const tree = treeSelector(h.container);
  const rows = rowElements(h.container);
  await act(async () => { clickRow(rows[1]); });
  await act(async () => { fireKey(tree, 'x', { metaKey: true }); });
  assert.deepEqual(Array.from(h.getLatestCut()).sort(), [2]);
  assert.deepEqual(cutIds(h.container), [2]);

  await act(async () => { fireKey(tree, 'Escape'); });

  assert.equal(h.getLatestCut().size, 0, 'cutIds cleared after Esc');
  assert.equal(h.getLatestCopy().size, 0);
  assert.deepEqual(cutIds(h.container), [], 'data-mille-cut attribute removed');

  await h.cleanup();
});

test('file.paste command is registered by default and visible in context menu when clipboard non-empty', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));

  // Build a fresh registry WITHOUT file.paste to verify the tree
  // auto-registers it.
  const reg = createCommandRegistry(
    mutationDefaults.filter((c) => c.id !== 'file.paste'),
  );
  let latestSelected = new Set();
  let latestFocused = null;
  let latestCut = new Set();
  let latestCopy = new Set();
  reg.setContextProvider(() => ({
    fx,
    snapshot: fx.getSnapshot(),
    focusedId: latestFocused,
    focusedEntry: latestFocused !== null ? fx.getSnapshot().getById(latestFocused) : null,
    selectedIds: latestSelected,
    selectedEntries: [],
    isMultiSelect: false,
    isRenaming: false,
    host: {},
    cutIds: latestCut,
    copyIds: latestCopy,
  }));

  // Sanity: paste NOT in registry before mount.
  assert.equal(reg.get('file.paste'), undefined);

  const { container, root } = mount();
  const obs = makeObservers();
  await act(async () => {
    root.render(
      createElement(
        FileTreeProvider,
        { fx, commands: reg },
        createElement(FileTree, {
          ariaLabel: 'AutoRegister',
          rowHeight: 22,
          overscan: 50,
          onSelectionChange: (ids) => { latestSelected = new Set(ids); },
          onFocusedIdChange: (id) => { latestFocused = id; },
          onClipboardChange: ({ cutIds: c, copyIds: p }) => {
            latestCut = new Set(c);
            latestCopy = new Set(p);
          },
          __testObserveElementRect: obs.observeElementRect,
          __testObserveElementOffset: obs.observeElementOffset,
        }),
      ),
    );
  });

  // After mount the tree should have registered file.paste.
  const paste = reg.get('file.paste');
  assert.ok(paste, 'file.paste should be auto-registered');
  assert.equal(paste.id, 'file.paste');
  // Visibility predicate: hidden when clipboard is empty, visible once
  // cut or copy ids appear.
  const vis = paste.visibleInContextMenu;
  assert.equal(typeof vis, 'function');
  // Hidden when both empty.
  assert.equal(
    vis({
      fx, snapshot: fx.getSnapshot(), focusedId: null, focusedEntry: null,
      selectedIds: new Set(), selectedEntries: [], isMultiSelect: false,
      isRenaming: false, host: {}, cutIds: new Set(), copyIds: new Set(),
    }),
    false,
  );
  // Visible when copyIds has anything.
  assert.equal(
    vis({
      fx, snapshot: fx.getSnapshot(), focusedId: null, focusedEntry: null,
      selectedIds: new Set(), selectedEntries: [], isMultiSelect: false,
      isRenaming: false, host: {}, cutIds: new Set(), copyIds: new Set([9]),
    }),
    true,
  );

  await act(async () => { root.unmount(); });
  container.remove();

  // The auto-registration is cleaned up on unmount.
  assert.equal(reg.get('file.paste'), undefined, 'file.paste should be unregistered on unmount');
});

test('single-item Delete does NOT prompt host.confirm', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));

  const prompts = [];
  const host = {
    confirm: (message) => {
      prompts.push(message);
      return true;
    },
  };

  const h = mountTreeWithRegistry({ fx, host });
  await h.render();

  const tree = treeSelector(h.container);
  const rows = rowElements(h.container);
  await act(async () => { clickRow(rows[1]); });

  await act(async () => { fireKey(tree, 'Delete'); });
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });

  assert.equal(prompts.length, 0, 'single-item delete should not confirm');
  assert.equal(fx.calls.delete.length, 1);

  await h.cleanup();
});

// Also exercise the pure useClipboardState hook directly.
test('useClipboardState: markCopy clears cutIds; clear empties both', async () => {
  const { useClipboardState } = await import('../dist/hooks/useClipboardState.js');
  // Call the hook outside React via a functional-component test.
  const { useEffect } = await import('react');
  let handle = null;
  function Probe() {
    handle = useClipboardState();
    useEffect(() => {}, []);
    return null;
  }
  const { container, root } = mount();
  await act(async () => {
    root.render(createElement(Probe));
  });

  assert.ok(handle);
  assert.equal(handle.cutIds.size, 0);
  assert.equal(handle.copyIds.size, 0);

  await act(async () => { handle.markCut([1, 2, 3]); });
  assert.deepEqual(Array.from(handle.cutIds).sort(), [1, 2, 3]);
  assert.equal(handle.copyIds.size, 0);

  await act(async () => { handle.markCopy([4, 5]); });
  assert.deepEqual(Array.from(handle.copyIds).sort(), [4, 5]);
  assert.equal(handle.cutIds.size, 0, 'markCopy clears cutIds');

  await act(async () => { handle.clear(); });
  assert.equal(handle.cutIds.size, 0);
  assert.equal(handle.copyIds.size, 0);

  await act(async () => { root.unmount(); });
  container.remove();
});

// Guard the `defaultCommands` export includes the new paste entry.
test('defaultCommands export includes file.paste', () => {
  const ids = defaultCommands.map((c) => c.id);
  assert.ok(ids.includes('file.paste'));
});
