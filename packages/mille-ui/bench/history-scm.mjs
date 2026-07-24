// Phase 5.3 — multi-root SCM target grouping + path checks with budget gate.

import { performance } from 'node:perf_hooks';

const { selectedScmTargets, groupScmTargetsByRoot } =
  await import('../dist/history.js');
const { assertPathUnderRoot } = await import('../dist/git-node.js');

const N = 2_000;
const BUDGET = {
  groupMs: 40,
  pathCheckMs: 80,
};

const byId = new Map();
byId.set(1, { id: 1, name: 'rootA', kind: 1, parentId: null });
byId.set(2, { id: 2, name: 'rootB', kind: 1, parentId: null });
const selected = new Set();
for (let i = 0; i < N; i += 1) {
  const rootId = i % 2 === 0 ? 1 : 2;
  const id = 100 + i;
  byId.set(id, {
    id,
    name: `file-${Math.floor(i / 2)}.ts`,
    kind: 0,
    parentId: rootId,
  });
  selected.add(id);
}

const ctx = {
  fx: {},
  snapshot: { getById: (id) => byId.get(id) ?? null },
  focusedId: 100,
  focusedEntry: byId.get(100),
  selectedIds: selected,
  selectedEntries: [],
  isMultiSelect: true,
  isRenaming: false,
  host: {
    resolveRootPath: (rootId) =>
      rootId === 1 ? '/abs/a' : rootId === 2 ? '/abs/b' : undefined,
  },
  cutIds: new Set(),
  copyIds: new Set(),
};

// Warmup
selectedScmTargets(ctx);
groupScmTargetsByRoot(selectedScmTargets(ctx));

const t0 = performance.now();
const targets = selectedScmTargets(ctx);
const groups = groupScmTargetsByRoot(targets);
const t1 = performance.now();

let safe = 0;
const t2 = performance.now();
for (let i = 0; i < N; i += 1) {
  try {
    assertPathUnderRoot('/ws', `src/f${i}.ts`);
    safe += 1;
  } catch {
    /* ignore */
  }
  try {
    assertPathUnderRoot('/ws', `../escape${i}`);
  } catch {
    /* expected */
  }
}
const t3 = performance.now();

const result = {
  targets: targets.length,
  roots: groups.size,
  groupMs: +(t1 - t0).toFixed(2),
  pathCheckMs: +(t3 - t2).toFixed(2),
  safeChecks: safe,
};
console.log(JSON.stringify(result));

const failures = [];
if (result.groupMs > BUDGET.groupMs) {
  failures.push(`groupMs ${result.groupMs} > ${BUDGET.groupMs}`);
}
if (result.pathCheckMs > BUDGET.pathCheckMs) {
  failures.push(`pathCheckMs ${result.pathCheckMs} > ${BUDGET.pathCheckMs}`);
}
if (result.roots !== 2) failures.push(`roots ${result.roots} !== 2`);
if (failures.length) {
  console.error('BUDGET FAIL:', failures.join('; '));
  process.exitCode = 1;
}
