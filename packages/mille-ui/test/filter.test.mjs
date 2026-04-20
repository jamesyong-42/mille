// Phase 8 — FileTreeFilter + filter mode on <FileTree>.
//
// Coverage:
//   1. Controlled `filter` prop hides non-matching rows (display: none).
//   2. Uncontrolled FileTreeFilter updates internal state on typing.
//   3. Esc at the tree level clears the filter.
//   4. Mod+F with filterInputRef focuses the input.
//   5. Case-insensitive substring match.
//   6. Empty filter shows all rows.

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

const { createElement, act, useRef } = await import('react');
const { createRoot } = await import('react-dom/client');

const { FileTree, FileTreeFilter } = await import('../dist/index.js');
const { createFakeEngine, createFakeSnapshot } = await import('../dist/testing.js');

// ─── Helpers ──────────────────────────────────────────────────────────

const KIND_FILE = 0;
const KIND_DIRECTORY = 1;

function makeRow(p) {
  return {
    id: p.id,
    parentId: p.parentId,
    name: p.name,
    kind: p.kind ?? KIND_FILE,
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

// React tracks input values through an internal value tracker; setting
// `.value` directly doesn't fire onChange. Use the native prototype
// setter + dispatch an `input` event so React picks it up.
function setReactInputValue(input, value) {
  const proto = Object.getPrototypeOf(input);
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  if (descriptor && typeof descriptor.set === 'function') {
    descriptor.set.call(input, value);
  } else {
    input.value = value;
  }
  input.dispatchEvent(new hdWindow.Event('input', { bubbles: true }));
}

function sampleRows() {
  return [
    makeRow({ id: 1, parentId: null, name: 'apple', depth: 0, hasChildren: true, isExpanded: true, kind: KIND_DIRECTORY }),
    makeRow({ id: 2, parentId: 1, name: 'banana', depth: 1 }),
    makeRow({ id: 3, parentId: 1, name: 'cherry', depth: 1 }),
    makeRow({ id: 4, parentId: 1, name: 'APPLESAUCE.md', depth: 1 }),
    makeRow({ id: 5, parentId: null, name: 'beta', depth: 0, hasChildren: false, kind: KIND_DIRECTORY }),
  ];
}

function visibleRowIds(container) {
  const out = [];
  for (const el of container.querySelectorAll('[role="treeitem"]')) {
    const style = el.getAttribute('style') ?? '';
    // Reject rows the UI hid with `display: none`.
    if (/display:\s*none/i.test(style)) continue;
    out.push(Number(el.getAttribute('data-mille-row-id')));
  }
  return out.sort((a, b) => a - b);
}

function allRowIds(container) {
  return Array.from(container.querySelectorAll('[role="treeitem"]'))
    .map((el) => Number(el.getAttribute('data-mille-row-id')))
    .sort((a, b) => a - b);
}

// ─── Test 1: controlled filter hides non-matching rows ───────────────

test('controlled filter hides non-matching rows via display:none', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));

  const { container, root } = mount();
  const obs = makeObservers();

  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'Filter test',
        rowHeight: 22,
        overscan: 20,
        filter: 'an',
        searchMode: 'filter',
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  // Still all 5 rows in the DOM (virtualizer's count doesn't change).
  assert.equal(allRowIds(container).length, 5, 'all rows still in DOM');
  // But only rows with "an" visible: 2 (banana), 5 (beta? no — 'beta' has no 'an').
  // Matching rows: 'banana'.
  const visible = visibleRowIds(container);
  assert.deepEqual(visible, [2], `expected only banana visible, got ${visible.join(',')}`);

  await act(async () => { root.unmount(); });
  container.remove();
});

// ─── Test 2: uncontrolled filter typing updates internal state ────────

test('FileTreeFilter uncontrolled typing updates its input value', async () => {
  const { container, root } = mount();
  const observed = [];

  await act(async () => {
    root.render(
      createElement(FileTreeFilter, {
        defaultValue: '',
        onChange: (v) => observed.push(v),
      }),
    );
  });

  const input = container.querySelector('[role="searchbox"]');
  assert.ok(input, 'input present');

  await act(async () => {
    setReactInputValue(input, 'abc');
  });

  assert.equal(input.value, 'abc', 'input reflects typed value');
  assert.ok(observed.includes('abc'), `onChange fired with 'abc', got ${JSON.stringify(observed)}`);

  await act(async () => { root.unmount(); });
  container.remove();
});

// ─── Test 3: Esc at tree level clears the filter ───────────────────────

test('Esc at the tree level clears an active filter', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));

  const { container, root } = mount();
  const obs = makeObservers();

  const filterChanges = [];

  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'Esc clear',
        rowHeight: 22,
        overscan: 20,
        filter: 'cher',
        onFilterChange: (v) => filterChanges.push(v),
        searchMode: 'filter',
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  // Only 'cherry' matches.
  assert.deepEqual(visibleRowIds(container), [3]);

  // Press Esc on the tree container.
  const tree = container.querySelector('[role="tree"]');
  assert.ok(tree);
  await act(async () => {
    fireKey(tree, 'Escape');
  });

  assert.ok(
    filterChanges.includes(''),
    `expected onFilterChange('') after Esc, got ${JSON.stringify(filterChanges)}`,
  );

  await act(async () => { root.unmount(); });
  container.remove();
});

// ─── Test 4: Mod+F with filterInputRef focuses input ───────────────────

test('Mod+F with filterInputRef focuses the filter input', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));

  const { container, root } = mount();
  const obs = makeObservers();

  let focusCalls = 0;
  const filterInputRef = { current: { focus: () => { focusCalls += 1; } } };

  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'ModF',
        rowHeight: 22,
        overscan: 20,
        searchMode: 'filter',
        filterInputRef,
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  const tree = container.querySelector('[role="tree"]');
  assert.ok(tree);

  // Focus the tree so key events are captured by the container.
  await act(async () => {
    tree.focus();
  });

  await act(async () => {
    fireKey(tree, 'f', { metaKey: true });
  });

  assert.ok(focusCalls >= 1, `filterInputRef.current.focus() should be called (got ${focusCalls})`);

  await act(async () => { root.unmount(); });
  container.remove();
});

// ─── Test 5: case-insensitive substring match ─────────────────────────

test('filter match is case-insensitive', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));

  const { container, root } = mount();
  const obs = makeObservers();

  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'Ci',
        rowHeight: 22,
        overscan: 20,
        filter: 'apple',
        searchMode: 'filter',
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  // Query 'apple' (lowercase) should match both 'apple' (id 1) and
  // 'APPLESAUCE.md' (id 4).
  const visible = visibleRowIds(container);
  assert.deepEqual(
    visible,
    [1, 4],
    `expected apple + APPLESAUCE.md visible, got ${visible.join(',')}`,
  );

  await act(async () => { root.unmount(); });
  container.remove();
});

// ─── Test 6: empty filter shows every row ─────────────────────────────

test('empty filter shows every row', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));

  const { container, root } = mount();
  const obs = makeObservers();

  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'Empty',
        rowHeight: 22,
        overscan: 20,
        filter: '',
        searchMode: 'filter',
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  assert.deepEqual(
    visibleRowIds(container),
    [1, 2, 3, 4, 5],
    'all rows visible when filter is empty',
  );

  await act(async () => { root.unmount(); });
  container.remove();
});

// ─── Test 7 (bonus): showFilter renders the embedded input ────────────

test('showFilter renders the embedded filter input', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));

  const { container, root } = mount();
  const obs = makeObservers();

  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'Embedded',
        rowHeight: 22,
        overscan: 20,
        showFilter: true,
        searchMode: 'filter',
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  const input = container.querySelector('[role="searchbox"]');
  assert.ok(input, 'embedded filter input rendered');

  await act(async () => { root.unmount(); });
  container.remove();
});
