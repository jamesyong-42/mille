import { performance } from 'node:perf_hooks';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  NAVIGATION_STORE_MAX_WORKSPACES,
  createNavigationStateStore,
} from './navigation-state-store.mjs';

const expandedPaths = Array.from(
  { length: 4_096 },
  (_, index) => `workspace/group-${Math.floor(index / 64)}/folder-${index}`,
);
const selectedPaths = expandedPaths.slice(-1_024);
const state = JSON.stringify({
  version: 1,
  expandedPaths,
  selectedPaths,
  focusedPath: selectedPaths.at(-1),
  filter: 'folder',
  searchMode: 'filter',
  scrollAnchor: { path: selectedPaths.at(-1), offsetPx: 11 },
});

const dir = mkdtempSync(join(tmpdir(), 'mille-navigation-store-bench-'));
const filePath = join(dir, 'navigation.json');
let clock = 0;
const store = createNavigationStateStore({ filePath, now: () => ++clock });
const saves = [];
for (let index = 0; index < NAVIGATION_STORE_MAX_WORKSPACES; index += 1) {
  const started = performance.now();
  if (!store.set(`/workspace/${index}`, state)) {
    throw new Error(`failed to save benchmark workspace ${index}`);
  }
  saves.push(performance.now() - started);
}

const sorted = [...saves].sort((a, b) => a - b);
const p50 = sorted[Math.floor(sorted.length * 0.5)];
const p95 = sorted[Math.floor(sorted.length * 0.95)];
const loadStarted = performance.now();
const restored = createNavigationStateStore({ filePath }).get('/workspace/31');
const loadMs = performance.now() - loadStarted;
const bytes = statSync(filePath).size;

if (restored !== state) throw new Error('worst-case store did not round-trip');
if (p95 > 100 || loadMs > 75 || bytes > 16_000_000) {
  throw new Error(
    `navigation store budget exceeded: save p95=${p95.toFixed(2)}ms ` +
      `load=${loadMs.toFixed(2)}ms bytes=${bytes}`,
  );
}

console.log('| store operation | result |');
console.log('|---|---:|');
console.log(
  `| save p50 / p95 (${NAVIGATION_STORE_MAX_WORKSPACES} workspaces) | ${p50.toFixed(2)} / ${p95.toFixed(2)} ms |`,
);
console.log(`| cold load + lookup | ${loadMs.toFixed(2)} ms |`);
console.log(`| worst-case store size | ${bytes.toLocaleString()} bytes |`);
