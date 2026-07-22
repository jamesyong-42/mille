// FileTree read-path happy path.
//
// Verifies the virtualization contract end-to-end:
//   A. A 10k-row snapshot renders only a small window of treeitems.
//   B. Every rendered row carries role="treeitem" and correct aria-level.
//   C. `<FileTree fx={...} />` mounts without a separate FileTreeProvider.
//
// happy-dom does not drive @tanstack/react-virtual's default
// `observeElementRect` / `observeElementOffset` paths (they rely on
// live layout + ResizeObserver). Tests supply synthetic observers via
// the `__testObserve*` props exposed on FileTreeProps.

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

function makeRow({ id, parentId, name, depth, kind, hasChildren, isExpanded }) {
  return {
    id,
    parentId,
    name,
    kind,
    size: 0,
    mtimeMs: 0,
    ctimeMs: 0,
    isIgnored: false,
    isReadonly: false,
    isHidden: false,
    depth,
    hasChildren,
    isExpanded,
  };
}

function buildRows(total, { rootCount = 3 } = {}) {
  const rows = [];
  const perRoot = Math.floor(total / rootCount);
  let id = 1;
  for (let r = 0; r < rootCount; r += 1) {
    const rootId = id;
    rows.push(makeRow({
      id, parentId: null, name: `root-${r}`,
      depth: 0, kind: 1, hasChildren: true, isExpanded: true,
    }));
    id += 1;
    for (let i = 0; i < perRoot - 1; i += 1) {
      const depth = (i % 4) + 1;
      rows.push(makeRow({
        id,
        parentId: rootId,
        name: `e-${r}-${i}`,
        depth,
        kind: 0,
        hasChildren: false,
        isExpanded: false,
      }));
      id += 1;
    }
  }
  return rows;
}

// Supply synthetic layout so the virtualizer can compute a visible
// range. Fixed 400 tall × 600 wide. Offset is driven by a mutable ref
// the test updates when it wants to simulate scroll.
function makeObservers({ height = 400, width = 600 } = {}) {
  const offsetRef = { current: 0 };
  const offsetListeners = new Set();
  const observeElementRect = (_instance, cb) => {
    cb({ width, height });
    return () => {};
  };
  const observeElementOffset = (_instance, cb) => {
    offsetListeners.add(cb);
    cb(offsetRef.current, false);
    return () => {
      offsetListeners.delete(cb);
    };
  };
  const setOffset = (next) => {
    offsetRef.current = next;
    for (const cb of offsetListeners) cb(next, true);
    for (const cb of offsetListeners) cb(next, false);
  };
  return { observeElementRect, observeElementOffset, setOffset };
}

function mount() {
  const container = hdDocument.createElement('div');
  hdDocument.body.appendChild(container);
  return { container, root: createRoot(container) };
}

// ─── Test 1: <FileTree fx> mounts standalone with big snapshot ────────

test('FileTree renders only a small window for a 10k-row snapshot', async () => {
  const fx = createFakeEngine();
  const rows = buildRows(10_000);
  fx.emitDelta(createFakeSnapshot({ rows, treeVersion: 1 }));

  const { container, root } = mount();
  const obs = makeObservers({ height: 400 });

  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'Files',
        rowHeight: 20,
        overscan: 10,
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  const treeitems = container.querySelectorAll('[role="treeitem"]');
  // Viewport 400 / row 20 = 20 visible + overscan*2 = 40 max.
  assert.ok(treeitems.length > 0, 'expected some rendered rows');
  assert.ok(
    treeitems.length <= 50,
    `expected virtualized DOM (<=50 rows), got ${treeitems.length}`,
  );
  // Sanity: we have 10k rows and we're rendering far fewer.
  assert.ok(
    treeitems.length < 200,
    `virtualization failed: got ${treeitems.length} of 10000`,
  );

  // aria-level ≥ 1 for every row.
  for (const el of treeitems) {
    const level = Number(el.getAttribute('aria-level'));
    assert.ok(Number.isFinite(level) && level >= 1);
  }

  const tree = container.querySelector('[role="tree"]');
  assert.ok(tree);
  assert.equal(tree.getAttribute('aria-label'), 'Files');

  await act(async () => { root.unmount(); });
  container.remove();
});

// ─── Test 2: correct aria structure ───────────────────────────────────

test('FileTree rows carry role=treeitem with aria-level matching depth', async () => {
  const fx = createFakeEngine();
  const rows = [
    makeRow({ id: 1, parentId: null, name: 'r0', depth: 0, kind: 1, hasChildren: true, isExpanded: true }),
    makeRow({ id: 2, parentId: 1, name: 'a', depth: 1, kind: 1, hasChildren: true, isExpanded: true }),
    makeRow({ id: 3, parentId: 2, name: 'b', depth: 2, kind: 0, hasChildren: false, isExpanded: false }),
    makeRow({ id: 4, parentId: 1, name: 'c', depth: 1, kind: 0, hasChildren: false, isExpanded: false }),
    makeRow({ id: 5, parentId: null, name: 'r1', depth: 0, kind: 1, hasChildren: false, isExpanded: false }),
  ];
  fx.emitDelta(createFakeSnapshot({ rows, treeVersion: 1 }));

  const { container, root } = mount();
  const obs = makeObservers({ height: 400 });

  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'Small',
        rowHeight: 22,
        overscan: 20,
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  const treeitems = container.querySelectorAll('[role="treeitem"]');
  assert.equal(treeitems.length, 5);

  const levels = Array.from(treeitems).map((el) => Number(el.getAttribute('aria-level')));
  assert.deepEqual(levels, [1, 2, 3, 2, 1]);

  const hasExpanded = Array.from(treeitems).map((el) => el.hasAttribute('aria-expanded'));
  assert.deepEqual(hasExpanded, [true, true, false, false, false]);

  await act(async () => { root.unmount(); });
  container.remove();
});

// ─── Test 3: scroll shifts the virtual window ─────────────────────────

test('scrolling the tree shifts the rendered virtual items', async () => {
  const fx = createFakeEngine();
  const rows = buildRows(5_000);
  fx.emitDelta(createFakeSnapshot({ rows, treeVersion: 1 }));

  const { container, root } = mount();
  const obs = makeObservers({ height: 400 });

  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'Scroll',
        rowHeight: 20,
        overscan: 5,
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  const ids = () =>
    Array.from(container.querySelectorAll('[role="treeitem"]'))
      .map((el) => Number(el.getAttribute('data-mille-row-id')));

  const initial = ids();
  assert.ok(initial.length > 0);

  // Shift scroll by 100 rows × 20 px = 2000 px.
  await act(async () => {
    obs.setOffset(2000);
  });
  const afterScroll = ids();
  assert.ok(afterScroll.length > 0);

  // Both windows stay bounded.
  assert.ok(initial.length <= 50 && afterScroll.length <= 50);
  // Critical: the windows differ after scrolling.
  const firstInitial = initial[0];
  const firstAfter = afterScroll[0];
  assert.notEqual(
    firstInitial,
    firstAfter,
    `expected different first row after scroll, got ${firstInitial} both times`,
  );
  const viewport = fx.calls.setViewport.at(-1);
  assert.ok(viewport, 'the mounted virtual window must be published to the host');
  assert.ok(viewport.offset > 0, `expected a scrolled viewport offset; got ${viewport.offset}`);
  assert.equal(viewport.limit, afterScroll.length);
  assert.equal(viewport.overscan, 0, 'the published window already includes UI overscan');

  await act(async () => { root.unmount(); });
  container.remove();
});

test('structural inserts and anchor deletion preserve viewport pixel positions', async () => {
  const fx = createFakeEngine();
  const rows = buildRows(1_000, { rootCount: 1 });
  fx.emitDelta(createFakeSnapshot({ rows, treeVersion: 1 }));

  const { container, root } = mount();
  const obs = makeObservers({ height: 400 });
  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'Anchored',
        rowHeight: 20,
        overscan: 5,
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  const tree = container.querySelector('[role="tree"]');
  assert.ok(tree);
  const scrollCalls = [];
  tree.scrollTo = ({ top }) => {
    scrollCalls.push(top);
    tree.scrollTop = top;
    queueMicrotask(() => obs.setOffset(top));
  };

  await act(async () => {
    tree.scrollTop = 2_000;
    obs.setOffset(2_000);
  });
  const anchoredId = rows[100].id;

  const inserted = Array.from({ length: 10 }, (_, index) =>
    makeRow({
      id: 10_000 + index,
      parentId: 1,
      name: `inserted-${index}`,
      depth: 1,
      kind: 0,
      hasChildren: false,
      isExpanded: false,
    }),
  );
  await act(async () => {
    fx.emitDelta(createFakeSnapshot({ rows: [...inserted, ...rows], treeVersion: 2 }));
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  assert.equal(
    scrollCalls.at(-1),
    2_200,
    `ten inserted rows require a 200 px correction; calls=${JSON.stringify(scrollCalls)}`,
  );
  const anchoredRow = container.querySelector(`[data-mille-row-id="${anchoredId}"]`);
  assert.ok(anchoredRow, 'the same anchored row remains mounted');
  assert.equal(anchoredRow.style.transform, 'translateY(2200px)');
  assert.equal(
    tree.getAttribute('data-mille-layout-animating'),
    null,
    'scroll correction must not compete with transform animation',
  );

  const successorId = rows[101].id;
  await act(async () => {
    fx.emitDelta(
      createFakeSnapshot({
        rows: [...inserted, ...rows.filter((row) => row.id !== anchoredId)],
        treeVersion: 3,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  assert.equal(
    scrollCalls.at(-1),
    2_180,
    'deleting the anchor preserves its next sibling at the prior 20 px offset',
  );
  const successorRow = container.querySelector(`[data-mille-row-id="${successorId}"]`);
  assert.ok(successorRow, 'the next surviving row becomes the viewport anchor');
  assert.equal(Number.parseFloat(successorRow.style.transform.slice(11)) - tree.scrollTop, 20);

  await act(async () => { root.unmount(); });
  container.remove();
});

test('structural churn preserves surviving selection and repairs deleted focus', async () => {
  const fx = createFakeEngine();
  const rows = buildRows(20, { rootCount: 1 });
  fx.emitDelta(createFakeSnapshot({ rows, treeVersion: 1 }));
  const { container, root } = mount();
  const obs = makeObservers({ height: 400 });

  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'Interaction churn',
        rowHeight: 20,
        overscan: 5,
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  const row = (id) => container.querySelector(`[data-mille-row-id="${id}"]`);
  await act(async () => {
    row(3).dispatchEvent(new hdWindow.MouseEvent('click', { bubbles: true, detail: 1 }));
  });
  await act(async () => {
    row(5).dispatchEvent(
      new hdWindow.MouseEvent('click', {
        bubbles: true,
        detail: 1,
        shiftKey: true,
      }),
    );
  });
  assert.equal(row(3).getAttribute('aria-selected'), 'true');
  assert.equal(row(4).getAttribute('aria-selected'), 'true');
  assert.equal(row(5).getAttribute('aria-selected'), 'true');
  assert.equal(row(5).getAttribute('data-mille-focused'), 'true');

  const inserted = makeRow({
    id: 10_000,
    parentId: 1,
    name: 'inserted-above',
    depth: 1,
    kind: 0,
    hasChildren: false,
    isExpanded: false,
  });
  await act(async () => {
    fx.emitDelta(
      createFakeSnapshot({ rows: [rows[0], inserted, ...rows.slice(1)], treeVersion: 2 }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  assert.equal(row(3).getAttribute('aria-selected'), 'true');
  assert.equal(row(4).getAttribute('aria-selected'), 'true');
  assert.equal(row(5).getAttribute('aria-selected'), 'true');
  assert.equal(row(5).getAttribute('data-mille-focused'), 'true');

  await act(async () => {
    fx.emitDelta(
      createFakeSnapshot({ rows: [rows[0], inserted, ...rows.slice(1).filter((r) => r.id !== 3)], treeVersion: 3 }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  assert.equal(row(3), null);
  assert.equal(row(4).getAttribute('aria-selected'), 'true');
  assert.equal(row(5).getAttribute('aria-selected'), 'true');
  assert.equal(row(5).getAttribute('data-mille-focused'), 'true');

  await act(async () => {
    fx.emitDelta(
      createFakeSnapshot({ rows: [rows[0], inserted, ...rows.slice(1).filter((r) => r.id !== 3 && r.id !== 5)], treeVersion: 4 }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  assert.equal(row(5), null);
  assert.equal(row(4).getAttribute('aria-selected'), 'true');
  assert.equal(row(6).getAttribute('aria-selected'), 'false');
  assert.equal(row(6).getAttribute('data-mille-focused'), 'true');

  await act(async () => { root.unmount(); });
  container.remove();
});
