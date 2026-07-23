// Phase 16.1 — scripted perf harness for @vibecook/mille-ui.
//
// Measures three things against a synthetic 500k-row tree, using
// happy-dom + React 19 `createRoot`:
//
//   1. Initial render — time to first paint with 1000 pre-expanded folders.
//   2. Scroll shift — time to re-render after a scrollTop change.
//   3. Expand 1000 children — time to re-render after a delta that
//      inserts 1000 new rows.
//
// happy-dom is not a browser. Numbers here are indicative only and
// shouldn't be treated as frame-budget evidence. The real bench lives
// behind a Playwright harness (see MILLE_UI_PLAN §16.4) and is deferred
// to v0.2.
//
// Usage:
//   pnpm --filter @vibecook/mille-ui bench
//
// Exits non-zero if virtualization or viewport-anchor invariants regress.
// Timing values remain reporters because happy-dom does not model paint.

import { performance } from 'node:perf_hooks';
import { Window } from 'happy-dom';

// ─── happy-dom globals ────────────────────────────────────────────────

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

// React / package imports must come AFTER the globals are installed.
const { createElement, createRef, act, memo } = await import('react');
const { createRoot } = await import('react-dom/client');

const { FileTree, FileTreeRow } = await import('../dist/index.js');
const { areFileTreeRowPropsEqual } = await import(
  '../dist/components/FileTreeRow.js'
);
const { createFakeEngine, createFakeSnapshot } = await import('../dist/testing.js');
const { MAX_LAYOUT_ANIMATION_ROWS } = await import('../dist/hooks/layoutAnimation.js');

// ─── Synthetic 500k-row hierarchy ─────────────────────────────────────
//
// Shape: 1 root, then N top-level folders (pre-expanded in scenario 1),
// each containing roughly equal slices of the remaining rows. The
// harness only needs a flat `VisibleRow[]` since the virtualizer is
// driven off that; we synthesize realistic depth distributions.

const TOTAL_ROWS = 500_000;
const EXPANDED_FOLDERS = 1_000;

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

function buildSyntheticTree(total, expandedFolders) {
  const rows = new Array(total);
  let idx = 0;
  let id = 1;

  // One synthetic workspace root.
  rows[idx++] = makeRow({
    id: id++,
    parentId: null,
    name: 'workspace',
    depth: 0,
    kind: 1,
    hasChildren: true,
    isExpanded: true,
  });

  // Under it: `expandedFolders` folders, each holding a uniform share
  // of the remaining budget. Every folder is pre-expanded so its
  // children contribute to the visible-row list (matches SPEC §12
  // "cold tree with 1000 expanded folders").
  const remaining = total - 1;
  const perFolder = Math.max(1, Math.floor(remaining / expandedFolders));
  let folderIdsUsed = 0;

  for (let f = 0; f < expandedFolders && idx < total; f += 1) {
    const folderId = id++;
    rows[idx++] = makeRow({
      id: folderId,
      parentId: 1,
      name: `folder-${f}`,
      depth: 1,
      kind: 1,
      hasChildren: true,
      isExpanded: true,
    });
    folderIdsUsed += 1;

    for (let j = 0; j < perFolder - 1 && idx < total; j += 1) {
      // Sprinkle a second nested layer for 20% of entries, to exercise
      // depth-sensitive aria-level wiring.
      const nested = (j & 0x7) === 0;
      const depth = nested ? 3 : 2;
      const parentId = nested && (idx & 0xf) !== 0 ? folderId : folderId;
      rows[idx++] = makeRow({
        id: id++,
        parentId,
        name: nested ? `nested-${f}-${j}.ts` : `file-${f}-${j}.ts`,
        depth,
        kind: 0,
        hasChildren: false,
        isExpanded: false,
      });
    }
  }

  // Pad with tail files at depth 1 if we under-filled.
  while (idx < total) {
    rows[idx++] = makeRow({
      id: id++,
      parentId: 1,
      name: `tail-${id}.txt`,
      depth: 1,
      kind: 0,
      hasChildren: false,
      isExpanded: false,
    });
  }

  rows.length = idx;
  return { rows, expandedFolderCount: folderIdsUsed };
}

// ─── Observer shims ───────────────────────────────────────────────────
//
// @tanstack/react-virtual reads rect + scroll offset from callbacks;
// happy-dom doesn't drive them. We supply them manually so the
// virtualizer can compute a window.

function makeObservers({ height, width = 800 }) {
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

function mountContainer() {
  const container = hdDocument.createElement('div');
  hdDocument.body.appendChild(container);
  return { container, root: createRoot(container) };
}

function makeCountingRowRenderer() {
  const counts = new Map();
  const inner = (props) => {
    counts.set(props.row.id, (counts.get(props.row.id) ?? 0) + 1);
    return createElement(FileTreeRow, props);
  };
  return { renderer: memo(inner, areFileTreeRowPropsEqual), counts };
}

function dispatchClick(element) {
  element.dispatchEvent(
    new hdWindow.MouseEvent('click', { bubbles: true, cancelable: true }),
  );
}

function dispatchKey(element, key) {
  element.dispatchEvent(
    new hdWindow.KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
    }),
  );
}

function setReactInputValue(input, value) {
  const descriptor = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(input),
    'value',
  );
  if (descriptor && typeof descriptor.set === 'function') {
    descriptor.set.call(input, value);
  } else {
    input.value = value;
  }
  input.dispatchEvent(new hdWindow.Event('input', { bubbles: true }));
}

async function measureAsync(label, fn) {
  const t0 = performance.now();
  await fn();
  const t1 = performance.now();
  return { label, ms: t1 - t0 };
}

// ─── Scenarios ────────────────────────────────────────────────────────

async function runInitialRender(rows) {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows, treeVersion: 1 }));

  const { container, root } = mountContainer();
  const obs = makeObservers({ height: 600 });
  let maxMaterializedRows = 0;

  const result = await measureAsync('initial render (500k rows, 1000 expanded)', async () => {
    await act(async () => {
      root.render(
        createElement(FileTree, {
          fx,
          ariaLabel: 'bench-initial',
          rowHeight: 22,
          overscan: 10,
          __testObserveElementRect: obs.observeElementRect,
          __testObserveElementOffset: obs.observeElementOffset,
          __testOnProjectionMaterialized: (count) => {
            maxMaterializedRows = Math.max(maxMaterializedRows, count);
          },
        }),
      );
    });
  });

  const treeitems = container.querySelectorAll('[role="treeitem"]').length;
  await act(async () => {
    root.unmount();
  });
  container.remove();
  return { ...result, rendered: treeitems, maxMaterializedRows };
}

async function runScrollShift(rows) {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows, treeVersion: 1 }));

  const { container, root } = mountContainer();
  const obs = makeObservers({ height: 600 });
  let maxMaterializedRows = 0;

  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'bench-scroll',
        rowHeight: 22,
        overscan: 10,
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
        __testOnProjectionMaterialized: (count) => {
          maxMaterializedRows = Math.max(maxMaterializedRows, count);
        },
      }),
    );
  });
  maxMaterializedRows = 0;

  // Shift scroll by 1000 rows × 22 px = 22000 px.
  const result = await measureAsync('scroll shift (1000 rows forward)', async () => {
    await act(async () => {
      obs.setOffset(1000 * 22);
    });
  });

  const treeitems = container.querySelectorAll('[role="treeitem"]').length;
  const viewport = fx.calls.setViewport.at(-1);
  const viewportPublished =
    viewport !== undefined && viewport.offset > 0 && viewport.limit === treeitems;
  await act(async () => {
    root.unmount();
  });
  container.remove();
  return { ...result, rendered: treeitems, viewportPublished, maxMaterializedRows };
}

async function runExpandChildren(rows) {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows, treeVersion: 1 }));

  const { container, root } = mountContainer();
  const obs = makeObservers({ height: 600 });
  let maxMaterializedRows = 0;

  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'bench-expand',
        rowHeight: 22,
        overscan: 10,
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
        __testOnProjectionMaterialized: (count) => {
          maxMaterializedRows = Math.max(maxMaterializedRows, count);
        },
      }),
    );
  });
  maxMaterializedRows = 0;

  // Build an expanded-children set: inject 1000 new rows as direct
  // children of the root folder.
  const insertionPoint = 1; // right after the root row
  const newRows = [];
  let nextId = 10_000_000;
  for (let i = 0; i < 1000; i += 1) {
    newRows.push(
      makeRow({
        id: nextId++,
        parentId: 1,
        name: `expanded-${i}.ts`,
        depth: 1,
        kind: 0,
        hasChildren: false,
        isExpanded: false,
      }),
    );
  }
  const expandedRows = [
    ...rows.slice(0, insertionPoint),
    ...newRows,
    ...rows.slice(insertionPoint),
  ];

  const result = await measureAsync('expand 1000 direct children', async () => {
    await act(async () => {
      fx.emitDelta(createFakeSnapshot({ rows: expandedRows, treeVersion: 2 }));
    });
  });

  const treeitems = container.querySelectorAll('[role="treeitem"]').length;
  const animatedRows = container.querySelectorAll(
    '[data-mille-entering], [data-mille-repositioning]',
  ).length;
  const animationActive =
    container.querySelector('[role="tree"]')?.getAttribute('data-mille-layout-animating') ===
    'true';
  await act(async () => {
    root.unmount();
  });
  container.remove();
  return {
    ...result,
    rendered: treeitems,
    animatedRows,
    animationActive,
    maxMaterializedRows,
  };
}

async function runAnimationStorm(rows) {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows, treeVersion: 1 }));
  const { container, root } = mountContainer();
  const obs = makeObservers({ height: 2_400 });

  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'bench-animation-budget',
        rowHeight: 22,
        overscan: 20,
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  const inserted = Array.from({ length: 1_000 }, (_, index) =>
    makeRow({
      id: 30_000_000 + index,
      parentId: 1,
      name: `storm-${index}.ts`,
      depth: 1,
      kind: 0,
      hasChildren: false,
      isExpanded: false,
    }),
  );
  const nextRows = [rows[0], ...inserted, ...rows.slice(1)];
  const result = await measureAsync('budget 1000-row visible storm', async () => {
    await act(async () => {
      fx.emitDelta(createFakeSnapshot({ rows: nextRows, treeVersion: 2 }));
    });
  });
  const rendered = container.querySelectorAll('[role="treeitem"]').length;
  const animatedRows = container.querySelectorAll(
    '[data-mille-entering], [data-mille-repositioning]',
  ).length;
  const suppressedBy = container
    .querySelector('[role="tree"]')
    ?.getAttribute('data-mille-animation-suppressed');

  await act(async () => root.unmount());
  container.remove();
  return { ...result, rendered, animatedRows, suppressedBy };
}

async function runDecorationChurn(rows) {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows, treeVersion: 1 }));
  const { container, root } = mountContainer();
  const obs = makeObservers({ height: 600 });
  let projectionMaterializations = 0;
  const { renderer: rowRenderer, counts: rowRenderCounts } =
    makeCountingRowRenderer();

  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'bench-decoration-churn',
        rowHeight: 22,
        overscan: 10,
        rowRenderer,
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
        __testOnProjectionMaterialized: () => {
          projectionMaterializations += 1;
        },
      }),
    );
  });
  const baselineMaterializations = projectionMaterializations;
  const baselineRowRenders = Array.from(rowRenderCounts.values()).reduce(
    (total, count) => total + count,
    0,
  );
  const targetId = rows[5]?.id;
  if (targetId === undefined) throw new Error('decoration churn target is missing');

  fx.setDecorations(targetId, [{ badge: 'M' }]);
  const result = await measureAsync('decoration-only viewport update', async () => {
    await act(async () => {
      fx.bumpDecorationVersion([targetId]);
    });
  });
  const target = container.querySelector(`[data-mille-row-id="${targetId}"]`);
  const decorationVisible =
    target?.querySelector('[data-mille-decoration-badge="M"]') !== null;
  const rendered = container.querySelectorAll('[role="treeitem"]').length;
  const projectionReads = projectionMaterializations - baselineMaterializations;
  const changedRowRenders =
    Array.from(rowRenderCounts.values()).reduce(
      (total, count) => total + count,
      0,
    ) - baselineRowRenders;
  const animatedRows = container.querySelectorAll(
    '[data-mille-entering], [data-mille-repositioning]',
  ).length;

  await act(async () => root.unmount());
  container.remove();
  return {
    ...result,
    rendered,
    animatedRows,
    projectionReads,
    changedRowRenders,
    decorationVisible,
  };
}

async function runRenameChurn(rows) {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows, treeVersion: 1 }));
  const { container, root } = mountContainer();
  const obs = makeObservers({ height: 600 });

  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'bench-rename-churn',
        rowHeight: 22,
        overscan: 10,
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });
  const tree = container.querySelector('[role="tree"]');
  const target = container.querySelector(`[data-mille-row-id="${rows[5]?.id}"]`);
  if (!tree || !target) throw new Error('rename churn bench target is not mounted');
  await act(async () => dispatchClick(target));
  await act(async () => dispatchKey(tree, 'F2'));
  const inputBefore = container.querySelector('[data-mille-rename-input]');
  if (!inputBefore) throw new Error('rename churn bench did not open the editor');
  const draft = 'unfinished-bench-draft.ts';
  await act(async () => setReactInputValue(inputBefore, draft));

  const appended = Array.from({ length: 1_000 }, (_, index) =>
    makeRow({
      id: 40_000_000 + index,
      parentId: 1,
      name: `unrelated-tail-${index}.ts`,
      depth: 1,
      kind: 0,
      hasChildren: false,
      isExpanded: false,
    }),
  );
  const result = await measureAsync('rename during 1000-row tail churn', async () => {
    await act(async () => {
      fx.emitDelta(createFakeSnapshot({ rows: [...rows, ...appended], treeVersion: 2 }));
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  });
  const inputAfter = container.querySelector('[data-mille-rename-input]');
  const interactionPreserved =
    inputAfter === inputBefore &&
    inputAfter?.value === draft &&
    hdDocument.activeElement === inputBefore;
  const rendered = container.querySelectorAll('[role="treeitem"]').length;
  const animatedRows = container.querySelectorAll(
    '[data-mille-entering], [data-mille-repositioning]',
  ).length;

  await act(async () => root.unmount());
  container.remove();
  return { ...result, rendered, animatedRows, interactionPreserved };
}

async function runKeyboardNavigation(rows) {
  const fx = createFakeEngine();
  let maxProjectionReadRows = 0;
  let projectionRowsRead = 0;
  const snapshot = createFakeSnapshot({ rows, treeVersion: 1 });
  fx.emitDelta({
    ...snapshot,
    visibleRows: (options) => {
      // createFakeEngine snapshots its input once with MAX_SAFE_INTEGER.
      if (options.limit !== Number.MAX_SAFE_INTEGER) {
        maxProjectionReadRows = Math.max(maxProjectionReadRows, options.limit);
        projectionRowsRead += options.limit;
      }
      return snapshot.visibleRows(options);
    },
  });
  const { container, root } = mountContainer();
  const obs = makeObservers({ height: 600 });

  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'bench-keyboard-navigation',
        rowHeight: 22,
        overscan: 10,
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });
  const tree = container.querySelector('[role="tree"]');
  const target = container.querySelector(`[data-mille-row-id="${rows[5]?.id}"]`);
  if (!tree || !target) throw new Error('keyboard bench target is not mounted');
  await act(async () => dispatchClick(target));
  maxProjectionReadRows = 0;
  projectionRowsRead = 0;

  const result = await measureAsync('ArrowDown in 500k-row tree', async () => {
    await act(async () => dispatchKey(tree, 'ArrowDown'));
  });
  const focusedId = Number(
    container
      .querySelector('[data-mille-focused="true"]')
      ?.getAttribute('data-mille-row-id'),
  );
  const interactionPreserved = focusedId === rows[6]?.id;
  const rendered = container.querySelectorAll('[role="treeitem"]').length;

  await act(async () => root.unmount());
  container.remove();
  return {
    ...result,
    rendered,
    interactionPreserved,
    maxMaterializedRows: maxProjectionReadRows,
    projectionRowsRead,
  };
}

async function runTypeahead(rows, { key, label, expectMatch }) {
  const fx = createFakeEngine();
  let maxProjectionReadRows = 0;
  let projectionRowsRead = 0;
  const snapshot = createFakeSnapshot({ rows, treeVersion: 1 });
  fx.emitDelta({
    ...snapshot,
    visibleRows: (options) => {
      if (options.limit !== Number.MAX_SAFE_INTEGER) {
        maxProjectionReadRows = Math.max(maxProjectionReadRows, options.limit);
        projectionRowsRead += options.limit;
      }
      return snapshot.visibleRows(options);
    },
  });
  const { container, root } = mountContainer();
  const obs = makeObservers({ height: 600 });

  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: `bench-${label}`,
        rowHeight: 22,
        overscan: 10,
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });
  const tree = container.querySelector('[role="tree"]');
  const originIndex = 5;
  const origin = container.querySelector(
    `[data-mille-row-id="${rows[originIndex]?.id}"]`,
  );
  if (!tree || !origin) throw new Error('typeahead bench origin is not mounted');
  await act(async () => dispatchClick(origin));
  maxProjectionReadRows = 0;
  projectionRowsRead = 0;

  let expected = rows[originIndex]?.id ?? null;
  if (expectMatch) {
    expected = null;
    for (let offset = 1; offset <= rows.length; offset += 1) {
      const row = rows[(originIndex + offset) % rows.length];
      if (row?.name.toLowerCase().startsWith(key.toLowerCase())) {
        expected = row.id;
        break;
      }
    }
  }
  const result = await measureAsync(label, async () => {
    await act(async () => dispatchKey(tree, key));
  });
  const focusedId = Number(
    container
      .querySelector('[data-mille-focused="true"]')
      ?.getAttribute('data-mille-row-id'),
  );
  const interactionPreserved = focusedId === expected;
  const rendered = container.querySelectorAll('[role="treeitem"]').length;

  await act(async () => root.unmount());
  container.remove();
  return {
    ...result,
    rendered,
    interactionPreserved,
    maxMaterializedRows: maxProjectionReadRows,
    projectionRowsRead,
  };
}

async function runReveal(rows) {
  const fx = createFakeEngine();
  let maxProjectionReadRows = 0;
  let projectionRowsRead = 0;
  const snapshot = createFakeSnapshot({ rows, treeVersion: 1 });
  fx.emitDelta({
    ...snapshot,
    visibleRows: (options) => {
      if (options.limit !== Number.MAX_SAFE_INTEGER) {
        maxProjectionReadRows = Math.max(maxProjectionReadRows, options.limit);
        projectionRowsRead += options.limit;
      }
      return snapshot.visibleRows(options);
    },
  });
  const { container, root } = mountContainer();
  const obs = makeObservers({ height: 600 });
  const ref = createRef();
  let focusedId = null;
  await act(async () => {
    root.render(
      createElement(FileTree, {
        ref,
        fx,
        ariaLabel: 'bench-deep-reveal',
        rowHeight: 22,
        overscan: 10,
        onFocusedIdChange: (id) => {
          focusedId = id;
        },
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });
  maxProjectionReadRows = 0;
  projectionRowsRead = 0;
  const targetIndex = 400_000;
  const targetId = rows[targetIndex]?.id;
  if (targetId === undefined || !ref.current) {
    throw new Error('deep reveal target or FileTree ref is missing');
  }
  const tree = container.querySelector('[role="tree"]');
  if (!tree) throw new Error('deep reveal tree is missing');
  let scrollRequested = false;
  tree.scrollTo = (...args) => {
    const top = typeof args[0] === 'object' ? args[0]?.top : args[1];
    if (typeof top === 'number' && top > 0) scrollRequested = true;
  };
  let scrollTop = 0;
  Object.defineProperty(tree, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (top) => {
      scrollTop = top;
      if (typeof top === 'number' && top > 0) scrollRequested = true;
    },
  });

  let revealAccepted = false;
  const result = await measureAsync('reveal row 400k (500k rows)', async () => {
    await act(async () => {
      revealAccepted = ref.current.revealId(targetId);
    });
  });
  const rendered = container.querySelectorAll('[role="treeitem"]').length;

  await act(async () => root.unmount());
  container.remove();
  return {
    ...result,
    rendered,
    interactionPreserved: revealAccepted && focusedId === targetId,
    scrollRequested,
    maxMaterializedRows: maxProjectionReadRows,
    projectionRowsRead,
    targetIndex,
  };
}

async function runAnchoredInsert(rows) {
  const fx = createFakeEngine();
  let maxProjectionReadRows = 0;
  let projectionRowsRead = 0;
  const trackProjectionReads = (snapshot) => ({
    ...snapshot,
    visibleRows: (options) => {
      // createFakeEngine snapshots its input once with MAX_SAFE_INTEGER.
      // Exclude that harness-internal read and measure FileTree probes only.
      if (options.limit !== Number.MAX_SAFE_INTEGER) {
        maxProjectionReadRows = Math.max(maxProjectionReadRows, options.limit);
        projectionRowsRead += options.limit;
      }
      return snapshot.visibleRows(options);
    },
  });
  fx.emitDelta(trackProjectionReads(createFakeSnapshot({ rows, treeVersion: 1 })));
  const { container, root } = mountContainer();
  const obs = makeObservers({ height: 600 });
  const rowHeight = 22;

  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'bench-anchor',
        rowHeight,
        overscan: 10,
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });
  maxProjectionReadRows = 0;
  projectionRowsRead = 0;

  const tree = container.querySelector('[role="tree"]');
  if (!tree) throw new Error('anchor bench did not mount a tree');
  tree.scrollTo = ({ top }) => {
    tree.scrollTop = top;
    queueMicrotask(() => obs.setOffset(top));
  };
  const anchorIndex = 10_000;
  const initialOffset = anchorIndex * rowHeight;
  await act(async () => {
    tree.scrollTop = initialOffset;
    obs.setOffset(initialOffset);
  });
  const anchorId = rows[anchorIndex]?.id;
  if (anchorId === undefined) throw new Error('anchor row is missing');
  const anchorBefore = container.querySelector(`[data-mille-row-id="${anchorId}"]`);
  if (!anchorBefore) throw new Error('anchor row is outside the rendered window');
  await act(async () => {
    anchorBefore.dispatchEvent(
      new hdWindow.MouseEvent('click', { bubbles: true, cancelable: true }),
    );
  });

  const insertCount = 1_000;
  const inserted = Array.from({ length: insertCount }, (_, index) =>
    makeRow({
      id: 20_000_000 + index,
      parentId: 1,
      name: `insert-above-${index}.ts`,
      depth: 1,
      kind: 0,
      hasChildren: false,
      isExpanded: false,
    }),
  );
  const nextRows = [rows[0], ...inserted, ...rows.slice(1)];
  const result = await measureAsync('insert 1000 above viewport', async () => {
    await act(async () => {
      fx.emitDelta(
        trackProjectionReads(createFakeSnapshot({ rows: nextRows, treeVersion: 2 })),
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  });

  const anchoredRow = container.querySelector(`[data-mille-row-id="${anchorId}"]`);
  if (!anchoredRow) throw new Error('anchored row left the rendered window');
  const match = /translateY\(([-\d.]+)px\)/.exec(anchoredRow.style.transform);
  if (!match) throw new Error(`unexpected anchored transform: ${anchoredRow.style.transform}`);
  const viewportPosition = Number(match[1]) - tree.scrollTop;
  const driftPx = Math.abs(viewportPosition);
  const unanchoredDriftPx = insertCount * rowHeight;
  const interactionPreserved =
    anchoredRow.getAttribute('aria-selected') === 'true' &&
    anchoredRow.getAttribute('data-mille-focused') === 'true';
  const rendered = container.querySelectorAll('[role="treeitem"]').length;
  const animatedRows = container.querySelectorAll(
    '[data-mille-entering], [data-mille-repositioning]',
  ).length;

  await act(async () => root.unmount());
  container.remove();
  return {
    ...result,
    rendered,
    driftPx,
    unanchoredDriftPx,
    interactionPreserved,
    animatedRows,
    maxMaterializedRows: maxProjectionReadRows,
    projectionRowsRead,
  };
}

// ─── Runner ───────────────────────────────────────────────────────────

function printTable(rows) {
  const w1 = Math.max(...rows.map((r) => r.label.length));
  const w2 = 10;
  const w3 = 10;
  const w4 = 10;
  const w5 = 11;
  const w6 = 9;
  const w7 = 11;
  const w8 = 11;
  const w9 = 12;
  const header = `| ${'scenario'.padEnd(w1)} | ${'ms'.padStart(w2)} | ${'rendered'.padStart(w3)} | ${'drift px'.padStart(w4)} | ${'interaction'.padStart(w5)} | ${'animated'.padStart(w6)} | ${'projections'.padStart(w7)} | ${'row renders'.padStart(w8)} | ${'materialized'.padStart(w9)} |`;
  const sep = `|${'-'.repeat(w1 + 2)}|${'-'.repeat(w2 + 2)}|${'-'.repeat(w3 + 2)}|${'-'.repeat(w4 + 2)}|${'-'.repeat(w5 + 2)}|${'-'.repeat(w6 + 2)}|${'-'.repeat(w7 + 2)}|${'-'.repeat(w8 + 2)}|${'-'.repeat(w9 + 2)}|`;
  console.log(header);
  console.log(sep);
  for (const r of rows) {
    console.log(
      `| ${r.label.padEnd(w1)} | ${r.ms.toFixed(2).padStart(w2)} | ${String(r.rendered).padStart(w3)} | ${(r.driftPx === undefined ? '—' : r.driftPx.toFixed(2)).padStart(w4)} | ${(r.interactionPreserved === undefined ? '—' : r.interactionPreserved ? 'preserved' : 'lost').padStart(w5)} | ${(r.animatedRows === undefined ? '—' : String(r.animatedRows)).padStart(w6)} | ${(r.projectionReads === undefined ? '—' : String(r.projectionReads)).padStart(w7)} | ${(r.changedRowRenders === undefined ? '—' : String(r.changedRowRenders)).padStart(w8)} | ${(r.maxMaterializedRows === undefined ? '—' : String(r.maxMaterializedRows)).padStart(w9)} |`,
    );
  }
}

async function main() {
  console.log(`mille-ui bench — synthesizing ${TOTAL_ROWS.toLocaleString()} rows...`);
  const t0 = performance.now();
  const { rows, expandedFolderCount } = buildSyntheticTree(TOTAL_ROWS, EXPANDED_FOLDERS);
  const buildMs = performance.now() - t0;
  console.log(
    `  built ${rows.length.toLocaleString()} rows (${expandedFolderCount} pre-expanded folders) in ${buildMs.toFixed(1)} ms`,
  );
  console.log('');

  const results = [];
  results.push(await runInitialRender(rows));
  results.push(await runScrollShift(rows));
  const expandResult = await runExpandChildren(rows);
  results.push(expandResult);
  const decorationResult = await runDecorationChurn(rows);
  results.push(decorationResult);
  const stormResult = await runAnimationStorm(rows);
  results.push(stormResult);
  const renameResult = await runRenameChurn(rows);
  results.push(renameResult);
  const keyboardResult = await runKeyboardNavigation(rows);
  results.push(keyboardResult);
  const typeaheadNearResult = await runTypeahead(rows, {
    key: 'n',
    label: 'typeahead near match (500k rows)',
    expectMatch: true,
  });
  results.push(typeaheadNearResult);
  const typeaheadMissResult = await runTypeahead(rows, {
    key: '§',
    label: 'typeahead full-wrap miss (500k rows)',
    expectMatch: false,
  });
  results.push(typeaheadMissResult);
  const revealResult = await runReveal(rows);
  results.push(revealResult);
  const anchorResult = await runAnchoredInsert(rows);
  results.push(anchorResult);

  console.log('Results:');
  printTable(results);
  console.log('');
  console.log(
    'Note: happy-dom is not a real browser — numbers are indicative only.',
  );
  console.log(
    `      Anchor counterfactual without correction: ${anchorResult.unanchoredDriftPx.toFixed(0)} px; measured: ${anchorResult.driftPx.toFixed(2)} px.`,
  );
  console.log(
    `      Anchor projection probes: ${anchorResult.projectionRowsRead.toLocaleString()} rows total, ${anchorResult.maxMaterializedRows} max per read.`,
  );
  console.log(
    `      Keyboard projection reads: ${keyboardResult.projectionRowsRead.toLocaleString()} rows total, ${keyboardResult.maxMaterializedRows} max per read.`,
  );
  console.log(
    `      Typeahead projection reads: near=${typeaheadNearResult.projectionRowsRead.toLocaleString()}, miss=${typeaheadMissResult.projectionRowsRead.toLocaleString()} rows; ${Math.max(typeaheadNearResult.maxMaterializedRows, typeaheadMissResult.maxMaterializedRows)} max per read.`,
  );
  console.log(
    `      Reveal projection reads: ${revealResult.projectionRowsRead.toLocaleString()} rows total, ${revealResult.maxMaterializedRows} max per read.`,
  );
  if (anchorResult.driftPx > 0.5) {
    throw new Error(`viewport anchor drift ${anchorResult.driftPx.toFixed(2)} px exceeds 0.5 px`);
  }
  if (!anchorResult.interactionPreserved) {
    throw new Error('focused selection was not preserved during insert-above churn');
  }
  if (
    !expandResult.animationActive ||
    expandResult.animatedRows === 0 ||
    expandResult.animatedRows > MAX_LAYOUT_ANIMATION_ROWS
  ) {
    throw new Error(
      `ordinary expansion animated ${expandResult.animatedRows} rows; expected 1-${MAX_LAYOUT_ANIMATION_ROWS}`,
    );
  }
  if (stormResult.animatedRows !== 0 || stormResult.suppressedBy !== 'budget') {
    throw new Error(
      `visible animation storm was not budget-suppressed: ${stormResult.animatedRows} rows, reason=${stormResult.suppressedBy}`,
    );
  }
  if (anchorResult.animatedRows !== 0) {
    throw new Error(`anchored update animated ${anchorResult.animatedRows} rows`);
  }
  if (anchorResult.maxMaterializedRows > 256 || anchorResult.projectionRowsRead > 4_096) {
    throw new Error(
      `anchor probing read max=${anchorResult.maxMaterializedRows}, total=${anchorResult.projectionRowsRead} rows`,
    );
  }
  if (!keyboardResult.interactionPreserved) {
    throw new Error('ArrowDown did not move focus to the next visible row');
  }
  if (
    keyboardResult.maxMaterializedRows > 256 ||
    keyboardResult.projectionRowsRead > 512
  ) {
    throw new Error(
      `keyboard navigation read max=${keyboardResult.maxMaterializedRows}, total=${keyboardResult.projectionRowsRead} rows`,
    );
  }
  if (!typeaheadNearResult.interactionPreserved) {
    throw new Error('near typeahead did not focus the next matching row');
  }
  if (!typeaheadMissResult.interactionPreserved) {
    throw new Error('typeahead miss changed the focused row');
  }
  if (
    typeaheadNearResult.maxMaterializedRows > 256 ||
    typeaheadNearResult.projectionRowsRead > 1_024
  ) {
    throw new Error(
      `near typeahead read max=${typeaheadNearResult.maxMaterializedRows}, total=${typeaheadNearResult.projectionRowsRead} rows`,
    );
  }
  if (
    typeaheadMissResult.maxMaterializedRows > 256 ||
    typeaheadMissResult.projectionRowsRead < rows.length ||
    typeaheadMissResult.projectionRowsRead > rows.length + 512
  ) {
    throw new Error(
      `full-wrap typeahead read max=${typeaheadMissResult.maxMaterializedRows}, total=${typeaheadMissResult.projectionRowsRead} rows`,
    );
  }
  if (!revealResult.interactionPreserved || !revealResult.scrollRequested) {
    throw new Error('deep reveal did not focus and scroll to its target');
  }
  if (
    revealResult.maxMaterializedRows > 256 ||
    revealResult.projectionRowsRead > revealResult.targetIndex + 1_024
  ) {
    throw new Error(
      `deep reveal read max=${revealResult.maxMaterializedRows}, total=${revealResult.projectionRowsRead} rows`,
    );
  }
  if (!decorationResult.decorationVisible) {
    throw new Error('decoration-only update was not visible');
  }
  if (decorationResult.projectionReads !== 0) {
    throw new Error(
      `decoration-only update rematerialized ${decorationResult.projectionReads} structural projections`,
    );
  }
  if (decorationResult.changedRowRenders !== 1) {
    throw new Error(
      `decoration-only update rendered ${decorationResult.changedRowRenders} rows; expected 1`,
    );
  }
  if (!renameResult.interactionPreserved) {
    throw new Error('rename input identity, draft, or focus was lost during tail churn');
  }
  if (renameResult.animatedRows !== 0) {
    throw new Error(`unrelated rename churn animated ${renameResult.animatedRows} rows`);
  }
  const scrollResult = results[1];
  if (!scrollResult?.viewportPublished) {
    throw new Error('scrolled virtual window was not published through setViewport');
  }
  for (const result of [results[0], scrollResult, expandResult]) {
    if ((result?.maxMaterializedRows ?? Number.POSITIVE_INFINITY) > 100) {
      throw new Error(
        `${result?.label ?? 'windowed scenario'} materialized ${result?.maxMaterializedRows} rows`,
      );
    }
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
