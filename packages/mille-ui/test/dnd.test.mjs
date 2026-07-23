// Phase 11 — drag-and-drop end-to-end tests.
//
// Exercises the FileTree DnD wiring installed in packages/mille-ui via
// `useFileTreeDragDrop`. happy-dom does not fully simulate HTML5 DnD
// (no DataTransfer, no synthesized DragEvents), so we:
//
//   - Fire `dragstart` / `dragenter` / `dragover` / `drop` / `dragend`
//     as plain DOM Events (bubbling + cancellable) and bolt a stubbed
//     `dataTransfer` onto each via `Object.defineProperty`.
//   - Stub each row's `getBoundingClientRect` so
//     `classifyDropPosition` has deterministic geometry.
//   - Track mutation intent via `fx.calls.move` / `fx.calls.copy` on the
//     `createFakeEngine` double.
//
// Tests align with MILLE_UI_SPEC.md §6.3 / §6.4 and the plan's
// coverage list (≥10 required cases).

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
installGlobal('HTMLDivElement', hdWindow.HTMLDivElement);
installGlobal('HTMLSpanElement', hdWindow.HTMLSpanElement);
installGlobal('HTMLInputElement', hdWindow.HTMLInputElement);
installGlobal('Node', hdWindow.Node);
installGlobal('Element', hdWindow.Element);
installGlobal('Event', hdWindow.Event);
installGlobal('MouseEvent', hdWindow.MouseEvent);
installGlobal('KeyboardEvent', hdWindow.KeyboardEvent);
installGlobal('CustomEvent', hdWindow.CustomEvent);
installGlobal('DocumentFragment', hdWindow.DocumentFragment);
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

const { FileTree, FileTreeProvider } = await import('../dist/index.js');
const { createFakeEngine, createFakeSnapshot } = await import('../dist/testing.js');

// ─── Fake DataTransfer ────────────────────────────────────────────────

function createFakeDataTransfer() {
  const data = new Map();
  const dt = {
    effectAllowed: 'uninitialized',
    dropEffect: 'none',
    files: { length: 0, item: () => null },
    get types() {
      return Array.from(data.keys());
    },
    setData(format, value) {
      data.set(format, String(value));
    },
    getData(format) {
      return data.get(format) ?? '';
    },
    clearData(format) {
      if (format === undefined) data.clear();
      else data.delete(format);
    },
    // Expose a peek so assertions can inspect what was written.
    __peek() {
      return new Map(data);
    },
  };
  return dt;
}

function fireDragEvent(el, type, {
  clientX = 0,
  clientY = 0,
  altKey = false,
  dataTransfer = null,
} = {}) {
  const evt = new hdWindow.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(evt, 'clientX', { value: clientX, configurable: true });
  Object.defineProperty(evt, 'clientY', { value: clientY, configurable: true });
  Object.defineProperty(evt, 'altKey', { value: altKey, configurable: true });
  if (dataTransfer !== null) {
    Object.defineProperty(evt, 'dataTransfer', {
      value: dataTransfer,
      configurable: true,
    });
  }
  el.dispatchEvent(evt);
  return evt;
}

// Patch `getBoundingClientRect` on a row so the hook's geometry-based
// classifier has deterministic output. `y` controls the row's top; the
// row is 22 px tall to match the default FileTree rowHeight.
function patchRowRect(el, top, height = 22) {
  el.getBoundingClientRect = () => ({
    top,
    left: 0,
    right: 200,
    bottom: top + height,
    width: 200,
    height,
    x: 0,
    y: top,
  });
}

// ─── Mount helpers ────────────────────────────────────────────────────

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
    isIgnored: p.isIgnored ?? false,
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

function rowByEntryId(container, id) {
  return container.querySelector(`[data-mille-row-id="${id}"]`);
}

/**
 * Sample tree:
 *   root (1, dir, expanded)
 *     alpha.ts (2, file)
 *     subfolder (3, dir, expanded)
 *       nested.ts (4, file)
 *     beta.ts (5, file)
 */
function sampleRows() {
  return [
    makeRow({ id: 1, parentId: null, name: 'root', depth: 0, hasChildren: true, isExpanded: true }),
    makeRow({ id: 2, parentId: 1, name: 'alpha.ts', depth: 1, kind: KIND_FILE }),
    makeRow({ id: 3, parentId: 1, name: 'subfolder', depth: 1, hasChildren: true, isExpanded: true }),
    makeRow({ id: 4, parentId: 3, name: 'nested.ts', depth: 2, kind: KIND_FILE }),
    makeRow({ id: 5, parentId: 1, name: 'beta.ts', depth: 1, kind: KIND_FILE }),
  ];
}

/** Two-root tree for cross-root tests. */
function multiRootRows() {
  return [
    makeRow({ id: 1, parentId: null, name: 'rootA', depth: 0, hasChildren: true, isExpanded: true }),
    makeRow({ id: 2, parentId: 1, name: 'a-file.ts', depth: 1, kind: KIND_FILE }),
    makeRow({ id: 10, parentId: null, name: 'rootB', depth: 0, hasChildren: true, isExpanded: true }),
    makeRow({ id: 11, parentId: 10, name: 'b-file.ts', depth: 1, kind: KIND_FILE }),
  ];
}

async function mountTree({ fx, props = {} } = {}) {
  const { container, root } = mount();
  const obs = makeObservers();

  await act(async () => {
    root.render(
      createElement(
        FileTreeProvider,
        { fx },
        createElement(FileTree, {
          ariaLabel: 'DnDTree',
          rowHeight: 22,
          overscan: 50,
          __testObserveElementRect: obs.observeElementRect,
          __testObserveElementOffset: obs.observeElementOffset,
          ...props,
        }),
      ),
    );
  });

  // Install deterministic rects on every rendered row (top = index * 22).
  const rowEls = Array.from(container.querySelectorAll('[role="treeitem"]'));
  rowEls.forEach((el, i) => patchRowRect(el, i * 22, 22));

  return { container, root };
}

// ─── Tests ────────────────────────────────────────────────────────────

test('onDragStart sets the four expected MIME entries on DataTransfer', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));

  const { container, root } = await mountTree({ fx });
  const row = rowByEntryId(container, 2);
  assert.ok(row, 'alpha.ts row rendered');

  const dt = createFakeDataTransfer();
  await act(async () => { fireDragEvent(row, 'dragstart', { dataTransfer: dt }); });

  const peek = dt.__peek();
  assert.ok(peek.has('text/uri-list'), 'text/uri-list present');
  assert.ok(peek.has('application/x-mille-ui-entries'), 'mille MIME present');
  assert.ok(peek.has('application/vnd.claude.attachment'), 'claude attachment MIME present');
  assert.ok(peek.has('text/plain'), 'text/plain fallback present');

  const millePayload = JSON.parse(peek.get('application/x-mille-ui-entries'));
  assert.deepEqual(millePayload.ids, [2]);

  await act(async () => { root.unmount(); });
  container.remove();
});

test('multi-row drag carries all selectedIds when source is in selection', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));

  // Selection is controlled: pre-select rows 2 and 5.
  const selected = new Set([2, 5]);
  const { container, root } = await mountTree({
    fx,
    props: { selectedIds: selected },
  });

  const row = rowByEntryId(container, 2);
  const dt = createFakeDataTransfer();
  await act(async () => { fireDragEvent(row, 'dragstart', { dataTransfer: dt }); });

  const payload = JSON.parse(dt.__peek().get('application/x-mille-ui-entries'));
  assert.deepEqual(payload.ids.sort((a, b) => a - b), [2, 5]);

  await act(async () => { root.unmount(); });
  container.remove();
});

test('drop on a folder (self) calls fx.move with target parent id', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));

  const { container, root } = await mountTree({ fx });
  const source = rowByEntryId(container, 2); // alpha.ts
  const target = rowByEntryId(container, 3); // subfolder (folder)

  const dt = createFakeDataTransfer();
  await act(async () => { fireDragEvent(source, 'dragstart', { dataTransfer: dt }); });
  // Drop dead-center of subfolder row (row 2 → top=44, center y=55).
  await act(async () => { fireDragEvent(target, 'dragenter', { clientY: 55, dataTransfer: dt }); });
  await act(async () => { fireDragEvent(target, 'dragover', { clientY: 55, dataTransfer: dt }); });
  await act(async () => { fireDragEvent(target, 'drop', { clientY: 55, dataTransfer: dt }); });

  // Drop is async; flush microtasks.
  await act(async () => { await Promise.resolve(); });

  assert.equal(fx.calls.move.length, 1, 'move dispatched once');
  assert.equal(fx.calls.move[0].id, 2);
  assert.equal(fx.calls.move[0].newParentId, 3);
  assert.equal(fx.calls.copy.length, 0, 'copy must not fire for move');

  await act(async () => { root.unmount(); });
  container.remove();
});

test('Alt held on drop switches move to copy', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));

  const { container, root } = await mountTree({ fx });
  const source = rowByEntryId(container, 2);
  const target = rowByEntryId(container, 3);

  const dt = createFakeDataTransfer();
  await act(async () => { fireDragEvent(source, 'dragstart', { dataTransfer: dt }); });
  await act(async () => { fireDragEvent(target, 'dragenter', { clientY: 55, altKey: true, dataTransfer: dt }); });
  await act(async () => { fireDragEvent(target, 'dragover', { clientY: 55, altKey: true, dataTransfer: dt }); });
  await act(async () => { fireDragEvent(target, 'drop', { clientY: 55, altKey: true, dataTransfer: dt }); });
  await act(async () => { await Promise.resolve(); });

  assert.equal(fx.calls.copy.length, 1, 'copy dispatched once');
  assert.equal(fx.calls.copy[0].id, 2);
  assert.equal(fx.calls.copy[0].newParentId, 3);
  assert.equal(fx.calls.move.length, 0, 'move must not fire under Alt');

  await act(async () => { root.unmount(); });
  container.remove();
});

test('drop position above/below resolves to target row parent', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));

  const { container, root } = await mountTree({ fx });
  // Source: nested.ts (4, parent=3). Target: beta.ts (5, parent=1),
  // row idx 4 → top=88. Using source from a DIFFERENT parent than the
  // target's parent forces the move to actually cross parents (the
  // hook's onDrop skips no-op same-parent moves).
  const source = rowByEntryId(container, 4);
  const target = rowByEntryId(container, 5);

  const dt = createFakeDataTransfer();
  await act(async () => { fireDragEvent(source, 'dragstart', { dataTransfer: dt }); });
  // 'above' zone: ratio < 0.25; with height=22, y=1 clearly above.
  await act(async () => { fireDragEvent(target, 'dragenter', { clientY: 89, dataTransfer: dt }); });
  await act(async () => { fireDragEvent(target, 'dragover', { clientY: 89, dataTransfer: dt }); });
  await act(async () => { fireDragEvent(target, 'drop', { clientY: 89, dataTransfer: dt }); });
  await act(async () => { await Promise.resolve(); });

  // `beta.ts`'s parent is root (id 1); a sibling "above" drop resolves
  // to that parent (root). nested.ts moves from id 3 → id 1.
  assert.equal(fx.calls.move.length, 1, 'sibling drop fires a cross-parent move');
  assert.equal(fx.calls.move[0].id, 4, 'source id');
  assert.equal(fx.calls.move[0].newParentId, 1, 'resolved to target\'s parent (root)');

  await act(async () => { root.unmount(); });
  container.remove();
});

test('drop on a descendant of the source is rejected (cycle prevention)', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));

  const { container, root } = await mountTree({ fx });
  // Source = subfolder (3). Target = nested.ts (4, whose parent is 3).
  // Dropping 3 into 4's parent (=3) is the self-drop / cycle case.
  const source = rowByEntryId(container, 3);
  const target = rowByEntryId(container, 4);

  const dt = createFakeDataTransfer();
  await act(async () => { fireDragEvent(source, 'dragstart', { dataTransfer: dt }); });
  await act(async () => { fireDragEvent(target, 'dragenter', { clientY: 77, dataTransfer: dt }); });
  await act(async () => { fireDragEvent(target, 'dragover', { clientY: 77, dataTransfer: dt }); });
  await act(async () => { fireDragEvent(target, 'drop', { clientY: 77, dataTransfer: dt }); });
  await act(async () => { await Promise.resolve(); });

  assert.equal(fx.calls.move.length, 0, 'move must NOT fire for a cycle-forming drop');
  assert.equal(fx.calls.copy.length, 0, 'copy must NOT fire for a cycle-forming drop');

  await act(async () => { root.unmount(); });
  container.remove();
});

test('cross-root drop with crossRoot:false is rejected', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: multiRootRows(), treeVersion: 1 }));

  const { container, root } = await mountTree({
    fx,
    props: { dragDrop: { crossRoot: false } },
  });
  const source = rowByEntryId(container, 2);     // a-file.ts under rootA
  const target = rowByEntryId(container, 10);    // rootB (folder)

  const dt = createFakeDataTransfer();
  await act(async () => { fireDragEvent(source, 'dragstart', { dataTransfer: dt }); });
  await act(async () => { fireDragEvent(target, 'dragenter', { clientY: 55, dataTransfer: dt }); });
  await act(async () => { fireDragEvent(target, 'dragover', { clientY: 55, dataTransfer: dt }); });
  await act(async () => { fireDragEvent(target, 'drop', { clientY: 55, dataTransfer: dt }); });
  await act(async () => { await Promise.resolve(); });

  assert.equal(fx.calls.move.length, 0, 'cross-root move must be rejected');

  await act(async () => { root.unmount(); });
  container.remove();
});

test('cross-root drop forwards explicit allow and collision policy', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: multiRootRows(), treeVersion: 1 }));

  const { container, root } = await mountTree({
    fx,
    props: { dragDrop: { crossRoot: true, collision: 'rename' } },
  });
  const source = rowByEntryId(container, 2);
  const target = rowByEntryId(container, 10);
  const dt = createFakeDataTransfer();

  await act(async () => {
    fireDragEvent(source, 'dragstart', { dataTransfer: dt });
  });
  await act(async () => {
    fireDragEvent(target, 'dragenter', { clientY: 55, dataTransfer: dt });
    fireDragEvent(target, 'dragover', { clientY: 55, dataTransfer: dt });
    fireDragEvent(target, 'drop', { clientY: 55, dataTransfer: dt });
  });
  await act(async () => {
    await Promise.resolve();
  });

  assert.equal(fx.calls.move.length, 1);
  assert.deepEqual(fx.calls.move[0].options, {
    crossRoot: true,
    collision: 'rename',
  });

  await act(async () => {
    root.unmount();
  });
  container.remove();
});

test('auto-expand: dwelling 320ms on a collapsed folder calls setExpanded', async () => {
  const rows = [
    makeRow({ id: 1, parentId: null, name: 'root', depth: 0, hasChildren: true, isExpanded: true }),
    makeRow({ id: 2, parentId: 1, name: 'alpha.ts', depth: 1, kind: KIND_FILE }),
    // Collapsed folder — dropping into it should fire auto-expand.
    makeRow({ id: 3, parentId: 1, name: 'closed', depth: 1, hasChildren: true, isExpanded: false }),
  ];
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows, treeVersion: 1 }));

  const { container, root } = await mountTree({
    fx,
    props: { dragDrop: { autoExpandDelayMs: 300 } },
  });
  const source = rowByEntryId(container, 2);
  const target = rowByEntryId(container, 3);

  const dt = createFakeDataTransfer();
  await act(async () => { fireDragEvent(source, 'dragstart', { dataTransfer: dt }); });
  await act(async () => { fireDragEvent(target, 'dragenter', { clientY: 50, dataTransfer: dt }); });

  // Wait longer than the dwell (real setTimeout, no fake timers).
  await act(async () => { await new Promise((r) => setTimeout(r, 320)); });

  // The engine's `setExpanded({ add: [3] })` must have fired at least once
  // with id 3 in the add set.
  const matched = fx.calls.setExpanded.some((c) => Array.from(c.add).includes(3));
  assert.equal(matched, true, 'setExpanded({add:[3]}) should fire after dwell');

  await act(async () => { root.unmount(); });
  container.remove();
});

test('external drag-in (file:// URIs) calls fx.copyFromPath with real source paths', async () => {
  // External drops must import content via copyFromPath — never empty
  // create() placeholders that hide data loss.
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));

  const { container, root } = await mountTree({ fx });
  const target = rowByEntryId(container, 3); // subfolder

  const dt = createFakeDataTransfer();
  // External source: set uri-list WITHOUT a prior dragstart from this tree.
  dt.setData('text/uri-list', 'file:///tmp/outside1.txt\r\nfile:///tmp/outside2.txt');

  await act(async () => { fireDragEvent(target, 'dragenter', { clientY: 55, dataTransfer: dt }); });
  await act(async () => { fireDragEvent(target, 'dragover', { clientY: 55, dataTransfer: dt }); });
  await act(async () => { fireDragEvent(target, 'drop', { clientY: 55, dataTransfer: dt }); });
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });

  const imported = fx.calls.copyFromPath.filter((c) => c.newParentId === 3);
  assert.equal(imported.length, 2, `expected 2 copyFromPath calls under id 3, got ${imported.length}`);
  assert.deepEqual(
    imported.map((c) => c.sourcePath).sort(),
    ['/tmp/outside1.txt', '/tmp/outside2.txt'],
  );
  assert.equal(fx.calls.create.length, 0, 'must not create empty placeholders');

  await act(async () => { root.unmount(); });
  container.remove();
});

test('onCollision prompts only when probeDestination reports a collision', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));
  const prompts = [];
  fx.probeDestination = async (_parentId, name) => {
    if (name === 'outside1.txt') {
      return { status: 'exists', existingName: 'outside1.txt' };
    }
    return { status: 'free' };
  };

  const { container, root } = await mountTree({
    fx,
    props: {
      dragDrop: {
        onCollision: (request) => {
          prompts.push(request);
          return { policy: 'rename', applyToAll: true };
        },
      },
    },
  });
  const target = rowByEntryId(container, 3);
  const dt = createFakeDataTransfer();
  dt.setData('text/uri-list', 'file:///tmp/outside1.txt\r\nfile:///tmp/outside2.txt');

  await act(async () => { fireDragEvent(target, 'dragenter', { clientY: 55, dataTransfer: dt }); });
  await act(async () => { fireDragEvent(target, 'dragover', { clientY: 55, dataTransfer: dt }); });
  await act(async () => { fireDragEvent(target, 'drop', { clientY: 55, dataTransfer: dt }); });
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });

  assert.equal(prompts.length, 1, 'only the colliding item should prompt');
  assert.equal(prompts[0].desiredName, 'outside1.txt');
  assert.equal(prompts[0].status, 'exists');
  // applyToAll reuses rename for the free second path too (engine still gets policy).
  assert.equal(fx.calls.copyFromPath.length, 2);
  assert.equal(fx.calls.copyFromPath[0].options?.collision, 'rename');
  assert.equal(fx.calls.copyFromPath[1].options?.collision, 'rename');

  await act(async () => { root.unmount(); });
  container.remove();
});

test('onDropError is invoked when external import fails', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));
  fx.copyFromPath = async () => {
    throw new Error('disk full');
  };
  const errors = [];

  const { container, root } = await mountTree({
    fx,
    props: {
      dragDrop: {
        onDropError: (error) => {
          errors.push(error);
        },
      },
    },
  });
  const target = rowByEntryId(container, 3);
  const dt = createFakeDataTransfer();
  dt.setData('text/uri-list', 'file:///tmp/outside1.txt');

  await act(async () => { fireDragEvent(target, 'dragenter', { clientY: 55, dataTransfer: dt }); });
  await act(async () => { fireDragEvent(target, 'dragover', { clientY: 55, dataTransfer: dt }); });
  await act(async () => { fireDragEvent(target, 'drop', { clientY: 55, dataTransfer: dt }); });
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });

  assert.equal(errors.length, 1, 'onDropError should surface the import failure');
  assert.match(String(errors[0]?.message ?? errors[0]), /disk full|external import failed/);

  await act(async () => { root.unmount(); });
  container.remove();
});

test('onDropError fires once for internal move failures', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));
  fx.move = async () => {
    throw new Error('move denied');
  };
  const errors = [];
  const { container, root } = await mountTree({
    fx,
    props: {
      dragDrop: {
        onDropError: (error) => {
          errors.push(error);
        },
      },
    },
  });
  const source = rowByEntryId(container, 2);
  const target = rowByEntryId(container, 3);
  const dt = createFakeDataTransfer();
  await act(async () => { fireDragEvent(source, 'dragstart', { dataTransfer: dt }); });
  await act(async () => { fireDragEvent(target, 'dragenter', { clientY: 55, dataTransfer: dt }); });
  await act(async () => { fireDragEvent(target, 'dragover', { clientY: 55, dataTransfer: dt }); });
  await act(async () => { fireDragEvent(target, 'drop', { clientY: 55, dataTransfer: dt }); });
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });

  assert.equal(errors.length, 1, 'internal drop failures must report once');
  assert.match(String(errors[0]?.message ?? errors[0]), /move denied/);

  await act(async () => { root.unmount(); });
  container.remove();
});

test('disableDragDrop on the tree → rows are not rendered with draggable attr', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));

  const { container, root } = await mountTree({
    fx,
    props: { disableDragDrop: true },
  });

  const rows = Array.from(container.querySelectorAll('[role="treeitem"]'));
  assert.ok(rows.length > 0, 'rows rendered');
  for (const r of rows) {
    // The `draggable` attr is omitted when DnD is disabled — both
    // `hasAttribute` and the reflected property must be falsy.
    assert.equal(
      r.hasAttribute('draggable'),
      false,
      'no row should advertise draggable when disableDragDrop is true',
    );
  }

  // Also: firing a dragstart is inert — no MIME types written, no
  // move/copy calls possible.
  const dt = createFakeDataTransfer();
  await act(async () => { fireDragEvent(rows[1], 'dragstart', { dataTransfer: dt }); });
  assert.equal(dt.__peek().size, 0, 'dragstart should be a no-op when DnD is disabled');

  await act(async () => { root.unmount(); });
  container.remove();
});

test('data-mille-dragging is set on the source row during an active drag', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));

  const { container, root } = await mountTree({ fx });
  const source = rowByEntryId(container, 2);

  const dt = createFakeDataTransfer();
  await act(async () => { fireDragEvent(source, 'dragstart', { dataTransfer: dt }); });

  // Re-query: React committed the dragging state.
  const liveSource = rowByEntryId(container, 2);
  assert.equal(
    liveSource.getAttribute('data-mille-dragging'),
    'true',
    'data-mille-dragging should be "true" on the source row',
  );

  // dragend clears the attr.
  await act(async () => { fireDragEvent(source, 'dragend', { dataTransfer: dt }); });
  const afterEnd = rowByEntryId(container, 2);
  assert.notEqual(
    afterEnd.getAttribute('data-mille-dragging'),
    'true',
    'data-mille-dragging should be cleared after dragend',
  );

  await act(async () => { root.unmount(); });
  container.remove();
});

test('data-mille-drop-target-self is set on the hovered folder target', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));

  const { container, root } = await mountTree({ fx });
  const source = rowByEntryId(container, 2);
  const target = rowByEntryId(container, 3); // subfolder (folder), row idx 2, top=44

  const dt = createFakeDataTransfer();
  await act(async () => { fireDragEvent(source, 'dragstart', { dataTransfer: dt }); });
  await act(async () => { fireDragEvent(target, 'dragenter', { clientY: 55, dataTransfer: dt }); });
  await act(async () => { fireDragEvent(target, 'dragover', { clientY: 55, dataTransfer: dt }); });

  const liveTarget = rowByEntryId(container, 3);
  assert.equal(
    liveTarget.getAttribute('data-mille-drop-target-self'),
    'true',
    'hovered folder target should get data-mille-drop-target-self="true"',
  );

  await act(async () => { root.unmount(); });
  container.remove();
});
