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

const rows = [
  {
    id: 1,
    parentId: null,
    name: 'root',
    kind: 1,
    size: 0,
    mtimeMs: 0,
    ctimeMs: 0,
    isIgnored: false,
    isReadonly: false,
    isHidden: false,
    depth: 0,
    hasChildren: true,
    isExpanded: true,
  },
  {
    id: 2,
    parentId: 1,
    name: 'file.ts',
    kind: 0,
    size: 0,
    mtimeMs: 0,
    ctimeMs: 0,
    isIgnored: false,
    isReadonly: false,
    isHidden: false,
    depth: 1,
    hasChildren: false,
    isExpanded: false,
  },
];

const observeElementRect = (_instance, callback) => {
  callback({ width: 600, height: 300 });
  return () => {};
};
const observeElementOffset = (_instance, callback) => {
  callback(0, false);
  return () => {};
};

async function mountTree(props = {}) {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows, treeVersion: 1 }));
  const container = hdDocument.createElement('div');
  hdDocument.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'Open policy',
        rowHeight: 20,
        __testObserveElementRect: observeElementRect,
        __testObserveElementOffset: observeElementOffset,
        ...props,
      }),
    );
  });
  return {
    file: container.querySelector('[data-mille-row-id="2"]'),
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

async function fire(element, type, options = {}) {
  assert.ok(element);
  await act(async () => {
    element.dispatchEvent(
      new hdWindow.MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        ...options,
      }),
    );
  });
}

test('default mouse policy selects on single click and permanently opens on double click', async () => {
  const opens = [];
  const tree = await mountTree({
    onOpen: (entry, event) => opens.push({ id: entry.id, event }),
  });

  await fire(tree.file, 'click', { detail: 1 });
  assert.deepEqual(opens, []);
  await fire(tree.file, 'dblclick', { detail: 2 });
  assert.deepEqual(opens, [
    {
      id: 2,
      event: { mode: 'permanent', source: 'doubleClick' },
    },
  ]);

  await tree.cleanup();
});

test('single-click preview promotes to permanent on the matching double-click sequence', async () => {
  const opens = [];
  const tree = await mountTree({
    openBehavior: { singleClick: 'preview' },
    onOpen: (entry, event) => opens.push({ id: entry.id, event }),
  });

  await fire(tree.file, 'click', { detail: 1 });
  await fire(tree.file, 'click', { detail: 2 });
  await fire(tree.file, 'dblclick', { detail: 2 });
  assert.deepEqual(opens, [
    {
      id: 2,
      event: { mode: 'preview', source: 'singleClick' },
    },
    {
      id: 2,
      event: { mode: 'permanent', source: 'doubleClick' },
    },
  ]);

  await tree.cleanup();
});

test('modified selection clicks never preview a file', async () => {
  const opens = [];
  const tree = await mountTree({
    openBehavior: { singleClick: 'preview' },
    onOpen: (_entry, event) => opens.push(event),
  });

  await fire(tree.file, 'click', { detail: 1, metaKey: true });
  await fire(tree.file, 'click', { detail: 1, shiftKey: true });
  assert.deepEqual(opens, []);

  await tree.cleanup();
});
