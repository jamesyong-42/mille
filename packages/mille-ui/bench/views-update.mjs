// Phase 5.2 — explorer view resolve + materialize update-cost harness.
//
// Usage:
//   node bench/views-update.mjs
//   PATHS=500 LOOKUP_MS=1 CONCURRENCY=16 node bench/views-update.mjs

import { performance } from 'node:perf_hooks';

const {
  projectOpenFilesView,
  projectProblemsView,
  resolveExplorerView,
} = await import('../dist/views.js');

const PATHS = Number(process.env.PATHS ?? 200);
const LOOKUP_MS = Number(process.env.LOOKUP_MS ?? 2);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 16);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function createFx(n) {
  const byId = new Map();
  const byPath = new Map();
  for (let i = 0; i < n; i += 1) {
    const path = `f${i}.ts`;
    const entry = {
      id: i + 1,
      parentId: null,
      name: path,
      kind: 0,
    };
    byId.set(entry.id, entry);
    byPath.set(path, entry);
  }
  return {
    getSnapshot: () => ({ getById: (id) => byId.get(id) ?? null }),
    getByUri: async (uri) => {
      await sleep(LOOKUP_MS);
      const rel = uri.path.replace(/^\/ROOT\/?/, '');
      return byPath.get(rel) ?? null;
    },
  };
}

const fx = createFx(PATHS);
const open = [];
for (let i = 0; i < PATHS; i += 1) {
  open.push({
    path: `f${i}.ts`,
    entryId: i + 1,
    rootPath: '/ROOT',
    dirty: i % 4 === 0,
    active: i === 0,
  });
}
const definition = projectOpenFilesView({ open, activePath: 'f0.ts' });

// Warm id-path (should be fast — prefers seed.id snapshot lookup).
await resolveExplorerView({
  fx,
  rootPath: '/ROOT',
  definition,
  resolveConcurrency: CONCURRENCY,
});

const t0 = performance.now();
const model = await resolveExplorerView({
  fx,
  rootPath: '/ROOT',
  definition,
  resolveConcurrency: CONCURRENCY,
});
const elapsedId = performance.now() - t0;

// Path-only resolve (no ids) — concurrent getByUri cost.
const openNoId = open.map(({ path, dirty, active }) => ({ path, dirty, active }));
const defPath = projectOpenFilesView({ open: openNoId });
const t1 = performance.now();
await resolveExplorerView({
  fx,
  rootPath: '/ROOT',
  definition: defPath,
  resolveConcurrency: CONCURRENCY,
});
const elapsedPath = performance.now() - t1;

const sequentialMs = PATHS * LOOKUP_MS;

console.log(
  JSON.stringify(
    {
      provider: 'views',
      paths: PATHS,
      lookupMs: LOOKUP_MS,
      concurrency: CONCURRENCY,
      resolveWithIdMs: Number(elapsedId.toFixed(2)),
      resolvePathOnlyMs: Number(elapsedPath.toFixed(2)),
      sequentialLowerBoundMs: sequentialMs,
      pathSpeedup: Number((sequentialMs / Math.max(elapsedPath, 0.001)).toFixed(2)),
      itemCount: model.items.length,
    },
    null,
    2,
  ),
);

if (elapsedPath > sequentialMs * 0.6) {
  console.error(
    `FAIL: path resolve ${elapsedPath.toFixed(1)}ms too close to sequential ${sequentialMs}ms`,
  );
  process.exitCode = 1;
} else {
  console.error(
    `OK: id-path ${elapsedId.toFixed(1)}ms, path-only ${elapsedPath.toFixed(1)}ms vs sequential ${sequentialMs}ms`,
  );
}

// Also time problems projector+resolve
const diags = new Map();
for (let i = 0; i < PATHS; i += 1) {
  diags.set(`f${i}.ts`, [
    { path: `f${i}.ts`, severity: i % 5 === 0 ? 'error' : 'warning' },
  ]);
}
const t2 = performance.now();
await resolveExplorerView({
  fx,
  rootPath: '/ROOT',
  definition: projectProblemsView(diags),
  resolveConcurrency: CONCURRENCY,
});
const problemsMs = performance.now() - t2;
console.error(`OK: problems resolve ${problemsMs.toFixed(1)}ms`);
