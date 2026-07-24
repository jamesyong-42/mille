// Phase 5.4 — concurrent dispatchWithLifecycle microbench with budget gate.

import { performance } from 'node:perf_hooks';

const {
  createCommandRegistry,
  dispatchWithLifecycle,
  buildCommandContext,
} = await import('../dist/commands.js');

function fakeCtx() {
  return buildCommandContext({
    fx: {},
    snapshot: { getById: () => null },
    focusedId: null,
    focusedEntry: null,
    selectedIds: new Set(),
    selectedEntries: [],
    isMultiSelect: false,
    isRenaming: false,
    host: {},
    cutIds: new Set(),
    copyIds: new Set(),
  });
}

const CONCURRENCY = 50;
const ROUNDS = 20;
const WARMUP = 2;
const BUDGET_PER_DISPATCH_US = 200; // generous CI ceiling

const registry = createCommandRegistry([
  {
    id: 'bench.work',
    label: 'Work',
    async run(ctx) {
      ctx.reportProgress?.({ phase: 'running', fraction: 0.5 });
      await Promise.resolve();
    },
  },
]);
registry.setContextProvider(() => fakeCtx());

async function runRound() {
  const jobs = [];
  for (let i = 0; i < CONCURRENCY; i += 1) {
    const ac = new AbortController();
    jobs.push(
      dispatchWithLifecycle(registry, 'bench.work', {
        signal: ac.signal,
        context: fakeCtx(),
      }),
    );
  }
  await Promise.all(jobs);
}

for (let w = 0; w < WARMUP; w += 1) await runRound();

const t0 = performance.now();
for (let r = 0; r < ROUNDS; r += 1) await runRound();
const t1 = performance.now();
const total = CONCURRENCY * ROUNDS;
const perDispatchUs = ((t1 - t0) * 1000) / total;
const result = {
  dispatches: total,
  totalMs: +(t1 - t0).toFixed(2),
  perDispatchUs: +perDispatchUs.toFixed(2),
  budgetUs: BUDGET_PER_DISPATCH_US,
};
console.log(JSON.stringify(result));
if (perDispatchUs > BUDGET_PER_DISPATCH_US) {
  console.error(
    `BUDGET FAIL: perDispatchUs ${perDispatchUs.toFixed(2)} > ${BUDGET_PER_DISPATCH_US}`,
  );
  process.exitCode = 1;
}
