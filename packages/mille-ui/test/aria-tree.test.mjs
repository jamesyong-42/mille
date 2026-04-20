// WAI-ARIA structural invariants for <FileTree>.
//
// Lightweight axe-lite assertions — not axe-core. happy-dom doesn't fit
// axe's live-layout requirements, so we hand-roll the small set of
// tree-pattern rules we care about (WAI-ARIA 1.2 tree pattern).

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

const { FileTree } = await import('../dist/index.js');
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

function clickRow(row) {
  const evt = new hdWindow.MouseEvent('click', {
    bubbles: true,
    cancelable: true,
  });
  row.dispatchEvent(evt);
}

function treeRows(container) {
  return Array.from(container.querySelectorAll('[role="treeitem"]'));
}

function mixedTree() {
  return [
    makeRow({ id: 1, parentId: null, name: 'root-a', depth: 0, hasChildren: true, isExpanded: true }),
    makeRow({ id: 2, parentId: 1, name: 'alpha', depth: 1, kind: 0 }),
    makeRow({ id: 3, parentId: 1, name: 'sub', depth: 1, hasChildren: true, isExpanded: true }),
    makeRow({ id: 4, parentId: 3, name: 'leaf.ts', depth: 2, kind: 0 }),
    makeRow({ id: 5, parentId: null, name: 'root-b', depth: 0, hasChildren: false }),
  ];
}

// ─── Tests ────────────────────────────────────────────────────────────

test('exactly one element with role="tree" renders', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: mixedTree(), treeVersion: 1 }));

  const { container, root } = mount();
  const obs = makeObservers();

  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'AriaTree',
        rowHeight: 22,
        overscan: 50,
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  const trees = container.querySelectorAll('[role="tree"]');
  assert.equal(trees.length, 1);
  assert.equal(trees[0].getAttribute('aria-label'), 'AriaTree');
  assert.equal(trees[0].getAttribute('aria-multiselectable'), 'true');

  await act(async () => { root.unmount(); });
  container.remove();
});

test('every visible row has role="treeitem"', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: mixedTree(), treeVersion: 1 }));

  const { container, root } = mount();
  const obs = makeObservers();

  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'Items',
        rowHeight: 22,
        overscan: 50,
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  const items = treeRows(container);
  assert.equal(items.length, 5);
  for (const el of items) {
    assert.equal(el.getAttribute('role'), 'treeitem');
  }

  await act(async () => { root.unmount(); });
  container.remove();
});

test('aria-level on every row equals depth + 1', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: mixedTree(), treeVersion: 1 }));

  const { container, root } = mount();
  const obs = makeObservers();

  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'Level',
        rowHeight: 22,
        overscan: 50,
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  const items = treeRows(container);
  const levels = items.map((el) => Number(el.getAttribute('aria-level')));
  assert.deepEqual(levels, [1, 2, 2, 3, 1]);

  await act(async () => { root.unmount(); });
  container.remove();
});

test('aria-expanded only on folder rows', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: mixedTree(), treeVersion: 1 }));

  const { container, root } = mount();
  const obs = makeObservers();

  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'Expanded',
        rowHeight: 22,
        overscan: 50,
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  const items = treeRows(container);
  // Only rows 1 and 3 have hasChildren=true.
  const hasExpanded = items.map((el) => el.hasAttribute('aria-expanded'));
  assert.deepEqual(hasExpanded, [true, false, true, false, false]);

  await act(async () => { root.unmount(); });
  container.remove();
});

test('aria-selected reflects selection state', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: mixedTree(), treeVersion: 1 }));

  const { container, root } = mount();
  const obs = makeObservers();

  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'Selected',
        rowHeight: 22,
        overscan: 50,
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  const items = treeRows(container);
  // Initially nothing selected — aria-selected="false" on every row.
  for (const el of items) {
    assert.equal(el.getAttribute('aria-selected'), 'false');
  }

  await act(async () => { clickRow(items[2]); });
  const refreshed = treeRows(container);
  assert.equal(refreshed[2].getAttribute('aria-selected'), 'true');
  for (let i = 0; i < refreshed.length; i += 1) {
    if (i !== 2) {
      assert.equal(refreshed[i].getAttribute('aria-selected'), 'false');
    }
  }

  await act(async () => { root.unmount(); });
  container.remove();
});

test('roving tabindex: at most one row has tabindex="0" after click; zero before', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: mixedTree(), treeVersion: 1 }));

  const { container, root } = mount();
  const obs = makeObservers();

  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'Roving',
        rowHeight: 22,
        overscan: 50,
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  // Before any interaction — no row is focused; every row has tabindex=-1.
  const preItems = treeRows(container);
  const preTabs = preItems.map((el) => el.getAttribute('tabindex'));
  assert.ok(
    preTabs.every((t) => t === '-1'),
    `expected all tabindex=-1 before interaction, got ${JSON.stringify(preTabs)}`,
  );

  // Focus a row via click.
  await act(async () => { clickRow(preItems[1]); });

  const postItems = treeRows(container);
  const zeroes = postItems.filter((el) => el.getAttribute('tabindex') === '0');
  assert.equal(
    zeroes.length,
    1,
    `expected exactly one tabindex=0 after click; got ${zeroes.length}`,
  );
  assert.equal(zeroes[0].getAttribute('data-mille-row-id'), '2');

  await act(async () => { root.unmount(); });
  container.remove();
});

test('roving tabindex: still exactly one tabindex="0" after ArrowDown', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: mixedTree(), treeVersion: 1 }));

  const { container, root } = mount();
  const obs = makeObservers();

  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'RovingArrow',
        rowHeight: 22,
        overscan: 50,
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  const items = treeRows(container);
  await act(async () => { clickRow(items[0]); });

  const tree = container.querySelector('[role="tree"]');
  const down = new hdWindow.KeyboardEvent('keydown', {
    key: 'ArrowDown',
    bubbles: true,
    cancelable: true,
  });
  await act(async () => { tree.dispatchEvent(down); });

  const after = treeRows(container);
  const zeroes = after.filter((el) => el.getAttribute('tabindex') === '0');
  assert.equal(zeroes.length, 1);
  assert.equal(zeroes[0].getAttribute('data-mille-row-id'), '2');

  await act(async () => { root.unmount(); });
  container.remove();
});

test('aria-setsize and aria-posinset are present and sensible on every row', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: mixedTree(), treeVersion: 1 }));

  const { container, root } = mount();
  const obs = makeObservers();

  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'SetSize',
        rowHeight: 22,
        overscan: 50,
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  const items = treeRows(container);
  assert.equal(items.length, 5);
  items.forEach((el, i) => {
    const setsize = Number(el.getAttribute('aria-setsize'));
    const posinset = Number(el.getAttribute('aria-posinset'));
    assert.ok(Number.isFinite(setsize) && setsize >= 1, `row ${i} missing aria-setsize`);
    assert.ok(Number.isFinite(posinset) && posinset >= 1, `row ${i} missing aria-posinset`);
    assert.ok(posinset >= 1 && posinset <= setsize);
  });

  await act(async () => { root.unmount(); });
  container.remove();
});

test('multiSelect=false → aria-multiselectable="false" on the tree container', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: mixedTree(), treeVersion: 1 }));

  const { container, root } = mount();
  const obs = makeObservers();

  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'SingleSelect',
        rowHeight: 22,
        overscan: 50,
        multiSelect: false,
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  const tree = container.querySelector('[role="tree"]');
  assert.ok(tree);
  assert.equal(tree.getAttribute('aria-multiselectable'), 'false');

  await act(async () => { root.unmount(); });
  container.remove();
});
