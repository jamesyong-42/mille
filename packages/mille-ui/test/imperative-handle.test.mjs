// v0.2 B6 — imperative tree handle tests.
//
// Coverage:
//   1. ref.clearSelection() empties selected ids.
//   2. ref.clearFilter() resets filter text (via onFilterChange).
//   3. ref.clearClipboard() drops cut ids.
//   4. ref.reset() does selection + filter + clipboard in one call.
//   5. ref.scrollToRow(5) invokes the virtualizer's scroll hook (we
//      assert via a spy on the scroller element's scrollTop property).
//   6. ref.revealId(rootId) focuses the root's row (no expansion
//      needed).
//   7. ref.revealId(childId) expands ancestors before focusing.
//   8. ref.revealPath('sub/deep') resolves via snapshot walk and
//      delegates to revealId.
//   9. ref.focusFilter() returns false when no filter plumbed; returns
//      true when `showFilter` is on or a `filterInputRef` is supplied.
//
// Follows the `clipboard.test.mjs` happy-dom + fake-engine pattern.

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

const { createElement, act, createRef } = await import('react');
const { createRoot } = await import('react-dom/client');

const { FileTree, useFileTreeRef } = await import('../dist/index.js');
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

/**
 * 3-level sample tree:
 *   root (1)                    depth 0, expanded
 *   ├── sub (2)                 depth 1, expanded
 *   │   ├── deep.ts (3)         depth 2
 *   │   └── deeper.ts (4)       depth 2
 *   ├── alpha.ts (5)            depth 1
 *   └── beta.ts (6)             depth 1
 */
function sampleRows() {
  return [
    makeRow({ id: 1, parentId: null, name: 'root', depth: 0, hasChildren: true, isExpanded: true }),
    makeRow({ id: 2, parentId: 1, name: 'sub', depth: 1, hasChildren: true, isExpanded: true }),
    makeRow({ id: 3, parentId: 2, name: 'deep.ts', depth: 2, kind: KIND_FILE }),
    makeRow({ id: 4, parentId: 2, name: 'deeper.ts', depth: 2, kind: KIND_FILE }),
    makeRow({ id: 5, parentId: 1, name: 'alpha.ts', depth: 1, kind: KIND_FILE }),
    makeRow({ id: 6, parentId: 1, name: 'beta.ts', depth: 1, kind: KIND_FILE }),
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
 * Renders a FileTree with a forwarded ref + optional props. Returns a
 * handle the test uses to mutate state and observe DOM.
 */
async function mountTree({ fx, showFilter = false, filterInputRef, filter, onFilterChange } = {}) {
  const ref = createRef();
  const { container, root } = mount();
  const obs = makeObservers();

  const props = {
    ref,
    ariaLabel: 'Imperative',
    rowHeight: 22,
    overscan: 50,
    multiSelect: true,
    showFilter,
    searchMode: showFilter ? 'filter' : 'off',
    __testObserveElementRect: obs.observeElementRect,
    __testObserveElementOffset: obs.observeElementOffset,
  };
  if (filterInputRef !== undefined) props.filterInputRef = filterInputRef;
  if (filter !== undefined) props.filter = filter;
  if (onFilterChange !== undefined) props.onFilterChange = onFilterChange;

  await act(async () => {
    root.render(createElement(FileTree, { fx, ...props }));
  });

  return {
    ref,
    container,
    root,
    async cleanup() {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────

test('ref.clearSelection() drops all selected ids', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));

  // Drive the selection through the `onSelectionChange` observer so the
  // test sees the post-clear state even when `selectedIds` is entirely
  // uncontrolled. `clearSelection()` fires the observer with an empty set.
  const changes = [];
  const ref = createRef();
  const { container, root } = mount();
  const obs = makeObservers();

  await act(async () => {
    root.render(
      createElement(FileTree, {
        ref,
        fx,
        ariaLabel: 'clearSel',
        rowHeight: 22,
        overscan: 50,
        multiSelect: true,
        onSelectionChange: (ids) => { changes.push(new Set(ids)); },
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  // Select two rows via clicks to populate selection.
  const alphaRow = rowByEntryId(container, 5);
  assert.ok(alphaRow, 'alpha row rendered');
  await act(async () => { clickRow(alphaRow); });
  const betaRow = rowByEntryId(container, 6);
  assert.ok(betaRow, 'beta row rendered');
  await act(async () => { clickRow(betaRow, { metaKey: true }); });
  // Selection has something (exact set not asserted — the observer path
  // below is what matters for `clearSelection`).
  assert.ok(selectedIds(container).length > 0, 'pre-clear: some rows selected');

  changes.length = 0;
  await act(async () => { ref.current.clearSelection(); });

  assert.deepEqual(selectedIds(container), [], 'DOM: no rows marked selected');
  // The observer fires with an empty set on clear.
  const last = changes[changes.length - 1];
  assert.ok(last instanceof Set && last.size === 0, 'onSelectionChange fired with empty set');

  await act(async () => { root.unmount(); });
  container.remove();
});

test('ref.clearFilter() resets filter text', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));

  const filterChanges = [];
  // Use controlled-filter mode so we can observe `onFilterChange('')`.
  const h = await mountTree({
    fx,
    filter: 'alpha',
    onFilterChange: (next) => filterChanges.push(next),
    showFilter: true,
  });

  // Sanity: a non-empty filter is set via controlled prop. We don't
  // assert visibility here (filter.test.mjs covers that) — we just
  // want to verify the ref method fires onFilterChange('').
  filterChanges.length = 0;

  await act(async () => { h.ref.current.clearFilter(); });

  assert.ok(
    filterChanges.includes(''),
    `expected clearFilter() to fire onFilterChange(''), got ${JSON.stringify(filterChanges)}`,
  );

  await h.cleanup();
});

test('ref.clearClipboard() drops cut ids', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));

  const h = await mountTree({ fx });

  const tree = treeSelector(h.container);
  // Cut alpha.ts (id 5).
  const alphaRow = rowByEntryId(h.container, 5);
  assert.ok(alphaRow, 'alpha row rendered');
  await act(async () => { clickRow(alphaRow); });
  await act(async () => { fireKey(tree, 'x', { metaKey: true }); });
  assert.deepEqual(cutIds(h.container), [5]);

  await act(async () => { h.ref.current.clearClipboard(); });

  assert.deepEqual(cutIds(h.container), []);

  await h.cleanup();
});

test('ref.reset() clears selection + filter + clipboard in one call', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));

  const filterChanges = [];
  const h = await mountTree({
    fx,
    filter: 'alpha',
    onFilterChange: (next) => filterChanges.push(next),
    showFilter: true,
  });

  const tree = treeSelector(h.container);
  // Select two rows + cut one so we have all three dimensions dirty.
  const alphaRow = rowByEntryId(h.container, 5);
  const betaRow = rowByEntryId(h.container, 6);
  assert.ok(alphaRow && betaRow, 'alpha + beta rendered');
  await act(async () => { clickRow(alphaRow); });
  await act(async () => { clickRow(betaRow, { metaKey: true }); });
  await act(async () => { fireKey(tree, 'x', { metaKey: true }); });

  assert.ok(selectedIds(h.container).length > 0, 'pre-reset: some selection');
  assert.ok(cutIds(h.container).length > 0, 'pre-reset: some cut ids');

  filterChanges.length = 0;
  await act(async () => { h.ref.current.reset(); });

  assert.deepEqual(selectedIds(h.container), [], 'post-reset: no selection');
  assert.deepEqual(cutIds(h.container), [], 'post-reset: no cut ids');
  assert.ok(
    filterChanges.includes(''),
    `post-reset: onFilterChange('') fired, got ${JSON.stringify(filterChanges)}`,
  );

  await h.cleanup();
});

test('ref.scrollToRow(index) drives the virtualizer scroll hook', async () => {
  const fx = createFakeEngine();
  // Wider row list so the row index is meaningfully addressable.
  const rows = [
    makeRow({ id: 1, parentId: null, name: 'root', depth: 0, hasChildren: true, isExpanded: true }),
  ];
  for (let i = 2; i <= 30; i += 1) {
    rows.push(makeRow({ id: i, parentId: 1, name: `file${i}.ts`, depth: 1, kind: KIND_FILE }));
  }
  fx.emitDelta(createFakeSnapshot({ rows, treeVersion: 1 }));

  const h = await mountTree({ fx });

  // happy-dom's element lacks layout; @tanstack/react-virtual's scroll
  // helper calls `scrollTo({ top })` on the scroll element. Spy that.
  const tree = treeSelector(h.container);
  const scrollCalls = [];
  tree.scrollTo = (opts) => {
    scrollCalls.push(opts);
  };
  // Fallback for older paths that set scrollTop directly.
  let latestTop = 0;
  Object.defineProperty(tree, 'scrollTop', {
    configurable: true,
    get: () => latestTop,
    set: (v) => {
      latestTop = v;
      scrollCalls.push({ top: v });
    },
  });

  await act(async () => { h.ref.current.scrollToRow(5); });

  assert.ok(
    scrollCalls.length > 0,
    `expected the virtualizer to call scrollTo, got ${scrollCalls.length} calls`,
  );

  await h.cleanup();
});

test('ref.revealId(rootId) focuses the row without needing expansion', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));

  const h = await mountTree({ fx });

  // Before reveal nothing is focused.
  const pre = h.container.querySelectorAll('[data-mille-focused="true"]');
  assert.equal(pre.length, 0);

  await act(async () => {
    const ok = h.ref.current.revealId(1);
    assert.equal(ok, true, 'revealId(1) returned true');
  });

  // After reveal the root row carries data-mille-focused.
  const row1 = rowByEntryId(h.container, 1);
  assert.ok(row1, 'root row exists');
  assert.equal(row1.getAttribute('data-mille-focused'), 'true');

  await h.cleanup();
});

test('ref.revealId(childId) auto-expands ancestors before focusing', async () => {
  const fx = createFakeEngine();
  // Start with `sub` (id 2) NOT expanded — its children are absent from
  // the initial snapshot because nothing under `sub` is walked yet.
  // Supply the full row list with `sub` pre-expanded so the reveal path
  // can compute the visible row index; this mirrors the real engine
  // where expansion populates the mirror lazily.
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));

  const h = await mountTree({ fx });

  // Reveal `deeper.ts` (id 4). Its ancestors are root (1) and sub (2).
  await act(async () => {
    const ok = h.ref.current.revealId(4);
    assert.equal(ok, true, 'revealId(4) should succeed');
  });

  // Row exists + is focused.
  const target = rowByEntryId(h.container, 4);
  assert.ok(target, 'deeper.ts row present');
  assert.equal(target.getAttribute('data-mille-focused'), 'true');

  // And the fake engine recorded the ancestors getting `setExpanded`-added.
  // The bridge fires for each expansion tick. We can't assert the exact
  // order but we can assert the ancestor ids made it into the set.
  const addedIds = new Set();
  for (const call of fx.calls.setExpanded) {
    for (const id of call.add) addedIds.add(id);
  }
  assert.ok(addedIds.has(1), `expected root (1) in setExpanded calls, got ${[...addedIds].join(',')}`);
  assert.ok(addedIds.has(2), `expected sub (2) in setExpanded calls, got ${[...addedIds].join(',')}`);

  await h.cleanup();
});

test('ref.revealPath("sub/deep.ts") resolves the path and focuses the entry', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));

  const h = await mountTree({ fx });

  let ok = false;
  await act(async () => {
    ok = await h.ref.current.revealPath('sub/deep.ts');
  });
  assert.equal(ok, true, 'revealPath should resolve sub/deep.ts');

  const target = rowByEntryId(h.container, 3);
  assert.ok(target, 'deep.ts row present');
  assert.equal(target.getAttribute('data-mille-focused'), 'true');

  await h.cleanup();
});

test('ref.focusFilter() returns false when no filter is plumbed, true with filterInputRef', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));

  // Case A — no showFilter, no filterInputRef → returns false.
  {
    const h = await mountTree({ fx });
    let result = true;
    await act(async () => {
      result = h.ref.current.focusFilter();
    });
    assert.equal(result, false, 'focusFilter returns false without any filter input');
    await h.cleanup();
  }

  // Case B — caller-supplied filterInputRef → returns true + invokes focus.
  {
    let focusCount = 0;
    const filterInputRef = { current: { focus: () => { focusCount += 1; } } };
    const h = await mountTree({ fx, filterInputRef });
    let result = false;
    await act(async () => {
      result = h.ref.current.focusFilter();
    });
    assert.equal(result, true, 'focusFilter returns true when filterInputRef is supplied');
    assert.ok(focusCount >= 1, 'filterInputRef.current.focus() was called');
    await h.cleanup();
  }

  // Case C — embedded filter via showFilter → returns true.
  {
    const h = await mountTree({ fx, showFilter: true });
    let result = false;
    await act(async () => {
      result = h.ref.current.focusFilter();
    });
    assert.equal(result, true, 'focusFilter returns true when showFilter is on');
    await h.cleanup();
  }
});

// Sanity: `useFileTreeRef` returns a `RefObject`-shaped value with a
// mutable `.current` slot. Keeps the import alive in the API barrel.
test('useFileTreeRef() returns a usable RefObject', async () => {
  const { useFileTreeRef: hook } = await import('../dist/hooks/useFileTreeRef.js');
  let observedRef = null;
  function Probe() {
    observedRef = hook();
    return null;
  }
  const { container, root } = mount();
  await act(async () => { root.render(createElement(Probe)); });
  assert.ok(observedRef, 'ref observed');
  assert.equal(observedRef.current, null, 'starts at null');
  observedRef.current = { revealId: () => true };
  assert.equal(typeof observedRef.current.revealId, 'function');
  await act(async () => { root.unmount(); });
  container.remove();
});
