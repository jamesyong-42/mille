import { performance } from 'node:perf_hooks';
import { strict as assert } from 'node:assert';

import { createMirror } from '../dist/mirror.js';
import { ClientMirrorSnapshot } from '../dist/mirror-snapshot.js';

const childCount = Number(process.env.MILLE_VISIBILITY_ENTRIES ?? 100_000);
const samples = Number(process.env.MILLE_VISIBILITY_SAMPLES ?? 30);
const budgetMs = Number(process.env.MILLE_VISIBILITY_P95_BUDGET_MS ?? 150);

const mirror = createMirror();
mirror.roots.push(1);
mirror.byId.set(1, {
  id: 1,
  parentId: null,
  name: 'root',
  kind: 1,
  size: 0,
  mtimeMs: 0,
  ctimeMs: 0,
  symlinkTargetIsDir: null,
  pathSegments: null,
  isIgnored: false,
  isReadonly: false,
  isHidden: false,
});
mirror.directChildCounts.set(1, childCount);

const children = new Array(childCount);
for (let i = 0; i < childCount; i++) {
  const id = i + 2;
  children[i] = id;
  mirror.byId.set(id, {
    id,
    parentId: 1,
    name: i % 97 === 0 ? `.hidden-${i}` : `file-${i}.txt`,
    kind: 0,
    size: i,
    mtimeMs: i,
    ctimeMs: i,
    symlinkTargetIsDir: null,
    pathSegments: null,
    isIgnored: i % 89 === 0,
    isReadonly: false,
    isHidden: i % 97 === 0,
  });
}
mirror.children.set(1, children);
mirror.orderedChildren.add(1);
mirror.showHiddenFiles = false;
mirror.showIgnoredFiles = false;

const snapshot = new ClientMirrorSnapshot(mirror);
const expanded = new Set([1]);
const timings = [];
let expectedCount = 0;

for (let sample = 0; sample < samples + 5; sample++) {
  const start = performance.now();
  const count = snapshot.visibleRowCount(expanded).known;
  const rows = snapshot.visibleRowIds({ expanded, offset: 0, limit: count });
  const elapsed = performance.now() - start;
  assert.equal(rows.length, count);
  if (sample === 0) expectedCount = count;
  else assert.equal(count, expectedCount);
  if (sample >= 5) timings.push(elapsed);
}

timings.sort((a, b) => a - b);
const percentile = (p) => timings[Math.min(timings.length - 1, Math.floor(timings.length * p))];
const result = {
  entries: childCount + 1,
  visible: expectedCount,
  samples,
  medianMs: Number(percentile(0.5).toFixed(2)),
  p95Ms: Number(percentile(0.95).toFixed(2)),
  budgetMs,
};
console.log(JSON.stringify(result));
assert.ok(result.p95Ms <= budgetMs, `visibility projection p95 ${result.p95Ms}ms > ${budgetMs}ms`);
