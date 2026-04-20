// Provider + snapshot rerender invariants.
//
// Verifies:
//   A. Distinct snapshots delivered via emitDelta cause one consumer
//      render per emission.
//   B. Re-emitting the SAME snapshot reference coalesces to zero extra
//      renders (identity-based subscription).
//   C. `useFileTreeContext` throws a clear error when called outside a
//      provider.
//
// Uses React 19's `createRoot` + `act` (which, in R19, also drains
// `useSyncExternalStore` notifications) against happy-dom.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

// Install happy-dom globals BEFORE React imports so useLayoutEffect etc.
// see a DOM.
import { Window } from 'happy-dom';

const hdWindow = new Window({ url: 'http://localhost/' });
const hdDocument = hdWindow.document;

// Node 21+ pre-defines a read-only global `navigator`; assignment via
// `globalThis.navigator = …` throws. Use `defineProperty` with
// configurable: true so happy-dom can shadow it.
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
// React 19's scheduler touches MessageChannel during act(); happy-dom
// exposes one but not on globalThis.
installGlobal('MessageChannel', hdWindow.MessageChannel);
// IS_REACT_ACT_ENVIRONMENT silences R19's "not wrapped in act" warning.
installGlobal('IS_REACT_ACT_ENVIRONMENT', true);

const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');

const { FileTreeProvider, useFileTreeContext } = await import('../dist/index.js');
const { createFakeEngine, createFakeSnapshot } = await import('../dist/testing.js');

// ─── Test helpers ─────────────────────────────────────────────────────

function mountProvider(fx, Consumer) {
  const container = hdDocument.createElement('div');
  hdDocument.body.appendChild(container);
  const root = createRoot(container);
  return {
    container,
    root,
    render: async () => {
      await act(async () => {
        root.render(createElement(FileTreeProvider, { fx }, createElement(Consumer)));
      });
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

// ─── Test A: distinct snapshots → one render each ─────────────────────

test('distinct emitDelta calls cause exactly N renders', async () => {
  const fx = createFakeEngine();
  let renderCount = 0;
  function Consumer() {
    const { snapshot } = useFileTreeContext();
    renderCount += 1;
    return createElement('span', null, String(snapshot.treeVersion));
  }

  const m = mountProvider(fx, Consumer);
  await m.render();
  const initial = renderCount;
  assert.equal(initial, 1, 'first mount should render the consumer once');

  await act(async () => {
    fx.emitDelta(createFakeSnapshot({ treeVersion: 1 }));
  });
  await act(async () => {
    fx.emitDelta(createFakeSnapshot({ treeVersion: 2 }));
  });
  await act(async () => {
    fx.emitDelta(createFakeSnapshot({ treeVersion: 3 }));
  });

  assert.equal(
    renderCount - initial,
    3,
    `expected 3 extra renders, got ${renderCount - initial}`,
  );
  await m.unmount();
});

// ─── Test B: same snapshot ref → no extra renders ─────────────────────

test('re-emitting the same snapshot ref does not re-render', async () => {
  const fx = createFakeEngine();
  let renderCount = 0;
  function Consumer() {
    useFileTreeContext();
    renderCount += 1;
    return null;
  }

  const m = mountProvider(fx, Consumer);
  await m.render();
  const initial = renderCount;

  const stable = createFakeSnapshot({ treeVersion: 42 });
  await act(async () => {
    fx.emitDelta(stable);
  });
  const afterFirst = renderCount;
  assert.equal(afterFirst - initial, 1, 'first emit should render once');

  await act(async () => {
    fx.emitDelta(stable);
  });
  await act(async () => {
    fx.emitDelta(stable);
  });

  assert.equal(
    renderCount,
    afterFirst,
    'identical snapshot refs must not cause extra renders',
  );
  await m.unmount();
});

// ─── Test C: hook throws outside provider ─────────────────────────────

test('useFileTreeContext throws a clear error outside FileTreeProvider', async () => {
  let caught = null;
  function Orphan() {
    try {
      useFileTreeContext();
    } catch (err) {
      caught = err;
    }
    return null;
  }

  const container = hdDocument.createElement('div');
  hdDocument.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(Orphan));
  });
  assert.ok(caught instanceof Error);
  assert.match(
    caught.message,
    /useFileTreeContext must be called inside FileTreeProvider/,
  );
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

