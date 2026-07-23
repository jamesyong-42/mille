// Phase 5.1 — integration tests for the diagnostics decoration companion.
//
// Coverage:
//   1. registerDiagnosticsDecorations returns a disposable handle.
//   2. After initial fetch, leaf decorations land with count badge + severity color.
//   3. Severity precedence: error > warning > info > hint.
//   4. Ancestor aggregates sum counts and use muted colors.
//   5. propagateToParent: false → only leaves decorated.
//   6. client.onChange triggers a recompute.
//   7. Batcher coalesces rapid onChange calls.
//   8. dispose() unregisters and stops calling client.onChange.
//   9. refresh() forces immediate re-fetch.
//  10. Pure helpers: formatDiagnosticBadge, formatDiagnosticTooltip, counts.
//  11. Badge cap renders "99+".
//  12. Single-diag leaf tooltip includes message.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const {
  registerDiagnosticsDecorations,
  formatDiagnosticBadge,
  formatDiagnosticTooltip,
  countDiagnostics,
  maxSeverityFromCounts,
  totalDiagnosticCount,
  addCounts,
  ZERO_COUNTS,
  DIAGNOSTIC_SEVERITY_RANK,
} = await import('../dist/diagnostics.js');

// ─── Fake engine / snapshot ───────────────────────────────────────────

function createFakeEngineForDiagnostics(rows) {
  const byId = new Map();
  const byPath = new Map();
  for (const r of rows) {
    const entry = {
      id: r.id,
      parentId: r.parentId,
      name: r.path.split('/').pop() ?? '',
      kind: r.kind ?? 0,
      size: 0,
      mtimeMs: 0,
      ctimeMs: 0,
      isIgnored: false,
      isReadonly: false,
      isHidden: false,
    };
    byId.set(r.id, entry);
    byPath.set(r.path, entry);
  }
  const snapshot = {
    getById: (id) => byId.get(id) ?? null,
  };
  const registeredProviders = [];
  let registeredCount = 0;
  let disposedCount = 0;
  const fx = {
    getSnapshot: () => snapshot,
    getByUri: (uri) => {
      const rel = uri.path.replace(/^\/ROOT\/?/, '');
      return byPath.get(rel) ?? null;
    },
    registerDecorationProvider: (provider) => {
      registeredProviders.push(provider);
      registeredCount += 1;
      return {
        dispose: () => {
          disposedCount += 1;
        },
      };
    },
    _stats: () => ({
      registeredCount,
      disposedCount,
      providers: registeredProviders,
    }),
  };
  return { fx, snapshot, byId };
}

// ─── Fake DiagnosticsClient ───────────────────────────────────────────

function createFakeDiagnosticsClient(initialEntries = []) {
  let status = toMap(initialEntries);
  const listeners = new Set();
  let getDiagnosticsCalls = 0;

  function toMap(entries) {
    // entries: Array<{ path, diagnostics: Diagnostic[] }>
    // or Array<Diagnostic> grouped by path
    const m = new Map();
    if (entries.length === 0) return m;
    // Support both shapes:
    // 1. [{ path, severity, message? }, ...]  — flat diags
    // 2. [{ path, diagnostics: [...] }, ...]  — grouped
    if (entries[0] && Array.isArray(entries[0].diagnostics)) {
      for (const e of entries) m.set(e.path, e.diagnostics);
    } else {
      for (const d of entries) {
        const list = m.get(d.path) ?? [];
        list.push(d);
        m.set(d.path, list);
      }
    }
    return m;
  }

  return {
    async getDiagnostics(_root) {
      getDiagnosticsCalls += 1;
      const copy = new Map();
      for (const [k, v] of status) copy.set(k, [...v]);
      return copy;
    },
    onChange(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    setDiagnostics(entries) {
      status = toMap(entries);
    },
    fire() {
      for (const l of [...listeners]) l();
    },
    get listenerCount() {
      return listeners.size;
    },
    get getDiagnosticsCalls() {
      return getDiagnosticsCalls;
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, { timeoutMs = 500, stepMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(stepMs);
  }
  assert.fail(`waitFor timed out after ${timeoutMs}ms`);
}

//   id=1 /            (root)
//   id=2 /src         (folder)
//   id=3 /src/a.ts    (file)
//   id=4 /src/b.ts    (file)
//   id=5 /README.md   (file)
function sampleRows() {
  return [
    { id: 1, parentId: null, path: '', kind: 1 },
    { id: 2, parentId: 1, path: 'src', kind: 1 },
    { id: 3, parentId: 2, path: 'src/a.ts', kind: 0 },
    { id: 4, parentId: 2, path: 'src/b.ts', kind: 0 },
    { id: 5, parentId: 1, path: 'README.md', kind: 0 },
  ];
}

// ─── Test 1: disposable handle ────────────────────────────────────────

test('registerDiagnosticsDecorations returns a disposable handle', async () => {
  const { fx } = createFakeEngineForDiagnostics(sampleRows());
  const client = createFakeDiagnosticsClient([]);
  const handle = registerDiagnosticsDecorations({
    fx,
    client,
    rootPath: '/ROOT',
  });
  assert.equal(typeof handle.dispose, 'function');
  assert.equal(typeof handle.refresh, 'function');
  handle.dispose();
  handle.dispose(); // second dispose is a no-op
});

// ─── Test 2: initial fetch → leaf decorations ─────────────────────────

test('after initial fetch, leaf decorations appear with count badge', async () => {
  const { fx } = createFakeEngineForDiagnostics(sampleRows());
  const client = createFakeDiagnosticsClient([
    { path: 'src/a.ts', severity: 'error', message: 'Type error' },
    { path: 'src/a.ts', severity: 'warning', message: 'Unused' },
    { path: 'README.md', severity: 'info', message: 'TODO' },
  ]);
  const handle = registerDiagnosticsDecorations({
    fx,
    client,
    rootPath: '/ROOT',
    propagateToParent: false,
  });

  await waitFor(() => client.getDiagnosticsCalls >= 1);
  await nextTick();
  await nextTick();

  const { providers } = fx._stats();
  assert.equal(providers.length, 1);
  const provider = providers[0];
  assert.equal(provider.id, 'diagnostics');

  const decA = provider.provide({ id: 3 });
  assert.ok(decA, 'src/a.ts must be decorated');
  assert.equal(decA.badge, '2');
  assert.ok(typeof decA.color === 'string');
  assert.ok(
    decA.tooltip.includes('error') && decA.tooltip.includes('warning'),
    `tooltip should summarize severities; got ${decA.tooltip}`,
  );

  const decReadme = provider.provide({ id: 5 });
  assert.ok(decReadme);
  assert.equal(decReadme.badge, '1');

  assert.equal(provider.provide({ id: 4 }), null, 'src/b.ts is clean');
  assert.equal(provider.provide({ id: 2 }), null, 'folder not propagated');

  handle.dispose();
});

// ─── Test 3: severity precedence ──────────────────────────────────────

test('max severity wins for leaf color (error > warning > info > hint)', async () => {
  const { fx } = createFakeEngineForDiagnostics(sampleRows());
  const client = createFakeDiagnosticsClient([
    { path: 'src/a.ts', severity: 'hint' },
    { path: 'src/a.ts', severity: 'info' },
    { path: 'src/a.ts', severity: 'warning' },
    { path: 'src/a.ts', severity: 'error' },
    { path: 'src/b.ts', severity: 'hint' },
    { path: 'src/b.ts', severity: 'info' },
  ]);
  const handle = registerDiagnosticsDecorations({
    fx,
    client,
    rootPath: '/ROOT',
    propagateToParent: false,
  });

  await waitFor(() => client.getDiagnosticsCalls >= 1);
  await nextTick();
  await nextTick();

  const { providers } = fx._stats();
  const provider = providers[0];

  const decA = provider.provide({ id: 3 });
  const decB = provider.provide({ id: 4 });
  assert.ok(decA && decB);
  assert.equal(decA.badge, '4');
  assert.equal(decB.badge, '2');
  // Error palette vs info palette must differ.
  assert.notEqual(decA.color, decB.color);
  // Error color uses the error token.
  assert.ok(
    String(decA.color).includes('error') || String(decA.color).includes('f85149'),
    `expected error color, got ${decA.color}`,
  );
  assert.ok(
    String(decB.color).includes('info') || String(decB.color).includes('58a6ff'),
    `expected info color, got ${decB.color}`,
  );

  handle.dispose();
});

// ─── Test 4: ancestor aggregates ──────────────────────────────────────

test('propagateToParent: true → ancestors get aggregate counts', async () => {
  const { fx } = createFakeEngineForDiagnostics(sampleRows());
  const client = createFakeDiagnosticsClient([
    { path: 'src/a.ts', severity: 'error' },
    { path: 'src/a.ts', severity: 'warning' },
    { path: 'src/b.ts', severity: 'warning' },
  ]);
  const handle = registerDiagnosticsDecorations({
    fx,
    client,
    rootPath: '/ROOT',
    propagateToParent: true,
  });

  await waitFor(() => client.getDiagnosticsCalls >= 1);
  await nextTick();
  await nextTick();

  const { providers } = fx._stats();
  const provider = providers[0];

  const leafA = provider.provide({ id: 3 });
  assert.ok(leafA);
  assert.equal(leafA.badge, '2');

  const leafB = provider.provide({ id: 4 });
  assert.ok(leafB);
  assert.equal(leafB.badge, '1');

  // src folder: 2 + 1 = 3 problems
  const folder = provider.provide({ id: 2 });
  assert.ok(folder, 'src folder must aggregate descendants');
  assert.equal(folder.badge, '3');
  assert.ok(
    folder.tooltip.includes('error') && folder.tooltip.includes('warning'),
  );

  // root: same total (README clean)
  const root = provider.provide({ id: 1 });
  assert.ok(root);
  assert.equal(root.badge, '3');

  // Ancestor uses muted color (distinct from leaf error color).
  assert.notEqual(leafA.color, folder.color);

  handle.dispose();
});

// ─── Test 5: no propagation ───────────────────────────────────────────

test('propagateToParent: false → only leaves decorated', async () => {
  const { fx } = createFakeEngineForDiagnostics(sampleRows());
  const client = createFakeDiagnosticsClient([
    { path: 'src/a.ts', severity: 'error' },
  ]);
  const handle = registerDiagnosticsDecorations({
    fx,
    client,
    rootPath: '/ROOT',
    propagateToParent: false,
  });

  await waitFor(() => client.getDiagnosticsCalls >= 1);
  await nextTick();
  await nextTick();

  const { providers } = fx._stats();
  const provider = providers[0];

  assert.ok(provider.provide({ id: 3 }));
  assert.equal(provider.provide({ id: 2 }), null);
  assert.equal(provider.provide({ id: 1 }), null);

  handle.dispose();
});

// ─── Test 6: onChange recompute ───────────────────────────────────────

test('client.onChange triggers a recompute', async () => {
  const { fx } = createFakeEngineForDiagnostics(sampleRows());
  const client = createFakeDiagnosticsClient([
    { path: 'src/a.ts', severity: 'error' },
  ]);
  const handle = registerDiagnosticsDecorations({
    fx,
    client,
    rootPath: '/ROOT',
    propagateToParent: false,
    batchOptions: { debounceMs: 10, maxWaitMs: 100 },
  });

  await waitFor(() => client.getDiagnosticsCalls >= 1);
  const initialCalls = client.getDiagnosticsCalls;

  client.setDiagnostics([
    { path: 'src/a.ts', severity: 'error' },
    { path: 'src/b.ts', severity: 'warning' },
  ]);
  client.fire();

  await waitFor(
    () => client.getDiagnosticsCalls > initialCalls,
    { timeoutMs: 200 },
  );
  await nextTick();

  const { providers } = fx._stats();
  const provider = providers[0];
  const decB = provider.provide({ id: 4 });
  assert.ok(decB, 'src/b.ts must now be decorated');
  assert.equal(decB.badge, '1');

  handle.dispose();
});

// ─── Test 7: batcher coalescing ───────────────────────────────────────

test('batcher coalesces 3 rapid onChange calls into 1 recompute', async () => {
  const { fx } = createFakeEngineForDiagnostics(sampleRows());
  const client = createFakeDiagnosticsClient([
    { path: 'src/a.ts', severity: 'error' },
  ]);
  const handle = registerDiagnosticsDecorations({
    fx,
    client,
    rootPath: '/ROOT',
    propagateToParent: false,
    batchOptions: { debounceMs: 50, maxWaitMs: 500 },
  });

  await waitFor(() => client.getDiagnosticsCalls >= 1);
  for (let i = 0; i < 5; i += 1) await nextTick();
  await sleep(20);

  const baseline = client.getDiagnosticsCalls;

  let didChangeCount = 0;
  const { providers } = fx._stats();
  const provider = providers[0];
  const sub = provider.onDidChange(() => {
    didChangeCount += 1;
  });

  client.fire();
  await sleep(5);
  client.fire();
  await sleep(5);
  client.fire();

  await sleep(80);
  await nextTick();
  await nextTick();

  assert.equal(
    client.getDiagnosticsCalls,
    baseline + 1,
    `3 fires must yield 1 getDiagnostics; got ${client.getDiagnosticsCalls - baseline}`,
  );
  assert.equal(
    didChangeCount,
    1,
    `3 fires must yield 1 onDidChange; got ${didChangeCount}`,
  );

  sub.dispose();
  handle.dispose();
});

// ─── Test 8: dispose ──────────────────────────────────────────────────

test('dispose() unregisters provider and unsubscribes from client', async () => {
  const { fx } = createFakeEngineForDiagnostics(sampleRows());
  const client = createFakeDiagnosticsClient([
    { path: 'src/a.ts', severity: 'error' },
  ]);
  const handle = registerDiagnosticsDecorations({
    fx,
    client,
    rootPath: '/ROOT',
    propagateToParent: false,
    batchOptions: { debounceMs: 10, maxWaitMs: 100 },
  });

  await waitFor(() => client.getDiagnosticsCalls >= 1);
  assert.equal(client.listenerCount, 1);

  handle.dispose();

  assert.equal(client.listenerCount, 0);
  const { disposedCount } = fx._stats();
  assert.equal(disposedCount, 1);

  const callsBefore = client.getDiagnosticsCalls;
  client.fire();
  await sleep(50);
  assert.equal(client.getDiagnosticsCalls, callsBefore);
});

// ─── Test 9: refresh ──────────────────────────────────────────────────

test('refresh() forces immediate re-fetch and awaits completion', async () => {
  const { fx } = createFakeEngineForDiagnostics(sampleRows());
  const client = createFakeDiagnosticsClient([]);
  const handle = registerDiagnosticsDecorations({
    fx,
    client,
    rootPath: '/ROOT',
    propagateToParent: false,
    batchOptions: { debounceMs: 10_000, maxWaitMs: 20_000 },
  });

  await waitFor(() => client.getDiagnosticsCalls >= 1);
  const initial = client.getDiagnosticsCalls;

  client.setDiagnostics([
    { path: 'src/b.ts', severity: 'warning' },
  ]);

  await handle.refresh();

  assert.ok(client.getDiagnosticsCalls >= initial + 1);

  const { providers } = fx._stats();
  const provider = providers[0];
  const dec = provider.provide({ id: 4 });
  assert.ok(dec);
  assert.equal(dec.badge, '1');

  handle.dispose();
});

// ─── Test 10: pure helpers ────────────────────────────────────────────

test('pure helpers: badge, tooltip, counts, severity rank', () => {
  assert.equal(formatDiagnosticBadge(0), '');
  assert.equal(formatDiagnosticBadge(1), '1');
  assert.equal(formatDiagnosticBadge(42), '42');
  assert.equal(formatDiagnosticBadge(99), '99');
  assert.equal(formatDiagnosticBadge(100), '99+');
  assert.equal(formatDiagnosticBadge(150, 9), '9+');

  assert.equal(
    formatDiagnosticTooltip({ error: 2, warning: 1, info: 0, hint: 0 }),
    '2 errors, 1 warning',
  );
  assert.equal(
    formatDiagnosticTooltip({ error: 1, warning: 0, info: 0, hint: 0 }),
    '1 error',
  );
  assert.equal(
    formatDiagnosticTooltip({ error: 0, warning: 0, info: 3, hint: 1 }),
    '3 infos, 1 hint',
  );

  const counts = countDiagnostics([
    { path: 'a', severity: 'error' },
    { path: 'a', severity: 'error' },
    { path: 'a', severity: 'hint' },
  ]);
  assert.deepEqual(counts, { error: 2, warning: 0, info: 0, hint: 1 });
  assert.equal(maxSeverityFromCounts(counts), 'error');
  assert.equal(totalDiagnosticCount(counts), 3);
  assert.equal(maxSeverityFromCounts(ZERO_COUNTS), null);

  const summed = addCounts(counts, { error: 0, warning: 4, info: 0, hint: 0 });
  assert.deepEqual(summed, { error: 2, warning: 4, info: 0, hint: 1 });

  assert.ok(
    DIAGNOSTIC_SEVERITY_RANK.error >
      DIAGNOSTIC_SEVERITY_RANK.warning,
  );
  assert.ok(
    DIAGNOSTIC_SEVERITY_RANK.warning >
      DIAGNOSTIC_SEVERITY_RANK.info,
  );
  assert.ok(
    DIAGNOSTIC_SEVERITY_RANK.info > DIAGNOSTIC_SEVERITY_RANK.hint,
  );
});

// ─── Test 11: badge cap ───────────────────────────────────────────────

test('badgeCap renders capped numeral on leaf and ancestor', async () => {
  const { fx } = createFakeEngineForDiagnostics(sampleRows());
  // 12 diagnostics on one file with badgeCap=9 → "9+"
  const diags = Array.from({ length: 12 }, () => ({
    path: 'src/a.ts',
    severity: 'error',
  }));
  const client = createFakeDiagnosticsClient(diags);
  const handle = registerDiagnosticsDecorations({
    fx,
    client,
    rootPath: '/ROOT',
    propagateToParent: true,
    badgeCap: 9,
  });

  await waitFor(() => client.getDiagnosticsCalls >= 1);
  await nextTick();
  await nextTick();

  const { providers } = fx._stats();
  const provider = providers[0];

  assert.equal(provider.provide({ id: 3 }).badge, '9+');
  assert.equal(provider.provide({ id: 2 }).badge, '9+');

  handle.dispose();
});

// ─── Test 12: single-diag message in tooltip ──────────────────────────

test('single diagnostic leaf tooltip includes message', async () => {
  const { fx } = createFakeEngineForDiagnostics(sampleRows());
  const client = createFakeDiagnosticsClient([
    {
      path: 'src/a.ts',
      severity: 'error',
      message: "Cannot find name 'foo'",
      source: 'ts',
    },
  ]);
  const handle = registerDiagnosticsDecorations({
    fx,
    client,
    rootPath: '/ROOT',
    propagateToParent: false,
  });

  await waitFor(() => client.getDiagnosticsCalls >= 1);
  await nextTick();
  await nextTick();

  const { providers } = fx._stats();
  const provider = providers[0];
  const dec = provider.provide({ id: 3 });
  assert.ok(dec);
  assert.ok(
    dec.tooltip.includes("Cannot find name 'foo'"),
    `tooltip missing message: ${dec.tooltip}`,
  );
  assert.ok(
    dec.tooltip.includes('ts:'),
    `tooltip missing source: ${dec.tooltip}`,
  );

  handle.dispose();
});

// ─── Test 13: clearing diagnostics notifies previous ids ──────────────

test('clearing diagnostics removes badges and notifies previous ids', async () => {
  const { fx } = createFakeEngineForDiagnostics(sampleRows());
  const client = createFakeDiagnosticsClient([
    { path: 'src/a.ts', severity: 'error' },
  ]);
  const handle = registerDiagnosticsDecorations({
    fx,
    client,
    rootPath: '/ROOT',
    propagateToParent: false,
    batchOptions: { debounceMs: 10, maxWaitMs: 100 },
  });

  await waitFor(() => client.getDiagnosticsCalls >= 1);
  await nextTick();
  await nextTick();

  const { providers } = fx._stats();
  const provider = providers[0];
  assert.ok(provider.provide({ id: 3 }));

  const notified = [];
  provider.onDidChange((ids) => {
    notified.push([...ids]);
  });

  client.setDiagnostics([]);
  await handle.refresh();

  assert.equal(provider.provide({ id: 3 }), null, 'cleared leaf');
  assert.ok(
    notified.some((ids) => ids.includes(3)),
    'must notify previously decorated id so UI clears the badge',
  );

  handle.dispose();
});
