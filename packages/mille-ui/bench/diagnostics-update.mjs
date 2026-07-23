// Phase 5.1 — diagnostics decoration update-cost harness.
//
// Measures registerDiagnosticsDecorations refresh cost with N leaf paths
// and simulated resolve latency. Guards against unbounded sequential
// resolution regressions.
//
// Usage:
//   node bench/diagnostics-update.mjs
//   PATHS=500 LOOKUP_MS=1 CONCURRENCY=16 node bench/diagnostics-update.mjs

import { performance } from 'node:perf_hooks';

const { registerDiagnosticsDecorations, mapPool } = await import(
  '../dist/diagnostics.js'
);

const PATHS = Number(process.env.PATHS ?? 200);
const LOOKUP_MS = Number(process.env.LOOKUP_MS ?? 2);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 16);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function buildRows(n) {
  const rows = [{ id: 1, parentId: null, path: '', kind: 1 }];
  for (let i = 0; i < n; i += 1) {
    rows.push({
      id: i + 2,
      parentId: 1,
      path: `f${i}.ts`,
      kind: 0,
    });
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
const diags = new Map();
for (let i = 0; i < PATHS; i += 1) {
  diags.set(`f${i}.ts`, [
    { path: `f${i}.ts`, severity: i % 5 === 0 ? 'error' : 'warning' },
  ]);
}

const client = {
  async getDiagnostics() {
    return diags;
  },
  onChange() {
    return () => {};
  },
};

const handle = registerDiagnosticsDecorations({
  fx,
  client,
  rootPath: '/ROOT',
  propagateToParent: true,
  resolveConcurrency: CONCURRENCY,
});

// Warm-up initial fire-and-forget.
await sleep(LOOKUP_MS * 2 + 50);
await handle.refresh(); // ensure ready

const t0 = performance.now();
await handle.refresh();
const elapsed = performance.now() - t0;

// Sequential lower bound would be PATHS * LOOKUP_MS.
const sequentialMs = PATHS * LOOKUP_MS;
const speedup = sequentialMs / Math.max(elapsed, 0.001);

console.log(
  JSON.stringify(
    {
      paths: PATHS,
      lookupMs: LOOKUP_MS,
      concurrency: CONCURRENCY,
      refreshMs: Number(elapsed.toFixed(2)),
      sequentialLowerBoundMs: sequentialMs,
      speedup: Number(speedup.toFixed(2)),
      mapPoolSelfCheck: await (async () => {
        const t = performance.now();
        await mapPool(
          Array.from({ length: 32 }, (_, i) => i),
          8,
          async () => {
            await sleep(5);
          },
        );
        return Number((performance.now() - t).toFixed(2));
      })(),
    },
    null,
    2,
  ),
);

// Soft budget: with concurrency 16 and 2ms lookup, 200 paths should finish
// well under sequential 400ms — target under 80ms wall on a healthy machine.
if (elapsed > sequentialMs * 0.6) {
  console.error(
    `FAIL: refresh ${elapsed.toFixed(1)}ms is too close to sequential ${sequentialMs}ms (concurrency not effective)`,
  );
  process.exitCode = 1;
} else {
  console.error(
    `OK: refresh ${elapsed.toFixed(1)}ms vs sequential ${sequentialMs}ms (${speedup.toFixed(1)}×)`,
  );
}

handle.dispose();
