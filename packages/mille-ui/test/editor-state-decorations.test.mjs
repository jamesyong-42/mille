// Phase 5.1 — editor open/dirty/active decoration companion tests.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const {
  registerEditorStateDecorations,
  createMapEditorStateClient,
  normalizeEditorState,
  formatEditorStateBadge,
  formatEditorStateTooltip,
} = await import('../dist/editor-state.js');

function createFakeEngine(rows) {
  const byId = new Map();
  const byPath = new Map();
  for (const r of rows) {
    const entry = {
      id: r.id,
      parentId: r.parentId,
      name: r.path.split('/').pop() ?? '',
      kind: r.kind ?? 0,
    };
    byId.set(r.id, entry);
    byPath.set(r.path, entry);
  }
  const providers = [];
  let disposedCount = 0;
  const fx = {
    getSnapshot: () => ({ getById: (id) => byId.get(id) ?? null }),
    getByUri: (uri) => {
      const rel = uri.path.replace(/^\/ROOT\/?/, '');
      return byPath.get(rel) ?? null;
    },
    registerDecorationProvider: (provider) => {
      providers.push(provider);
      return {
        dispose: () => {
          disposedCount += 1;
        },
      };
    },
    _stats: () => ({ providers, disposedCount }),
  };
  return { fx };
}

function sampleRows() {
  return [
    { id: 1, parentId: null, path: '', kind: 1 },
    { id: 2, parentId: 1, path: 'src', kind: 1 },
    { id: 3, parentId: 2, path: 'src/a.ts', kind: 0 },
    { id: 4, parentId: 2, path: 'src/b.ts', kind: 0 },
    { id: 5, parentId: 1, path: 'README.md', kind: 0 },
  ];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(predicate, { timeoutMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }
  assert.fail('waitFor timed out');
}

// ─── Pure helpers ─────────────────────────────────────────────────────

test('normalizeEditorState merges tabs and activePath override', () => {
  const map = normalizeEditorState({
    open: [
      { path: 'src/a.ts', dirty: true },
      { path: 'src/b.ts', active: true },
      { path: 'src/a.ts', dirty: false }, // later tab: dirty stays true via OR
    ],
    activePath: 'src/a.ts',
  });
  assert.deepEqual(map.get('src/a.ts'), {
    open: true,
    dirty: true,
    active: true,
    path: 'src/a.ts',
  });
  assert.deepEqual(map.get('src/b.ts'), {
    open: true,
    dirty: false,
    active: false,
    path: 'src/b.ts',
  });
});

test('normalizeEditorState keeps multi-root same path as distinct keys', () => {
  const map = normalizeEditorState({
    open: [
      { path: 'src/index.ts', rootPath: '/a', entryId: 1, active: true },
      { path: 'src/index.ts', rootPath: '/b', entryId: 2, dirty: true },
    ],
  });
  assert.equal(map.size, 2);
  assert.ok(map.has('entry:1'));
  assert.ok(map.has('entry:2'));
  assert.equal(map.get('entry:1')?.path, 'src/index.ts');
  assert.equal(map.get('entry:2')?.path, 'src/index.ts');
  assert.equal(map.get('entry:1')?.rootPath, '/a');
  assert.equal(map.get('entry:2')?.rootPath, '/b');
});

test('activePath alone does not activate same path across roots', () => {
  const map = normalizeEditorState({
    open: [
      { path: 'src/index.ts', rootPath: '/a', entryId: 1 },
      { path: 'src/index.ts', rootPath: '/b', entryId: 2 },
    ],
    activePath: 'src/index.ts',
  });
  assert.equal(map.get('entry:1')?.active, false);
  assert.equal(map.get('entry:2')?.active, false);
});

test('activeEntryId selects sole multi-root tab', () => {
  const map = normalizeEditorState({
    open: [
      { path: 'src/index.ts', rootPath: '/a', entryId: 1 },
      { path: 'src/index.ts', rootPath: '/b', entryId: 2 },
    ],
    activePath: 'src/index.ts',
    activeEntryId: 2,
  });
  assert.equal(map.get('entry:1')?.active, false);
  assert.equal(map.get('entry:2')?.active, true);
});

test('activeRootPath + activePath disambiguates multi-root', () => {
  const map = normalizeEditorState({
    open: [
      { path: 'src/index.ts', rootPath: '/a', entryId: 1 },
      { path: 'src/index.ts', rootPath: '/b', entryId: 2 },
    ],
    activePath: 'src/index.ts',
    activeRootPath: '/a',
  });
  assert.equal(map.get('entry:1')?.active, true);
  assert.equal(map.get('entry:2')?.active, false);
});

test('formatEditorStateBadge and tooltip', () => {
  assert.equal(
    formatEditorStateBadge({ open: true, dirty: true, active: false }),
    '●',
  );
  assert.equal(
    formatEditorStateBadge({ open: true, dirty: false, active: false }),
    '○',
  );
  assert.equal(
    formatEditorStateTooltip({ open: true, dirty: true, active: true }),
    'Active editor · Unsaved changes',
  );
  assert.equal(
    formatEditorStateTooltip({ open: true, dirty: false, active: false }),
    'Open in editor',
  );
});

// ─── Registration ─────────────────────────────────────────────────────

test('registerEditorStateDecorations returns disposable handle', async () => {
  const { fx } = createFakeEngine(sampleRows());
  const client = createMapEditorStateClient();
  const handle = registerEditorStateDecorations({
    fx,
    client,
    rootPath: '/ROOT',
  });
  assert.equal(typeof handle.dispose, 'function');
  assert.equal(typeof handle.refresh, 'function');
  handle.dispose();
  handle.dispose();
});

test('dirty open file gets filled-circle badge', async () => {
  const { fx } = createFakeEngine(sampleRows());
  const client = createMapEditorStateClient({
    initial: {
      open: [{ path: 'src/a.ts', dirty: true }],
    },
  });
  const handle = registerEditorStateDecorations({
    fx,
    client,
    rootPath: '/ROOT',
  });
  await handle.refresh();
  const { providers } = fx._stats();
  const dec = providers[0].provide({ id: 3 });
  assert.ok(dec);
  assert.equal(dec.badge, '●');
  assert.ok(String(dec.tooltip).includes('Unsaved'));
  assert.equal(providers[0].provide({ id: 4 }), null);
  handle.dispose();
});

test('open clean file gets hollow-circle badge', async () => {
  const { fx } = createFakeEngine(sampleRows());
  const client = createMapEditorStateClient({
    initial: { open: [{ path: 'src/b.ts' }] },
  });
  const handle = registerEditorStateDecorations({
    fx,
    client,
    rootPath: '/ROOT',
  });
  await handle.refresh();
  const dec = fx._stats().providers[0].provide({ id: 4 });
  assert.ok(dec);
  assert.equal(dec.badge, '○');
  handle.dispose();
});

test('decorateOpen: false skips clean open badges', async () => {
  const { fx } = createFakeEngine(sampleRows());
  const client = createMapEditorStateClient({
    initial: {
      open: [
        { path: 'src/a.ts', dirty: true },
        { path: 'src/b.ts' },
      ],
    },
  });
  const handle = registerEditorStateDecorations({
    fx,
    client,
    rootPath: '/ROOT',
    decorateOpen: false,
  });
  await handle.refresh();
  const provider = fx._stats().providers[0];
  assert.equal(provider.provide({ id: 3 }).badge, '●');
  assert.equal(provider.provide({ id: 4 }), null);
  handle.dispose();
});

test('activePath forces active tooltip when decorateOpen is true', async () => {
  const { fx } = createFakeEngine(sampleRows());
  const client = createMapEditorStateClient({
    initial: {
      open: [{ path: 'README.md', title: 'Read me' }],
      activePath: 'README.md',
    },
  });
  const handle = registerEditorStateDecorations({
    fx,
    client,
    rootPath: '/ROOT',
    decorateOpen: true,
  });
  await handle.refresh();
  const dec = fx._stats().providers[0].provide({ id: 5 });
  assert.ok(dec);
  assert.ok(dec.tooltip.includes('Active editor'));
  assert.ok(dec.tooltip.includes('Read me'), 'title appears in tooltip');
  handle.dispose();
});

test('decorateOpen: false does not recolor active clean files', async () => {
  const { fx } = createFakeEngine(sampleRows());
  const client = createMapEditorStateClient({
    initial: {
      open: [{ path: 'src/a.ts', active: true }],
      activePath: 'src/a.ts',
    },
  });
  const handle = registerEditorStateDecorations({
    fx,
    client,
    rootPath: '/ROOT',
    decorateOpen: false,
  });
  await handle.refresh();
  // Must not emit color/tooltip-only decoration (would steal diagnostics color).
  assert.equal(fx._stats().providers[0].provide({ id: 3 }), null);
  handle.dispose();
});

test('activePath null clears active flags', () => {
  const map = normalizeEditorState({
    open: [{ path: 'src/a.ts', active: true }],
    activePath: null,
  });
  assert.deepEqual(map.get('src/a.ts'), {
    open: true,
    dirty: false,
    active: false,
    path: 'src/a.ts',
  });
});

test('stale recompute does not overwrite newer editor-state', async () => {
  const { fx } = createFakeEngine(sampleRows());
  let call = 0;
  const client = {
    getEditorState() {
      call += 1;
      const n = call;
      if (n === 1) {
        return (async () => {
          await sleep(80);
          return { open: [{ path: 'src/a.ts', dirty: false }] };
        })();
      }
      return { open: [{ path: 'src/a.ts', dirty: true }] };
    },
    onChange() {
      return () => {};
    },
  };
  const handle = registerEditorStateDecorations({
    fx,
    client,
    rootPath: '/ROOT',
    decorateOpen: true,
  });
  await sleep(10);
  await handle.refresh();
  await sleep(100);
  const dec = fx._stats().providers[0].provide({ id: 3 });
  assert.ok(dec);
  assert.equal(dec.badge, '●', 'stale clean open must not overwrite dirty');
  handle.dispose();
});

test('client mutation notifies and updates badges', async () => {
  const { fx } = createFakeEngine(sampleRows());
  const client = createMapEditorStateClient({
    initial: { open: [{ path: 'src/a.ts' }] },
  });
  const handle = registerEditorStateDecorations({
    fx,
    client,
    rootPath: '/ROOT',
    batchOptions: { debounceMs: 10, maxWaitMs: 50 },
  });
  await handle.refresh();
  const provider = fx._stats().providers[0];
  assert.equal(provider.provide({ id: 3 }).badge, '○');

  client.setDirty('src/a.ts', true);
  await waitFor(() => provider.provide({ id: 3 })?.badge === '●');
  handle.dispose();
});

test('unchanged refresh does not notify', async () => {
  const { fx } = createFakeEngine(sampleRows());
  const client = createMapEditorStateClient({
    initial: { open: [{ path: 'src/a.ts', dirty: true }] },
  });
  const handle = registerEditorStateDecorations({
    fx,
    client,
    rootPath: '/ROOT',
  });
  await handle.refresh();
  let n = 0;
  fx._stats().providers[0].onDidChange(() => {
    n += 1;
  });
  await handle.refresh();
  assert.equal(n, 0);
  handle.dispose();
});

test('resolvePath fallback when getByUri absent', async () => {
  const rows = sampleRows();
  const byId = new Map();
  const byAbs = new Map();
  for (const r of rows) {
    const entry = { id: r.id, parentId: r.parentId, name: r.path, kind: 0 };
    byId.set(r.id, entry);
    byAbs.set(r.path === '' ? '/ROOT' : `/ROOT/${r.path}`, entry);
  }
  const providers = [];
  const fx = {
    getSnapshot: () => ({ getById: (id) => byId.get(id) ?? null }),
    resolvePath: async (abs) => byAbs.get(abs)?.id ?? null,
    registerDecorationProvider: (p) => {
      providers.push(p);
      return { dispose() {} };
    },
  };
  const client = createMapEditorStateClient({
    initial: { open: [{ path: 'src/a.ts', dirty: true }] },
  });
  const handle = registerEditorStateDecorations({
    fx,
    client,
    rootPath: '/ROOT',
  });
  await handle.refresh();
  assert.equal(providers[0].provide({ id: 3 }).badge, '●');
  handle.dispose();
});

test('unsafe paths are ignored', async () => {
  const { fx } = createFakeEngine(sampleRows());
  const client = createMapEditorStateClient({
    initial: {
      open: [
        { path: '../secret.ts', dirty: true },
        { path: 'src/a.ts', dirty: true },
      ],
    },
  });
  const handle = registerEditorStateDecorations({
    fx,
    client,
    rootPath: '/ROOT',
  });
  await handle.refresh();
  const provider = fx._stats().providers[0];
  assert.ok(provider.provide({ id: 3 }));
  // No crash; only safe path decorated.
  handle.dispose();
});

test('background error is reported via onError', async () => {
  const { fx } = createFakeEngine(sampleRows());
  const errors = [];
  const client = {
    getEditorState() {
      throw new Error('editor down');
    },
    onChange() {
      return () => {};
    },
  };
  const handle = registerEditorStateDecorations({
    fx,
    client,
    rootPath: '/ROOT',
    onError: (e) => errors.push(e),
  });
  await sleep(30);
  assert.ok(errors.length >= 1);
  await assert.rejects(() => handle.refresh(), /editor down/);
  handle.dispose();
});

test('dispose unregisters provider', async () => {
  const { fx } = createFakeEngine(sampleRows());
  const client = createMapEditorStateClient();
  const handle = registerEditorStateDecorations({
    fx,
    client,
    rootPath: '/ROOT',
  });
  await handle.refresh();
  handle.dispose();
  assert.equal(fx._stats().disposedCount, 1);
});
