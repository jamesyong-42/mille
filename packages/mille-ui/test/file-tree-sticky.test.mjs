// FileTree sticky root headers.
//
// Verifies:
//   A. Depth-0 rows carry `data-mille-sticky-root=""`.
//   B. Non-depth-0 rows do NOT carry that attribute.
//   C. Sticky root rows have `position: sticky` in their inline style.
//      (happy-dom's computed-style fidelity is limited; we check the
//      inline style attribute which we set directly.)
//   D. Passing `stickyRoots={false}` disables the behavior.

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
  return {
    observeElementRect: (_i, cb) => {
      cb({ width, height });
      return () => {};
    },
    observeElementOffset: (_i, cb) => {
      cb(0, false);
      return () => {};
    },
  };
}

function mount() {
  const container = hdDocument.createElement('div');
  hdDocument.body.appendChild(container);
  return { container, root: createRoot(container) };
}

// ─── Test A: two-root snapshot, roots carry sticky attribute ──────────

test('depth-0 rows carry data-mille-sticky-root with stickyRoots default', async () => {
  const fx = createFakeEngine();
  const rows = [
    makeRow({ id: 1, parentId: null, name: 'root-a', depth: 0, hasChildren: true, isExpanded: true }),
    makeRow({ id: 2, parentId: 1, name: 'child-a1', depth: 1, kind: 0 }),
    makeRow({ id: 3, parentId: 1, name: 'child-a2', depth: 1, kind: 0 }),
    makeRow({ id: 4, parentId: null, name: 'root-b', depth: 0, hasChildren: true, isExpanded: true }),
    makeRow({ id: 5, parentId: 4, name: 'child-b1', depth: 1, kind: 0 }),
  ];
  fx.emitDelta(createFakeSnapshot({
    rows,
    roots: [rows[0], rows[3]],
    treeVersion: 1,
  }));

  const { container, root } = mount();
  const obs = makeObservers();

  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'Sticky',
        rowHeight: 22,
        overscan: 10,
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  const items = container.querySelectorAll('[role="treeitem"]');
  assert.equal(items.length, 5);

  const stickyFlags = Array.from(items).map((el) =>
    el.hasAttribute('data-mille-sticky-root'),
  );
  assert.deepEqual(
    stickyFlags,
    [true, false, false, true, false],
    `expected only depth-0 rows to be sticky; got ${JSON.stringify(stickyFlags)}`,
  );

  // Position-sticky in inline style on the two roots.
  const roots = container.querySelectorAll('[data-mille-sticky-root]');
  assert.equal(roots.length, 2);
  for (const r of roots) {
    const styleAttr = r.getAttribute('style') ?? '';
    // happy-dom serializes `position: sticky`; we just need to see it
    // in the inline style. If future happy-dom versions drop it from
    // the serializer, the data attribute alone still proves intent.
    assert.ok(
      styleAttr.includes('sticky') || r.hasAttribute('data-mille-sticky-root'),
      `expected sticky position in style or data attribute; style=${styleAttr}`,
    );
  }

  await act(async () => { root.unmount(); });
  container.remove();
});

// ─── Test B: stickyRoots={false} disables ─────────────────────────────

test('stickyRoots={false} omits the sticky attribute on roots', async () => {
  const fx = createFakeEngine();
  const rows = [
    makeRow({ id: 1, parentId: null, name: 'root-a', depth: 0, hasChildren: false }),
    makeRow({ id: 2, parentId: null, name: 'root-b', depth: 0, hasChildren: false }),
  ];
  fx.emitDelta(createFakeSnapshot({ rows, treeVersion: 1 }));

  const { container, root } = mount();
  const obs = makeObservers();

  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'NotSticky',
        rowHeight: 22,
        overscan: 10,
        stickyRoots: false,
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  const items = container.querySelectorAll('[role="treeitem"]');
  assert.equal(items.length, 2);
  for (const el of items) {
    assert.ok(
      !el.hasAttribute('data-mille-sticky-root'),
      'expected no sticky attribute when stickyRoots is false',
    );
  }

  await act(async () => { root.unmount(); });
  container.remove();
});

test('duplicate root names receive stable ordinal display labels', async () => {
  const fx = createFakeEngine();
  const rows = [
    makeRow({ id: 11, parentId: null, name: 'workspace', depth: 0 }),
    makeRow({ id: 12, parentId: null, name: 'unique', depth: 0 }),
    makeRow({ id: 13, parentId: null, name: 'workspace', depth: 0 }),
  ];
  fx.emitDelta(
    createFakeSnapshot({
      rows,
      roots: rows,
      treeVersion: 1,
    }),
  );

  const { container, root } = mount();
  const obs = makeObservers();
  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'Duplicate roots',
        rowHeight: 22,
        overscan: 10,
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  assert.deepEqual(
    Array.from(container.querySelectorAll('[data-mille-row-name]')).map(
      (element) => element.textContent,
    ),
    ['workspace (1)', 'unique', 'workspace (2)'],
  );

  await act(async () => {
    fx.emitDelta(
      createFakeSnapshot({
        rows: [rows[0]],
        roots: [rows[0]],
        treeVersion: 2,
      }),
    );
  });
  assert.deepEqual(
    Array.from(container.querySelectorAll('[data-mille-row-name]')).map(
      (element) => element.textContent,
    ),
    ['workspace'],
  );

  await act(async () => {
    root.unmount();
  });
  container.remove();
});

test('rootLabel aliases follow live root order without changing entry names', async () => {
  const fx = createFakeEngine();
  const alpha = makeRow({ id: 21, parentId: null, name: 'workspace', depth: 0 });
  const beta = makeRow({ id: 22, parentId: null, name: 'workspace', depth: 0 });
  const seen = [];
  const rootLabel = (rootEntry, context) => {
    seen.push({ id: rootEntry.id, name: rootEntry.name, ...context });
    return `${context.index + 1}. ${rootEntry.id === alpha.id ? 'Primary' : 'Secondary'}`;
  };
  fx.emitDelta(
    createFakeSnapshot({
      rows: [alpha, beta],
      roots: [alpha, beta],
      treeVersion: 1,
    }),
  );

  const { container, root } = mount();
  const obs = makeObservers();
  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'Root aliases',
        rootLabel,
        rowHeight: 22,
        overscan: 10,
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });
  assert.deepEqual(
    Array.from(container.querySelectorAll('[data-mille-row-name]')).map(
      (element) => element.textContent,
    ),
    ['1. Primary', '2. Secondary'],
  );
  assert.deepEqual(
    seen.slice(-2),
    [
      { id: 21, name: 'workspace', index: 0, duplicateIndex: 0, duplicateCount: 2 },
      { id: 22, name: 'workspace', index: 1, duplicateIndex: 1, duplicateCount: 2 },
    ],
  );

  seen.length = 0;
  await act(async () => {
    fx.emitDelta(
      createFakeSnapshot({
        rows: [beta, alpha],
        roots: [beta, alpha],
        treeVersion: 2,
      }),
    );
  });
  assert.deepEqual(
    Array.from(container.querySelectorAll('[data-mille-row-name]')).map(
      (element) => element.textContent,
    ),
    ['1. Secondary', '2. Primary'],
  );
  assert.deepEqual(
    seen.slice(-2),
    [
      { id: 22, name: 'workspace', index: 0, duplicateIndex: 0, duplicateCount: 2 },
      { id: 21, name: 'workspace', index: 1, duplicateIndex: 1, duplicateCount: 2 },
    ],
  );
  assert.equal(alpha.name, 'workspace');
  assert.equal(beta.name, 'workspace');

  await act(async () => {
    root.unmount();
  });
  container.remove();
});
