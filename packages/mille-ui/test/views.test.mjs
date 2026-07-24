// Phase 5.2 — explorer view projectors, resolve, and list harness.

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

const {
  projectOpenFilesView,
  projectChangedFilesView,
  projectProblemsView,
  projectFailedTestsView,
  projectCustomScopeView,
  resolveExplorerView,
  filterExplorerViewItems,
  sortViewSeeds,
  basenamePath,
  explorerViewItemKey,
  ExplorerViewList,
  viewBadgeAccessibleLabel,
} = await import('../dist/views.js');

const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');

// ─── Pure helpers ─────────────────────────────────────────────────────

test('basenamePath, sortViewSeeds, explorerViewItemKey', () => {
  assert.equal(basenamePath('src/a.ts'), 'a.ts');
  assert.equal(explorerViewItemKey({ id: 42, path: 'a.ts' }), 'id:42');
  assert.equal(
    explorerViewItemKey({ path: 'a.ts', rootPath: '/R' }),
    'path:/R:a.ts',
  );
  const sorted = sortViewSeeds([
    { path: 'b.ts', reason: 'x', order: 10 },
    { path: 'a.ts', reason: 'x', order: 0 },
    { path: 'c.ts', reason: 'x', order: 0, rootPath: '/A' },
  ]);
  assert.deepEqual(
    sorted.map((s) => s.path),
    ['a.ts', 'c.ts', 'b.ts'],
  );
});

// ─── Open Files ───────────────────────────────────────────────────────

test('projectOpenFilesView orders active then dirty then path', () => {
  const def = projectOpenFilesView({
    open: [
      { path: 'src/z.ts' },
      { path: 'src/a.ts', dirty: true },
      { path: 'src/m.ts', active: true },
    ],
    activePath: 'src/m.ts',
  });
  assert.equal(def.kind, 'openFiles');
  assert.deepEqual(
    def.seeds.map((s) => s.path),
    ['src/m.ts', 'src/a.ts', 'src/z.ts'],
  );
  assert.equal(def.seeds[1].badge, '●');
});

test('projectOpenFilesView preserves entryId and rootPath for multi-root', () => {
  const def = projectOpenFilesView({
    open: [
      {
        path: 'a.ts',
        entryId: 99,
        rootPath: '/other-root',
        dirty: true,
      },
    ],
  });
  assert.equal(def.seeds[0].id, 99);
  assert.equal(def.seeds[0].rootPath, '/other-root');
});

test('projectOpenFilesView keeps same relative path across roots', () => {
  const def = projectOpenFilesView({
    open: [
      { path: 'src/index.ts', rootPath: '/a', entryId: 1, active: true },
      { path: 'src/index.ts', rootPath: '/b', entryId: 2, dirty: true },
    ],
  });
  assert.equal(def.seeds.length, 2);
  const ids = def.seeds.map((s) => s.id).sort();
  assert.deepEqual(ids, [1, 2]);
  assert.ok(def.seeds.every((s) => s.path === 'src/index.ts'));
  const roots = def.seeds.map((s) => s.rootPath).sort();
  assert.deepEqual(roots, ['/a', '/b']);
});

test('projectOpenFilesView dirtyOnly', () => {
  const def = projectOpenFilesView(
    {
      open: [
        { path: 'a.ts', dirty: true },
        { path: 'b.ts' },
      ],
    },
    { dirtyOnly: true },
  );
  assert.equal(def.seeds.length, 1);
  assert.equal(def.seeds[0].path, 'a.ts');
});

// ─── Changed / Problems / Tests / Custom ──────────────────────────────

test('projectChangedFilesView from status map values', () => {
  const map = new Map([
    ['/abs/a.ts', { path: 'src/a.ts', status: 'M' }],
    ['/abs/b.ts', { path: 'src/b.ts', status: '?', staged: false }],
    ['/abs/c.ts', { path: 'src/c.ts', status: '!' }],
  ]);
  const def = projectChangedFilesView(map);
  assert.equal(def.seeds.some((s) => s.path === 'src/c.ts'), false);
  assert.equal(def.seeds[0].path, 'src/a.ts');
  assert.equal(def.seeds[0].badge, 'M');
});

test('projectProblemsView aggregates per path by max severity', () => {
  const diags = new Map([
    [
      'src/a.ts',
      [
        { path: 'src/a.ts', severity: 'warning' },
        { path: 'src/a.ts', severity: 'error' },
      ],
    ],
    ['src/b.ts', [{ path: 'src/b.ts', severity: 'hint' }]],
  ]);
  const def = projectProblemsView(diags, { minSeverity: 'warning' });
  assert.equal(def.seeds.length, 1);
  assert.equal(def.seeds[0].badge, '2');
});

test('projectFailedTestsView filters statuses', () => {
  const results = new Map([
    ['a.test.ts', { path: 'a.test.ts', status: 'failed' }],
    ['b.test.ts', { path: 'b.test.ts', status: 'passed' }],
    ['c.test.ts', { path: 'c.test.ts', status: 'errored', message: 'boom' }],
  ]);
  const def = projectFailedTestsView(results);
  assert.equal(def.seeds.length, 2);
  assert.equal(def.seeds[0].badge, '✗');
});

test('projectCustomScopeView preserves host order as order field', () => {
  const def = projectCustomScopeView(['z.ts', 'a.ts'], { title: 'Mine' });
  assert.deepEqual(
    def.seeds.map((s) => s.path),
    ['z.ts', 'a.ts'],
  );
});

// ─── Resolve ──────────────────────────────────────────────────────────

function createFakeFx(rows) {
  const byId = new Map();
  const byPath = new Map();
  for (const r of rows) {
    const entry = {
      id: r.id,
      parentId: r.parentId ?? null,
      name: r.path.split('/').pop() ?? '',
      kind: r.kind ?? 0,
    };
    byId.set(r.id, entry);
    byPath.set(r.path, entry);
  }
  return {
    getSnapshot: () => ({ getById: (id) => byId.get(id) ?? null }),
    getByUri: (uri) => {
      // Support multi-root: path is /ROOT/... or /OTHER/...
      const m = uri.path.match(/^\/(ROOT|OTHER)\/?(.*)$/);
      if (!m) return null;
      const root = m[1];
      const rel = m[2];
      if (root === 'OTHER') return byPath.get(`other:${rel}`) ?? null;
      return byPath.get(rel) ?? null;
    },
  };
}

test('resolveExplorerView maps paths to ids and tracks unresolved', async () => {
  const fx = createFakeFx([
    { id: 1, path: '', kind: 1 },
    { id: 2, path: 'src/a.ts', kind: 0 },
  ]);
  const definition = projectOpenFilesView({
    open: [
      { path: 'src/a.ts', dirty: true },
      { path: 'missing.ts' },
    ],
  });
  const model = await resolveExplorerView({
    fx,
    rootPath: '/ROOT',
    definition,
  });
  assert.equal(model.items.length, 2);
  const a = model.items.find((i) => i.path === 'src/a.ts');
  assert.ok(a);
  assert.equal(a.id, 2);
  assert.equal(a.key, 'id:2');
  assert.equal(a.badge, '●');
  assert.deepEqual(model.unresolvedPaths, ['missing.ts']);
  const miss = model.items.find((i) => i.path === 'missing.ts');
  assert.ok(miss);
  assert.equal(miss.id, null);
  assert.ok(miss.key.startsWith('path:'));
});

test('resolveExplorerView prefers seed.id over path (multi-root safe)', async () => {
  const fx = createFakeFx([
    { id: 10, path: 'a.ts' },
    { id: 20, path: 'other:a.ts' },
  ]);
  // Same relative path under different roots — id wins.
  const model = await resolveExplorerView({
    fx,
    rootPath: '/ROOT',
    definition: {
      kind: 'custom',
      title: 'Multi',
      seeds: [
        { path: 'a.ts', rootPath: '/OTHER', id: 20, reason: 'x' },
        { path: 'a.ts', rootPath: '/ROOT', id: 10, reason: 'x' },
      ],
    },
  });
  assert.equal(model.items[0].id, 20);
  assert.equal(model.items[0].key, 'id:20');
  assert.equal(model.items[1].id, 10);
});

test('resolveExplorerView rejects traversal seeds without id', async () => {
  const fx = createFakeFx([{ id: 1, path: 'src/a.ts' }]);
  const model = await resolveExplorerView({
    fx,
    rootPath: '/ROOT',
    definition: projectCustomScopeView(['../secret.ts', 'src/a.ts']),
  });
  assert.equal(model.items.length, 1);
  assert.equal(model.items[0].path, 'src/a.ts');
});

test('filterExplorerViewItems filters by name and path', () => {
  const items = [
    {
      key: 'id:1',
      id: 1,
      path: 'src/foo.ts',
      name: 'foo.ts',
      reason: 'open',
      order: 0,
    },
    {
      key: 'id:2',
      id: 2,
      path: 'lib/bar.ts',
      name: 'bar.ts',
      reason: 'dirty',
      order: 1,
    },
  ];
  assert.equal(filterExplorerViewItems(items, 'foo').length, 1);
  assert.equal(filterExplorerViewItems(items, 'lib/').length, 1);
  assert.equal(filterExplorerViewItems(items, 'dirty').length, 1);
});

// ─── ExplorerViewList harness ─────────────────────────────────────────

function mount() {
  const container = hdDocument.createElement('div');
  container.style.height = '400px';
  hdDocument.body.appendChild(container);
  const root = createRoot(container);
  return { container, root };
}

function makeObservers({ height = 400 } = {}) {
  const observeElementRect = (_instance, cb) => {
    cb({ width: 300, height });
    return () => {};
  };
  // Signature matches VirtualizerOffsetObserver: (offset, isScrolling).
  const observeElementOffset = (_instance, cb) => {
    cb(0, false);
    return () => {};
  };
  return { observeElementRect, observeElementOffset };
}

function sampleModel(items) {
  return {
    kind: 'openFiles',
    title: 'Open Files',
    items,
    unresolvedPaths: items.filter((i) => i.id === null).map((i) => i.path),
  };
}

function listProps(model) {
  const obs = makeObservers();
  return {
    model,
    rowHeight: 22,
    __testObserveElementRect: obs.observeElementRect,
    __testObserveElementOffset: obs.observeElementOffset,
  };
}

test('ExplorerViewList renders rows and selects unresolved by key', async () => {
  const model = sampleModel([
    {
      key: 'path:/R:missing.ts',
      id: null,
      path: 'missing.ts',
      name: 'missing.ts',
      reason: 'open',
      order: 0,
    },
    {
      key: 'id:2',
      id: 2,
      path: 'src/a.ts',
      name: 'a.ts',
      reason: 'dirty',
      order: 1,
      badge: '●',
      tooltip: 'Unsaved changes',
    },
  ]);
  const { container, root } = mount();
  await act(async () => {
    root.render(createElement(ExplorerViewList, listProps(model)));
  });

  const list = container.querySelector('[role="listbox"]');
  assert.ok(list);
  const opts = container.querySelectorAll('[role="option"]');
  assert.ok(opts.length >= 1, `expected options, got ${opts.length}`);

  // Click unresolved row — must select via key, not EntryId.
  const unresolved = container.querySelector('[data-mille-view-unresolved]');
  assert.ok(unresolved);
  await act(async () => {
    unresolved.dispatchEvent(new hdWindow.MouseEvent('click', { bubbles: true }));
  });
  assert.equal(unresolved.getAttribute('aria-selected'), 'true');
  assert.ok(list.getAttribute('aria-activedescendant'));
  assert.equal(
    list.getAttribute('aria-activedescendant'),
    unresolved.id,
  );

  // ArrowDown moves to next row and keeps selection valid.
  await act(async () => {
    list.dispatchEvent(
      new hdWindow.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    );
  });
  const selected = container.querySelector('[role="option"][aria-selected="true"]');
  assert.ok(selected);
  assert.equal(selected.getAttribute('data-mille-view-key'), 'id:2');

  // Badge has sr-only accessible text.
  const sr = container.querySelector('.mille-explorer-view-sr-only');
  assert.ok(sr);
  assert.ok(sr.textContent.includes('Unsaved') || sr.textContent.length > 0);

  await act(async () => {
    root.unmount();
  });
  container.remove();
});

test('ExplorerViewList keeps stable keys across reorder', async () => {
  const itemA = {
    key: 'id:1',
    id: 1,
    path: 'a.ts',
    name: 'a.ts',
    reason: 'open',
    order: 0,
  };
  const itemB = {
    key: 'id:2',
    id: 2,
    path: 'b.ts',
    name: 'b.ts',
    reason: 'dirty',
    order: 1,
    badge: '●',
  };
  const { container, root } = mount();
  await act(async () => {
    root.render(
      createElement(ExplorerViewList, listProps(sampleModel([itemA, itemB]))),
    );
  });
  const firstKeys = [...container.querySelectorAll('[data-mille-view-key]')].map(
    (el) => el.getAttribute('data-mille-view-key'),
  );
  assert.deepEqual(firstKeys, ['id:1', 'id:2']);

  // Reorder: B first (active), A second — keys must stay id-based.
  await act(async () => {
    root.render(
      createElement(
        ExplorerViewList,
        listProps(
          sampleModel([
            { ...itemB, order: 0, reason: 'open+active' },
            { ...itemA, order: 1 },
          ]),
        ),
      ),
    );
  });
  const secondKeys = [...container.querySelectorAll('[data-mille-view-key]')].map(
    (el) => el.getAttribute('data-mille-view-key'),
  );
  assert.deepEqual(secondKeys, ['id:2', 'id:1']);

  await act(async () => {
    root.unmount();
  });
  container.remove();
});

test('viewBadgeAccessibleLabel covers common glyphs', () => {
  assert.equal(viewBadgeAccessibleLabel('●', undefined), 'Unsaved changes');
  assert.equal(viewBadgeAccessibleLabel('2', '2 errors'), '2 errors');
  assert.equal(viewBadgeAccessibleLabel('✗', undefined), 'Test failed');
});
