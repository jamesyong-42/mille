// Keyboard navigation + typeahead coverage for <FileTree>.
//
// Exercises SPEC §6.1 through the rendered tree. happy-dom KeyboardEvent
// shim carries metaKey/ctrlKey/shiftKey we need for range / select-all.

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
const { createCommandRegistry } = await import('../dist/commands.js');
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

function sampleRows(n) {
  const rows = [
    makeRow({ id: 1, parentId: null, name: 'alpha', depth: 0, hasChildren: true, isExpanded: true }),
    makeRow({ id: 2, parentId: 1, name: 'banana', depth: 1, kind: 0 }),
    makeRow({ id: 3, parentId: 1, name: 'cherry', depth: 1, kind: 0 }),
    makeRow({ id: 4, parentId: 1, name: 'durian', depth: 1, kind: 0 }),
    makeRow({ id: 5, parentId: null, name: 'beta', depth: 0, hasChildren: true, isExpanded: false }),
  ];
  return rows.slice(0, n);
}

function treeSelector(container) {
  return container.querySelector('[role="tree"]');
}

function rowIds(container) {
  return Array.from(container.querySelectorAll('[role="treeitem"]'))
    .map((el) => Number(el.getAttribute('data-mille-row-id')));
}

function focusedId(container) {
  const el = container.querySelector('[data-mille-focused="true"]');
  return el ? Number(el.getAttribute('data-mille-row-id')) : null;
}

function selectedIds(container) {
  return Array.from(container.querySelectorAll('[data-mille-selected="true"]'))
    .map((el) => Number(el.getAttribute('data-mille-row-id')))
    .sort((a, b) => a - b);
}

// ─── Tests ────────────────────────────────────────────────────────────

test('ArrowDown / ArrowUp moves focus to next/prev visible row', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(5), treeVersion: 1 }));

  const { container, root } = mount();
  const obs = makeObservers();

  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'KeyNav',
        rowHeight: 22,
        overscan: 50,
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  const tree = treeSelector(container);
  assert.ok(tree);

  // Start by clicking the first row.
  const rowsEls = container.querySelectorAll('[role="treeitem"]');
  await act(async () => { clickRow(rowsEls[0]); });
  assert.equal(focusedId(container), 1);

  await act(async () => { fireKey(tree, 'ArrowDown'); });
  assert.equal(focusedId(container), 2);
  await act(async () => { fireKey(tree, 'ArrowDown'); });
  assert.equal(focusedId(container), 3);
  await act(async () => { fireKey(tree, 'ArrowUp'); });
  assert.equal(focusedId(container), 2);

  await act(async () => { root.unmount(); });
  container.remove();
});

test('Home / End jump focus to first / last visible row', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(5), treeVersion: 1 }));

  const { container, root } = mount();
  const obs = makeObservers();

  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'HomeEnd',
        rowHeight: 22,
        overscan: 50,
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  const tree = treeSelector(container);
  const rowsEls = container.querySelectorAll('[role="treeitem"]');
  await act(async () => { clickRow(rowsEls[2]); });

  await act(async () => { fireKey(tree, 'End'); });
  assert.equal(focusedId(container), 5);
  await act(async () => { fireKey(tree, 'Home'); });
  assert.equal(focusedId(container), 1);

  await act(async () => { root.unmount(); });
  container.remove();
});

test('Shift+ArrowDown extends selection along the range', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(5), treeVersion: 1 }));

  const { container, root } = mount();
  const obs = makeObservers();

  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'Range',
        rowHeight: 22,
        overscan: 50,
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  const tree = treeSelector(container);
  const rowsEls = container.querySelectorAll('[role="treeitem"]');
  await act(async () => { clickRow(rowsEls[0]); });
  assert.deepEqual(selectedIds(container), [1]);

  await act(async () => { fireKey(tree, 'ArrowDown', { shiftKey: true }); });
  assert.deepEqual(selectedIds(container), [1, 2]);
  await act(async () => { fireKey(tree, 'ArrowDown', { shiftKey: true }); });
  assert.deepEqual(selectedIds(container), [1, 2, 3]);

  await act(async () => { root.unmount(); });
  container.remove();
});

test('Typeahead jumps focus to the next matching row (case-insensitive startsWith)', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(5), treeVersion: 1 }));

  const { container, root } = mount();
  const obs = makeObservers();

  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'Typeahead',
        rowHeight: 22,
        overscan: 50,
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  const tree = treeSelector(container);
  const rowsEls = container.querySelectorAll('[role="treeitem"]');
  await act(async () => { clickRow(rowsEls[0]); });

  await act(async () => { fireKey(tree, 'd'); });
  // 'durian' is the only "d" match.
  assert.equal(focusedId(container), 4);

  await act(async () => { root.unmount(); });
  container.remove();
});

test('Typeahead wraps from the end of the visible order', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(5), treeVersion: 1 }));
  const { container, root } = mount();
  const obs = makeObservers();

  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'Typeahead wrap',
        rowHeight: 22,
        overscan: 50,
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  const tree = treeSelector(container);
  const beta = container.querySelector('[data-mille-row-id="5"]');
  await act(async () => { clickRow(beta); });
  await act(async () => { fireKey(tree, 'b'); });
  assert.equal(focusedId(container), 2);

  await act(async () => { root.unmount(); });
  container.remove();
});

test('Enter on a file dispatches file.open through the command registry', async () => {
  const fx = createFakeEngine();
  const rows = [
    makeRow({ id: 1, parentId: null, name: 'root', depth: 0, hasChildren: true, isExpanded: true }),
    makeRow({ id: 2, parentId: 1, name: 'hello.ts', depth: 1, kind: 0 }),
  ];
  fx.emitDelta(createFakeSnapshot({ rows, treeVersion: 1 }));

  const dispatches = [];
  const commands = createCommandRegistry([
    {
      id: 'file.open',
      label: 'Open',
      run: (_ctx, args) => { dispatches.push({ id: 'file.open', args }); },
    },
    {
      id: 'tree.expand',
      label: 'Expand',
      run: (_ctx, args) => { dispatches.push({ id: 'tree.expand', args }); },
    },
    {
      id: 'tree.collapse',
      label: 'Collapse',
      run: (_ctx, args) => { dispatches.push({ id: 'tree.collapse', args }); },
    },
  ]);
  commands.setContextProvider(() => ({
    fx,
    snapshot: fx.getSnapshot(),
    focusedId: null,
    focusedEntry: null,
    selectedIds: new Set(),
    selectedEntries: [],
    isMultiSelect: false,
    isRenaming: false,
    host: {},
  }));

  const { container, root } = mount();
  const obs = makeObservers();

  await act(async () => {
    root.render(
      createElement(
        FileTreeProvider,
        { fx, commands },
        createElement(FileTree, {
          ariaLabel: 'EnterOpen',
          rowHeight: 22,
          overscan: 50,
          __testObserveElementRect: obs.observeElementRect,
          __testObserveElementOffset: obs.observeElementOffset,
        }),
      ),
    );
  });

  const tree = treeSelector(container);
  const rowsEls = container.querySelectorAll('[role="treeitem"]');
  // Focus the file row.
  await act(async () => { clickRow(rowsEls[1]); });

  await act(async () => { fireKey(tree, 'Enter'); });
  const openCalls = dispatches.filter((d) => d.id === 'file.open');
  assert.equal(openCalls.length, 1);
  assert.deepEqual(openCalls[0].args, {
    id: 2,
    mode: 'permanent',
    source: 'keyboard',
  });

  await act(async () => { root.unmount(); });
  container.remove();
});

test('Delete/Backspace dispatch file.delete with toTrash: true; Shift variants with false', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(5), treeVersion: 1 }));

  const deletes = [];
  const commands = createCommandRegistry([
    {
      id: 'file.delete',
      label: 'Delete',
      run: (_ctx, args) => { deletes.push(args); },
    },
  ]);
  commands.setContextProvider(() => ({
    fx,
    snapshot: fx.getSnapshot(),
    focusedId: null,
    focusedEntry: null,
    selectedIds: new Set(),
    selectedEntries: [],
    isMultiSelect: false,
    isRenaming: false,
    host: {},
  }));

  const { container, root } = mount();
  const obs = makeObservers();

  await act(async () => {
    root.render(
      createElement(
        FileTreeProvider,
        { fx, commands },
        createElement(FileTree, {
          ariaLabel: 'Delete',
          rowHeight: 22,
          overscan: 50,
          __testObserveElementRect: obs.observeElementRect,
          __testObserveElementOffset: obs.observeElementOffset,
        }),
      ),
    );
  });

  const tree = treeSelector(container);
  const rowsEls = container.querySelectorAll('[role="treeitem"]');
  await act(async () => { clickRow(rowsEls[1]); });

  await act(async () => { fireKey(tree, 'Delete'); });
  await act(async () => { fireKey(tree, 'Backspace'); });
  assert.equal(deletes.length, 2);
  assert.equal(deletes[0].toTrash, true);
  assert.equal(deletes[1].toTrash, true);

  await act(async () => { fireKey(tree, 'Delete', { shiftKey: true }); });
  assert.equal(deletes.length, 3);
  assert.equal(deletes[2].toTrash, false);

  await act(async () => { root.unmount(); });
  container.remove();
});

test('Cmd+A selects all visible rows when multiSelect is enabled', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(5), treeVersion: 1 }));

  const { container, root } = mount();
  const obs = makeObservers();

  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'SelectAll',
        rowHeight: 22,
        overscan: 50,
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  const tree = treeSelector(container);
  const rowsEls = container.querySelectorAll('[role="treeitem"]');
  await act(async () => { clickRow(rowsEls[0]); });

  await act(async () => { fireKey(tree, 'a', { metaKey: true }); });
  assert.deepEqual(selectedIds(container), [1, 2, 3, 4, 5]);

  await act(async () => { root.unmount(); });
  container.remove();
});

test('Cmd+A is a no-op when multiSelect=false', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(5), treeVersion: 1 }));

  const { container, root } = mount();
  const obs = makeObservers();

  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'NoMulti',
        rowHeight: 22,
        overscan: 50,
        multiSelect: false,
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  const tree = treeSelector(container);
  const rowsEls = container.querySelectorAll('[role="treeitem"]');
  await act(async () => { clickRow(rowsEls[0]); });

  await act(async () => { fireKey(tree, 'a', { metaKey: true }); });
  // Only the originally-clicked row stays selected.
  assert.deepEqual(selectedIds(container), [1]);

  await act(async () => { root.unmount(); });
  container.remove();
});

test('Escape clears selection', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(5), treeVersion: 1 }));

  const { container, root } = mount();
  const obs = makeObservers();

  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'Esc',
        rowHeight: 22,
        overscan: 50,
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  const tree = treeSelector(container);
  const rowsEls = container.querySelectorAll('[role="treeitem"]');
  await act(async () => { clickRow(rowsEls[1]); });
  assert.deepEqual(selectedIds(container), [2]);

  await act(async () => { fireKey(tree, 'Escape'); });
  assert.deepEqual(selectedIds(container), []);

  await act(async () => { root.unmount(); });
  container.remove();
});

test('ArrowRight on a collapsed folder expands it; second press moves to first child', async () => {
  const fx = createFakeEngine();
  const rows = [
    makeRow({ id: 1, parentId: null, name: 'root', depth: 0, hasChildren: true, isExpanded: true }),
    makeRow({ id: 2, parentId: 1, name: 'folder', depth: 1, hasChildren: true, isExpanded: false }),
  ];
  fx.emitDelta(createFakeSnapshot({ rows, treeVersion: 1 }));

  const { container, root } = mount();
  const obs = makeObservers();

  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'ArrowRight',
        rowHeight: 22,
        overscan: 50,
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  const tree = treeSelector(container);
  const rowsEls = container.querySelectorAll('[role="treeitem"]');
  await act(async () => { clickRow(rowsEls[1]); });
  fx.calls.setExpanded.length = 0;

  // First ArrowRight — expand.
  await act(async () => { fireKey(tree, 'ArrowRight'); });
  assert.ok(
    fx.calls.setExpanded.some((call) => Array.from(call.add).includes(2)),
    `expected setExpanded recorded; got ${fx.calls.setExpanded.length}`,
  );

  // Now publish the expanded snapshot with children visible.
  await act(async () => {
    fx.emitDelta(createFakeSnapshot({
      rows: [
        makeRow({ id: 1, parentId: null, name: 'root', depth: 0, hasChildren: true, isExpanded: true }),
        makeRow({ id: 2, parentId: 1, name: 'folder', depth: 1, hasChildren: true, isExpanded: true }),
        makeRow({ id: 3, parentId: 2, name: 'child', depth: 2, kind: 0 }),
      ],
      treeVersion: 2,
    }));
  });

  // Second ArrowRight — focus first child (row 3).
  await act(async () => { fireKey(tree, 'ArrowRight'); });
  assert.equal(focusedId(container), 3);

  await act(async () => { root.unmount(); });
  container.remove();
});

test('ArrowLeft on an expanded folder collapses it', async () => {
  const fx = createFakeEngine();
  const rows = [
    makeRow({ id: 1, parentId: null, name: 'root', depth: 0, hasChildren: true, isExpanded: true }),
    makeRow({ id: 2, parentId: 1, name: 'child', depth: 1, kind: 0 }),
  ];
  fx.emitDelta(createFakeSnapshot({ rows, treeVersion: 1 }));

  const { container, root } = mount();
  const obs = makeObservers();

  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'ArrowLeft',
        rowHeight: 22,
        overscan: 50,
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  const tree = treeSelector(container);
  const rowsEls = container.querySelectorAll('[role="treeitem"]');
  // Roots start expanded; clicking only establishes keyboard focus.
  await act(async () => { clickRow(rowsEls[0]); });
  fx.calls.setExpanded.length = 0;

  await act(async () => { fireKey(tree, 'ArrowLeft'); });
  assert.ok(
    fx.calls.setExpanded.length >= 1,
    `expected collapse forwarded to fx; got ${fx.calls.setExpanded.length}`,
  );

  await act(async () => { root.unmount(); });
  container.remove();
});

test('Space toggles selection of the focused row', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(3), treeVersion: 1 }));

  const { container, root } = mount();
  const obs = makeObservers();

  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'Space',
        rowHeight: 22,
        overscan: 50,
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  const tree = treeSelector(container);
  const rowsEls = container.querySelectorAll('[role="treeitem"]');
  await act(async () => { clickRow(rowsEls[0]); });
  assert.deepEqual(selectedIds(container), [1]);

  // Space toggles the focused row off.
  await act(async () => { fireKey(tree, ' '); });
  assert.deepEqual(selectedIds(container), []);
  // And back on.
  await act(async () => { fireKey(tree, ' '); });
  assert.deepEqual(selectedIds(container), [1]);

  await act(async () => { root.unmount(); });
  container.remove();
});

test('F2 dispatches file.rename without performing rename UI (Phase 5)', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(3), treeVersion: 1 }));

  const dispatches = [];
  const commands = createCommandRegistry([
    {
      id: 'file.rename',
      label: 'Rename',
      run: (_ctx, args) => { dispatches.push(args); },
    },
  ]);
  commands.setContextProvider(() => ({
    fx,
    snapshot: fx.getSnapshot(),
    focusedId: null,
    focusedEntry: null,
    selectedIds: new Set(),
    selectedEntries: [],
    isMultiSelect: false,
    isRenaming: false,
    host: {},
  }));

  const { container, root } = mount();
  const obs = makeObservers();

  await act(async () => {
    root.render(
      createElement(
        FileTreeProvider,
        { fx, commands },
        createElement(FileTree, {
          ariaLabel: 'F2',
          rowHeight: 22,
          overscan: 50,
          __testObserveElementRect: obs.observeElementRect,
          __testObserveElementOffset: obs.observeElementOffset,
        }),
      ),
    );
  });

  const tree = treeSelector(container);
  const rowsEls = container.querySelectorAll('[role="treeitem"]');
  await act(async () => { clickRow(rowsEls[1]); });

  await act(async () => { fireKey(tree, 'F2'); });
  assert.equal(dispatches.length, 1);
  assert.deepEqual(dispatches[0], { id: 2 });

  await act(async () => { root.unmount(); });
  container.remove();
});
