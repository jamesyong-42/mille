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
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');

const { FileTree } = await import('../dist/index.js');
const { createFakeEngine, createFakeSnapshot } = await import('../dist/testing.js');

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
        }),
      );
    });
  });

  const treeitems = container.querySelectorAll('[role="treeitem"]').length;
  await act(async () => {
    root.unmount();
  });
  container.remove();
  return { ...result, rendered: treeitems };
}

async function runScrollShift(rows) {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows, treeVersion: 1 }));

  const { container, root } = mountContainer();
  const obs = makeObservers({ height: 600 });

  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'bench-scroll',
        rowHeight: 22,
        overscan: 10,
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  // Shift scroll by 1000 rows × 22 px = 22000 px.
  const result = await measureAsync('scroll shift (1000 rows forward)', async () => {
    await act(async () => {
      obs.setOffset(1000 * 22);
    });
  });

  const treeitems = container.querySelectorAll('[role="treeitem"]').length;
  await act(async () => {
    root.unmount();
  });
  container.remove();
  return { ...result, rendered: treeitems };
}

async function runExpandChildren(rows) {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows, treeVersion: 1 }));

  const { container, root } = mountContainer();
  const obs = makeObservers({ height: 600 });

  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'bench-expand',
        rowHeight: 22,
        overscan: 10,
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

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
  await act(async () => {
    root.unmount();
  });
  container.remove();
  return { ...result, rendered: treeitems };
}

async function runAnchoredInsert(rows) {
  const fx = createFakeEngine();
  fx.emitDelta(createFakeSnapshot({ rows, treeVersion: 1 }));
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
      fx.emitDelta(createFakeSnapshot({ rows: nextRows, treeVersion: 2 }));
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
  const rendered = container.querySelectorAll('[role="treeitem"]').length;

  await act(async () => root.unmount());
  container.remove();
  return { ...result, rendered, driftPx, unanchoredDriftPx };
}

// ─── Runner ───────────────────────────────────────────────────────────

function printTable(rows) {
  const w1 = Math.max(...rows.map((r) => r.label.length));
  const w2 = 10;
  const w3 = 10;
  const w4 = 10;
  const header = `| ${'scenario'.padEnd(w1)} | ${'ms'.padStart(w2)} | ${'rendered'.padStart(w3)} | ${'drift px'.padStart(w4)} |`;
  const sep = `|${'-'.repeat(w1 + 2)}|${'-'.repeat(w2 + 2)}|${'-'.repeat(w3 + 2)}|${'-'.repeat(w4 + 2)}|`;
  console.log(header);
  console.log(sep);
  for (const r of rows) {
    console.log(
      `| ${r.label.padEnd(w1)} | ${r.ms.toFixed(2).padStart(w2)} | ${String(r.rendered).padStart(w3)} | ${(r.driftPx === undefined ? '—' : r.driftPx.toFixed(2)).padStart(w4)} |`,
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
  results.push(await runExpandChildren(rows));
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
  if (anchorResult.driftPx > 0.5) {
    throw new Error(`viewport anchor drift ${anchorResult.driftPx.toFixed(2)} px exceeds 0.5 px`);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
