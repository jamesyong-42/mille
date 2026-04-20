// useFileTreeSelection — selectOne / toggle / range / clear / anchor
// tracking. Pure hook; no DOM required, but we still mount under React
// so useState behaves correctly.

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
installGlobal('IS_REACT_ACT_ENVIRONMENT', true);

const { createElement, act, useRef } = await import('react');
const { createRoot } = await import('react-dom/client');

const { useFileTreeSelection } = await import('../dist/index.js');

// Render a tiny harness component that exposes the selection handle via
// a ref so the test can drive it imperatively.
function renderSelection(opts = {}) {
  const container = hdDocument.createElement('div');
  hdDocument.body.appendChild(container);
  const root = createRoot(container);

  const handleRef = { current: null };

  function Harness(props) {
    const handle = useFileTreeSelection(props.options);
    handleRef.current = handle;
    return null;
  }

  return {
    async mount() {
      await act(async () => {
        root.render(createElement(Harness, { options: opts }));
      });
      return handleRef;
    },
    async update(newOpts) {
      await act(async () => {
        root.render(createElement(Harness, { options: newOpts }));
      });
    },
    async unmount() {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────

test('selectOne replaces selection and sets focus + anchor', async () => {
  const h = renderSelection();
  const ref = await h.mount();
  await act(async () => { ref.current.selectOne(5); });
  assert.deepEqual(Array.from(ref.current.selectedIds), [5]);
  assert.equal(ref.current.focusedId, 5);
  assert.equal(ref.current.anchorId, 5);

  await act(async () => { ref.current.selectOne(9); });
  assert.deepEqual(Array.from(ref.current.selectedIds), [9]);
  assert.equal(ref.current.anchorId, 9);
  await h.unmount();
});

test('toggle adds and removes ids, keeping anchor on the toggled id', async () => {
  const h = renderSelection();
  const ref = await h.mount();
  await act(async () => { ref.current.toggle(1); });
  assert.deepEqual(Array.from(ref.current.selectedIds).sort(), [1]);
  assert.equal(ref.current.anchorId, 1);
  await act(async () => { ref.current.toggle(2); });
  assert.deepEqual(Array.from(ref.current.selectedIds).sort(), [1, 2]);
  assert.equal(ref.current.anchorId, 2);
  await act(async () => { ref.current.toggle(1); });
  assert.deepEqual(Array.from(ref.current.selectedIds).sort(), [2]);
  assert.equal(ref.current.anchorId, 1);
  await h.unmount();
});

test('selectRange fills the inclusive span in visual order', async () => {
  const h = renderSelection();
  const ref = await h.mount();
  const visible = [10, 20, 30, 40, 50];
  await act(async () => { ref.current.selectRange(20, 40, visible); });
  assert.deepEqual(
    Array.from(ref.current.selectedIds).sort((a, b) => a - b),
    [20, 30, 40],
  );
  // Anchor stays at the stable endpoint (fromId).
  assert.equal(ref.current.anchorId, 20);
  // Focus advances to the target endpoint.
  assert.equal(ref.current.focusedId, 40);
  await h.unmount();
});

test('selectRange handles reverse direction correctly', async () => {
  const h = renderSelection();
  const ref = await h.mount();
  const visible = [10, 20, 30, 40, 50];
  await act(async () => { ref.current.selectRange(40, 20, visible); });
  assert.deepEqual(
    Array.from(ref.current.selectedIds).sort((a, b) => a - b),
    [20, 30, 40],
  );
  assert.equal(ref.current.anchorId, 40);
  assert.equal(ref.current.focusedId, 20);
  await h.unmount();
});

test('selectRange is a no-op when either endpoint is missing', async () => {
  const h = renderSelection();
  const ref = await h.mount();
  await act(async () => { ref.current.selectOne(7); });
  await act(async () => { ref.current.selectRange(100, 200, [1, 2, 3]); });
  // Unchanged because endpoints not in the list.
  assert.deepEqual(Array.from(ref.current.selectedIds), [7]);
  assert.equal(ref.current.anchorId, 7);
  await h.unmount();
});

test('clear empties selection but preserves focus', async () => {
  const h = renderSelection();
  const ref = await h.mount();
  await act(async () => { ref.current.selectOne(3); });
  assert.equal(ref.current.focusedId, 3);
  await act(async () => { ref.current.clear(); });
  assert.equal(ref.current.selectedIds.size, 0);
  assert.equal(ref.current.focusedId, 3);
  await h.unmount();
});

test('initialSelected + initialFocused seed uncontrolled state', async () => {
  const h = renderSelection({
    initialSelected: new Set([1, 2]),
    initialFocused: 2,
  });
  const ref = await h.mount();
  assert.deepEqual(
    Array.from(ref.current.selectedIds).sort((a, b) => a - b),
    [1, 2],
  );
  assert.equal(ref.current.focusedId, 2);
  await h.unmount();
});

test('controlled selectedIds reflects prop value; setters call onSelectionChange', async () => {
  const changes = [];
  let selected = new Set([42]);
  const h = renderSelection({
    selectedIds: selected,
    onSelectionChange: (next) => {
      changes.push(next);
    },
  });
  const ref = await h.mount();
  assert.deepEqual(Array.from(ref.current.selectedIds), [42]);
  // Invoke selectOne — the callback must fire with the proposed new
  // selection, but internal state doesn't switch (controlled mode).
  await act(async () => { ref.current.selectOne(99); });
  assert.equal(changes.length, 1);
  assert.deepEqual(Array.from(changes[0]), [99]);
  // Controlled value unchanged until the caller updates the prop.
  assert.deepEqual(Array.from(ref.current.selectedIds), [42]);
  await h.unmount();
});

test('setSelection replaces selection directly (used by selectAll)', async () => {
  const h = renderSelection();
  const ref = await h.mount();
  await act(async () => {
    ref.current.setSelection(new Set([11, 22, 33]));
  });
  assert.deepEqual(
    Array.from(ref.current.selectedIds).sort((a, b) => a - b),
    [11, 22, 33],
  );
  await h.unmount();
});

test('anchor survives clear and remains the last selectOne / selectRange endpoint', async () => {
  const h = renderSelection();
  const ref = await h.mount();
  await act(async () => { ref.current.selectOne(5); });
  await act(async () => { ref.current.clear(); });
  // Anchor is preserved — it's not tied to selection lifetime.
  assert.equal(ref.current.anchorId, 5);
  await h.unmount();
});
