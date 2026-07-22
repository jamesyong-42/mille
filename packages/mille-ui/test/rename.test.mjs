// Phase-5 rename flow tests.
//
// Covers:
//   1. F2 on focused row → rename input appears.
//   2. Type + Enter → fx.rename called with correct args.
//   3. Esc → rename input disappears, no fx.rename call.
//   4. Blur with changed value → commits.
//   5. Blur with unchanged value → cancels (no fx.rename).
//   6. Engine rejects with EEXIST → input stays open with error tooltip.
//   7. Client-side validator blocks invalid characters.
//   8. F2 previously-Phase-4 command-dispatch still works AND the
//      input now opens on the focused row.

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
installGlobal('HTMLInputElement', hdWindow.HTMLInputElement);
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

const { FileTree, FileTreeProvider } = await import('../dist/index.js');
const { createCommandRegistry } = await import('../dist/commands.js');
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

function clickRow(row) {
  const evt = new hdWindow.MouseEvent('click', {
    bubbles: true,
    cancelable: true,
  });
  row.dispatchEvent(evt);
}

// React tracks input values through an internal value tracker; setting
// `.value` directly doesn't fire onChange. We set the value via the
// native prototype setter, bypassing React's dirty-check, then dispatch
// a native `input` event so React's synthetic onChange picks it up.
function setReactInputValue(input, value) {
  const proto = Object.getPrototypeOf(input);
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  if (descriptor && typeof descriptor.set === 'function') {
    descriptor.set.call(input, value);
  } else {
    input.value = value;
  }
  input.dispatchEvent(new hdWindow.Event('input', { bubbles: true }));
}

function treeSelector(container) {
  return container.querySelector('[role="tree"]');
}

function renameInput(container) {
  return container.querySelector('input[data-mille-rename-input=""]');
}

function renameTooltip(container) {
  return container.querySelector('[data-mille-rename-tooltip=""]');
}

function sampleRows() {
  // A visible file `hello.ts` we can rename; a sibling folder.
  return [
    makeRow({ id: 1, parentId: null, name: 'root', depth: 0, hasChildren: true, isExpanded: true }),
    makeRow({ id: 2, parentId: 1, name: 'hello.ts', depth: 1, kind: 0 }),
    makeRow({ id: 3, parentId: 1, name: 'world.md', depth: 1, kind: 0 }),
    makeRow({ id: 4, parentId: 1, name: 'docs', depth: 1, kind: 1 }),
  ];
}

async function mountTree(container, root, fx, extraProps = {}) {
  const obs = makeObservers();
  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'Rename',
        rowHeight: 22,
        overscan: 50,
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
        ...extraProps,
      }),
    );
  });
}

// ─── Tests ────────────────────────────────────────────────────────────

test('F2 on focused row opens the rename input', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));

  const { container, root } = mount();
  await mountTree(container, root, fx);

  const tree = treeSelector(container);
  const rowEls = container.querySelectorAll('[role="treeitem"]');
  await act(async () => { clickRow(rowEls[1]); }); // focus hello.ts
  assert.equal(renameInput(container), null, 'no input before F2');

  await act(async () => { fireKey(tree, 'F2'); });
  const input = renameInput(container);
  assert.ok(input, 'rename input should exist after F2');
  assert.equal(input.value, 'hello.ts');

  await act(async () => { root.unmount(); });
  container.remove();
});

test('Typing + Enter commits via fx.rename with the new name', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));

  const { container, root } = mount();
  await mountTree(container, root, fx);

  const tree = treeSelector(container);
  const rowEls = container.querySelectorAll('[role="treeitem"]');
  await act(async () => { clickRow(rowEls[1]); });
  await act(async () => { fireKey(tree, 'F2'); });

  const input = renameInput(container);
  assert.ok(input);

  // Change the value and press Enter.
  await act(async () => {
    setReactInputValue(input, 'renamed.ts');
  });
  await act(async () => { fireKey(input, 'Enter'); });

  assert.equal(fx.calls.rename.length, 1);
  assert.deepEqual(fx.calls.rename[0], { id: 2, newName: 'renamed.ts' });

  await act(async () => { root.unmount(); });
  container.remove();
});

test('Escape cancels the rename without calling fx.rename', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));

  const { container, root } = mount();
  await mountTree(container, root, fx);

  const tree = treeSelector(container);
  const rowEls = container.querySelectorAll('[role="treeitem"]');
  await act(async () => { clickRow(rowEls[1]); });
  await act(async () => { fireKey(tree, 'F2'); });

  const input = renameInput(container);
  assert.ok(input);

  await act(async () => {
    setReactInputValue(input, 'something-different.ts');
  });
  await act(async () => { fireKey(input, 'Escape'); });

  assert.equal(fx.calls.rename.length, 0, 'no rename dispatched on Esc');
  assert.equal(renameInput(container), null, 'input unmounted after Esc');

  await act(async () => { root.unmount(); });
  container.remove();
});

test('Blur with a changed value commits to fx.rename', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));

  const { container, root } = mount();
  await mountTree(container, root, fx);

  const tree = treeSelector(container);
  const rowEls = container.querySelectorAll('[role="treeitem"]');
  await act(async () => { clickRow(rowEls[1]); });
  await act(async () => { fireKey(tree, 'F2'); });

  const input = renameInput(container);
  assert.ok(input);
  await act(async () => {
    setReactInputValue(input, 'blur-rename.ts');
  });
  // React's synthetic onBlur fires on `focusout` (bubbling), not the
  // non-bubbling `blur`. happy-dom dispatches both on `.blur()`.
  await act(async () => {
    input.blur();
    input.dispatchEvent(new hdWindow.FocusEvent('focusout', { bubbles: true }));
  });
  assert.equal(fx.calls.rename.length, 1);
  assert.equal(fx.calls.rename[0].newName, 'blur-rename.ts');

  await act(async () => { root.unmount(); });
  container.remove();
});

test('Blur with unchanged value cancels (no fx.rename)', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));

  const { container, root } = mount();
  await mountTree(container, root, fx);

  const tree = treeSelector(container);
  const rowEls = container.querySelectorAll('[role="treeitem"]');
  await act(async () => { clickRow(rowEls[1]); });
  await act(async () => { fireKey(tree, 'F2'); });

  const input = renameInput(container);
  assert.ok(input);
  // Don't change the value; just blur.
  await act(async () => {
    input.blur();
    input.dispatchEvent(new hdWindow.FocusEvent('focusout', { bubbles: true }));
  });
  assert.equal(fx.calls.rename.length, 0);

  await act(async () => { root.unmount(); });
  container.remove();
});

test('Engine EEXIST rejection keeps input open + shows the error tooltip', async () => {
  // Wrap the fake engine's rename to reject with EEXIST.
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));

  // Monkey-patch the single method we want to fail.
  const origRename = fx.rename.bind(fx);
  fx.rename = async (id, newName) => {
    fx.calls.rename.push({ id, newName });
    const err = new Error('A file or folder with this name already exists');
    // Duck-typed FileSystemError.
    err.code = 'EEXIST';
    throw err;
  };

  const { container, root } = mount();
  await mountTree(container, root, fx);

  const tree = treeSelector(container);
  const rowEls = container.querySelectorAll('[role="treeitem"]');
  await act(async () => { clickRow(rowEls[1]); });
  await act(async () => { fireKey(tree, 'F2'); });

  const input = renameInput(container);
  assert.ok(input);
  await act(async () => {
    setReactInputValue(input, 'world.md'); // EEXIST simulated
  });
  await act(async () => { fireKey(input, 'Enter'); });
  // Flush the rejected rename promise.
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });

  // Input should still be present and the tooltip visible.
  const inputAfter = renameInput(container);
  assert.ok(inputAfter, 'input still present after EEXIST rejection');
  const tooltip = renameTooltip(container);
  assert.ok(tooltip, 'error tooltip renders');
  assert.match(tooltip.textContent, /already exists|exists/i);

  await act(async () => { root.unmount(); });
  container.remove();

  // Silence unused-var lint for the captured original.
  void origRename;
});

test('unrelated structural churn preserves the rename input, draft, and focus', async () => {
  const fx = createFakeEngine();
  const rows = sampleRows();
  fx.emitDelta(createFakeSnapshot({ rows, treeVersion: 1 }));

  const { container, root } = mount();
  await mountTree(container, root, fx);
  const tree = treeSelector(container);
  const rowEls = container.querySelectorAll('[role="treeitem"]');
  await act(async () => { clickRow(rowEls[1]); });
  await act(async () => { fireKey(tree, 'F2'); });

  const inputBefore = renameInput(container);
  assert.ok(inputBefore);
  await act(async () => {
    setReactInputValue(inputBefore, 'unfinished-draft.ts');
  });

  await act(async () => {
    fx.emitDelta(
      createFakeSnapshot({
        rows: [
          ...rows,
          makeRow({ id: 5, parentId: 1, name: 'unrelated.txt', depth: 1, kind: 0 }),
        ],
        treeVersion: 2,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  const inputAfter = renameInput(container);
  assert.equal(inputAfter, inputBefore, 'the active input DOM node remains mounted');
  assert.equal(inputAfter?.value, 'unfinished-draft.ts');
  assert.equal(hdDocument.activeElement, inputBefore, 'rename focus survives churn');

  await act(async () => { root.unmount(); });
  container.remove();
});

test('deleting the rename target cancels state so a reused id does not reopen it', async () => {
  const fx = createFakeEngine();
  const rows = sampleRows();
  fx.emitDelta(createFakeSnapshot({ rows, treeVersion: 1 }));

  const { container, root } = mount();
  await mountTree(container, root, fx);
  const tree = treeSelector(container);
  const rowEls = container.querySelectorAll('[role="treeitem"]');
  await act(async () => { clickRow(rowEls[1]); });
  await act(async () => { fireKey(tree, 'F2'); });
  assert.ok(renameInput(container));

  const withoutTarget = rows.filter((row) => row.id !== 2);
  await act(async () => {
    fx.emitDelta(createFakeSnapshot({ rows: withoutTarget, treeVersion: 2 }));
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  assert.equal(renameInput(container), null);

  await act(async () => {
    fx.emitDelta(createFakeSnapshot({ rows, treeVersion: 3 }));
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  assert.equal(renameInput(container), null, 'a recycled entry id must not resurrect rename mode');

  await act(async () => { root.unmount(); });
  container.remove();
});

test('a stale rename failure remains editable and can retry without remounting', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));
  let attempts = 0;
  fx.rename = async (id, newName) => {
    fx.calls.rename.push({ id, newName });
    attempts += 1;
    if (attempts <= 2) {
      const err = new Error('The file changed outside Mille; retry the rename');
      err.code = 'ENOENT';
      throw err;
    }
    return makeRow({ id, parentId: 1, name: newName, depth: 1, kind: 0 });
  };

  const { container, root } = mount();
  await mountTree(container, root, fx);
  const tree = treeSelector(container);
  const rowEls = container.querySelectorAll('[role="treeitem"]');
  await act(async () => { clickRow(rowEls[1]); });
  await act(async () => { fireKey(tree, 'F2'); });
  const inputBefore = renameInput(container);
  assert.ok(inputBefore);
  await act(async () => { setReactInputValue(inputBefore, 'retry.ts'); });

  await act(async () => {
    fireKey(inputBefore, 'Enter');
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(attempts, 1);
  assert.ok(renameTooltip(container));
  assert.equal(renameInput(container), inputBefore, 'failure must not remount the editor');

  await act(async () => {
    fireKey(inputBefore, 'Enter');
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(attempts, 2, 'the same draft can be retried after a stale failure');
  assert.equal(renameInput(container), inputBefore);

  await act(async () => {
    fireKey(inputBefore, 'Enter');
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(attempts, 3, 'an identical repeated error must not latch the editor');
  assert.equal(renameInput(container), null, 'successful retry closes rename mode');

  await act(async () => { root.unmount(); });
  container.remove();
});

test('a late rename result cannot close a newer rename session', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));
  let resolveFirst;
  fx.rename = (id, newName) => {
    fx.calls.rename.push({ id, newName });
    return new Promise((resolve) => {
      resolveFirst = resolve;
    });
  };

  const { container, root } = mount();
  await mountTree(container, root, fx);
  const tree = treeSelector(container);
  const rowEls = container.querySelectorAll('[role="treeitem"]');
  await act(async () => { clickRow(rowEls[1]); });
  await act(async () => { fireKey(tree, 'F2'); });
  const firstInput = renameInput(container);
  assert.ok(firstInput);
  await act(async () => { setReactInputValue(firstInput, 'pending.ts'); });
  await act(async () => { fireKey(firstInput, 'Enter'); });
  assert.equal(fx.calls.rename.length, 1);

  await act(async () => { clickRow(rowEls[2]); });
  await act(async () => { fireKey(tree, 'F2'); });
  const secondInput = renameInput(container);
  assert.ok(secondInput);
  assert.notEqual(secondInput, firstInput);
  assert.equal(secondInput.value, 'world.md');

  await act(async () => {
    resolveFirst(makeRow({ id: 2, parentId: 1, name: 'pending.ts', depth: 1, kind: 0 }));
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(renameInput(container), secondInput, 'old completion must not close the new editor');

  await act(async () => { root.unmount(); });
  container.remove();
});

test('Invalid characters in the new name block commit + show local tooltip', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));

  const { container, root } = mount();
  await mountTree(container, root, fx);

  const tree = treeSelector(container);
  const rowEls = container.querySelectorAll('[role="treeitem"]');
  await act(async () => { clickRow(rowEls[1]); });
  await act(async () => { fireKey(tree, 'F2'); });

  const input = renameInput(container);
  assert.ok(input);
  await act(async () => {
    setReactInputValue(input, 'bad/name.ts');
  });
  await act(async () => { fireKey(input, 'Enter'); });
  assert.equal(fx.calls.rename.length, 0, 'commit blocked by local validator');
  const tooltip = renameTooltip(container);
  assert.ok(tooltip, 'local tooltip visible');

  await act(async () => { root.unmount(); });
  container.remove();
});

test('F2 dispatches file.rename AND opens the input (Phase-4 contract preserved)', async () => {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows: sampleRows(), treeVersion: 1 }));

  const dispatches = [];
  const commands = createCommandRegistry([
    {
      id: 'file.rename',
      label: 'Rename',
      run: (_ctx, args) => { dispatches.push(args); },
    },
  ]);
  commands.setContextProvider(() => ({
    fx,
    snapshot: fx.getSnapshot(),
    focusedId: null,
    focusedEntry: null,
    selectedIds: new Set(),
    selectedEntries: [],
    isMultiSelect: false,
    isRenaming: false,
    host: {},
  }));

  const { container, root } = mount();
  const obs = makeObservers();
  await act(async () => {
    root.render(
      createElement(
        FileTreeProvider,
        { fx, commands },
        createElement(FileTree, {
          ariaLabel: 'F2+Open',
          rowHeight: 22,
          overscan: 50,
          __testObserveElementRect: obs.observeElementRect,
          __testObserveElementOffset: obs.observeElementOffset,
        }),
      ),
    );
  });

  const tree = treeSelector(container);
  const rowEls = container.querySelectorAll('[role="treeitem"]');
  await act(async () => { clickRow(rowEls[1]); });
  await act(async () => { fireKey(tree, 'F2'); });

  // Phase-4 behaviour: the command was dispatched.
  assert.equal(dispatches.length, 1);
  assert.deepEqual(dispatches[0], { id: 2 });
  // Phase-5 behaviour: the rename input opened.
  const input = renameInput(container);
  assert.ok(input, 'rename input opened alongside the command dispatch');

  await act(async () => { root.unmount(); });
  container.remove();
});
