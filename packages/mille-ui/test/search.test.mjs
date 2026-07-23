// Phase 8 — search mode on <FileTree> + SearchResultList.
//
// Coverage:
//   1. searchMode='search' + query → fx.search called after 150 ms debounce.
//   2. SearchResultList renders hits.
//   3. Arrow-down/up moves selection within results.
//   4. Enter on selected hit → onOpen(entryId).
//   5. Switching back to 'filter' restores the tree.
//   6. (bonus) AbortController cancels in-flight search when query changes.

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
if (typeof globalThis.AbortController === 'undefined') {
  installGlobal('AbortController', hdWindow.AbortController);
}
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

const { FileTree, SearchResultList } = await import('../dist/index.js');
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

function makeEntry(p) {
  return {
    id: p.id,
    parentId: p.parentId ?? null,
    name: p.name,
    kind: p.kind ?? KIND_FILE,
    size: 0,
    mtimeMs: 0,
    ctimeMs: 0,
    isIgnored: false,
    isReadonly: false,
    isHidden: false,
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

function sampleRows() {
  return [
    makeRow({ id: 1, parentId: null, name: 'root', depth: 0, hasChildren: true, isExpanded: true, kind: KIND_DIRECTORY }),
    makeRow({ id: 2, parentId: 1, name: 'alpha.ts', depth: 1 }),
    makeRow({ id: 3, parentId: 1, name: 'beta.ts', depth: 1 }),
  ];
}

function sampleHits() {
  return [
    {
      entry: makeEntry({ id: 100, parentId: 1, name: 'alpha.ts' }),
      score: 0.9,
      matchedIndices: [0, 1, 2],
    },
    {
      entry: makeEntry({ id: 101, parentId: 1, name: 'alphabet.md' }),
      score: 0.6,
      matchedIndices: [0, 1, 2, 3],
    },
  ];
}

async function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Test 1: debounced call into fx.search ────────────────────────────

test("searchMode='search' + query debounces by 150 ms before calling fx.search", async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));
  fx.setSearchResults('alp', sampleHits());

  const { container, root } = mount();
  const obs = makeObservers();

  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'Search1',
        rowHeight: 22,
        overscan: 20,
        filter: 'alp',
        searchMode: 'search',
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  // Before the debounce fires, fx.search must NOT have been called.
  assert.equal(
    fx.calls.search.length,
    0,
    `search should be debounced; got ${fx.calls.search.length} call(s) early`,
  );

  await act(async () => {
    await wait(200);
  });

  assert.ok(
    fx.calls.search.length >= 1,
    `expected fx.search to fire after debounce, got ${fx.calls.search.length}`,
  );
  assert.equal(fx.calls.search[0].query, 'alp');

  await act(async () => { root.unmount(); });
  container.remove();
});

// ─── Test 2: SearchResultList renders hits ────────────────────────────

test('SearchResultList renders each hit as a role=option', async () => {
  const fx = createFakeEngine();
  fx.setSearchResults('alp', sampleHits());

  const { container, root } = mount();
  const obs = makeObservers();

  await act(async () => {
    root.render(
      createElement(SearchResultList, {
        fx,
        query: 'alp',
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  await act(async () => {
    await wait(200);
  });

  const options = container.querySelectorAll('[role="option"]');
  assert.equal(options.length, 2, `expected 2 options, got ${options.length}`);

  // Listbox role present.
  const listbox = container.querySelector('[role="listbox"]');
  assert.ok(listbox, 'listbox role present');

  await act(async () => { root.unmount(); });
  container.remove();
});

// ─── Test 3: Arrow keys move selection ────────────────────────────────

test('Arrow down/up moves the selected option', async () => {
  const fx = createFakeEngine();
  fx.setSearchResults('alp', sampleHits());

  const { container, root } = mount();
  const obs = makeObservers();

  await act(async () => {
    root.render(
      createElement(SearchResultList, {
        fx,
        query: 'alp',
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  await act(async () => {
    await wait(200);
  });

  const listbox = container.querySelector('[role="listbox"]');
  assert.ok(listbox);

  // Initial selection: index 0.
  let selected = container.querySelector('[data-mille-search-option-selected="true"]');
  assert.ok(selected);
  assert.equal(selected.getAttribute('data-mille-search-option-index'), '0');

  await act(async () => {
    fireKey(listbox, 'ArrowDown');
  });
  selected = container.querySelector('[data-mille-search-option-selected="true"]');
  assert.equal(selected.getAttribute('data-mille-search-option-index'), '1');

  await act(async () => {
    fireKey(listbox, 'ArrowUp');
  });
  selected = container.querySelector('[data-mille-search-option-selected="true"]');
  assert.equal(selected.getAttribute('data-mille-search-option-index'), '0');

  await act(async () => { root.unmount(); });
  container.remove();
});

// ─── Test 4: Enter → onOpen(entryId) ──────────────────────────────────

test('Enter on selected hit calls onOpen with the entry id', async () => {
  const fx = createFakeEngine();
  fx.setSearchResults('alp', sampleHits());

  const { container, root } = mount();
  const obs = makeObservers();

  const opened = [];
  await act(async () => {
    root.render(
      createElement(SearchResultList, {
        fx,
        query: 'alp',
        onOpen: (id, event) => opened.push({ id, event }),
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  await act(async () => {
    await wait(200);
  });

  const listbox = container.querySelector('[role="listbox"]');
  assert.ok(listbox);

  await act(async () => {
    fireKey(listbox, 'ArrowDown');
  });
  await act(async () => {
    fireKey(listbox, 'Enter');
  });

  assert.deepEqual(opened, [
    {
      id: 101,
      event: { mode: 'permanent', source: 'search' },
    },
  ]);

  await act(async () => { root.unmount(); });
  container.remove();
});

// ─── Test 5: switching back to 'filter' restores the tree ────────────

test("switching searchMode from 'search' to 'filter' restores the tree view", async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));
  fx.setSearchResults('alp', sampleHits());

  const { container, root } = mount();
  const obs = makeObservers();

  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'SwitchBack',
        rowHeight: 22,
        overscan: 20,
        filter: 'alp',
        searchMode: 'search',
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  await act(async () => {
    await wait(200);
  });

  // In 'search' mode: listbox present, no role=tree.
  assert.ok(container.querySelector('[role="listbox"]'), 'search listbox present');
  assert.equal(
    container.querySelector('[role="tree"]'),
    null,
    'no tree role while in search mode',
  );

  // Switch back to filter mode.
  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'SwitchBack',
        rowHeight: 22,
        overscan: 20,
        filter: 'alp',
        searchMode: 'filter',
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  assert.ok(container.querySelector('[role="tree"]'), 'tree restored after switching to filter');
  assert.equal(
    container.querySelector('[role="listbox"]'),
    null,
    'search listbox gone in filter mode',
  );

  await act(async () => { root.unmount(); });
  container.remove();
});

// ─── Test 6 (bonus): AbortController cancels in-flight search ────────

test('AbortController cancels in-flight search when query changes', async () => {
  const fx = createFakeEngine();
  // Put each search in manual resolution mode; tests control timing.
  fx.setSearchResolution('manual');
  fx.setSearchResults('a', sampleHits());
  fx.setSearchResults('ab', [sampleHits()[0]]);

  const { container, root } = mount();
  const obs = makeObservers();

  await act(async () => {
    root.render(
      createElement(SearchResultList, {
        fx,
        query: 'a',
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  // Wait for the debounce so the first search dispatches.
  await act(async () => {
    await wait(200);
  });

  assert.equal(fx.calls.search.length, 1, 'first search dispatched');
  assert.equal(fx.calls.search[0].query, 'a');
  assert.equal(fx.calls.search[0].aborted, false, 'not aborted yet');

  // Re-render with a new query before we flush the pending resolver.
  await act(async () => {
    root.render(
      createElement(SearchResultList, {
        fx,
        query: 'ab',
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  // The first call's AbortController should have fired.
  assert.equal(
    fx.calls.search[0].aborted,
    true,
    'first search should be aborted when query changes',
  );

  // Debounce + dispatch the new query.
  await act(async () => {
    await wait(200);
  });
  assert.ok(fx.calls.search.length >= 2, 'second search dispatched');
  assert.equal(fx.calls.search[fx.calls.search.length - 1].query, 'ab');

  // Flush the manual resolver so any pending work drains cleanly.
  await act(async () => {
    fx.flushSearch();
  });

  await act(async () => { root.unmount(); });
  container.remove();
});
