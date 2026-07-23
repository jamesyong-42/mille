import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  FILE_TREE_NAVIGATION_LIMITS,
  captureFileTreeNavigationState,
  fileTreePathForId,
  parseFileTreeNavigationState,
  serializeFileTreeNavigationState,
} from '../dist/index.js';

function entry(id, parentId, name) {
  return {
    id,
    parentId,
    name,
    kind: 1,
    size: 0,
    mtimeMs: 0,
    ctimeMs: 0,
    isIgnored: false,
    isReadonly: false,
    isHidden: false,
  };
}

function snapshot(entries) {
  const byId = new Map(entries.map((value) => [value.id, value]));
  return { getById: (id) => byId.get(id) ?? null };
}

test('navigation state captures root-qualified paths and round-trips deterministically', () => {
  const snap = snapshot([
    entry(1, null, 'workspace'),
    entry(2, 1, 'src'),
    entry(3, 2, 'index.ts'),
  ]);
  const state = captureFileTreeNavigationState({
    snapshot: snap,
    expandedIds: new Set([2, 1]),
    selectedIds: new Set([3]),
    focusedId: 3,
    filter: 'index',
    searchMode: 'filter',
    scrollAnchor: { id: 3, offsetPx: 7.5 },
  });

  assert.deepEqual(state, {
    version: 1,
    expandedPaths: ['workspace', 'workspace/src'],
    selectedPaths: ['workspace/src/index.ts'],
    focusedPath: 'workspace/src/index.ts',
    filter: 'index',
    searchMode: 'filter',
    scrollAnchor: { path: 'workspace/src/index.ts', offsetPx: 7.5 },
  });
  const encoded = serializeFileTreeNavigationState(state);
  assert.equal(
    encoded,
    '{"version":1,"expandedPaths":["workspace","workspace/src"],"selectedPaths":["workspace/src/index.ts"],"focusedPath":"workspace/src/index.ts","filter":"index","searchMode":"filter","scrollAnchor":{"path":"workspace/src/index.ts","offsetPx":7.5}}',
  );
  assert.deepEqual(parseFileTreeNavigationState(encoded), state);
});

test('navigation parser migrates unversioned state and bounds hostile input', () => {
  const tooMany = Array.from(
    { length: FILE_TREE_NAVIGATION_LIMITS.expandedPaths + 50 },
    (_, index) => `root/folder-${index}`,
  );
  const parsed = parseFileTreeNavigationState({
    expanded: [...tooMany, 'root/folder-0', '', 42],
    selected: ['root/a.ts', 'root/a.ts'],
    focused: 'root/a.ts',
    filter: 'x'.repeat(FILE_TREE_NAVIGATION_LIMITS.filterLength + 10),
    searchMode: 'unknown',
    scrollAnchor: { path: 'root/a.ts', offsetPx: -20 },
  });

  assert.ok(parsed);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.expandedPaths.length, FILE_TREE_NAVIGATION_LIMITS.expandedPaths);
  assert.deepEqual(parsed.selectedPaths, ['root/a.ts']);
  assert.equal(parsed.focusedPath, 'root/a.ts');
  assert.equal(parsed.filter.length, FILE_TREE_NAVIGATION_LIMITS.filterLength);
  assert.equal(parsed.searchMode, 'off');
  assert.deepEqual(parsed.scrollAnchor, { path: 'root/a.ts', offsetPx: 0 });
  assert.equal(parseFileTreeNavigationState('{broken'), null);
  assert.equal(parseFileTreeNavigationState({ version: 99 }), null);
});

test('path reconstruction rejects cycles, missing parents, and invalid segments', () => {
  assert.equal(fileTreePathForId(snapshot([entry(1, 1, 'loop')]), 1), null);
  assert.equal(fileTreePathForId(snapshot([entry(2, 99, 'orphan')]), 2), null);
  assert.equal(fileTreePathForId(snapshot([entry(1, null, 'bad/name')]), 1), null);
});

