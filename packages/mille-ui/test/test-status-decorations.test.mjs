// Phase 5.1 — test status decoration companion tests.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const {
  registerTestStatusDecorations,
  createMapTestStatusClient,
  formatTestStatusBadge,
  formatTestStatusTooltip,
  maxStatusFromCounts,
  countsFromStatus,
  addTestCounts,
  ZERO_TEST_COUNTS,
  TEST_STATUS_RANK,
} = await import('../dist/test-status.js');

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
    { id: 3, parentId: 2, path: 'src/a.test.ts', kind: 0 },
    { id: 4, parentId: 2, path: 'src/b.test.ts', kind: 0 },
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

test('status rank and counts helpers', () => {
  assert.ok(TEST_STATUS_RANK.failed > TEST_STATUS_RANK.passed);
  assert.equal(maxStatusFromCounts(countsFromStatus('failed')), 'failed');
  assert.equal(
    maxStatusFromCounts(
      addTestCounts(countsFromStatus('passed'), countsFromStatus('failed')),
    ),
    'failed',
  );
  assert.equal(maxStatusFromCounts(ZERO_TEST_COUNTS), null);
});

test('formatTestStatusBadge leaf and aggregate', () => {
  assert.equal(
    formatTestStatusBadge('failed', countsFromStatus('failed'), false),
    '✗',
  );
  assert.equal(
    formatTestStatusBadge('passed', countsFromStatus('passed'), false),
    '✓',
  );
  assert.equal(
    formatTestStatusBadge(
      'failed',
      { passed: 2, failed: 3, errored: 0, skipped: 0, running: 0 },
      true,
    ),
    '3',
  );
  assert.equal(
    formatTestStatusBadge(
      'failed',
      { passed: 0, failed: 150, errored: 0, skipped: 0, running: 0 },
      true,
      99,
    ),
    '99+',
  );
});

test('formatTestStatusTooltip', () => {
  assert.equal(
    formatTestStatusTooltip('failed', countsFromStatus('failed'), false),
    'Test failed',
  );
  assert.equal(
    formatTestStatusTooltip(
      'failed',
      { passed: 1, failed: 2, errored: 0, skipped: 1, running: 0 },
      true,
    ),
    '2 failed, 1 skipped, 1 passed',
  );
});

// ─── Provider ─────────────────────────────────────────────────────────

test('registerTestStatusDecorations returns disposable handle', async () => {
  const { fx } = createFakeEngine(sampleRows());
  const client = createMapTestStatusClient();
  const handle = registerTestStatusDecorations({
    fx,
    client,
    rootPath: '/ROOT',
  });
  assert.equal(typeof handle.dispose, 'function');
  assert.equal(typeof handle.refresh, 'function');
  handle.dispose();
  handle.dispose();
});

test('failed leaf gets ✗ badge; passed hidden by default', async () => {
  const { fx } = createFakeEngine(sampleRows());
  const client = createMapTestStatusClient({
    initial: [
      { path: 'src/a.test.ts', status: 'failed', message: 'expect(1).toBe(2)' },
      { path: 'src/b.test.ts', status: 'passed' },
    ],
  });
  const handle = registerTestStatusDecorations({
    fx,
    client,
    rootPath: '/ROOT',
    propagateToParent: false,
  });
  await handle.refresh();
  const provider = fx._stats().providers[0];
  const fail = provider.provide({ id: 3 });
  assert.ok(fail);
  assert.equal(fail.badge, '✗');
  assert.ok(fail.tooltip.includes('failed'));
  assert.ok(fail.tooltip.includes('expect(1).toBe(2)'));
  assert.equal(
    provider.provide({ id: 4 }),
    null,
    'passed leaf hidden when showPassed is false',
  );
  handle.dispose();
});

test('showPassed: true decorates green checks', async () => {
  const { fx } = createFakeEngine(sampleRows());
  const client = createMapTestStatusClient({
    initial: [{ path: 'src/b.test.ts', status: 'passed' }],
  });
  const handle = registerTestStatusDecorations({
    fx,
    client,
    rootPath: '/ROOT',
    showPassed: true,
    propagateToParent: false,
  });
  await handle.refresh();
  const dec = fx._stats().providers[0].provide({ id: 4 });
  assert.ok(dec);
  assert.equal(dec.badge, '✓');
  handle.dispose();
});

test('ancestor aggregate shows failure count', async () => {
  const { fx } = createFakeEngine(sampleRows());
  const client = createMapTestStatusClient({
    initial: [
      { path: 'src/a.test.ts', status: 'failed' },
      { path: 'src/b.test.ts', status: 'failed' },
    ],
  });
  const handle = registerTestStatusDecorations({
    fx,
    client,
    rootPath: '/ROOT',
    propagateToParent: true,
  });
  await handle.refresh();
  const provider = fx._stats().providers[0];
  const folder = provider.provide({ id: 2 });
  assert.ok(folder, 'src folder must aggregate');
  assert.equal(folder.badge, '2');
  assert.ok(folder.tooltip.includes('failed'));
  const root = provider.provide({ id: 1 });
  assert.ok(root);
  assert.equal(root.badge, '2');
  handle.dispose();
});

test('directory-keyed suite uses aggregate badge not leaf ✗', async () => {
  const { fx } = createFakeEngine(sampleRows());
  // Key the suite folder itself with aggregate counts.
  const client = createMapTestStatusClient({
    initial: [
      {
        path: 'src',
        status: 'failed',
        counts: {
          passed: 7,
          failed: 3,
          errored: 0,
          skipped: 0,
          running: 0,
        },
      },
    ],
  });
  const handle = registerTestStatusDecorations({
    fx,
    client,
    rootPath: '/ROOT',
    propagateToParent: false,
  });
  await handle.refresh();
  const provider = fx._stats().providers[0];
  const folder = provider.provide({ id: 2 });
  assert.ok(folder);
  assert.equal(folder.badge, '3', 'suite folder shows failure count');
  assert.ok(folder.tooltip.includes('3 failed'));
  assert.ok(folder.tooltip.includes('7 passed'));
  assert.notEqual(folder.badge, '✗');
  handle.dispose();
});

test('stale recompute does not overwrite newer test-status', async () => {
  const { fx } = createFakeEngine(sampleRows());
  let call = 0;
  const client = {
    getResults() {
      call += 1;
      const n = call;
      if (n === 1) {
        return (async () => {
          await sleep(80);
          return new Map([
            ['src/a.test.ts', { path: 'src/a.test.ts', status: 'running' }],
          ]);
        })();
      }
      return new Map([
        ['src/a.test.ts', { path: 'src/a.test.ts', status: 'failed' }],
      ]);
    },
    onChange() {
      return () => {};
    },
  };
  const handle = registerTestStatusDecorations({
    fx,
    client,
    rootPath: '/ROOT',
    propagateToParent: false,
  });
  await sleep(10);
  await handle.refresh();
  await sleep(100);
  const dec = fx._stats().providers[0].provide({ id: 3 });
  assert.ok(dec);
  assert.equal(dec.badge, '✗', 'stale running must not overwrite failed');
  handle.dispose();
});

test('running and skipped glyphs', async () => {
  const { fx } = createFakeEngine(sampleRows());
  const client = createMapTestStatusClient({
    initial: [
      { path: 'src/a.test.ts', status: 'running' },
      { path: 'src/b.test.ts', status: 'skipped' },
    ],
  });
  const handle = registerTestStatusDecorations({
    fx,
    client,
    rootPath: '/ROOT',
    propagateToParent: false,
  });
  await handle.refresh();
  const provider = fx._stats().providers[0];
  assert.equal(provider.provide({ id: 3 }).badge, '…');
  assert.equal(provider.provide({ id: 4 }).badge, '○');
  handle.dispose();
});

test('client mutation updates decorations', async () => {
  const { fx } = createFakeEngine(sampleRows());
  const client = createMapTestStatusClient({
    initial: [{ path: 'src/a.test.ts', status: 'running' }],
  });
  const handle = registerTestStatusDecorations({
    fx,
    client,
    rootPath: '/ROOT',
    propagateToParent: false,
    batchOptions: { debounceMs: 10, maxWaitMs: 50 },
  });
  await handle.refresh();
  const provider = fx._stats().providers[0];
  assert.equal(provider.provide({ id: 3 }).badge, '…');
  client.set('src/a.test.ts', {
    path: 'src/a.test.ts',
    status: 'failed',
  });
  await waitFor(() => provider.provide({ id: 3 })?.badge === '✗');
  handle.dispose();
});

test('unchanged refresh does not notify', async () => {
  const { fx } = createFakeEngine(sampleRows());
  const client = createMapTestStatusClient({
    initial: [{ path: 'src/a.test.ts', status: 'failed' }],
  });
  const handle = registerTestStatusDecorations({
    fx,
    client,
    rootPath: '/ROOT',
    propagateToParent: false,
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

test('unsafe paths ignored; resolvePath fallback works', async () => {
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
  const client = createMapTestStatusClient({
    initial: [
      { path: '../evil.test.ts', status: 'failed' },
      { path: 'src/a.test.ts', status: 'failed' },
    ],
  });
  const handle = registerTestStatusDecorations({
    fx,
    client,
    rootPath: '/ROOT',
    propagateToParent: false,
  });
  await handle.refresh();
  assert.equal(providers[0].provide({ id: 3 }).badge, '✗');
  handle.dispose();
});

test('background error via onError; refresh still rejects', async () => {
  const { fx } = createFakeEngine(sampleRows());
  const errors = [];
  const client = {
    getResults() {
      throw new Error('runner down');
    },
    onChange() {
      return () => {};
    },
  };
  const handle = registerTestStatusDecorations({
    fx,
    client,
    rootPath: '/ROOT',
    onError: (e) => errors.push(e),
  });
  await sleep(30);
  assert.ok(errors.length >= 1);
  await assert.rejects(() => handle.refresh(), /runner down/);
  handle.dispose();
});

test('dispose unregisters provider', async () => {
  const { fx } = createFakeEngine(sampleRows());
  const client = createMapTestStatusClient();
  const handle = registerTestStatusDecorations({
    fx,
    client,
    rootPath: '/ROOT',
  });
  await handle.refresh();
  handle.dispose();
  assert.equal(fx._stats().disposedCount, 1);
});
