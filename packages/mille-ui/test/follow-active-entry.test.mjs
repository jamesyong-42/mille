import { strict as assert } from 'node:assert';
import { test } from 'node:test';

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

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { FileTree } = await import('../dist/index.js');
const { createFakeEngine, createFakeSnapshot } = await import('../dist/testing.js');

function row({ id, parentId, name, depth, kind = 0, hasChildren = false }) {
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
    isExpanded: false,
  };
}

const rows = [
  row({ id: 1, parentId: null, name: 'root', depth: 0, kind: 1, hasChildren: true }),
  row({ id: 2, parentId: 1, name: 'nested', depth: 1, kind: 1, hasChildren: true }),
  row({ id: 3, parentId: 2, name: 'first.ts', depth: 2 }),
  row({ id: 4, parentId: 2, name: 'second.ts', depth: 2 }),
  row({ id: 5, parentId: 1, name: 'elsewhere.ts', depth: 1 }),
];

function observers() {
  return {
    observeElementRect(_instance, callback) {
      callback({ width: 600, height: 400 });
      return () => {};
    },
    observeElementOffset(_instance, callback) {
      callback(0, false);
      return () => {};
    },
  };
}

function rowById(container, id) {
  return container.querySelector(`[data-mille-row-id="${id}"]`);
}

async function mountTree(fx, initialProps = {}) {
  const container = hdDocument.createElement('div');
  hdDocument.body.appendChild(container);
  const root = createRoot(container);
  const observe = observers();
  let props = initialProps;

  async function render(nextProps = props) {
    props = nextProps;
    await act(async () => {
      root.render(
        createElement(FileTree, {
          fx,
          ariaLabel: 'Follow active entry',
          rowHeight: 20,
          overscan: 20,
          __testObserveElementRect: observe.observeElementRect,
          __testObserveElementOffset: observe.observeElementOffset,
          ...props,
        }),
      );
      await Promise.resolve();
    });
  }

  await render();
  return {
    container,
    render,
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test('active editor marker is independent of tree focus and selection', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows, treeVersion: 1 }));
  const tree = await mountTree(fx, {
    activeEntry: 3,
    focusedId: 5,
    selectedIds: new Set([5]),
  });

  assert.equal(rowById(tree.container, 3)?.getAttribute('data-mille-active'), 'true');
  assert.equal(rowById(tree.container, 3)?.getAttribute('aria-current'), 'page');
  assert.equal(rowById(tree.container, 3)?.getAttribute('data-mille-focused'), null);
  assert.equal(rowById(tree.container, 5)?.getAttribute('data-mille-focused'), 'true');
  assert.equal(rowById(tree.container, 5)?.getAttribute('data-mille-selected'), 'true');
  assert.equal(
    fx.calls.setExpanded.some((change) => change.add.includes(2)),
    false,
    'marking an active entry alone must not expand its ancestors',
  );

  await tree.cleanup();
});

test('path-based auto reveal hydrates and expands lazily without stealing focus', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: [rows[0]], treeVersion: 1 }));
  const pathLookups = [];
  const indexedFx = {
    ...fx,
    resolvePath: async (path) => {
      pathLookups.push(path);
      fx.emitDelta(createFakeSnapshot({ rows, treeVersion: 2 }));
      return 3;
    },
  };
  const focusChanges = [];
  const tree = await mountTree(indexedFx, {
    activeEntry: 'nested/first.ts',
    autoRevealActiveEntry: true,
    onFocusedIdChange: (id) => focusChanges.push(id),
  });

  assert.deepEqual(pathLookups, ['nested/first.ts']);
  assert.ok(
    fx.calls.setExpanded.some((change) => change.add.includes(2)),
    'lazy ancestor should be expanded',
  );
  assert.deepEqual(focusChanges, []);
  assert.equal(rowById(tree.container, 3)?.getAttribute('data-mille-active'), 'true');

  await tree.cleanup();
});

test('unrelated tree updates do not snap back after deliberate user navigation', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows, treeVersion: 1 }));
  const tree = await mountTree(fx, {
    activeEntry: 3,
    autoRevealActiveEntry: true,
  });
  const elsewhere = rowById(tree.container, 5);
  assert.ok(elsewhere);

  await act(async () => {
    elsewhere.dispatchEvent(new hdWindow.MouseEvent('click', { bubbles: true }));
  });
  assert.equal(rowById(tree.container, 5)?.getAttribute('data-mille-focused'), 'true');

  const expansionCalls = fx.calls.setExpanded.length;
  await act(async () => {
    fx.emitDelta(createFakeSnapshot({ rows, treeVersion: 2 }));
  });

  assert.equal(rowById(tree.container, 5)?.getAttribute('data-mille-focused'), 'true');
  assert.equal(rowById(tree.container, 5)?.getAttribute('data-mille-selected'), 'true');
  assert.equal(rowById(tree.container, 3)?.getAttribute('data-mille-active'), 'true');
  assert.equal(fx.calls.setExpanded.length, expansionCalls);

  await tree.cleanup();
});

test('stale asynchronous path resolution cannot replace a newer active entry', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows, treeVersion: 1 }));
  let resolveSlow;
  const slow = new Promise((resolve) => {
    resolveSlow = resolve;
  });
  const indexedFx = {
    ...fx,
    resolvePath: (path) => (path === 'slow.ts' ? slow : Promise.resolve(4)),
  };
  const tree = await mountTree(indexedFx, { activeEntry: 'slow.ts' });
  await tree.render({ activeEntry: 'fast.ts' });
  assert.equal(rowById(tree.container, 4)?.getAttribute('data-mille-active'), 'true');

  await act(async () => {
    resolveSlow(3);
    await slow;
  });
  assert.equal(rowById(tree.container, 4)?.getAttribute('data-mille-active'), 'true');
  assert.equal(rowById(tree.container, 3)?.getAttribute('data-mille-active'), null);

  await tree.cleanup();
});
