// Phase 5.1 — editor-state decoration update-cost harness.
//
// Usage:
//   node bench/editor-state-update.mjs
//   PATHS=500 LOOKUP_MS=1 CONCURRENCY=16 node bench/editor-state-update.mjs

import { performance } from 'node:perf_hooks';

const { registerEditorStateDecorations, createMapEditorStateClient } =
  await import('../dist/editor-state.js');

const PATHS = Number(process.env.PATHS ?? 200);
const LOOKUP_MS = Number(process.env.LOOKUP_MS ?? 2);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 16);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function buildRows(n) {
  const rows = [{ id: 1, parentId: null, path: '', kind: 1 }];
  for (let i = 0; i < n; i += 1) {
    rows.push({ id: i + 2, parentId: 1, path: `f${i}.ts`, kind: 0 });
  }
  return rows;
}

function createFx(rows) {
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
  return {
    getSnapshot: () => ({ getById: (id) => byId.get(id) ?? null }),
    getByUri: async (uri) => {
      await sleep(LOOKUP_MS);
      const rel = uri.path.replace(/^\/ROOT\/?/, '');
      return byPath.get(rel) ?? null;
    },
    registerDecorationProvider: () => ({ dispose() {} }),
  };
}

const rows = buildRows(PATHS);
const fx = createFx(rows);
const open = [];
for (let i = 0; i < PATHS; i += 1) {
  open.push({
    path: `f${i}.ts`,
    dirty: i % 3 === 0,
    active: i === 0,
  });
}
const client = createMapEditorStateClient({
  initial: { open, activePath: 'f0.ts' },
});

const handle = registerEditorStateDecorations({
  fx,
  client,
  rootPath: '/ROOT',
  resolveConcurrency: CONCURRENCY,
  decorateOpen: true,
});

await sleep(LOOKUP_MS * 2 + 50);
await handle.refresh();

const t0 = performance.now();
await handle.refresh();
const elapsed = performance.now() - t0;
const sequentialMs = PATHS * LOOKUP_MS;
const speedup = sequentialMs / Math.max(elapsed, 0.001);

console.log(
  JSON.stringify(
    {
      provider: 'editor-state',
      paths: PATHS,
      lookupMs: LOOKUP_MS,
      concurrency: CONCURRENCY,
      refreshMs: Number(elapsed.toFixed(2)),
      sequentialLowerBoundMs: sequentialMs,
      speedup: Number(speedup.toFixed(2)),
    },
    null,
    2,
  ),
);

if (elapsed > sequentialMs * 0.6) {
  console.error(
    `FAIL: refresh ${elapsed.toFixed(1)}ms is too close to sequential ${sequentialMs}ms`,
  );
  process.exitCode = 1;
} else {
  console.error(
    `OK: refresh ${elapsed.toFixed(1)}ms vs sequential ${sequentialMs}ms (${speedup.toFixed(1)}×)`,
  );
}

handle.dispose();
