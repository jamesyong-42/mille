// Phase 10 — decorations pipeline.
//
// Coverage:
//   1. Row renders a badge from a decoration.
//   2. Row renders a letter with a color.
//   3. Row renders a tooltip (title attribute).
//   4. Row renders nothing for an empty decoration.
//   5. Decoration-only snapshot bump on row A → row A re-renders.
//   6. Decoration-only snapshot bump on row A → row B does NOT
//      re-render (render-count spy inside rowRenderer).
//   7. Tree-version bump re-renders only rows whose render data changed.
//   8. `fontWeight: 0` → row carries data-mille-decoration-ignored.
//
// Test 6 is the critical correctness test. If the row memo doesn't
// treat an identity-stable `decorations` prop as a skip signal, the
// whole Phase-10 memoization falls over.

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

const { createElement, act, memo } = await import('react');
const { createRoot } = await import('react-dom/client');

const {
  FileTree,
  FileTreeProvider,
  FileDecorations,
  decorationAccessibleLabel,
  mergeDecorations,
  EMPTY_DECORATION,
} =
  await import('../dist/index.js');
const { createCommandRegistry, defaultCommands } = await import(
  '../dist/commands/index.js'
);
const { areFileTreeRowPropsEqual } = await import(
  '../dist/components/FileTreeRow.js'
);
const { createFakeEngine, createFakeSnapshot } = await import(
  '../dist/testing.js'
);

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

function sampleRows() {
  return [
    makeRow({
      id: 1, parentId: null, name: 'a.ts',
      depth: 0, kind: 0, hasChildren: false, isExpanded: false,
    }),
    makeRow({
      id: 2, parentId: null, name: 'b.ts',
      depth: 0, kind: 0, hasChildren: false, isExpanded: false,
    }),
    makeRow({
      id: 3, parentId: null, name: 'c.ts',
      depth: 0, kind: 0, hasChildren: false, isExpanded: false,
    }),
  ];
}

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
  return { observeElementRect, observeElementOffset };
}

function mount() {
  const container = hdDocument.createElement('div');
  hdDocument.body.appendChild(container);
  return { container, root: createRoot(container) };
}

// Tiny row-renderer factory that counts per-id renders. Wrapped in
// React.memo with the same comparator the default FileTreeRow uses,
// so we count *actual* row renders (not tree-level re-renders that
// propagated before memoization).
//
function makeCountingRowRenderer(FileTreeRowImport) {
  const counts = new Map(); // id → number
  const inner = (props) => {
    counts.set(props.row.id, (counts.get(props.row.id) ?? 0) + 1);
    return createElement(FileTreeRowImport, props);
  };
  inner.displayName = 'CountingRowRendererInner';
  const wrapper = memo(inner, areFileTreeRowPropsEqual);
  wrapper.displayName = 'CountingRowRenderer';
  return { wrapper, counts };
}

// ─── Test 1: row renders a badge ──────────────────────────────────────

test('row renders a badge from the decoration', async () => {
  const fx = createFakeEngine();
  const rows = sampleRows();
  fx.emitDelta(createFakeSnapshot({ rows, treeVersion: 1 }));
  fx.setDecorations(1, [{ badge: 'M' }]);
  fx.bumpDecorationVersion();

  const { container, root } = mount();
  const obs = makeObservers({ height: 400 });

  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'Decor',
        rowHeight: 22,
        overscan: 10,
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  const row1 = container.querySelector('[data-mille-row-id="1"]');
  assert.ok(row1, 'row 1 must render');
  const badge = row1.querySelector('[data-mille-decoration-badge="M"]');
  assert.ok(badge, 'badge `M` must appear on row 1');
  assert.equal(badge.textContent, 'M');

  // Row 2 (no decoration) has no decoration span.
  const row2 = container.querySelector('[data-mille-row-id="2"]');
  assert.ok(row2);
  const r2Badge = row2.querySelector('[data-mille-decoration-badge]');
  assert.equal(r2Badge, null, 'row 2 must not render a decoration badge');

  await act(async () => { root.unmount(); });
  container.remove();
});

// ─── Test 2: letter with color ────────────────────────────────────────

test('row renders a letter with the decoration color', async () => {
  const fx = createFakeEngine();
  const rows = sampleRows();
  fx.emitDelta(createFakeSnapshot({ rows, treeVersion: 1 }));
  // letter + color — the UI-side merge surfaces these.
  fx.setDecorations(1, [
    { letter: 'A', color: 'rgb(63, 185, 80)' },
  ]);
  fx.bumpDecorationVersion();

  const { container, root } = mount();
  const obs = makeObservers({ height: 400 });

  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'Letter',
        rowHeight: 22,
        overscan: 10,
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  const row1 = container.querySelector('[data-mille-row-id="1"]');
  const letter = row1.querySelector('[data-mille-decoration-letter="A"]');
  assert.ok(letter, 'letter `A` must render');
  assert.equal(letter.textContent, 'A');
  const styleAttr = letter.getAttribute('style') ?? '';
  assert.ok(
    /color:\s*rgb\(63, ?185, ?80\)/.test(styleAttr),
    `letter style must carry the decoration color; got: ${styleAttr}`,
  );

  await act(async () => { root.unmount(); });
  container.remove();
});

// ─── Test 3: tooltip via title attribute ──────────────────────────────

test('row exposes the decoration tooltip as a title attribute', async () => {
  const fx = createFakeEngine();
  const rows = sampleRows();
  fx.emitDelta(createFakeSnapshot({ rows, treeVersion: 1 }));
  fx.setDecorations(2, [{ tooltip: 'Staged for commit' }]);
  fx.bumpDecorationVersion();

  const { container, root } = mount();
  const obs = makeObservers({ height: 400 });

  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'Tip',
        rowHeight: 22,
        overscan: 10,
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  const row2 = container.querySelector('[data-mille-row-id="2"]');
  const wrapper = row2.querySelector('[data-mille-decorations]');
  assert.ok(wrapper, 'decoration wrapper must render');
  assert.equal(wrapper.getAttribute('title'), 'Staged for commit');

  await act(async () => { root.unmount(); });
  container.remove();
});

// ─── Test 4: empty decoration → no element ────────────────────────────

test('FileDecorations renders nothing for an empty decoration', async () => {
  const { container, root } = mount();
  await act(async () => {
    root.render(
      createElement(FileDecorations, { decorations: EMPTY_DECORATION }),
    );
  });
  assert.equal(
    container.querySelector('[data-mille-decorations]'),
    null,
    'empty decoration must render no DOM',
  );
  // And any merged-but-empty record should also render null.
  await act(async () => {
    root.render(
      createElement(FileDecorations, { decorations: mergeDecorations([]) }),
    );
  });
  assert.equal(
    container.querySelector('[data-mille-decorations]'),
    null,
    'merged empty decoration must render no DOM',
  );
  await act(async () => { root.unmount(); });
  container.remove();
});

// ─── Accessible decoration text ───────────────────────────────────────

test('FileDecorations exposes aria-label, role, sr-only text, and hides glyphs', async () => {
  const { container, root } = mount();
  await act(async () => {
    root.render(
      createElement(FileDecorations, {
        decorations: {
          badge: '2',
          color: 'var(--mille-decoration-error)',
          tooltip: '2 errors\nts: detail message',
        },
      }),
    );
  });

  const wrapper = container.querySelector('[data-mille-decorations]');
  assert.ok(wrapper, 'wrapper must render');
  assert.equal(wrapper.getAttribute('role'), 'img');
  assert.equal(
    wrapper.getAttribute('aria-label'),
    '2 errors',
    'aria-label uses first tooltip line (summary)',
  );
  assert.equal(wrapper.getAttribute('title'), '2 errors\nts: detail message');

  const badge = wrapper.querySelector('[data-mille-decoration-badge="2"]');
  assert.ok(badge);
  assert.equal(badge.getAttribute('aria-hidden'), 'true');

  const sr = wrapper.querySelector('.mille-decoration-sr-only');
  assert.ok(sr, 'sr-only accessible text must be present');
  assert.equal(sr.textContent, '2 errors');

  await act(async () => { root.unmount(); });
  container.remove();
});

test('FileDecorations numeric badge without tooltip reads as N problems', async () => {
  assert.equal(
    decorationAccessibleLabel({ badge: '1' }),
    '1 problem',
  );
  assert.equal(
    decorationAccessibleLabel({ badge: '3' }),
    '3 problems',
  );
  assert.equal(
    decorationAccessibleLabel({ badge: '99+' }),
    '99+ problems',
  );
  assert.equal(
    decorationAccessibleLabel({ letter: 'M', badge: 'M' }),
    'status M, badge M',
  );
  assert.equal(
    decorationAccessibleLabel({ tooltip: '1 error', badge: '1' }),
    '1 error',
  );
});

test('FileDecorations letter glyph is aria-hidden when accessible label present', async () => {
  const { container, root } = mount();
  await act(async () => {
    root.render(
      createElement(FileDecorations, {
        decorations: {
          letter: 'M',
          badge: 'M',
          tooltip: 'staged modified',
        },
      }),
    );
  });
  const wrapper = container.querySelector('[data-mille-decorations]');
  assert.equal(wrapper.getAttribute('aria-label'), 'staged modified');
  const letter = wrapper.querySelector('[data-mille-decoration-letter="M"]');
  assert.ok(letter);
  assert.equal(letter.getAttribute('aria-hidden'), 'true');
  const badge = wrapper.querySelector('[data-mille-decoration-badge="M"]');
  assert.ok(badge);
  assert.equal(badge.getAttribute('aria-hidden'), 'true');
  await act(async () => { root.unmount(); });
  container.remove();
});

// ─── Test 5: decoration-only bump on row A → row A re-renders ─────────

test('decoration-only bump on row A re-renders row A', async () => {
  const fx = createFakeEngine();
  const rows = sampleRows();
  fx.emitDelta(createFakeSnapshot({ rows, treeVersion: 1 }));

  const { FileTreeRow } = await import('../dist/index.js');
  const { wrapper: rowRenderer, counts } = makeCountingRowRenderer(FileTreeRow);

  const { container, root } = mount();
  const obs = makeObservers({ height: 400 });

  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'Re-render A',
        rowHeight: 22,
        overscan: 10,
        rowRenderer,
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  const initialA = counts.get(1) ?? 0;
  assert.ok(initialA >= 1, 'row 1 must have rendered at least once');

  // Bump decoration on row 1 only.
  await act(async () => {
    fx.setDecorations(1, [{ badge: 'M' }]);
    fx.bumpDecorationVersion();
  });

  const afterA = counts.get(1) ?? 0;
  assert.ok(
    afterA > initialA,
    `row 1 must re-render on its own decoration bump; initial=${initialA}, after=${afterA}`,
  );

  // And the actual decoration DOM must now be present.
  const row1 = container.querySelector('[data-mille-row-id="1"]');
  assert.ok(row1.querySelector('[data-mille-decoration-badge="M"]'));

  await act(async () => { root.unmount(); });
  container.remove();
});

// ─── Test 6: decoration-only bump on row A → row B does NOT re-render ─

test('decoration-only bump on row A does NOT re-render row B', async () => {
  const fx = createFakeEngine();
  const rows = sampleRows();
  fx.emitDelta(createFakeSnapshot({ rows, treeVersion: 1 }));

  const { FileTreeRow } = await import('../dist/index.js');
  const { wrapper: rowRenderer, counts } = makeCountingRowRenderer(FileTreeRow);

  const { container, root } = mount();
  const obs = makeObservers({ height: 400 });

  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'Isolate B',
        rowHeight: 22,
        overscan: 10,
        rowRenderer,
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  const baselineB = counts.get(2) ?? 0;
  const baselineC = counts.get(3) ?? 0;
  assert.ok(baselineB >= 1);
  assert.ok(baselineC >= 1);

  // Decoration-only bump targeting row 1 only. Row 2 + row 3 are
  // untouched; `getDecorations(2)` / `getDecorations(3)` still return
  // the same empty array, so `mergeDecorations` returns the same
  // frozen `EMPTY_DECORATION`. Their `FileTreeRow` memo sees
  // identical props → SKIPS the render.
  await act(async () => {
    fx.setDecorations(1, [{ badge: 'M' }]);
    fx.bumpDecorationVersion();
  });

  const afterB = counts.get(2) ?? 0;
  const afterC = counts.get(3) ?? 0;

  assert.equal(
    afterB,
    baselineB,
    `row B (id=2) must NOT re-render on row A's decoration bump; baseline=${baselineB}, after=${afterB}`,
  );
  assert.equal(
    afterC,
    baselineC,
    `row C (id=3) must NOT re-render on row A's decoration bump; baseline=${baselineC}, after=${afterC}`,
  );

  await act(async () => { root.unmount(); });
  container.remove();
});

test('decoration-only bump does not rematerialize the structural projection', async () => {
  const fx = createFakeEngine();
  const rows = sampleRows();
  fx.emitDelta(createFakeSnapshot({ rows, treeVersion: 1 }));
  let materializations = 0;

  const { container, root } = mount();
  const obs = makeObservers({ height: 400 });
  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'Projection reuse',
        rowHeight: 22,
        overscan: 10,
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
        __testOnProjectionMaterialized: () => {
          materializations += 1;
        },
      }),
    );
  });
  const baseline = materializations;
  assert.ok(baseline >= 1);

  await act(async () => {
    fx.setDecorations(1, [{ badge: 'M' }]);
    fx.bumpDecorationVersion([1]);
  });

  assert.equal(materializations, baseline);
  assert.ok(
    container
      .querySelector('[data-mille-row-id="1"]')
      ?.querySelector('[data-mille-decoration-badge="M"]'),
  );

  await act(async () => { root.unmount(); });
  container.remove();
});

// ─── Test 7: tree-version bump isolates changed rows ──────────────────

test('tree-version bump re-renders only the changed visible row', async () => {
  const fx = createFakeEngine();
  const rows = sampleRows();
  fx.emitDelta(createFakeSnapshot({ rows, treeVersion: 1 }));
  const commands = createCommandRegistry(defaultCommands);

  const { FileTreeRow } = await import('../dist/index.js');
  const { wrapper: rowRenderer, counts } = makeCountingRowRenderer(FileTreeRow);

  const { container, root } = mount();
  const obs = makeObservers({ height: 400 });

  await act(async () => {
    root.render(
      createElement(
        FileTreeProvider,
        { fx, commands },
        createElement(FileTree, {
          ariaLabel: 'Tree bump',
          rowHeight: 22,
          overscan: 10,
          rowRenderer,
          __testObserveElementRect: obs.observeElementRect,
          __testObserveElementOffset: obs.observeElementOffset,
        }),
      ),
    );
  });

  const base = new Map([
    [1, counts.get(1) ?? 0],
    [2, counts.get(2) ?? 0],
    [3, counts.get(3) ?? 0],
  ]);
  for (const id of [1, 2, 3]) assert.ok(base.get(id) >= 1);

  // Emit a brand-new snapshot with fresh row objects, changing only row 2.
  // Snapshot materialization alone must not repaint rows 1 and 3.
  await act(async () => {
    const rows2 = sampleRows();
    rows2[1] = { ...rows2[1], name: 'b-renamed.ts', mtimeMs: 1 };
    fx.emitDelta(createFakeSnapshot({ rows: rows2, treeVersion: 2 }));
  });

  for (const id of [1, 2, 3]) {
    const before = base.get(id);
    const after = counts.get(id) ?? 0;
    if (id === 2) {
      assert.ok(
        after > before,
        `changed row ${id} must re-render; before=${before}, after=${after}`,
      );
    } else {
      assert.equal(
        after,
        before,
        `unchanged row ${id} must not re-render; before=${before}, after=${after}`,
      );
    }
  }

  await act(async () => { root.unmount(); });
  container.remove();
});

// ─── Test 8: fontWeight===0 → data-mille-decoration-ignored ───────────

test('row with fontWeight: 0 carries data-mille-decoration-ignored', async () => {
  const fx = createFakeEngine();
  const rows = sampleRows();
  fx.emitDelta(createFakeSnapshot({ rows, treeVersion: 1 }));
  // Script an "ignored" decoration — UI-only field on the underlying
  // decoration entry, surfaced via `mergeDecorations` into
  // `MergedDecoration.fontWeight`.
  fx.setDecorations(1, [{ fontWeight: 0 }]);
  fx.bumpDecorationVersion();

  const { container, root } = mount();
  const obs = makeObservers({ height: 400 });

  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'Ignored',
        rowHeight: 22,
        overscan: 10,
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  const row1 = container.querySelector('[data-mille-row-id="1"]');
  assert.ok(row1);
  assert.equal(
    row1.getAttribute('data-mille-decoration-ignored'),
    'true',
    'ignored row must carry data-mille-decoration-ignored="true"',
  );

  const row2 = container.querySelector('[data-mille-row-id="2"]');
  assert.equal(
    row2.getAttribute('data-mille-decoration-ignored'),
    null,
    'non-ignored row must not carry the attr',
  );

  await act(async () => { root.unmount(); });
  container.remove();
});

// ─── Test 9 (bonus): decoration-version bump with changedIds freshens
//                   identity for listed rows, not for others. ────────

test('bumpDecorationVersion with explicit changedIds freshens only those ids', async () => {
  const fx = createFakeEngine();
  const rows = sampleRows();
  fx.emitDelta(createFakeSnapshot({ rows, treeVersion: 1 }));

  // Put a decoration on both rows 1 and 2 up front.
  fx.setDecorations(1, [{ badge: 'A' }]);
  fx.setDecorations(2, [{ badge: 'B' }]);
  fx.bumpDecorationVersion();

  const { FileTreeRow } = await import('../dist/index.js');
  const { wrapper: rowRenderer, counts } = makeCountingRowRenderer(FileTreeRow);

  const { container, root } = mount();
  const obs = makeObservers({ height: 400 });

  await act(async () => {
    root.render(
      createElement(FileTree, {
        fx,
        ariaLabel: 'ChangedIds',
        rowHeight: 22,
        overscan: 10,
        rowRenderer,
        __testObserveElementRect: obs.observeElementRect,
        __testObserveElementOffset: obs.observeElementOffset,
      }),
    );
  });

  const baseA = counts.get(1) ?? 0;
  const baseB = counts.get(2) ?? 0;

  // Decoration-only bump with changedIds=[1]. Only row 1's decoration
  // array reference is freshened; row 2's is left alone.
  await act(async () => {
    fx.bumpDecorationVersion([1]);
  });

  const afterA = counts.get(1) ?? 0;
  const afterB = counts.get(2) ?? 0;
  assert.ok(
    afterA > baseA,
    `row 1 must re-render when in changedIds; base=${baseA}, after=${afterA}`,
  );
  assert.equal(
    afterB,
    baseB,
    `row 2 must NOT re-render when not in changedIds; base=${baseB}, after=${afterB}`,
  );

  await act(async () => { root.unmount(); });
  container.remove();
});
