// Phase 5.2 — explorer view projectors + resolve tests.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

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
} = await import('../dist/views.js');

// ─── Pure helpers ─────────────────────────────────────────────────────

test('basenamePath and sortViewSeeds', () => {
  assert.equal(basenamePath('src/a.ts'), 'a.ts');
  assert.equal(basenamePath('a.ts'), 'a.ts');
  const sorted = sortViewSeeds([
    { path: 'b.ts', reason: 'x', order: 10 },
    { path: 'a.ts', reason: 'x', order: 0 },
    { path: 'c.ts', reason: 'x', order: 0 },
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
  assert.equal(def.title, 'Open Files');
  assert.deepEqual(
    def.seeds.map((s) => s.path),
    ['src/m.ts', 'src/a.ts', 'src/z.ts'],
  );
  assert.equal(def.seeds[1].badge, '●');
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

// ─── Changed Files ────────────────────────────────────────────────────

test('projectChangedFilesView from status map values', () => {
  const map = new Map([
    ['/abs/a.ts', { path: 'src/a.ts', status: 'M' }],
    ['/abs/b.ts', { path: 'src/b.ts', status: '?', staged: false }],
    ['/abs/c.ts', { path: 'src/c.ts', status: '!' }],
  ]);
  const def = projectChangedFilesView(map);
  assert.equal(def.kind, 'changedFiles');
  // ignored hidden by default
  assert.equal(def.seeds.some((s) => s.path === 'src/c.ts'), false);
  assert.equal(def.seeds[0].path, 'src/a.ts');
  assert.equal(def.seeds[0].badge, 'M');
});

// ─── Problems ─────────────────────────────────────────────────────────

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
  assert.equal(def.kind, 'problems');
  assert.equal(def.seeds.length, 1);
  assert.equal(def.seeds[0].path, 'src/a.ts');
  assert.equal(def.seeds[0].badge, '2');
  assert.ok(def.seeds[0].reason.includes('error'));
});

// ─── Failed tests ─────────────────────────────────────────────────────

test('projectFailedTestsView filters statuses', () => {
  const results = new Map([
    ['a.test.ts', { path: 'a.test.ts', status: 'failed' }],
    ['b.test.ts', { path: 'b.test.ts', status: 'passed' }],
    ['c.test.ts', { path: 'c.test.ts', status: 'errored', message: 'boom' }],
  ]);
  const def = projectFailedTestsView(results);
  assert.equal(def.seeds.length, 2);
  assert.equal(def.seeds[0].badge, '✗');
  assert.ok(def.seeds.some((s) => s.tooltip === 'boom'));
});

// ─── Custom ───────────────────────────────────────────────────────────

test('projectCustomScopeView preserves host order as order field', () => {
  const def = projectCustomScopeView(['z.ts', 'a.ts'], { title: 'Mine' });
  assert.equal(def.kind, 'custom');
  assert.equal(def.title, 'Mine');
  // sort by order then path: z order 0, a order 1
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
      const rel = uri.path.replace(/^\/ROOT\/?/, '');
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
  assert.equal(a.badge, '●');
  assert.deepEqual(model.unresolvedPaths, ['missing.ts']);
});

test('resolveExplorerView rejects traversal seeds', async () => {
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
      id: 1,
      path: 'src/foo.ts',
      name: 'foo.ts',
      reason: 'open',
      order: 0,
    },
    {
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
  assert.equal(filterExplorerViewItems(items, '').length, 2);
});
