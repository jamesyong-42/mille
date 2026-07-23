import { performance } from 'node:perf_hooks';

import {
  FILE_TREE_NAVIGATION_LIMITS,
  captureFileTreeNavigationState,
  parseFileTreeNavigationState,
  serializeFileTreeNavigationState,
} from '../dist/index.js';

const entries = new Map();
const expandedIds = new Set();
const selectedIds = new Set();
let nextId = 1;
entries.set(nextId, { id: nextId, parentId: null, name: 'workspace' });
expandedIds.add(nextId);
const rootId = nextId++;

for (let group = 0; group < 64; group += 1) {
  const groupId = nextId++;
  entries.set(groupId, {
    id: groupId,
    parentId: rootId,
    name: `group-${group.toString().padStart(2, '0')}`,
  });
  expandedIds.add(groupId);
  for (let child = 0; child < 64; child += 1) {
    const id = nextId++;
    entries.set(id, {
      id,
      parentId: groupId,
      name: `folder-${child.toString().padStart(2, '0')}`,
    });
    expandedIds.add(id);
    if (id >= nextId - 1_024) selectedIds.add(id);
  }
}

// Select the final 1,024 entries deterministically.
selectedIds.clear();
for (let id = nextId - 1_024; id < nextId; id += 1) selectedIds.add(id);

const snapshot = {
  getById(id) {
    const value = entries.get(id);
    if (!value) return null;
    return {
      ...value,
      kind: 1,
      size: 0,
      mtimeMs: 0,
      ctimeMs: 0,
      isIgnored: false,
      isReadonly: false,
      isHidden: false,
    };
  },
};

function percentile(samples, value) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * value))];
}

function measure(iterations, operation) {
  const samples = [];
  let result;
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    result = operation();
    samples.push(performance.now() - started);
  }
  return { result, p50: percentile(samples, 0.5), p95: percentile(samples, 0.95) };
}

const captureInput = {
  snapshot,
  expandedIds,
  selectedIds,
  focusedId: nextId - 1,
  filter: 'folder',
  searchMode: 'filter',
  scrollAnchor: { id: nextId - 1, offsetPx: 11 },
};

for (let index = 0; index < 10; index += 1) {
  const warm = captureFileTreeNavigationState(captureInput);
  parseFileTreeNavigationState(serializeFileTreeNavigationState(warm));
}

const capture = measure(50, () => captureFileTreeNavigationState(captureInput));
const state = capture.result;
const encode = measure(100, () => serializeFileTreeNavigationState(state));
const encoded = encode.result;
const decode = measure(100, () => parseFileTreeNavigationState(encoded));
const decoded = decode.result;
const bytes = Buffer.byteLength(encoded);

if (state.expandedPaths.length !== FILE_TREE_NAVIGATION_LIMITS.expandedPaths) {
  throw new Error(`expanded-state bound regressed: ${state.expandedPaths.length}`);
}
if (state.selectedPaths.length !== FILE_TREE_NAVIGATION_LIMITS.selectedPaths) {
  throw new Error(`selection-state bound regressed: ${state.selectedPaths.length}`);
}
if (!decoded || decoded.focusedPath !== state.focusedPath) {
  throw new Error('navigation-state round trip failed');
}

const budgets = { captureP95: 50, encodeP95: 20, decodeP95: 30, bytes: 500_000 };
if (
  capture.p95 > budgets.captureP95 ||
  encode.p95 > budgets.encodeP95 ||
  decode.p95 > budgets.decodeP95 ||
  bytes > budgets.bytes
) {
  throw new Error(
    `navigation-state budget exceeded: capture=${capture.p95.toFixed(2)}ms ` +
      `encode=${encode.p95.toFixed(2)}ms decode=${decode.p95.toFixed(2)}ms bytes=${bytes}`,
  );
}

console.log('| operation | p50 | p95 |');
console.log('|---|---:|---:|');
console.log(`| capture 4,096 expanded + 1,024 selected | ${capture.p50.toFixed(2)} ms | ${capture.p95.toFixed(2)} ms |`);
console.log(`| serialize ${bytes.toLocaleString()} bytes | ${encode.p50.toFixed(2)} ms | ${encode.p95.toFixed(2)} ms |`);
console.log(`| parse + validate | ${decode.p50.toFixed(2)} ms | ${decode.p95.toFixed(2)} ms |`);
console.log(
  `bounded paths: expanded=${state.expandedPaths.length}, selected=${state.selectedPaths.length}`,
);

